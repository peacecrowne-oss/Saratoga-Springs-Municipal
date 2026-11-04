// GIS Sync Job (STORY-002, STORY-005): keeps asset records and the ArcGIS layer
// in step, and proves it.
//
// Who owns what (agreed with the user):
//   our system owns  ASSET_TAG, NAME, ASSET_TYPE, STATUS, LOCATION_DESC  → pushed to GIS
//   GIS owns         geometry and every other attribute                  → pulled into the system
//
// One run:
//   1. take the run lock, so two jobs never race            (already_running)
//   2. check the layer has the fields we need               (schema_mismatch)
//   3. pull features edited since the last run, page by page
//      - store GIS-owned fields and geometry on the asset   (gis.pull)
//      - a GIS edit to a field we own is a mismatch: audited and
//        queued for push, so our value wins below           (gis.mismatch)
//      - a feature whose tag matches no asset, or a second feature
//        with an asset's tag, is reported                   (gis.mismatch)
//      - a bad point never replaces a good one              (gis.spatial_problem)
//   4. at least daily, compare the whole layer, catching what the pull cannot
//      see: deleted features and edits that skipped editor tracking
//                                                           (gis.feature_missing, gis.mismatch)
//   5. push every asset changed since its last push         (gis.push / gis.push_failed)
//      - an asset not yet linked is first looked up by tag, so a retried
//        or interrupted add never creates a second feature
//      - changed location text flags the GIS point for review (gis.spatial_problem)
//   6. read every pushed feature back and compare           (gis.verify_failed)
//   7. write a summary                                      (gis.sync_run)
//
// Geometry belongs to GIS, so spatial problems are flagged for an analyst and
// never corrected here. A deleted feature is not recreated, either: restoring it
// with the same tag in GIS relinks it.
//
// Every change and its audit event land in one transaction. A run that stops for
// any reason is audited as gis.sync_failed, naming the stage, the asset if there
// was one, the error and what to check.

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
const LAST_RECONCILE = 'gis.reconcile.last_at';
const LOCK = 'gis.sync.lock';
const LOCK_EXPIRES_MS = 30 * 60000; // a crashed job cannot block the sync forever
const DAY_MS = 24 * 60 * 60000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;
const VERIFY_BATCH = 200;
const FEATURE_MISSING_CODE = 1019; // ESRI's "Object is missing"

const HINTS = {
  auth: 'Check ARCGIS_USERNAME and ARCGIS_PASSWORD, and that the account can still edit this layer.',
  timeout: 'Check the network path to ArcGIS and whether the server is busy. The next run picks up where this one stopped.',
  unreachable: 'Check that ArcGIS is up and reachable from this machine. The next run picks up where this one stopped.',
  refused: 'ArcGIS refused the request. Check the layer URL and the error code in the message.',
  bad_response: 'ArcGIS answered with something unexpected. Check that the layer URL points at a feature layer.',
  not_configured: 'Set ARCGIS_LAYER_URL (and ARCGIS_TOKEN_URL if the layer needs a token).',
  schema_mismatch: 'The layer must have the fields named in the message, with editor tracking on.',
  already_running: 'Another sync is running. Its lock expires by itself after 30 minutes if that job crashed.',
  too_many_pages: 'The layer is larger than this job is built for. Raise MAX_PAGES after checking the load.',
  internal: 'An unexpected error. See the message and the job output.',
};

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
const assetOf = row => ({ assetTag: row.asset_tag, name: row.name, assetType: row.asset_type, status: row.status, location: row.location });
// A link row read with its asset's tag, back to just the columns the upsert names.
const linkColumns = ({ asset_tag, ...columns }) => columns;

// Why this point cannot be trusted, or null. No point at all is not a problem
// here: it means an analyst has not placed the asset yet.
export function geometryProblem(geometry, layer) {
  if (geometry === null || geometry === undefined) return null;
  if (layer.geometryType && layer.geometryType !== 'esriGeometryPoint') return null;
  const { x, y } = geometry;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { kind: 'invalid_geometry', message: 'GIS sent a point without usable coordinates, so the last good point is kept.', received: geometry };
  }
  const e = layer.extent;
  if (e && (x < e.xmin || x > e.xmax || y < e.ymin || y > e.ymax)) {
    return { kind: 'outside_layer_extent', message: `The point (${x}, ${y}) is outside the layer's area, so the last good point is kept.`, received: geometry };
  }
  return null;
}

