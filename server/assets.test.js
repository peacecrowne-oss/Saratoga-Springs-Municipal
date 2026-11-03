import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { AssetConflictError, AssetValidationError, createAssetStore } from './assets.js';
import { checkHealth } from './health.js';

const hydrant = { asset_tag: 'HYD-0001', name: 'Hydrant at Broadway & Main', asset_type: 'hydrant', location: 'Broadway & Main' };

function setup() {
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  return { db, audit, assets: createAssetStore(db, audit) };
}

test('creating an asset stores it and audits who created it', () => {
  const { audit, assets } = setup();
  const { created, asset } = assets.create({ actor: 'am-1', input: hydrant });
  assert.equal(created, true);
  assert.equal(asset.status, 'active');
  assert.deepEqual(assets.get(asset.id), asset);

  const [event] = audit.list({ entityType: 'asset' });
  assert.equal(event.action, 'asset.create');
  assert.equal(event.actor, 'am-1');
  assert.equal(event.entityId, asset.id);
});

test('creating the same asset twice returns the first one and writes nothing more', () => {
  const { audit, assets } = setup();
  const first = assets.create({ actor: 'am-1', input: hydrant });
  const again = assets.create({ actor: 'am-1', input: hydrant });
  assert.equal(again.created, false);
  assert.equal(again.asset.id, first.asset.id);
  assert.equal(assets.list().length, 1);
  assert.equal(audit.list({ entityType: 'asset' }).length, 1);
});

test('the same tag with different details is a conflict', () => {
  const { assets } = setup();
  assets.create({ actor: 'am-1', input: hydrant });
  assert.throws(() => assets.create({ actor: 'am-1', input: { ...hydrant, name: 'Something else' } }), AssetConflictError);
});

test('an invalid asset names every field that is wrong', () => {
  const { assets } = setup();
  assert.throws(() => assets.create({ actor: 'am-1', input: { asset_tag: 'bad tag!', status: 'lost' } }), err => {
    assert.ok(err instanceof AssetValidationError);
    assert.deepEqual(err.problems.map(p => p.field).sort(), ['asset_tag', 'asset_type', 'name', 'status']);
    return true;
  });
});

test('if the audit write fails, the asset is not stored', () => {
  const db = openDb(':memory:');
  const failing = { record() { throw new AuditWriteError('disk full'); }, list: () => [] };
  const assets = createAssetStore(db, failing);
  assert.throws(() => assets.create({ actor: 'am-1', input: hydrant }), AuditWriteError);
  assert.equal(assets.list().length, 0);
});

test('health is ok on a fresh database and unhealthy when the audit trail loses its protection', () => {
  const db = openDb(':memory:');
  assert.equal(checkHealth(db).status, 'ok');
  db.exec('DROP TRIGGER audit_event_no_delete');
  const health = checkHealth(db);
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.checks.audit.ok, false);
});
