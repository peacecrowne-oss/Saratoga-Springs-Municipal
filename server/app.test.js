import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { TylerIntegrationError } from './integrations/tyler/client.js';
import { createApp } from './app.js';

const budget = {
  asOf: '2026-11-02T12:00:00.000Z',
  simulated: true,
  lines: [{ accountCode: 'SIM-1', description: 'd', department: 'SIMULATED · X', fiscalYear: 2026, budgeted: 100, actual: 40, remaining: 60 }],
};
const connected = { fetchBudget: async () => budget };
const disconnected = { fetchBudget: async () => { throw new TylerIntegrationError('unreachable', 'Could not reach Tyler at http://127.0.0.1:4100.'); } };
const manager = { 'x-user-id': 'fm-1', 'x-user-role': 'financial_manager' };

async function withApp({ tyler = connected, db = openDb(':memory:') } = {}, fn) {
  const audit = createAuditLog(db);
  const assets = createAssetStore(db, audit);
  const server = http.createServer(createApp({ db, audit, assets, tyler, allowDevHeaders: true, currentFiscalYear: () => 2026 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = {}) => {
    const res = await fetch(base + path, { headers });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  try {
    return await fn({ get, audit, db });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('connected: a financial manager sees the budget, and the view is audited', async () => {
  await withApp({}, async ({ get, audit }) => {
    const { status, body } = await get('/api/budget', manager);
    assert.equal(status, 200);
    assert.equal(body.connected, true);
    assert.equal(body.fiscalYear, 2026);
    assert.deepEqual(body.lines, budget.lines);

    const [event] = audit.list();
    assert.equal(event.action, 'budget.view');
    assert.equal(event.actor, 'fm-1');
    assert.equal(event.entityId, '2026');
  });
});

test('disconnected: the dashboard gets an error naming the integration problem, and the failure is audited', async () => {
  await withApp({ tyler: disconnected }, async ({ get, audit }) => {
    const { status, body } = await get('/api/budget', manager);
    assert.equal(status, 502);
    assert.equal(body.connected, false);
    assert.equal(body.error.kind, 'unreachable');
    assert.match(body.error.message, /Could not reach Tyler/);
    assert.equal(body.lines, undefined);

    const [event] = audit.list();
    assert.equal(event.action, 'budget.view_failed');
    assert.equal(event.after.kind, 'unreachable');
  });
});

test('a role without budget access is refused, and the refusal is audited', async () => {
  await withApp({}, async ({ get, audit }) => {
    const { status, body } = await get('/api/budget', { 'x-user-id': 'c-1', 'x-user-role': 'citizen' });
    assert.equal(status, 403);
    assert.equal(body.error.kind, 'forbidden');
    assert.equal(audit.list()[0].action, 'budget.view_denied');
  });
});

test('a request with no user is refused', async () => {
  await withApp({}, async ({ get }) => {
    const { status, body } = await get('/api/budget');
    assert.equal(status, 401);
    assert.equal(body.error.kind, 'unauthenticated');
  });
});

test('if the audit trail cannot be written, the budget is withheld', async () => {
  const db = openDb(':memory:');
  await withApp({ db }, async ({ get }) => {
    db.close();
    const original = console.error;
    console.error = () => {};
    try {
      const { status, body } = await get('/api/budget', manager);
      assert.equal(status, 500);
      assert.equal(body.error.kind, 'audit_unavailable');
      assert.equal(body.lines, undefined);
    } finally {
      console.error = original;
    }
  });
});

test('the audit trail is readable by a financial manager only', async () => {
  await withApp({}, async ({ get }) => {
    await get('/api/budget', manager);
    const ok = await get('/api/audit', manager);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.events[0].action, 'budget.view');
    const no = await get('/api/audit', { 'x-user-id': 'c-1', 'x-user-role': 'citizen' });
    assert.equal(no.status, 403);
  });
});

test('serves the dashboard page', async () => {
  await withApp({}, async ({ get }) => {
    const { status, body } = await get('/budget');
    assert.equal(status, 200);
    assert.match(body, /Budget tracking/);
  });
});
