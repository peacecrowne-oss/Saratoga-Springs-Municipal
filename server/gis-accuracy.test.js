// STORY-005 acceptance, end to end: is the data in GIS accurate, can a person see
// what went wrong, and do the logs last? Runs the GIS Sync Job against the
// SIMULATED ArcGIS stand-in over real HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createArcGisStandin, LAYER_PATH, TOKEN_PATH, STANDIN_USER, STANDIN_PASSWORD } from '../tools/arcgis-standin/server.js';
import { createArcGisClient } from './integrations/arcgis/client.js';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createApp } from './app.js';
import { geometryProblem, runGisSync } from './gis-sync.js';
import { describeGisEvent, gisStatus, readGisLog } from './gis-log.js';

const hydrant = { asset_tag: 'HYD-0001', name: 'Hydrant at Broadway & Main', asset_type: 'hydrant', location: 'Broadway & Main' };
const POINT = { x: -73.7846, y: 43.0831 };

async function setup(t, { standin: standinOptions = {}, client: clientOptions = {}, db = openDb(':memory:') } = {}) {
  const standin = createArcGisStandin(standinOptions);
  await new Promise(resolve => standin.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { standin.server.closeAllConnections(); return new Promise(resolve => standin.server.close(resolve)); });
  const base = `http://127.0.0.1:${standin.server.address().port}`;
  const client = createArcGisClient({
    layerUrl: base + LAYER_PATH, tokenUrl: base + TOKEN_PATH, username: STANDIN_USER, password: STANDIN_PASSWORD,
    timeoutMs: 300, retries: 1, retryDelayMs: 0, ...clientOptions,
  });
  const audit = createAuditLog(db);
  const assets = createAssetStore(db, audit);
  const sync = (options = {}) => runGisSync({ db, audit, client, ...options });
  const post = async (route, body) => {
    const res = await fetch(base + route, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const gisEdit = body => post('/_edit', { asset_tag: 'HYD-0001', ...body });
  const feature = (tag = 'HYD-0001') => [...standin.features.values()].find(f => f.attributes.ASSET_TAG === tag);
  const actionsFor = id => audit.list({ entityType: 'asset', entityId: id, limit: 100 }).map(e => e.action).reverse();
  return { standin, base, client, db, audit, assets, sync, gisEdit, post, feature, actionsFor };
}

test('criterion 1: an updated asset is read back from GIS and confirmed, keeping its point', async t => {
  const { assets, sync, gisEdit, feature } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  const first = await sync();
  assert.equal(first.verified, 1);
  assert.equal(first.awaitingLocation, 1, 'no point until an analyst places it');
  assert.ok(assets.get(asset.id).gis.verifiedAt);

  await gisEdit({ geometry: POINT });
  await sync();
  assets.update({ actor: 'am-1', id: asset.id, input: { status: 'maintenance' } });
  const run = await sync();
  assert.equal(run.pushed, 1);
  assert.equal(run.verified, 1);
  assert.equal(run.awaitingLocation, 0);
  assert.equal(feature().attributes.STATUS, 'maintenance');
  assert.deepEqual(feature().geometry, POINT, 'a push of our fields never moves the point');
  assert.deepEqual(assets.get(asset.id).gis.geometry, POINT);
});

test('criterion 1: changing the location text flags the GIS point for review until it moves', async t => {
  const { assets, sync, gisEdit, audit, actionsFor } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ geometry: POINT });
  await sync();

  assets.update({ actor: 'am-1', id: asset.id, input: { location: '12 Lake Ave' } });
  const run = await sync();
  assert.equal(run.spatialProblems, 1);
  assert.equal(assets.get(asset.id).gis.spatialProblem.kind, 'location_review');
  assert.equal(actionsFor(asset.id).at(-1), 'gis.spatial_problem');
  assert.match(audit.listActions({ only: ['gis.spatial_problem'] })[0].after.message, /12 Lake Ave/);

  await sync();
  assert.equal(assets.get(asset.id).gis.spatialProblem.kind, 'location_review', 'our own push coming back does not clear it');

  await gisEdit({ geometry: { x: -73.79, y: 43.09 } });
  await sync();
  assert.equal(assets.get(asset.id).gis.spatialProblem, null);
});

