// Asset records: the first core function of the system (STORY-001).
//
// create() writes the asset and its audit event in one transaction, so an
// asset can never exist without the record of who created it. Creating the
// same asset tag again with the same details returns the existing asset and
// writes nothing; the same tag with different details is a conflict.

import { randomUUID } from 'node:crypto';

export const ASSET_STATUSES = ['planned', 'active', 'maintenance', 'retired'];

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

export function validateAsset(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
  }
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
  const byTag = db.prepare('SELECT * FROM asset WHERE asset_tag = ?');
  const byId = db.prepare('SELECT * FROM asset WHERE id = ?');
  const all = db.prepare('SELECT * FROM asset ORDER BY created_at DESC, rowid DESC LIMIT ?');
  const insert = db.prepare(`
    INSERT INTO asset (id, asset_tag, name, asset_type, status, location, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function inTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        err.rollbackFailure = rollbackErr;
      }
      throw err;
    }
  }

  return {
    create({ actor, input }) {
      const asset = validateAsset(input);
      return inTransaction(() => {
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

    get(id) {
      return fromRow(byId.get(String(id))) ?? null;
    },

    list({ limit = 100 } = {}) {
      return all.all(limit).map(fromRow);
    },
  };
}
