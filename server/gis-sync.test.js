// STORY-002 acceptance, end to end: the GIS Sync Job against the SIMULATED
// ArcGIS stand-in over real HTTP, with a real (in-memory) database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createArcGisStandin, LAYER_PATH, TOKEN_PATH, STANDIN_USER, STANDIN_PASSWORD } from '../tools/arcgis-standin/server.js';
import { createArcGisClient } from './integrations/arcgis/client.js';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createApp } from './app.js';
import { runGisSync } from './gis-sync.js';

const hydrant = { asset_tag: 'HYD-0001', name: 'Hydrant at Broadway & Main', asset_type: 'hydrant', location: 'Broadway & Main' };

async function setup(t, standinOptions = {}, clientOptions = {}) {
  const standin = createArcGisStandin(standinOptions);
  await new Promise(resolve => standin.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { standin.server.closeAllConnections(); return new Promise(resolve => standin.server.close(resolve)); });
  const base = `http://127.0.0.1:${standin.server.address().port}`;
  const client = createArcGisClient({
    layerUrl: base + LAYER_PATH, tokenUrl: base + TOKEN_PATH, username: STANDIN_USER, password: STANDIN_PASSWORD,
    timeoutMs: 300, retries: 1, retryDelayMs: 0, ...clientOptions,
  });
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  const assets = createAssetStore(db, audit);
  const sync = () => runGisSync({ db, audit, client });
  const gisEdit = async body => {
    const res = await fetch(`${base}/_edit`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const featureFor = tag => [...standin.features.values()].find(f => f.attributes.ASSET_TAG === tag);
  const actions = () => audit.list({ limit: 1000 }).map(e => e.action).reverse();
  return { standin, client, db, audit, assets, sync, gisEdit, featureFor, actions };
}

test('criterion 1: asset data updated in the system is reflected in the GIS layer', async t => {
  const { assets, sync, featureFor } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });

  const first = await sync();
  assert.equal(first.pushed, 1);
  assert.equal(featureFor('HYD-0001').attributes.NAME, hydrant.name);

  assets.update({ actor: 'am-1', id: asset.id, input: { status: 'maintenance', name: 'Hydrant (out of service)' } });
  const second = await sync();
  assert.equal(second.pushed, 1);
  const feature = featureFor('HYD-0001').attributes;
  assert.equal(feature.STATUS, 'maintenance');
  assert.equal(feature.NAME, 'Hydrant (out of service)');
  assert.equal(assets.get(asset.id).gis.status, 'synced');
});