test('criterion 1: a bad point never replaces a good one, and is flagged once', async t => {
  const { assets, sync, gisEdit, actionsFor } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ geometry: POINT });
  await sync();

  await gisEdit({ geometry: { x: 0, y: 0 } }); // the classic "null island" typo
  assert.equal((await sync()).spatialProblems, 1);
  let gis = assets.get(asset.id).gis;
  assert.deepEqual(gis.geometry, POINT);
  assert.equal(gis.spatialProblem.kind, 'outside_layer_extent');

  await gisEdit({ attributes: { MATERIAL: 'Iron' } }); // still bad, edited again
  assert.equal((await sync()).spatialProblems, 0);
  assert.equal(actionsFor(asset.id).filter(a => a === 'gis.spatial_problem').length, 1);

  await gisEdit({ geometry: { x: 'NaN', y: null } });
  await sync();
  assert.equal(assets.get(asset.id).gis.spatialProblem.kind, 'invalid_geometry');
  assert.deepEqual(assets.get(asset.id).gis.geometry, POINT);

  await gisEdit({ geometry: { x: -73.79, y: 43.09 } });
  await sync();
  gis = assets.get(asset.id).gis;
  assert.deepEqual(gis.geometry, { x: -73.79, y: 43.09 });
  assert.equal(gis.spatialProblem, null);
});

test('geometryProblem: no point is not a problem, and a non-point layer is not range-checked', () => {
  const layer = { geometryType: 'esriGeometryPoint', extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } };
  assert.equal(geometryProblem(null, layer), null);
  assert.equal(geometryProblem({ x: 5, y: 5 }, layer), null);
  assert.equal(geometryProblem({ x: 50, y: 5 }, layer).kind, 'outside_layer_extent');
  assert.equal(geometryProblem({ x: 50, y: 5 }, { geometryType: 'esriGeometryPoint' }), null, 'no extent, nothing to compare to');
  assert.equal(geometryProblem({ paths: [] }, { geometryType: 'esriGeometryPolyline' }), null);
});

test('GIS layer update failure: the layer says success but holds something else, and read-back catches it', async t => {
  const { assets, sync, standin, audit, actionsFor } = await setup(t, { standin: { mode: 'lossy' } });
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  const run = await sync();
  assert.equal(run.pushed, 1, 'the layer claimed success');
  assert.equal(run.verifyFailed, 1);
  assert.equal(run.ok, false);

  const gis = assets.get(asset.id).gis;
  assert.equal(gis.status, 'error');
  assert.equal(gis.lastError.kind, 'verify_failed');
  assert.equal(gis.verifiedAt, null);
  assert.ok(actionsFor(asset.id).includes('gis.verify_failed'));
  const [event] = audit.listActions({ only: ['gis.verify_failed'] });
  assert.deepEqual(event.after.fields, [{ field: 'NAME', sent: hydrant.name, gis: hydrant.name.slice(0, 10) }]);

  standin.setMode('ok');
  const fixed = await sync();
  assert.equal(fixed.ok, true);
  assert.equal(fixed.verified, 1);
  assert.equal(assets.get(asset.id).gis.status, 'synced');
});

test('whole-layer comparison: finds a deleted feature, does not recreate it, and relinks when it is restored', async t => {
  const { assets, sync, post, client, standin, feature } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();

  await post('/_delete', { asset_tag: 'HYD-0001' });
  assert.equal((await sync()).missingFeatures, 0, 'a normal run cannot see a deletion');
  const run = await sync({ reconcile: true });
  assert.equal(run.reconciled, true);
  assert.equal(run.missingFeatures, 1);
  assert.equal(assets.get(asset.id).gis.status, 'missing');

  assets.update({ actor: 'am-1', id: asset.id, input: { status: 'maintenance' } });
  const quiet = await sync({ reconcile: true });
  assert.equal(quiet.pushFailed, 0, 'a missing feature does not fail every run');
  assert.equal(quiet.missingFeatures, 0, 'reported once');
  assert.equal(standin.features.size, 0, 'not recreated');

  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'HYD-0001', NAME: hydrant.name, ASSET_TYPE: 'hydrant', STATUS: 'active', LOCATION_DESC: hydrant.location } }] });
  const restored = await sync();
  assert.equal(restored.pushed, 1);
  assert.equal(assets.get(asset.id).gis.status, 'synced');
  assert.equal(assets.get(asset.id).gis.objectId, feature().attributes.OBJECTID);
  assert.equal(feature().attributes.STATUS, 'maintenance', 'our value is sent to the restored feature');
});

