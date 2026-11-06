// STORY-010 acceptance, end to end: our API over HTTP, the real Caselle client,
// and the SIMULATED Caselle stand-in over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { CaselleIntegrationError, createCaselleClient, validateAccount } from './integrations/caselle/client.js';
import { createApp } from './app.js';
import { ACCOUNTS, createStandin, DEFAULT_KEY } from '../tools/caselle-standin/server.js';

const run = promisify(execFile);
const NOW = new Date('2026-11-05T15:00:00.000Z');
const billingManager = { 'x-user-id': 'bm-1', 'x-user-role': 'billing_manager' };
const assetManager = { 'x-user-id': 'am-1', 'x-user-role': 'asset_manager' };

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

async function setup(t, { mode = 'ok', apiKey = DEFAULT_KEY, baseUrl, makeAudit = createAuditLog, timeoutMs = 2000 } = {}) {
  const standin = createStandin({ mode, now: () => NOW.getTime() });
  const standinUrl = await listen(standin.server);
  t.after(() => close(standin.server));

  const db = openDb(':memory:');
  const audit = makeAudit(db);
  const caselle = createCaselleClient({ baseUrl: baseUrl === undefined ? standinUrl : baseUrl, apiKey, timeoutMs, retryDelayMs: 1 });
  const server = http.createServer(createApp({ db, audit, assets: createAssetStore(db, audit), caselle, tyler: {}, allowDevHeaders: true }));
  const base = await listen(server);
  t.after(() => close(server));

  const get = async (account, headers = billingManager) => {
    const res = await fetch(`${base}/api/billing/accounts/${encodeURIComponent(account)}`, { headers });
    return { status: res.status, body: await res.json() };
  };
  const events = () => audit.list({ entityType: 'billing' }).reverse();
  return { db, audit, standin, standinUrl, get, events };
}

test('criterion 1: with Caselle connected, a billing request returns the account exactly as Caselle holds it', async t => {
  const { get } = await setup(t);
  const { status, body } = await get('SIM-1001');
  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.simulated, true);
  assert.equal(body.asOf, NOW.toISOString());

  const source = ACCOUNTS['SIM-1001'];
  assert.equal(body.account.accountNumber, 'SIM-1001');
  assert.equal(body.account.customerName, source.customer_name);
  assert.equal(body.account.status, 'active');
  assert.equal(body.account.balanceCents, 9120 + 3875);
  assert.deepEqual(body.account.bills.map(b => [b.billId, b.amountCents, b.amountDueCents, b.status]),
    source.bills.map(b => [b.bill_id, b.amount_cents, b.amount_due_cents, b.status]));
});

test('criterion 2: with Caselle not connected, the request says it is a connection problem', async t => {
  for (const [label, options] of [
    ['not configured', { baseUrl: null }],
    ['down', { mode: 'down' }],
    ['unreachable', { baseUrl: 'http://127.0.0.1:9' }],
  ]) {
    const { get } = await setup(t, options);
    const { status, body } = await get('SIM-1001');
    assert.equal(status, 502, label);
    assert.equal(body.connected, false, label);
    assert.match(body.error.message, /^Cannot connect to Caselle/, label);
  }
});

test('criterion 3: every billing transaction is logged with the user and the time', async t => {
  const { get, events } = await setup(t);
  await get('SIM-1001');
  await get('NOPE-1');
  await get('SIM-1001', assetManager);
  await get('SIM-1001', {});

  const logged = events();
  assert.deepEqual(logged.map(e => e.action), ['billing.lookup', 'billing.lookup_failed', 'billing.view_denied', 'billing.unauthenticated']);
  assert.deepEqual(logged.map(e => e.actor), ['bm-1', 'bm-1', 'am-1', 'anonymous']);
  for (const e of logged) assert.ok(!isNaN(Date.parse(e.occurredAt)), 'each has a timestamp');
  assert.equal(logged[0].entityId, 'SIM-1001');
  assert.equal(logged[0].after.balanceCents, 12995);
  assert.ok(!JSON.stringify(logged).includes('SIMULATED Customer One'), 'the customer name stays out of the audit trail');
});

test('a billing request whose audit record cannot be written is not answered with data', async t => {
  const makeAudit = db => {
    const real = createAuditLog(db);
    return { ...real, record: e => { if (e.action === 'billing.lookup') throw new AuditWriteError('disk full'); return real.record(e); } };
  };
  const { get } = await setup(t, { makeAudit });
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const { status, body } = await get('SIM-1001');
  assert.equal(status, 500);
  assert.equal(body.account, undefined);
});

test('incorrect credentials: refused once, not retried, and named as a credentials problem', async t => {
  const { get, standin, events } = await setup(t, { apiKey: 'wrong-key' });
  const { status, body } = await get('SIM-1001');
  assert.equal(status, 502);
  assert.equal(body.error.kind, 'refused');
  assert.match(body.error.message, /credentials/);
  assert.equal(standin.state.requests, 1, 'a refusal is not retried');
  assert.equal(events()[0].after.kind, 'refused');
});

