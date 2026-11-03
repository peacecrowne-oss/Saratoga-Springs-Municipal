// STORY-004 acceptance, end to end over HTTP against a real (in-memory) database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createAssetCare } from './asset-care.js';
import { createApp } from './app.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const clock = () => NOW;
const manager = { 'x-user-id': 'am-1', 'x-user-role': 'asset_manager' };
const hydrant = { asset_tag: 'HYD-0001', name: 'Hydrant at Broadway', asset_type: 'hydrant', location: 'Broadway' };

async function setup(t, { makeAudit = createAuditLog } = {}) {
  const db = openDb(':memory:');
  const audit = makeAudit(db, { now: clock });
  const assets = createAssetStore(db, audit, { now: clock });
  const care = createAssetCare(db, audit, assets, { now: clock });
  const server = http.createServer(createApp({ db, audit, assets, care, tyler: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = manager) => {
    const res = await fetch(base + path, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const add = async (input = hydrant) => (await call('POST', '/api/assets', input)).body.asset;
  const trail = id => audit.list({ entityType: 'asset', entityId: id }).map(e => e.action).reverse();
  return { db, audit, assets, care, call, add, trail, baseUrl: base };
}

test('criterion 1: an asset added to the system shows its lifecycle status and where it can go next', async t => {
  const { call, add } = await setup(t);
  const { id } = await add();
  const { status, body } = await call('GET', `/api/assets/${id}`);
  assert.equal(status, 200);
  assert.equal(body.asset.status, 'active');
  assert.deepEqual(body.asset.nextStatuses, ['maintenance', 'retired']);
  assert.equal(body.asset.condition, null);
});

test('criterion 2: a changed condition is reflected, and the same update can move the status', async t => {
  const { call, add } = await setup(t);
  const { id } = await add();

  const first = await call('POST', `/api/assets/${id}/conditions`, { condition: 'fair', observed_at: '2026-11-01T09:00:00Z' });
  assert.equal(first.status, 201);
  assert.equal((await call('GET', `/api/assets/${id}`)).body.asset.condition.condition, 'fair');

  const second = await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z', status: 'maintenance', notes: 'Leaking at the base' });
  assert.equal(second.status, 201);
  const { asset } = (await call('GET', `/api/assets/${id}`)).body;
  assert.equal(asset.condition.condition, 'poor');
  assert.equal(asset.condition.notes, 'Leaking at the base');
  assert.equal(asset.status, 'maintenance');
  assert.equal(asset.conditionHistory.length, 2);
});

test('criterion 3: every asset update is in its audit trail, with who did it', async t => {
  const { call, add, trail, audit } = await setup(t);
  const { id } = await add();
  await call('PATCH', `/api/assets/${id}`, { name: 'Hydrant, Broadway' });
  await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z', status: 'maintenance' });
  const { body } = await call('POST', `/api/assets/${id}/maintenance`, { title: 'Replace seal', due_on: '2026-12-01' });
  await call('PATCH', `/api/assets/${id}/maintenance/${body.task.id}`, { status: 'completed' });

  assert.deepEqual(trail(id), ['asset.create', 'asset.update', 'asset.condition_recorded', 'asset.update', 'maintenance.schedule', 'maintenance.complete']);
  assert.ok(audit.list({ entityType: 'asset', entityId: id }).every(e => e.actor === 'am-1'));

  const history = await call('GET', `/api/assets/${id}/history`);
  assert.equal(history.body.events.length, 6);
});

test('data entry errors: every wrong field is named, and nothing is stored', async t => {
  const { call, add, assets } = await setup(t);
  const bad = await call('POST', '/api/assets', { asset_tag: 'bad tag!', status: 'lost' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.problems.map(p => p.field).sort(), ['asset_tag', 'asset_type', 'name', 'status']);
  assert.equal(assets.list().length, 0);

  const { id } = await add();
  const reading = await call('POST', `/api/assets/${id}/conditions`, { condition: 'wobbly', observed_at: 'yesterday' });
  assert.deepEqual(reading.body.error.problems.map(p => p.field), ['condition', 'observed_at']);
  const future = await call('POST', `/api/assets/${id}/conditions`, { condition: 'good', observed_at: '2027-01-01T00:00:00Z' });
  assert.match(future.body.error.message, /future/);
  const task = await call('POST', `/api/assets/${id}/maintenance`, { title: ' ', due_on: '2026-02-31' });
  assert.deepEqual(task.body.error.problems.map(p => p.field), ['title', 'due_on']);
  const past = await call('POST', `/api/assets/${id}/maintenance`, { title: 'Flush', due_on: '2026-01-01' });
  assert.match(past.body.error.message, /past/);
});

test('data entry errors: a tag differing only by case is the same asset, not a second one', async t => {
  const { call, add, assets } = await setup(t);
  await add();
  const repeat = await call('POST', '/api/assets', { ...hydrant, asset_tag: 'hyd-0001' });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.created, false);
  const different = await call('POST', '/api/assets', { ...hydrant, asset_tag: 'hyd-0001', name: 'Another' });
  assert.equal(different.status, 409);
  assert.equal(assets.list().length, 1);
});

test('lifecycle failure: an illegal move is refused, names the legal moves, changes nothing and is audited', async t => {
  const { call, add, trail } = await setup(t);
  const { id } = await add();
  await call('PATCH', `/api/assets/${id}`, { status: 'retired' });

  const { status, body } = await call('PATCH', `/api/assets/${id}`, { status: 'active' });
  assert.equal(status, 409);
  assert.equal(body.error.kind, 'illegal_transition');
  assert.match(body.error.message, /retired is final/);
  assert.equal((await call('GET', `/api/assets/${id}`)).body.asset.status, 'retired');
  assert.deepEqual(trail(id), ['asset.create', 'asset.update', 'asset.update_rejected']);
});

test('lifecycle failure: a refused status move takes its condition reading with it', async t => {
  const { call, add, trail } = await setup(t);
  const { id } = await add({ ...hydrant, status: 'planned' });
  const { status, body } = await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z', status: 'maintenance' });
  assert.equal(status, 409);
  assert.equal(body.error.kind, 'illegal_transition');
  assert.equal((await call('GET', `/api/assets/${id}`)).body.asset.condition, null);
  assert.deepEqual(trail(id), ['asset.create', 'asset.update_rejected']);
});

test('lifecycle failure: an edit based on an out-of-date copy is refused, so nobody overwrites a colleague', async t => {
  const { call, add, trail } = await setup(t);
  const asset = await add();
  await call('PATCH', `/api/assets/${asset.id}`, { name: 'First edit', expected_updated_at: asset.updatedAt });
  const stale = await call('PATCH', `/api/assets/${asset.id}`, { name: 'Second edit', expected_updated_at: asset.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.kind, 'stale');
  assert.equal((await call('GET', `/api/assets/${asset.id}`)).body.asset.name, 'First edit');
  assert.equal(trail(asset.id).at(-1), 'asset.update_rejected');
});

test('lifecycle failure: if the audit write fails, neither the reading nor the status change is kept', async t => {
  let failing = false;
  const flaky = (db, options) => {
    const real = createAuditLog(db, options);
    return { ...real, record(event) { if (failing) throw new AuditWriteError('disk full'); return real.record(event); } };
  };
  const { call, add } = await setup(t, { makeAudit: flaky });
  const { id } = await add();
  failing = true;
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const { status, body } = await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z', status: 'maintenance' });
  assert.equal(status, 500);
  assert.equal(body.error.kind, 'audit_unavailable');
  failing = false;
  const { asset } = (await call('GET', `/api/assets/${id}`)).body;
  assert.equal(asset.condition, null);
  assert.equal(asset.status, 'active');
});

test('condition discrepancy: critical while still active is flagged and audited, and the status is left for a person', async t => {
  const { call, add, audit } = await setup(t);
  const { id } = await add();
  const { body } = await call('POST', `/api/assets/${id}/conditions`, { condition: 'critical', observed_at: '2026-11-02T09:00:00Z' });
  assert.deepEqual(body.raised.map(d => d.kind), ['critical_but_active']);
  assert.equal(body.asset.status, 'active');
  assert.equal(audit.list({ entityType: 'asset', entityId: id })[0].action, 'asset.condition_discrepancy');

  const cleared = await call('PATCH', `/api/assets/${id}`, { status: 'maintenance' });
  assert.deepEqual(cleared.body.asset.discrepancies, []);
});

test('condition discrepancy: a late older reading is kept and flagged, but does not replace the newer one', async t => {
  const { call, add } = await setup(t);
  const { id } = await add();
  await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z' });
  const late = await call('POST', `/api/assets/${id}/conditions`, { condition: 'good', observed_at: '2026-10-01T09:00:00Z' });
  assert.equal(late.status, 201);
  assert.equal(late.body.outOfOrder, true);
  assert.deepEqual(late.body.raised.map(d => d.kind), ['older_than_current']);
  const { asset } = (await call('GET', `/api/assets/${id}`)).body;
  assert.equal(asset.condition.condition, 'poor');
  assert.equal(asset.conditionHistory.length, 2);
});

test('condition discrepancy: two different readings for the same moment are refused; the same one twice is a no-op', async t => {
  const { call, add, trail } = await setup(t);
  const { id } = await add();
  const reading = { condition: 'fair', observed_at: '2026-11-02T09:00:00Z' };
  await call('POST', `/api/assets/${id}/conditions`, reading);
  const repeat = await call('POST', `/api/assets/${id}/conditions`, reading);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.recorded, false);
  const clash = await call('POST', `/api/assets/${id}/conditions`, { ...reading, condition: 'poor' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.kind, 'condition_conflict');
  assert.deepEqual(trail(id), ['asset.create', 'asset.condition_recorded', 'asset.update_rejected']);
});

test('a retired asset takes no new readings or maintenance, and retiring one with work scheduled is flagged', async t => {
  const { call, add } = await setup(t);
  const { id } = await add();
  await call('POST', `/api/assets/${id}/maintenance`, { title: 'Flush', due_on: '2026-12-01' });
  const retired = await call('PATCH', `/api/assets/${id}`, { status: 'retired' });
  assert.deepEqual(retired.body.asset.discrepancies.map(d => d.kind), ['retired_with_open_maintenance']);
  const reading = await call('POST', `/api/assets/${id}/conditions`, { condition: 'good', observed_at: '2026-11-02T09:00:00Z' });
  assert.equal(reading.body.error.kind, 'asset_retired');
  const task = await call('POST', `/api/assets/${id}/maintenance`, { title: 'Paint', due_on: '2026-12-02' });
  assert.equal(task.body.error.kind, 'asset_retired');
});

test('maintenance: scheduling twice makes one task, due and overdue are worked out, and a closed task stays closed', async t => {
  const { call, add, db } = await setup(t);
  const { id } = await add();
  const task = { title: 'Flush', due_on: '2026-12-01' };
  const first = await call('POST', `/api/assets/${id}/maintenance`, task);
  assert.equal(first.status, 201);
  assert.equal((await call('POST', `/api/assets/${id}/maintenance`, task)).status, 200);

  let { asset } = (await call('GET', `/api/assets/${id}`)).body;
  assert.equal(asset.maintenance.length, 1);
  assert.equal(asset.nextMaintenance.dueOn, '2026-12-01');
  assert.equal(asset.overdueMaintenance, 0);

  db.exec("UPDATE maintenance_task SET due_on = '2026-10-01'");
  ({ asset } = (await call('GET', `/api/assets/${id}`)).body);
  assert.equal(asset.overdueMaintenance, 1);
  const open = await call('GET', '/api/maintenance');
  assert.equal(open.body.tasks[0].assetTag, 'HYD-0001');
  assert.equal(open.body.tasks[0].overdue, true);

  const path = `/api/assets/${id}/maintenance/${first.body.task.id}`;
  assert.equal((await call('PATCH', path, { status: 'completed' })).body.updated, true);
  assert.equal((await call('PATCH', path, { status: 'completed' })).body.updated, false);
  const reopen = await call('PATCH', path, { status: 'cancelled' });
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error.kind, 'task_closed');
});

test('the inventory filters, searches and pages, and rejects a bad filter', async t => {
  const { call, add } = await setup(t);
  const one = await add();
  await add({ ...hydrant, asset_tag: 'HYD-0002', name: 'Hydrant at 100% Main', location: 'Main St' });
  await add({ asset_tag: 'VLV-0001', name: 'Valve', asset_type: 'valve', status: 'planned' });
  await call('POST', `/api/assets/${one.id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z' });

  const tags = async query => (await call('GET', `/api/assets?${query}`)).body.assets.map(a => a.assetTag);
  assert.deepEqual(await tags(''), ['HYD-0001', 'HYD-0002', 'VLV-0001']);
  assert.deepEqual(await tags('status=planned'), ['VLV-0001']);
  assert.deepEqual(await tags('asset_type=HYDRANT'), ['HYD-0001', 'HYD-0002']);
  assert.deepEqual(await tags('condition=poor'), ['HYD-0001']);
  assert.deepEqual(await tags('q=broadway'), ['HYD-0001']);
  assert.deepEqual(await tags('q=100%25'), ['HYD-0002'], 'a percent sign is searched for, not a wildcard');

  const page = (await call('GET', '/api/assets?limit=2&offset=2')).body;
  assert.equal(page.total, 3);
  assert.deepEqual(page.assets.map(a => a.assetTag), ['VLV-0001']);
  assert.equal((await call('GET', '/api/assets?status=lost')).status, 400);
  assert.equal((await call('GET', '/api/assets?limit=5000')).status, 400);
});

test('roles: a GIS analyst can read but not change, and the refused change is audited', async t => {
  const { call, add, trail } = await setup(t);
  const { id } = await add();
  const analyst = { 'x-user-id': 'gis-1', 'x-user-role': 'gis_analyst' };
  assert.equal((await call('GET', `/api/assets/${id}`, undefined, analyst)).status, 200);
  const refused = await call('POST', `/api/assets/${id}/conditions`, { condition: 'poor', observed_at: '2026-11-02T09:00:00Z' }, analyst);
  assert.equal(refused.status, 403);
  assert.deepEqual(trail(id), ['asset.create', 'asset.update_denied']);
  assert.equal((await call('GET', `/api/assets/${id}`, undefined, { 'x-user-id': 'c-1', 'x-user-role': 'citizen' })).status, 403);
  assert.equal((await call('GET', `/api/assets/${id}`, undefined, {})).status, 401);
});

test('condition readings cannot be rewritten at the database level', async t => {
  const { db, call, add } = await setup(t);
  const { id } = await add();
  await call('POST', `/api/assets/${id}/conditions`, { condition: 'good', observed_at: '2026-11-02T09:00:00Z' });
  assert.throws(() => db.exec("UPDATE asset_condition SET condition = 'poor'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM asset_condition'), /append-only/);
});

test('serves the Asset Management Dashboard, and an unknown route or bad address is refused plainly', async t => {
  const { call, add, baseUrl } = await setup(t);
  const { id } = await add();
  assert.equal((await call('GET', `/api/assets/${id}/nope`)).status, 404);
  assert.equal((await call('GET', '/api/assets/%E0%A4%A')).status, 400);
  const page = await fetch(`${baseUrl}/assets`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Asset management/);
  const script = await fetch(`${baseUrl}/assets.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});