test('whole-layer comparison: catches an edit that skipped editor tracking, and runs by itself when due', async t => {
  const { assets, sync, gisEdit, feature } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await sync();

  await gisEdit({ quiet: true, attributes: { NAME: 'Changed directly', MATERIAL: 'Brass' }, geometry: POINT });
  const normal = await sync();
  assert.equal(normal.reconciled, false);
  assert.equal(normal.mismatches, 0, 'a normal run cannot see an untracked edit');

  const later = new Date(Date.now() + 25 * 60 * 60000);
  const run = await sync({ now: () => later });
  assert.equal(run.reconciled, true);
  assert.equal(run.mismatches, 1);
  assert.equal(feature().attributes.NAME, hydrant.name, 'our value is pushed back');
  const gis = assets.get(asset.id).gis;
  assert.equal(gis.fields.MATERIAL, 'Brass');
  assert.deepEqual(gis.geometry, POINT);
  const clean = await sync({ reconcile: true, now: () => later });
  assert.equal(clean.mismatches + clean.pulled, 0, 'nothing left to report');
});

test('data sync error: a second feature with the same tag is reported and cannot take over the link', async t => {
  const { assets, sync, client, audit, feature } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  const objectId = feature().attributes.OBJECTID;

  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'HYD-0001', NAME: 'A copy' } }] });
  assert.equal((await sync()).duplicates, 1);
  assert.equal(assets.get(asset.id).gis.objectId, objectId);
  assert.equal((await sync()).duplicates, 0, 'reported once by the pull');
  const [event] = audit.listActions({ only: ['gis.mismatch'] });
  assert.equal(event.after.kind, 'duplicate_feature');
  assert.equal(event.after.objectId, objectId);
});

test('data sync error: a tag re-typed in a different case in GIS still finds its asset and is corrected', async t => {
  const { assets, sync, gisEdit, feature, audit } = await setup(t);
  assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ attributes: { ASSET_TAG: 'hyd-0001' } });
  const run = await sync();
  assert.equal(run.unknown, 0);
  assert.equal(run.mismatches, 1);
  assert.equal(feature().attributes.ASSET_TAG, 'HYD-0001');
  assert.equal(audit.listActions({ only: ['gis.mismatch'] })[0].after.fields[0].field, 'ASSET_TAG');
});

test('network failure mid-push: the log names the stage and the asset, and the next run does not duplicate', async t => {
  let dropAnswer = false;
  const flaky = async (url, options) => {
    const res = await fetch(url, options);
    if (dropAnswer && String(url).includes('applyEdits')) {
      dropAnswer = false;
      throw new TypeError('connection lost after the layer saved the edit');
    }
    return res;
  };
  const { assets, sync, standin, audit, feature } = await setup(t, { client: { fetchImpl: flaky } });
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  dropAnswer = true;

  await assert.rejects(sync(), err => err.kind === 'unreachable' && err.stage === 'push' && err.auditRecorded === true);
  assert.equal(standin.features.size, 1, 'the layer saved it, but we never heard');
  const [failed] = audit.listActions({ only: ['gis.sync_failed'] });
  assert.equal(failed.after.stage, 'push');
  assert.equal(failed.after.kind, 'unreachable');
  assert.equal(failed.after.assetTag, 'HYD-0001');
  assert.equal(failed.after.assetId, asset.id);
  assert.match(failed.after.hint, /reachable/);
  assert.equal(assets.get(asset.id).gis.status, 'error');
  assert.equal(assets.get(asset.id).gis.lastError.kind, 'unreachable');

  const next = await sync();
  assert.equal(next.ok, true);
  assert.equal(standin.features.size, 1, 'no second feature');
  assert.equal(assets.get(asset.id).gis.status, 'synced');
  assert.equal(assets.get(asset.id).gis.objectId, feature().attributes.OBJECTID);
});

