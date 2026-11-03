// GIS Sync Job (STORY-002): keeps asset records and the ArcGIS layer in step.
//
// Who owns what (agreed with the user):
//   our system owns  ASSET_TAG, NAME, ASSET_TYPE, STATUS, LOCATION_DESC  → pushed to GIS
//   GIS owns         geometry and every other attribute                  → pulled into the system
//
// One run:
//   1. check the layer has the fields we need               (schema_mismatch)
//   2. pull features edited since the last run, page by page
//      - store GIS-owned fields and geometry on the asset   (gis.pull)
//      - a GIS edit to a field we own is a mismatch: audited and
//        queued for push, so our value wins below           (gis.mismatch)
//      - a feature whose tag matches no asset is reported   (gis.mismatch, unknown_asset)
//   3. push every asset changed since its last push         (gis.push / gis.push_failed)
//      - an asset not yet linked is first looked up by tag, so a retried
//        or interrupted add never creates a second feature
//   4. write a summary                                      (gis.sync_run)
//
// Every change and its audit event land in one transaction. A run that cannot
// talk to ArcGIS (auth, network, schema) stops and is audited as gis.sync_failed.

import { transaction } from './db.js';
import { ArcGisError, sqlString, sqlTimestamp } from './integrations/arcgis/client.js';

export const OWNED_FIELDS = {
  ASSET_TAG: 'assetTag',
  NAME: 'name',
  ASSET_TYPE: 'assetType',
  STATUS: 'status',
  LOCATION_DESC: 'location',
};
const WATERMARK = 'gis.pull.last_edited_at';
const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;

export class GisSyncError extends Error {
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'GisSyncError';
    this.kind = kind;
  }
}

const norm = v => (v === undefined || v === '' ? null : v);
const toJson = v => (v === null || v === undefined ? null : JSON.stringify(v));
const fromJson = v => (v === null || v === undefined ? null : JSON.parse(v));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const compact = fields => {
  const kept = Object.entries(fields ?? {}).filter(([, v]) => v !== null && v !== undefined);
  return kept.length ? Object.fromEntries(kept) : null;
};

const ownedValues = asset => Object.fromEntries(Object.entries(OWNED_FIELDS).map(([field, key]) => [field, norm(asset[key])]));