test('Caselle down: retried a capped number of times, then reported', async t => {
  const { get, standin } = await setup(t, { mode: 'down' });
  const { body } = await get('SIM-1001');
  assert.equal(body.error.kind, 'unreachable');
  assert.equal(standin.state.requests, 3, 'one try and two retries');
});

test('network timeout: a Caselle that never answers is given up on', async t => {
  const { get } = await setup(t, { mode: 'slow', timeoutMs: 50 });
  const started = Date.now();
  const { status, body } = await get('SIM-1001');
  assert.equal(status, 502);
  assert.equal(body.error.kind, 'timeout');
  assert.ok(Date.now() - started < 3000);
});

test('data format mismatch: malformed or inconsistent billing data is refused, not shown', async t => {
  for (const mode of ['bad', 'mismatch']) {
    const { get } = await setup(t, { mode });
    const { status, body } = await get('SIM-1001');
    assert.equal(status, 502, mode);
    assert.equal(body.connected, true, `${mode}: Caselle answered`);
    assert.equal(body.error.kind, 'bad_data', mode);
    assert.equal(body.account, undefined, mode);
  }
  const { get } = await setup(t, { mode: 'mismatch' });
  assert.match((await get('SIM-1001')).body.error.message, /open bills owe/);
});

test('data format mismatch: each kind of wrong field is caught on its own', () => {
  const good = () => ({
    as_of: NOW.toISOString(),
    account: {
      account_number: 'SIM-1001', customer_name: 'X', status: 'active', balance_cents: 500,
      bills: [{ bill_id: 'B1', bill_date: '2026-10-01', due_date: '2026-10-25', amount_cents: 500, amount_due_cents: 500, status: 'open' }],
    },
  });
  assert.equal(validateAccount(good(), 'SIM-1001').account.balanceCents, 500);
  const broken = [
    ['dollars instead of cents', b => { Object.assign(b.account.bills[0], { amount_cents: 5.25, amount_due_cents: 0, status: 'paid' }); b.account.balance_cents = 0; }],
    ['amount as text', b => { Object.assign(b.account.bills[0], { amount_cents: '5.00', amount_due_cents: 0, status: 'paid' }); b.account.balance_cents = 0; }],
    ['another account', b => { b.account.account_number = 'SIM-1002'; }],
    ['unknown status', b => { b.account.status = 'frozen'; }],
    ['more due than billed', b => { b.account.bills[0].amount_due_cents = 600; b.account.balance_cents = 600; }],
    ['no bills', b => { delete b.account.bills; }],
  ];
  for (const [label, breakIt] of broken) {
    const body = good();
    breakIt(body);
    assert.throws(() => validateAccount(body, 'SIM-1001'), err => err instanceof CaselleIntegrationError && err.kind === 'bad_data', label);
  }
});

test('unauthorized access: other roles and strangers are refused and recorded; bad input too', async t => {
  const { get, standin, events } = await setup(t);
  assert.equal((await get('SIM-1001', assetManager)).status, 403);
  assert.equal((await get('SIM-1001', { 'x-user-id': 'admin', 'x-user-role': 'it_administrator' })).status, 403);
  assert.equal((await get('SIM-1001', {})).status, 401);
  assert.equal((await get('../../etc')).status, 400);
  assert.equal((await get('bad number!')).status, 400);
  assert.equal(standin.state.requests, 0, 'none of these reached Caselle');
  assert.deepEqual(events().map(e => e.action), ['billing.view_denied', 'billing.view_denied', 'billing.unauthenticated', 'billing.lookup_refused', 'billing.lookup_refused']);
  const notFound = await get('SIM-9999');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.connected, true);
});

test('the headless Caselle job retrieves an account, logs it, and fails loudly when disconnected', async t => {
  const { standinUrl } = await setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caselle-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'app.db');
  const job = (env, account = 'SIM-1001') => run(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/caselle-main.js', 'account', account], {
    env: { ...process.env, DB_PATH: dbPath, CASELLE_API_KEY: DEFAULT_KEY, ...env }, timeout: 30000,
  }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

  const ok = await job({ CASELLE_BASE_URL: standinUrl });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /SIM-1001 · active · balance \$129\.95/);
  assert.match(ok.stdout, /SIMULATED/);

  const off = await job({ CASELLE_BASE_URL: '' });
  assert.equal(off.code, 1);
  assert.match(off.stderr, /Cannot connect to Caselle/);

  const db = openDb(dbPath);
  const logged = createAuditLog(db).list({ entityType: 'billing' }).reverse();
  db.close();
  assert.deepEqual(logged.map(e => e.action), ['billing.lookup', 'billing.lookup_failed']);
  assert.ok(logged.every(e => e.actor.startsWith('job:')));
});