test('network failure during read-back: nothing is marked verified, and the next run still checks it', async t => {
  let failReads = false;
  const flaky = (url, options) => {
    if (failReads && String(url).endsWith('/query') && String(options.body).includes('OBJECTID+IN')) throw new TypeError('network down');
    return fetch(url, options);
  };
  const { assets, sync, audit } = await setup(t, { client: { fetchImpl: flaky } });
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  failReads = true;
  await assert.rejects(sync(), err => err.stage === 'verify');
  assert.equal(assets.get(asset.id).gis.verifiedAt, null);
  assert.equal(audit.listActions({ only: ['gis.sync_failed'] })[0].after.stage, 'verify');

  failReads = false;
  const next = await sync();
  assert.equal(next.pushed, 0);
  assert.equal(next.verified, 1);
  assert.ok(assets.get(asset.id).gis.verifiedAt);
});

test('two jobs cannot run at once, and a crashed job cannot block the sync forever', async t => {
  const { assets, sync, standin, db, audit } = await setup(t);
  assets.create({ actor: 'am-1', input: hydrant });

  const [a, b] = await Promise.allSettled([sync(), sync()]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.kind, 'already_running');
  assert.equal(standin.features.size, 1);
  assert.equal(audit.listActions({ only: ['gis.sync_failed'] })[0].after.kind, 'already_running');
  assert.equal((await sync()).ok, true, 'the lock is released afterwards');

  db.prepare("INSERT INTO sync_state (key, value) VALUES ('gis.sync.lock', ?)").run(JSON.stringify({ at: Date.now() }));
  await assert.rejects(sync(), err => err.kind === 'already_running');
  db.prepare("UPDATE sync_state SET value = ? WHERE key = 'gis.sync.lock'").run(JSON.stringify({ at: Date.now() - 31 * 60000 }));
  assert.equal((await sync()).ok, true, 'a lock left by a crash expires');
});

test('criterion 2: an unexpected error is logged with its details, not just thrown', async t => {
  const { sync, audit, client } = await setup(t);
  client.describeLayer = async () => { throw new RangeError('something nobody planned for'); };
  await assert.rejects(sync(), err => err.kind === 'internal' && err.auditRecorded === true);
  const [failed] = audit.listActions({ only: ['gis.sync_failed'] });
  assert.equal(failed.after.kind, 'internal');
  assert.equal(failed.after.stage, 'schema');
  assert.match(failed.after.message, /nobody planned/);
});

test('criterion 2: if the audit trail itself fails, the original error still reaches the caller, and says so', async t => {
  const { db, client } = await setup(t);
  const real = createAuditLog(db);
  const failing = { ...real, record() { throw new AuditWriteError('disk full'); } };
  client.describeLayer = async () => { throw new RangeError('the first problem'); };
  await assert.rejects(runGisSync({ db, audit: failing, client }), err => {
    assert.match(err.message, /the first problem/);
    assert.equal(err.auditRecorded, false);
    assert.match(err.auditError, /disk full/);
    return true;
  });
});