export async function runGisSync({ db, audit, client, actor = 'gis-sync-job', now = () => new Date() }) {
  const started = now();
  const summary = { pulled: 0, mismatches: 0, unknown: 0, pushed: 0, pushFailed: 0, layer: null, simulated: false };

  const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const setState = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const assetByTag = db.prepare('SELECT * FROM asset WHERE asset_tag = ?');
  const linkOf = db.prepare('SELECT * FROM asset_gis WHERE asset_id = ?');
  const upsertLink = db.prepare(`
    INSERT INTO asset_gis (asset_id, object_id, layer, attributes, geometry, gis_edited_at, gis_edited_by, pushed_values, pushed_at, synced_at, status, mismatch, last_error)
    VALUES (:asset_id, :object_id, :layer, :attributes, :geometry, :gis_edited_at, :gis_edited_by, :pushed_values, :pushed_at, :synced_at, :status, :mismatch, :last_error)
    ON CONFLICT(asset_id) DO UPDATE SET
      object_id = excluded.object_id, layer = excluded.layer, attributes = excluded.attributes, geometry = excluded.geometry,
      gis_edited_at = excluded.gis_edited_at, gis_edited_by = excluded.gis_edited_by, pushed_values = excluded.pushed_values,
      pushed_at = excluded.pushed_at, synced_at = excluded.synced_at, status = excluded.status,
      mismatch = excluded.mismatch, last_error = excluded.last_error
  `);
  const toPush = db.prepare(`
    SELECT a.* FROM asset a LEFT JOIN asset_gis g ON g.asset_id = a.id
    WHERE g.asset_id IS NULL OR g.pushed_at IS NULL OR a.updated_at > g.pushed_at
    ORDER BY a.created_at, a.rowid
  `);

  const record = (action, entityId, after, before = null) =>
    audit.record({ actor, action, entityType: 'asset', entityId, before, after });

  const blankLink = (assetId) => ({
    asset_id: assetId, object_id: null, layer: summary.layer, attributes: null, geometry: null,
    gis_edited_at: null, gis_edited_by: null, pushed_values: null, pushed_at: null,
    synced_at: null, status: 'pending', mismatch: null, last_error: null,
  });

  try {
    // 1. Schema.
    const layer = await client.describeLayer();
    summary.layer = layer.name ?? null;
    summary.simulated = /^SIMULATED/.test(layer.name ?? '');
    const names = new Set(layer.fields.map(f => f.name));
    const editDateField = layer.editFieldsInfo?.editDateField;
    const editorField = layer.editFieldsInfo?.editorField;
    const missing = [...Object.keys(OWNED_FIELDS), layer.objectIdField ?? 'OBJECTID'].filter(f => !names.has(f));
    if (!editDateField || !names.has(editDateField)) missing.push('editor tracking (editFieldsInfo.editDateField)');
    if (missing.length) {
      throw new GisSyncError('schema_mismatch', `The ArcGIS layer "${layer.name}" is missing fields the sync needs: ${missing.join(', ')}.`);
    }
    const oidField = layer.objectIdField ?? 'OBJECTID';
    const trackingFields = new Set([oidField, ...Object.values(layer.editFieldsInfo)]);

    // 2. Pull.
    const watermark = fromJson(getState.get(WATERMARK)?.value);
    const where = watermark === null ? '1=1' : `${editDateField} >= ${sqlTimestamp(watermark)}`;
    let highest = watermark;
    let page = 0;
    // The layer may cap a page below PAGE_SIZE (its maxRecordCount), so the
    // offset moves on by what actually came back.
    for (let offset = 0, more = true; more;) {
      if (++page > MAX_PAGES) throw new GisSyncError('too_many_pages', `The pull stopped after ${MAX_PAGES} pages; the layer is larger than this job is built for.`);
      const { features, exceededTransferLimit } = await client.query({ where, resultOffset: offset, resultRecordCount: PAGE_SIZE });
      offset += features.length;
      more = exceededTransferLimit && features.length > 0;

      for (const feature of features) {
        const a = feature.attributes ?? {};
        const editedAt = a[editDateField];
        const objectId = a[oidField];
        highest = Math.max(highest ?? 0, editedAt ?? 0);
        const row = assetByTag.get(String(a.ASSET_TAG ?? ''));

        if (!row) {
          if (watermark !== null && editedAt <= watermark) continue;
          transaction(db, () => {
            audit.record({ actor, action: 'gis.mismatch', entityType: 'gis_feature', entityId: String(objectId),
              after: { kind: 'unknown_asset', objectId, assetTag: a.ASSET_TAG ?? null, layer: summary.layer, editedAt } });
          });
          summary.unknown++;
          continue;
        }

        const link = linkOf.get(row.id);
        if (link?.gis_edited_at !== null && link?.gis_edited_at !== undefined && editedAt <= link.gis_edited_at) continue;

        const gisFields = Object.fromEntries(Object.entries(a).filter(([k]) => !(k in OWNED_FIELDS) && !trackingFields.has(k)));
        const geometry = feature.geometry ?? null;
        const asset = { assetTag: row.asset_tag, name: row.name, assetType: row.asset_type, status: row.status, location: row.location };
        // What GIS should hold for our fields: what we last pushed, or, never pushed, our current values.
        const expected = fromJson(link?.pushed_values) ?? ownedValues(asset);
        const current = ownedValues(asset);
        const mismatch = Object.keys(OWNED_FIELDS)
          .filter(f => !same(norm(a[f]), expected[f]))
          .map(f => ({ field: f, system: current[f], gis: norm(a[f]) }));

        const before = { fields: fromJson(link?.attributes), geometry: fromJson(link?.geometry) };
        // Empty GIS fields are no news: our own add coming back is not a pull.
        const changed = !same(compact(before.fields), compact(gisFields)) || !same(before.geometry, geometry);

        transaction(db, () => {
          upsertLink.run({
            ...(link ?? blankLink(row.id)),
            object_id: objectId,
            layer: summary.layer,
            attributes: toJson(gisFields),
            geometry: toJson(geometry),
            gis_edited_at: editedAt,
            gis_edited_by: editorField ? norm(a[editorField]) : null,
            synced_at: now().toISOString(),
            // A mismatch forces a push, so our value wins.
            pushed_at: mismatch.length ? null : (link?.pushed_at ?? null),
            status: mismatch.length ? 'mismatch' : (link?.status === 'error' ? 'error' : 'synced'),
            mismatch: mismatch.length ? toJson(mismatch) : null,
          });
          if (changed) {
            record('gis.pull', row.id, { objectId, layer: summary.layer, fields: gisFields, geometry, editedAt, editedBy: editorField ? a[editorField] : null }, before);
            summary.pulled++;
          }
          if (mismatch.length) {
            record('gis.mismatch', row.id, { kind: 'owned_field_edited_in_gis', objectId, layer: summary.layer, fields: mismatch, resolution: 'system value will be pushed' });
            summary.mismatches++;
          }
        });
      }
    }
    if (highest !== null && highest !== watermark) setState.run(WATERMARK, JSON.stringify(highest));

    // 3. Push.
    for (const row of toPush.all()) {
      const asset = { assetTag: row.asset_tag, name: row.name, assetType: row.asset_type, status: row.status, location: row.location };
      const values = ownedValues(asset);
      const link = linkOf.get(row.id);
      let objectId = link?.object_id ?? null;

      if (objectId === null) {
        const found = await client.query({ where: `ASSET_TAG = ${sqlString(row.asset_tag)}`, resultRecordCount: 2 });
        objectId = found.features[0]?.attributes?.[oidField] ?? null;
      }
      const operation = objectId === null ? 'add' : 'update';
      const { addResults, updateResults } = operation === 'add'
        ? await client.applyEdits({ adds: [{ attributes: values, geometry: null }] })
        : await client.applyEdits({ updates: [{ attributes: { ...values, [oidField]: objectId } }] });
      const result = (operation === 'add' ? addResults : updateResults)[0];
      const overwrote = fromJson(link?.mismatch);

      transaction(db, () => {
        if (result?.success) {
          upsertLink.run({
            ...(link ?? blankLink(row.id)),
            object_id: result.objectId ?? objectId,
            layer: summary.layer,
            pushed_values: toJson(values),
            pushed_at: row.updated_at,
            synced_at: now().toISOString(),
            status: 'synced',
            mismatch: null,
            last_error: null,
          });
          record('gis.push', row.id, { operation, objectId: result.objectId ?? objectId, layer: summary.layer, fields: values, ...(overwrote && { overwrote }) });
          summary.pushed++;
        } else {
          const error = result?.error ?? { description: 'ArcGIS returned no result for this edit.' };
          upsertLink.run({ ...(link ?? blankLink(row.id)), object_id: objectId, layer: summary.layer, status: 'error', last_error: toJson(error) });
          record('gis.push_failed', row.id, { operation, objectId, layer: summary.layer, fields: values, error });
          summary.pushFailed++;
        }
      });
    }

    summary.durationMs = now() - started;
    audit.record({ actor, action: 'gis.sync_run', entityType: 'gis_sync', entityId: null, after: summary });
    return { ok: summary.pushFailed === 0, ...summary };
  } catch (err) {
    if (!(err instanceof ArcGisError) && !(err instanceof GisSyncError)) throw err;
    summary.durationMs = now() - started;
    audit.record({ actor, action: 'gis.sync_failed', entityType: 'gis_sync', entityId: null, after: { ...summary, kind: err.kind, message: err.message } });
    throw err;
  }
}
