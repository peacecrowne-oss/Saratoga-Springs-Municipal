// Asset records: the first core function of the system (STORY-001).
//
// create() and update() write the asset and its audit event in one
// transaction, so an asset never changes without the record of who changed
// it. Both are idempotent: creating the same asset tag again with the same
// details, or applying the same update twice, writes nothing the second time.
// The same tag with different details is a conflict.
//
// Each asset also carries its GIS view (STORY-002): the feature it is linked
// to in ArcGIS and the field values GIS maintains, as last synced.

import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

export const ASSET_STATUSES = ['planned', 'active', 'maintenance', 'retired'];
// The lifecycle (STORY-004): where each status may go next. Retired is final.
export const NEXT_STATUSES = {
  planned: ['active', 'retired'],
  active: ['maintenance', 'retired'],
  maintenance: ['active', 'retired'],
  retired: [],
};
const EDITABLE = ['name', 'asset_type', 'status', 'location'];

export class AssetValidationError extends Error {
  constructor(problems) {
    super(`The asset is not valid: ${problems.map(p => `${p.field} ${p.problem}`).join('; ')}.`);
    this.name = 'AssetValidationError';
    this.problems = problems;
  }
}

export class AssetConflictError extends Error {
  constructor(existing) {
    super(`Asset tag ${existing.assetTag} already exists with different details.`);
    this.name = 'AssetConflictError';
    this.existing = existing;
  }
}

