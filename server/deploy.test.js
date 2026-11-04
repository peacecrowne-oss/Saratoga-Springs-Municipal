// STORY-001 acceptance, end to end: deploy the system for real (a real port,
// a real database file), then use it over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { deploy, DeployError } from './deploy.js';

const fast = { port: 0, actor: 'it-admin-1', checkRetries: 2, retryDelayMs: 0, sleep: async () => {}, allowDevHeaders: true };
const admin = { 'x-user-id': 'it-admin-1', 'x-user-role': 'it_administrator' };

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'app.db');
}

// Stops the deployment inside the test, so its database file is closed
// before the after-hook removes the folder (Windows will not delete an open file).
async function withDeployment(options, fn) {
  const deployed = await deploy({ ...fast, ...options });
  try {
    return await fn(deployed);
  } finally {
    await deployed.stop();
  }
}

function auditOf(dbPath) {
  const db = openDb(dbPath);
  const events = createAuditLog(db).list({ entityType: 'system' });
  db.close();
  return events;
}

test('deploying brings the system up with its core functions and audits the deployment', async t => {
  const dbPath = tempDb(t);
  await withDeployment({ dbPath }, async deployed => {
    // Criterion 1: operational with core functionalities.
    const health = await (await fetch(`${deployed.url}/api/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '0.1.0');

    // Criterion 3: the deployment is on the record, with its details.
    const { event } = deployed;
    assert.equal(event.action, 'system.deploy');
    assert.equal(event.actor, 'it-admin-1');
    assert.equal(event.after.version, '0.1.0');
    assert.equal(event.after.database, dbPath);
    assert.equal(event.after.url, deployed.url);
    assert.deepEqual(event.after.checks.map(c => [c.name, c.ok]), [['database', true], ['listen', true], ['health', true], ['assets', true]]);
    assert.ok('commit' in event.after);
    const [stored] = createAuditLog(deployed.db).list({ entityType: 'system' });
    assert.equal(stored.id, event.id);
  });
});

test('once deployed, a core function works: an asset can be created, read back and is audited', async t => {
  await withDeployment({ dbPath: tempDb(t) }, async deployed => {
    const post = body => fetch(`${deployed.url}/api/assets`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const created = await post({ asset_tag: 'HYD-0001', name: 'Hydrant at Broadway & Main', asset_type: 'hydrant' });
    assert.equal(created.status, 201);
    const { asset } = await created.json();

    const read = await fetch(`${deployed.url}/api/assets/${asset.id}`, { headers: admin });
    assert.equal(read.status, 200);
    const shown = (await read.json()).asset;
    assert.equal(shown.id, asset.id);
    assert.equal(shown.assetTag, 'HYD-0001');
    assert.equal(shown.gis, null);

    const repeat = await post({ asset_tag: 'HYD-0001', name: 'Hydrant at Broadway & Main', asset_type: 'hydrant' });
    assert.equal(repeat.status, 200, 'a repeated create is not a second asset');

    const invalid = await post({ asset_tag: 'HYD-0002' });
    assert.equal(invalid.status, 400);

    const refused = await fetch(`${deployed.url}/api/assets`, { headers: { 'x-user-id': 'c-1', 'x-user-role': 'citizen' } });
    assert.equal(refused.status, 403);

    const events = await (await fetch(`${deployed.url}/api/audit?entity_type=asset`, { headers: admin })).json();
    assert.deepEqual(events.events.map(e => [e.action, e.entityId]), [['asset.create', asset.id]]);
  });
});

test('network failure: the port is taken, so the deployment fails, is audited as failed, and nothing is left running', async t => {
  const dbPath = tempDb(t);
  const squatter = http.createServer();
  await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => squatter.close(resolve)));

  await assert.rejects(deploy({ ...fast, dbPath, port: squatter.address().port }), err => {
    assert.ok(err instanceof DeployError);
    assert.equal(err.kind, 'network');
    assert.match(err.message, /EADDRINUSE/);
    assert.equal(err.details.auditRecorded, true);
    return true;
  });
  const [failed] = auditOf(dbPath);
  assert.equal(failed.action, 'system.deploy_failed');
  assert.equal(failed.after.kind, 'network');
});

test('network failure: the health check never answers, so it is retried a capped number of times and the deployment fails', async t => {
  const dbPath = tempDb(t);
  let calls = 0;
  const unreachable = async () => { calls++; throw new TypeError('fetch failed'); };

  await assert.rejects(deploy({ ...fast, dbPath, fetchImpl: unreachable }), err => {
    assert.equal(err.kind, 'unreachable');
    assert.match(err.message, /after 3 attempts/);
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(auditOf(dbPath)[0].after.kind, 'unreachable');
});

test('core functionality does not initialize: the database cannot be opened, so nothing starts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(deploy({ ...fast, dbPath: dir }), err => {
    assert.equal(err.kind, 'core_init_failed');
    assert.equal(err.details.auditRecorded, false);
    assert.match(err.message, /no audit entry could be written/);
    return true;
  });
});

test('audit entry is not created: the deployment is stopped and reported as failed', async t => {
  const failingAudit = () => ({ record() { throw new AuditWriteError('disk full'); }, list: () => [] });
  let url;
  const realFetch = fetch;
  const spyFetch = (u, o) => { url = new URL(u).origin; return realFetch(u, o); };

  await assert.rejects(deploy({ ...fast, dbPath: tempDb(t), makeAudit: failingAudit, fetchImpl: spyFetch }), err => {
    assert.equal(err.kind, 'audit_failed');
    assert.match(err.message, /does not count/);
    return true;
  });
  await assert.rejects(fetch(`${url}/api/health`), 'the server was stopped');
});