export async function runGisSync({ db, audit, client, actor = 'gis-sync-job', now = () => new Date(), reconcile = false, reconcileEveryMs = DAY_MS }) {
  const started = now();
  const summary = {
    pulled: 0, mismatches: 0, unknown: 0, duplicates: 0, pushed: 0, pushFailed: 0,
    verified: 0, verifyFailed: 0, missingFeatures: 0, spatialProblems: 0, reconciled: false,
    awaitingLocation: 0, layer: null, simulated: false,
  };
  let stage = 'lock';
  let locked = false;
  let failedAsset = null;

  const getState = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const setState = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const clearState = db.prepare('DELETE FROM sync_state WHERE key = ?');
  // Case-insensitive like the asset store, so a re-typed tag in GIS still finds its asset.
  const assetByTag = db.prepare('SELECT * FROM asset WHERE asset_tag = ? COLLATE NOCASE');
  const linkOf = db.prepare('SELECT * FROM asset_gis WHERE asset_id = ?');
  const upsertLink = db.prepare(`
    INSERT INTO asset_gis (asset_id, object_id, layer, attributes, geometry, gis_edited_at, gis_edited_by, pushed_values, pushed_at, synced_at, status, mismatch, last_error, spatial_problem, verified_at)
    VALUES (:asset_id, :object_id, :layer, :attributes, :geometry, :gis_edited_at, :gis_edited_by, :pushed_values, :pushed_at, :synced_at, :status, :mismatch, :last_error, :spatial_problem, :verified_at)
    ON CONFLICT(asset_id) DO UPDATE SET
      object_id = excluded.object_id, layer = excluded.layer, attributes = excluded.attributes, geometry = excluded.geometry,
      gis_edited_at = excluded.gis_edited_at, gis_edited_by = excluded.gis_edited_by, pushed_values = excluded.pushed_values,
      pushed_at = excluded.pushed_at, synced_at = excluded.synced_at, status = excluded.status,
      mismatch = excluded.mismatch, last_error = excluded.last_error,
      spatial_problem = excluded.spatial_problem, verified_at = excluded.verified_at
  `);
  // A deleted feature stays out until someone restores it in GIS, so it cannot fail every run.
  const toPush = db.prepare(`
    SELECT a.* FROM asset a LEFT JOIN asset_gis g ON g.asset_id = a.id
    WHERE (g.asset_id IS NULL OR g.pushed_at IS NULL OR a.updated_at > g.pushed_at)
      AND COALESCE(g.status, '') <> 'missing'
    ORDER BY a.created_at, a.rowid
  `);
  const toVerify = db.prepare(`
    SELECT g.*, a.asset_tag FROM asset_gis g JOIN asset a ON a.id = g.asset_id
    WHERE g.pushed_at IS NOT NULL AND g.object_id IS NOT NULL AND g.verified_at IS NULL AND g.status <> 'missing'
  `);
  const linked = db.prepare(`
    SELECT g.*, a.asset_tag FROM asset_gis g JOIN asset a ON a.id = g.asset_id
    WHERE g.object_id IS NOT NULL AND g.status <> 'missing'
  `);
  const countAwaiting = db.prepare("SELECT COUNT(*) AS n FROM asset_gis WHERE geometry IS NULL AND status <> 'missing'");

  const record = (action, entityId, after, before = null) =>
    audit.record({ actor, action, entityType: 'asset', entityId, before, after });

  const blankLink = (assetId) => ({
    asset_id: assetId, object_id: null, layer: summary.layer, attributes: null, geometry: null,
    gis_edited_at: null, gis_edited_by: null, pushed_values: null, pushed_at: null,
    synced_at: null, status: 'pending', mismatch: null, last_error: null, spatial_problem: null, verified_at: null,
  });

  function takeLock() {
    transaction(db, () => {
      const held = fromJson(getState.get(LOCK)?.value);
      if (held && now().getTime() - held.at < LOCK_EXPIRES_MS) {
        throw new GisSyncError('already_running', `Another GIS sync started at ${new Date(held.at).toISOString()} and has not finished.`);
      }
      setState.run(LOCK, JSON.stringify({ at: now().getTime() }));
    });
    locked = true;
  }

  function markMissing(link, source) {
    const error = { kind: 'feature_missing', description: `Feature ${link.object_id} is no longer in the GIS layer. It was not recreated; restore it in GIS with the same tag to relink it.` };
    transaction(db, () => {
      upsertLink.run({ ...linkColumns(link), status: 'missing', last_error: toJson(error), verified_at: null });
      record('gis.feature_missing', link.asset_id, { objectId: link.object_id, assetTag: link.asset_tag, layer: summary.layer, found_by: source, ...error });
      summary.missingFeatures++;
    });
  }

  try {
    takeLock();

    // 2. Schema.
    stage = 'schema';
    const layer = await client.describeLayer();
    summary.layer = layer.name ?? null;
    summary.simulated = /^SIMULATED/.test(layer.name ?? '');
    const names = new Set(layer.fields.map(f => f.name));
    const editDateField = layer.editFieldsInfo?.editDateField;
    const editorField = layer.editFieldsInfo?.editorField;
    const oidField = layer.objectIdField ?? 'OBJECTID';
    const missing = [...Object.keys(OWNED_FIELDS), oidField].filter(f => !names.has(f));
    if (!editDateField || !names.has(editDateField)) missing.push('editor tracking (editFieldsInfo.editDateField)');
    if (missing.length) {
      throw new GisSyncError('schema_mismatch', `The ArcGIS layer "${layer.name}" is missing fields the sync needs: ${missing.join(', ')}.`);
    }
    const trackingFields = new Set([oidField, ...Object.values(layer.editFieldsInfo)]);

    // The layer may cap a page below PAGE_SIZE (its maxRecordCount), so the
    // offset moves on by what actually came back.
    async function* featuresWhere(where) {
      let page = 0;
      for (let offset = 0, more = true; more;) {
        if (++page > MAX_PAGES) throw new GisSyncError('too_many_pages', `The query stopped after ${MAX_PAGES} pages; the layer is larger than this job is built for.`);
        const { features, exceededTransferLimit } = await client.query({ where, orderByFields: oidField, resultOffset: offset, resultRecordCount: PAGE_SIZE });
        offset += features.length;
        more = exceededTransferLimit && features.length > 0;
        yield* features;
      }
    }

    const watermark = fromJson(getState.get(WATERMARK)?.value);

    // Brings one feature into the system. source is 'pull' (it was edited) or
    // 'reconcile' (a full comparison, which writes only if something differs).
    function applyFeature(feature, source) {
      const a = feature.attributes ?? {};
      const editedAt = a[editDateField] ?? null;
      const objectId = a[oidField];
      const alreadySeen = watermark !== null && (editedAt ?? 0) <= watermark;
      const row = assetByTag.get(String(a.ASSET_TAG ?? ''));

      if (!row) {
        if (source === 'reconcile' || alreadySeen) return;
        transaction(db, () => {
          audit.record({ actor, action: 'gis.mismatch', entityType: 'gis_feature', entityId: String(objectId),
            after: { kind: 'unknown_asset', objectId, assetTag: a.ASSET_TAG ?? null, layer: summary.layer, editedAt } });
        });
        summary.unknown++;
        return;
      }

      const link = linkOf.get(row.id);
      const restored = link?.status === 'missing';

      // A second feature with this asset's tag must not take over its link.
      if (link && link.object_id !== null && link.object_id !== objectId && !restored) {
        if (source === 'pull' && alreadySeen) return;
        transaction(db, () => {
          record('gis.mismatch', row.id, { kind: 'duplicate_feature', assetTag: row.asset_tag, objectId: link.object_id, duplicateObjectId: objectId, layer: summary.layer, resolution: 'link kept; remove the duplicate in GIS' });
        });
        summary.duplicates++;
        return;
      }
      if (source === 'pull' && !restored && link?.gis_edited_at !== null && link?.gis_edited_at !== undefined && editedAt !== null && editedAt <= link.gis_edited_at) return;

      const gisFields = Object.fromEntries(Object.entries(a).filter(([k]) => !(k in OWNED_FIELDS) && !trackingFields.has(k)));
      const current = ownedValues(assetOf(row));
      // What GIS should hold for our fields: what we last pushed, or, never pushed, our current values.
      const expected = fromJson(link?.pushed_values) ?? current;
      const mismatch = Object.keys(OWNED_FIELDS)
        .filter(f => !same(norm(a[f]), expected[f]))
        .map(f => ({ field: f, system: current[f], gis: norm(a[f]) }));

      const storedGeometry = fromJson(link?.geometry);
      const problem = geometryProblem(feature.geometry ?? null, layer);
      const geometry = problem ? storedGeometry : (feature.geometry ?? null);
      const geometryChanged = !same(storedGeometry, geometry);
      const prior = fromJson(link?.spatial_problem);
      // A location review stays open until the point actually moves.
      const spatial = problem ?? (prior?.kind === 'location_review' && !geometryChanged ? prior : null);

      const before = { fields: fromJson(link?.attributes), geometry: storedGeometry };
      // Empty GIS fields are no news: our own add coming back is not a pull.
      const changed = !same(compact(before.fields), compact(gisFields)) || geometryChanged;

      if (source === 'reconcile' && !changed && !mismatch.length && !restored && same(spatial, prior)) return;

      transaction(db, () => {
        upsertLink.run({
          ...(link ?? blankLink(row.id)),
          object_id: objectId,
          layer: summary.layer,
          attributes: toJson(gisFields),
          geometry: toJson(geometry),
          gis_edited_at: editedAt ?? link?.gis_edited_at ?? null,
          gis_edited_by: editorField ? norm(a[editorField]) : null,
          synced_at: now().toISOString(),
          // A mismatch forces a push, so our value wins. A restored feature needs ours again too.
          pushed_at: mismatch.length || restored ? null : (link?.pushed_at ?? null),
          status: mismatch.length ? 'mismatch' : (link?.status === 'error' ? 'error' : 'synced'),
          mismatch: mismatch.length ? toJson(mismatch) : null,
          last_error: restored ? null : (link?.last_error ?? null),
          spatial_problem: toJson(spatial),
        });
        if (changed) {
          record('gis.pull', row.id, { objectId, layer: summary.layer, fields: gisFields, geometry, editedAt, editedBy: editorField ? a[editorField] : null, ...(source === 'reconcile' && { found_by: 'reconcile' }) }, before);
          summary.pulled++;
        }
        if (mismatch.length) {
          record('gis.mismatch', row.id, { kind: 'owned_field_edited_in_gis', objectId, layer: summary.layer, fields: mismatch, resolution: 'system value will be pushed', ...(source === 'reconcile' && { found_by: 'reconcile' }) });
          summary.mismatches++;
        }
        if (problem && problem.kind !== prior?.kind) {
          record('gis.spatial_problem', row.id, { objectId, layer: summary.layer, ...problem });
          summary.spatialProblems++;
        }
      });
    }

    // 3. Pull.
    stage = 'pull';
    let highest = watermark;
    const where = watermark === null ? '1=1' : `${editDateField} >= ${sqlTimestamp(watermark)}`;
    for await (const feature of featuresWhere(where)) {
      highest = Math.max(highest ?? 0, feature.attributes?.[editDateField] ?? 0);
      applyFeature(feature, 'pull');
    }
    if (highest !== null && highest !== watermark) setState.run(WATERMARK, JSON.stringify(highest));

    // 4. Compare the whole layer, when due.
    const lastReconcile = fromJson(getState.get(LAST_RECONCILE)?.value);
    if (reconcile || lastReconcile === null || now().getTime() - lastReconcile >= reconcileEveryMs) {
      stage = 'reconcile';
      const seen = new Set();
      for await (const feature of featuresWhere('1=1')) {
        seen.add(feature.attributes?.[oidField]);
        applyFeature(feature, 'reconcile');
      }
      for (const link of linked.all()) {
        if (!seen.has(link.object_id)) markMissing(link, 'reconcile');
      }
      setState.run(LAST_RECONCILE, JSON.stringify(now().getTime()));
      summary.reconciled = true;
    }

    // 5. Push.
    stage = 'push';
    for (const row of toPush.all()) {
      failedAsset = { assetId: row.id, assetTag: row.asset_tag };
      const values = ownedValues(assetOf(row));
      const link = linkOf.get(row.id);
      let objectId = link?.object_id ?? null;
      let result;
      let operation;
      try {
        if (objectId === null) {
          const found = await client.query({ where: `ASSET_TAG = ${sqlString(row.asset_tag)}`, orderByFields: oidField, resultRecordCount: 2 });
          objectId = found.features[0]?.attributes?.[oidField] ?? null;
        }
        operation = objectId === null ? 'add' : 'update';
        const { addResults, updateResults } = operation === 'add'
          ? await client.applyEdits({ adds: [{ attributes: values, geometry: null }] })
          : await client.applyEdits({ updates: [{ attributes: { ...values, [oidField]: objectId } }] });
        result = (operation === 'add' ? addResults : updateResults)[0];
      } catch (err) {
        // The edit may or may not have landed, so the asset stays queued. The next
        // run finds any saved feature by its tag, so nothing is duplicated.
        if (err instanceof ArcGisError) {
          transaction(db, () => upsertLink.run({ ...(link ?? blankLink(row.id)), object_id: objectId, layer: summary.layer, status: 'error', last_error: toJson({ kind: err.kind, description: err.message }) }));
        }
        throw err;
      }

      const overwrote = fromJson(link?.mismatch);
      const previous = fromJson(link?.pushed_values);
      // We own the description and GIS owns the point: if the words moved, someone should check the point.
      const review = previous && previous.LOCATION_DESC !== values.LOCATION_DESC && fromJson(link?.geometry)
        ? { kind: 'location_review', message: `The location description changed from "${previous.LOCATION_DESC ?? ''}" to "${values.LOCATION_DESC ?? ''}", but the GIS point has not moved. An analyst should confirm it.` }
        : null;

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
            spatial_problem: review ? toJson(review) : (link?.spatial_problem ?? null),
            verified_at: null,
          });
          record('gis.push', row.id, { operation, objectId: result.objectId ?? objectId, layer: summary.layer, fields: values, ...(overwrote && { overwrote }) });
          summary.pushed++;
          if (review) {
            record('gis.spatial_problem', row.id, { objectId: result.objectId ?? objectId, layer: summary.layer, ...review });
            summary.spatialProblems++;
          }
        } else {
          const error = result?.error ?? { description: 'ArcGIS returned no result for this edit.' };
          const gone = error.code === FEATURE_MISSING_CODE;
          upsertLink.run({ ...(link ?? blankLink(row.id)), object_id: objectId, layer: summary.layer, status: gone ? 'missing' : 'error', last_error: toJson(error) });
          record('gis.push_failed', row.id, { operation, objectId, assetTag: row.asset_tag, layer: summary.layer, fields: values, error });
          summary.pushFailed++;
        }
      });
    }
    failedAsset = null;

    // 6. Read back what was pushed: "success" from the layer is a claim, not proof.
    stage = 'verify';
    const pending = toVerify.all();
    for (let i = 0; i < pending.length; i += VERIFY_BATCH) {
      const batch = pending.slice(i, i + VERIFY_BATCH);
      const found = new Map();
      for await (const f of featuresWhere(`${oidField} IN (${batch.map(l => l.object_id).join(',')})`)) {
        found.set(f.attributes?.[oidField], f);
      }
      for (const link of batch) {
        const feature = found.get(link.object_id);
        if (!feature) { markMissing(link, 'verify'); continue; }
        const pushed = fromJson(link.pushed_values);
        const wrong = Object.keys(OWNED_FIELDS)
          .filter(f => !same(norm(feature.attributes[f]), pushed[f]))
          .map(f => ({ field: f, sent: pushed[f], gis: norm(feature.attributes[f]) }));
        transaction(db, () => {
          if (wrong.length) {
            const error = { kind: 'verify_failed', description: `ArcGIS accepted the edit but holds different values for: ${wrong.map(w => w.field).join(', ')}.`, fields: wrong };
            // Queued again: the next run retries, and says so again if it still does not hold.
            upsertLink.run({ ...linkColumns(link), status: 'error', last_error: toJson(error), pushed_at: null });
            record('gis.verify_failed', link.asset_id, { objectId: link.object_id, assetTag: link.asset_tag, layer: summary.layer, ...error });
            summary.verifyFailed++;
          } else {
            upsertLink.run({ ...linkColumns(link), verified_at: now().toISOString() });
            summary.verified++;
          }
        });
      }
    }

    // 7. Summary.
    summary.awaitingLocation = countAwaiting.get().n;
    summary.durationMs = now() - started;
    audit.record({ actor, action: 'gis.sync_run', entityType: 'gis_sync', entityId: null, after: summary });
    return { ok: summary.pushFailed === 0 && summary.verifyFailed === 0, ...summary };
  } catch (err) {
    const known = err instanceof ArcGisError || err instanceof GisSyncError;
    const kind = known ? err.kind : 'internal';
    summary.durationMs = now() - started;
    err.kind ??= kind;
    err.stage = stage;
    // If the audit trail is what failed, the original error must still reach the caller.
    try {
      audit.record({ actor, action: 'gis.sync_failed', entityType: 'gis_sync', entityId: null,
        after: { ...summary, stage, kind, message: err.message, hint: HINTS[kind] ?? HINTS.internal, ...(failedAsset ?? {}) } });
      err.auditRecorded = true;
    } catch (auditErr) {
      err.auditRecorded = false;
      err.auditError = auditErr.message;
    }
    throw err;
  } finally {
    if (locked) {
      try {
        clearState.run(LOCK);
      } catch (lockErr) {
        console.error(`Could not release the GIS sync lock; it expires in ${LOCK_EXPIRES_MS / 60000} minutes: ${lockErr.message}`);
      }
    }
  }
}