export class AssetTransitionError extends Error {
  constructor(from, to) {
    const allowed = NEXT_STATUSES[from];
    super(`An asset cannot go from ${from} to ${to}. ${allowed.length ? `From ${from} it can go to: ${allowed.join(', ')}.` : `${from} is final.`}`);
    this.name = 'AssetTransitionError';
    this.kind = 'illegal_transition';
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

export class AssetStaleError extends Error {
  constructor(current) {
    super(`Someone else changed asset ${current.assetTag} after you opened it. Reload it and try again.`);
    this.name = 'AssetStaleError';
    this.kind = 'stale';
    this.current = current;
  }
}

const TAG = /^[A-Za-z0-9._-]{1,64}$/;

function text(input, field, max, problems, { required = true } = {}) {
  const value = input[field];
  if (value === undefined || value === null || value === '') {
    if (required) problems.push({ field, problem: 'is required' });
    return null;
  }
  if (typeof value !== 'string') { problems.push({ field, problem: 'must be text' }); return null; }
  const trimmed = value.trim();
  if (!trimmed && required) { problems.push({ field, problem: 'is required' }); return null; }
  if (trimmed.length > max) { problems.push({ field, problem: `must be at most ${max} characters` }); return null; }
  return trimmed || null;
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

export function validateAsset(input) {
  if (!isObject(input)) throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
  const problems = [];
  const assetTag = text(input, 'asset_tag', 64, problems);
  if (assetTag && !TAG.test(assetTag)) problems.push({ field: 'asset_tag', problem: 'may only use letters, digits, dot, dash and underscore' });
  const name = text(input, 'name', 200, problems);
  const assetType = text(input, 'asset_type', 64, problems);
  const location = text(input, 'location', 200, problems, { required: false });
  const status = input.status === undefined ? 'active' : input.status;
  if (!ASSET_STATUSES.includes(status)) problems.push({ field: 'status', problem: `must be one of ${ASSET_STATUSES.join(', ')}` });
  if (problems.length) throw new AssetValidationError(problems);
  return { assetTag, name, assetType, status, location };
}

const json = v => (v === null || v === undefined ? null : JSON.parse(v));

const fromGisRow = row => row && ({
  objectId: row.object_id,
  layer: row.layer,
  status: row.status,
  fields: json(row.attributes),
  geometry: json(row.geometry),
  editedAt: row.gis_edited_at === null ? null : new Date(row.gis_edited_at).toISOString(),
  editedBy: row.gis_edited_by,
  syncedAt: row.synced_at,
  mismatch: json(row.mismatch),
  lastError: json(row.last_error),
  spatialProblem: json(row.spatial_problem),
  verifiedAt: row.verified_at,
});

const fromRow = row => row && ({
  id: row.id,
  assetTag: row.asset_tag,
  name: row.name,
  assetType: row.asset_type,
  status: row.status,
  location: row.location,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sameDetails = (a, b) =>
  a.name === b.name && a.assetType === b.assetType && a.status === b.status && a.location === b.location;

export function createAssetStore(db, audit, { now = () => new Date() } = {}) {
  // Case-insensitive, so hyd-0001 cannot become a second HYD-0001.
  const byTag = db.prepare('SELECT * FROM asset WHERE asset_tag = ? COLLATE NOCASE');
  const byId = db.prepare('SELECT * FROM asset WHERE id = ?');
  const all = db.prepare('SELECT * FROM asset ORDER BY created_at DESC, rowid DESC LIMIT ?');
  const gisOf = db.prepare('SELECT * FROM asset_gis WHERE asset_id = ?');
  const insert = db.prepare(`
    INSERT INTO asset (id, asset_tag, name, asset_type, status, location, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const save = db.prepare('UPDATE asset SET name = ?, asset_type = ?, status = ?, location = ?, updated_at = ? WHERE id = ?');

  const withGis = asset => asset && { ...asset, gis: fromGisRow(gisOf.get(asset.id)) ?? null };

  // The update itself, for a caller already inside a transaction.
  // Returns null if there is no such asset.
  function applyUpdate({ actor, id, input }) {
    if (!isObject(input)) throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
    const { expected_updated_at: expected, ...changes } = input;
    const unknown = Object.keys(changes).filter(k => !EDITABLE.includes(k));
    if (unknown.length) throw new AssetValidationError(unknown.map(field => ({ field, problem: 'cannot be changed here' })));

    const before = fromRow(byId.get(String(id)));
    if (!before) return null;
    if (expected !== undefined && expected !== before.updatedAt) throw new AssetStaleError(before);
    const merged = validateAsset({
      asset_tag: before.assetTag, name: before.name, asset_type: before.assetType,
      status: before.status, location: before.location, ...changes,
    });
    if (sameDetails(before, merged)) return { updated: false, asset: before };
    if (merged.status !== before.status && !NEXT_STATUSES[before.status].includes(merged.status)) {
      throw new AssetTransitionError(before.status, merged.status);
    }

    // Strictly later than the last change, so "changed since last sync" is never ambiguous.
    const at = new Date(Math.max(now().getTime(), Date.parse(before.updatedAt) + 1)).toISOString();
    const after = { ...before, ...merged, updatedAt: at };
    save.run(after.name, after.assetType, after.status, after.location, at, after.id);
    audit.record({ actor, action: 'asset.update', entityType: 'asset', entityId: after.id, before, after });
    return { updated: true, asset: after };
  }

  // A refused change is on the record too. Written after any rollback, so it survives it.
  function recordRejection({ actor, id, input, err }) {
    audit.record({ actor, action: 'asset.update_rejected', entityType: 'asset', entityId: String(id),
      after: { kind: err.kind, message: err.message, requested: input } });
  }

  return {
    applyUpdate,
    recordRejection,

    create({ actor, input }) {
      const asset = validateAsset(input);
      return transaction(db, () => {
        const existing = fromRow(byTag.get(asset.assetTag));
        if (existing) {
          if (sameDetails(existing, asset)) return { created: false, asset: existing };
          throw new AssetConflictError(existing);
        }
        const at = now().toISOString();
        const created = { id: randomUUID(), ...asset, createdAt: at, updatedAt: at };
        insert.run(created.id, created.assetTag, created.name, created.assetType, created.status, created.location, at, at);
        audit.record({ actor, action: 'asset.create', entityType: 'asset', entityId: created.id, after: created });
        return { created: true, asset: created };
      });
    },

    // Changes the fields this system owns. Returns null if there is no such asset.
    update({ actor, id, input }) {
      try {
        return transaction(db, () => applyUpdate({ actor, id, input }));
      } catch (err) {
        if (err instanceof AssetTransitionError || err instanceof AssetStaleError) recordRejection({ actor, id, input, err });
        throw err;
      }
    },

    get(id) {
      return withGis(fromRow(byId.get(String(id)))) ?? null;
    },

    list({ limit = 100 } = {}) {
      return all.all(limit).map(row => withGis(fromRow(row)));
    },
  };
}