test('criterion 2: an analyst reviewing the log sees each error in plain words, through the API, by role', async t => {
  const { db, audit, assets, sync, standin, gisEdit } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ attributes: { NAME: 'Renamed in GIS' } });
  await sync();
  standin.setMode('auth');
  await assert.rejects(sync());

  const server = http.createServer(createApp({ db, audit, assets, tyler: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = `http://127.0.0.1:${server.address().port}`;
  const analyst = { 'x-user-id': 'gis-1', 'x-user-role': 'gis_analyst' };

  const errors = (await (await fetch(`${api}/api/gis/log?errors=1`, { headers: analyst })).json()).events;
  assert.deepEqual(errors.map(e => e.action), ['gis.sync_failed', 'gis.mismatch']);
  assert.match(errors[0].summary, /stopped at schema \(auth\)/);
  assert.match(errors[0].summary, /Next step: Check ARCGIS_USERNAME/);
  assert.match(errors[1].summary, /NAME system "Hydrant at Broadway & Main", GIS "Renamed in GIS"/);

  const all = (await (await fetch(`${api}/api/gis/log`, { headers: analyst })).json()).events;
  assert.ok(all.some(e => e.action === 'gis.sync_run'));
  assert.ok(all.every(e => e.summary));

  const status = await (await fetch(`${api}/api/gis/status`, { headers: analyst })).json();
  assert.equal(status.lastFailure.after.kind, 'auth');
  assert.ok(status.lastRun);
  assert.ok(status.lastReconcileAt);

  assert.equal((await fetch(`${api}/api/gis/log`, { headers: { 'x-user-id': 'am-1', 'x-user-role': 'asset_manager' } })).status, 403);
  assert.equal((await fetch(`${api}/api/gis/log`)).status, 401);
  assert.equal((await fetch(`${api}/api/gis/log?limit=9999`, { headers: analyst })).status, 400);
  assert.ok(asset.id);
});

test('gisStatus lists what needs attention now, and it clears once fixed', async t => {
  const { db, audit, assets, sync, post, client } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  assert.deepEqual(gisStatus(db, audit).attention, []);

  await post('/_delete', { asset_tag: 'HYD-0001' });
  await sync({ reconcile: true });
  const [item] = gisStatus(db, audit).attention;
  assert.equal(item.assetTag, 'HYD-0001');
  assert.equal(item.status, 'missing');
  assert.match(item.lastError.description, /no longer in the GIS layer/);
  assert.equal(item.assetId, asset.id);

  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'HYD-0001', NAME: hydrant.name, ASSET_TYPE: 'hydrant', STATUS: 'active', LOCATION_DESC: hydrant.location } }] });
  await sync();
  assert.deepEqual(gisStatus(db, audit).attention, []);
});

test('criterion 3: every kind of event has a readable line, and no secret ever reaches the log', async t => {
  const { audit, assets, sync, standin, gisEdit, client, post } = await setup(t);
  assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ attributes: { NAME: 'Renamed' }, geometry: { x: 0, y: 0 } });
  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'GHOST-1' } }, { attributes: { ASSET_TAG: 'HYD-0001' } }] });
  await sync();
  await post('/_delete', { asset_tag: 'GHOST-1' });
  standin.setMode('auth');
  await assert.rejects(sync());
  standin.setMode('ok');

  const events = readGisLog(audit, { limit: 500 });
  const kinds = new Set(events.map(e => e.action));
  for (const kind of ['gis.push', 'gis.mismatch', 'gis.spatial_problem', 'gis.sync_run', 'gis.sync_failed']) assert.ok(kinds.has(kind), kind);
  assert.ok(events.every(e => describeGisEvent(e).length > 0));

  const everything = JSON.stringify(events);
  assert.doesNotMatch(everything, new RegExp(STANDIN_PASSWORD));
  assert.doesNotMatch(everything, /SIMULATED-[0-9a-f]{8}-/, 'no token');
});

test('criterion 3: sync logs last: they survive a restart and cannot be edited or deleted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-gis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.db');
  const db = openDb(file);
  const { assets, sync } = await setup(t, { db });
  assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  db.close();

  const reopened = openDb(file);
  const audit = createAuditLog(reopened);
  const events = readGisLog(audit);
  assert.deepEqual(events.map(e => e.action), ['gis.sync_run', 'gis.push']);
  assert.throws(() => reopened.exec("UPDATE audit_event SET action = 'x' WHERE action = 'gis.push'"), /append-only/);
  assert.throws(() => reopened.exec("DELETE FROM audit_event WHERE action = 'gis.push'"), /append-only/);
  reopened.close();
});

test('an existing database from before STORY-005 gets the new columns and keeps its data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-gis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE asset_gis (asset_id TEXT PRIMARY KEY, object_id INTEGER, layer TEXT, attributes TEXT, geometry TEXT, gis_edited_at INTEGER, gis_edited_by TEXT, pushed_values TEXT, pushed_at TEXT, synced_at TEXT, status TEXT NOT NULL, mismatch TEXT, last_error TEXT)');
  old.exec("INSERT INTO asset_gis (asset_id, object_id, status) VALUES ('a1', 7, 'synced')");
  old.close();

  for (let i = 0; i < 2; i++) { // safe to open twice
    const db = openDb(file);
    const row = db.prepare('SELECT * FROM asset_gis').get();
    assert.equal(row.object_id, 7);
    assert.equal(row.spatial_problem, null);
    assert.equal(row.verified_at, null);
    db.close();
  }
});