test('criterion 2: a GIS field value changed in ArcGIS shows in the system', async t => {
  const { assets, sync, gisEdit, db, audit } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();

  await gisEdit({ asset_tag: 'HYD-0001', attributes: { MATERIAL: 'Ductile iron', DIAMETER_IN: 6 }, geometry: { x: -73.7846, y: 43.0831 } });
  const run = await sync();
  assert.equal(run.pulled, 1);

  const gis = assets.get(asset.id).gis;
  assert.equal(gis.fields.MATERIAL, 'Ductile iron');
  assert.equal(gis.fields.DIAMETER_IN, 6);
  assert.deepEqual(gis.geometry, { x: -73.7846, y: 43.0831 });
  assert.equal(gis.editedBy, 'gis.analyst');

  // ...and through the API, as a GIS analyst checking the system.
  const server = http.createServer(createApp({ db, audit, assets, tyler: {}, allowDevHeaders: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assets/${asset.id}`, { headers: { 'x-user-id': 'gis-1', 'x-user-role': 'gis_analyst' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).asset.gis.fields.MATERIAL, 'Ductile iron');
});

test('criterion 3: every GIS transaction is in the audit trail', async t => {
  const { assets, sync, gisEdit, actions, audit } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  await gisEdit({ asset_tag: 'HYD-0001', attributes: { MATERIAL: 'Cast iron' } });
  await sync();

  assert.deepEqual(actions(), ['asset.create', 'gis.push', 'gis.sync_run', 'gis.pull', 'gis.sync_run']);
  const [push] = audit.list({ entityType: 'asset', entityId: asset.id }).filter(e => e.action === 'gis.push');
  assert.equal(push.actor, 'gis-sync-job');
  assert.equal(push.after.operation, 'add');
  assert.ok(Number.isInteger(push.after.objectId));
  const pull = audit.list({ entityType: 'asset', entityId: asset.id }).find(e => e.action === 'gis.pull');
  assert.equal(pull.after.fields.MATERIAL, 'Cast iron');
  assert.equal(pull.after.editedBy, 'gis.analyst');
});

test('our own edits coming back from GIS are not logged as pulls', async t => {
  const { assets, sync, actions } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();
  assets.update({ actor: 'am-1', id: asset.id, input: { status: 'maintenance' } });
  await sync();
  await sync();
  assert.deepEqual(actions(), ['asset.create', 'gis.push', 'gis.sync_run', 'asset.update', 'gis.push', 'gis.sync_run', 'gis.sync_run']);
});

test('data mismatch: a GIS edit to a field the system owns is flagged, audited, and our value is pushed back', async t => {
  const { assets, sync, gisEdit, featureFor, audit } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await sync();

  await gisEdit({ asset_tag: 'HYD-0001', attributes: { NAME: 'Renamed in GIS' } });
  const run = await sync();
  assert.equal(run.mismatches, 1);
  assert.equal(run.pushed, 1);
  assert.equal(featureFor('HYD-0001').attributes.NAME, hydrant.name, 'our value wins');

  const events = audit.list({ entityType: 'asset', entityId: asset.id });
  const mismatch = events.find(e => e.action === 'gis.mismatch');
  assert.deepEqual(mismatch.after.fields, [{ field: 'NAME', system: hydrant.name, gis: 'Renamed in GIS' }]);
  const push = events.find(e => e.action === 'gis.push');
  assert.deepEqual(push.after.overwrote, mismatch.after.fields);

  const quiet = await sync();
  assert.equal(quiet.mismatches, 0, 'our own push coming back is not a mismatch');
  assert.equal(assets.get(asset.id).gis.status, 'synced');
});

test('data mismatch: a GIS feature whose tag matches no asset is reported once', async t => {
  const { client, sync, audit } = await setup(t);
  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'GHOST-1', NAME: 'Not in our system' } }] });
  assert.equal((await sync()).unknown, 1);
  assert.equal((await sync()).unknown, 0);
  const [event] = audit.list({ entityType: 'gis_feature' });
  assert.equal(event.after.kind, 'unknown_asset');
  assert.equal(event.after.assetTag, 'GHOST-1');
});

test('idempotent: syncing again with nothing changed writes nothing and never duplicates a feature', async t => {
  const { assets, sync, standin, client } = await setup(t);
  assets.create({ actor: 'am-1', input: hydrant });
  // The feature already exists in GIS, as if an earlier add saved but its answer was lost.
  await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'HYD-0001', NAME: hydrant.name, ASSET_TYPE: 'hydrant', STATUS: 'active', LOCATION_DESC: 'Broadway & Main' } }] });

  await sync();
  await sync();
  const again = await sync();
  assert.equal(again.pushed, 0);
  assert.equal(again.pulled, 0);
  assert.equal(standin.features.size, 1);
});

test('pulls page by page when the layer limits how many features one answer holds', async t => {
  const { assets, sync, gisEdit } = await setup(t, { maxRecordCount: 2 });
  for (let i = 1; i <= 5; i++) assets.create({ actor: 'am-1', input: { ...hydrant, asset_tag: `HYD-000${i}` } });
  await sync();
  for (let i = 1; i <= 5; i++) await gisEdit({ asset_tag: `HYD-000${i}`, attributes: { INSTALL_YEAR: 2000 + i } });
  const run = await sync();
  assert.equal(run.pulled, 5);
  assert.deepEqual(assets.list().map(a => a.gis.fields.INSTALL_YEAR).sort(), [2001, 2002, 2003, 2004, 2005]);
});

test('authentication failure: the run stops, nothing changes, and the failure is audited', async t => {
  const { assets, sync, standin, audit } = await setup(t, { mode: 'auth' });
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  await assert.rejects(sync(), err => err.kind === 'auth');
  assert.equal(standin.features.size, 0);
  assert.equal(assets.get(asset.id).gis, null);
  const [failed] = audit.list({ entityType: 'gis_sync' });
  assert.equal(failed.action, 'gis.sync_failed');
  assert.equal(failed.after.kind, 'auth');
});

test('network latency: a layer that stops answering times out, and the next run catches up', async t => {
  const { assets, sync, standin, audit, featureFor } = await setup(t);
  assets.create({ actor: 'am-1', input: hydrant });
  standin.setMode('slow');
  await assert.rejects(sync(), err => err.kind === 'timeout');
  assert.equal(audit.list({ entityType: 'gis_sync' })[0].after.kind, 'timeout');

  standin.server.closeAllConnections();
  standin.setMode('ok');
  assert.equal((await sync()).pushed, 1);
  assert.ok(featureFor('HYD-0001'));
});

test('the layer is missing a field the system owns: the run refuses to start', async t => {
  const { assets, sync, standin } = await setup(t, { mode: 'schema' });
  assets.create({ actor: 'am-1', input: hydrant });
  await assert.rejects(sync(), err => err.kind === 'schema_mismatch' && /STATUS/.test(err.message));
  assert.equal(standin.features.size, 0);
});

test('a single rejected edit is recorded on that asset and does not stop the others', async t => {
  const { assets, sync, standin, audit } = await setup(t);
  const { asset } = assets.create({ actor: 'am-1', input: hydrant });
  assets.create({ actor: 'am-1', input: { ...hydrant, asset_tag: 'HYD-0002' } });
  await sync();

  standin.features.delete(assets.get(asset.id).gis.objectId); // deleted in GIS behind our back
  assets.update({ actor: 'am-1', id: asset.id, input: { status: 'retired' } });
  const other = assets.list().find(a => a.assetTag === 'HYD-0002');
  assets.update({ actor: 'am-1', id: other.id, input: { status: 'maintenance' } });

  const run = await sync();
  assert.equal(run.ok, false);
  assert.equal(run.pushFailed, 1);
  assert.equal(run.pushed, 1);
  const gis = assets.get(asset.id).gis;
  assert.equal(gis.status, 'missing');
  assert.match(gis.lastError.description, /missing/i);
  assert.equal(audit.list({ entityType: 'asset', entityId: asset.id })[0].action, 'gis.push_failed');
});
