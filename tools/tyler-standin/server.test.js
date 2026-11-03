// Checks the stand-in against the real Tyler client, in every mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStandin } from './server.js';
import { createTylerClient } from '../../server/integrations/tyler/client.js';

async function withStandin(mode, fn) {
  const standin = createStandin({ mode, now: () => Date.UTC(2026, 6, 2) });
  await new Promise(resolve => standin.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${standin.server.address().port}`;
  // Short only where a timeout is the point; elsewhere a busy test run must not fail it.
  const client = createTylerClient({ baseUrl, timeoutMs: mode === 'slow' ? 200 : 5000, retries: 0 });
  try {
    return await fn(client, standin, baseUrl);
  } finally {
    standin.server.closeAllConnections();
    await new Promise(resolve => standin.server.close(resolve));
  }
}

test('ok: the client accepts its budget, marked as simulated', async () => {
  await withStandin('ok', async client => {
    const budget = await client.fetchBudget({ fiscalYear: 2026 });
    assert.equal(budget.simulated, true);
    assert.equal(budget.lines.length, 5);
    assert.ok(budget.lines.every(l => l.department.startsWith('SIMULATED')));
    assert.ok(budget.lines.every(l => l.actual > 0 && l.actual < l.budgeted));
  });
});

test('down: the client reports Tyler as unreachable', async () => {
  await withStandin('down', client =>
    assert.rejects(client.fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'unreachable'));
});

test('slow: the client times out', async () => {
  await withStandin('slow', client =>
    assert.rejects(client.fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'timeout'));
});

test('bad: the client rejects the data', async () => {
  await withStandin('bad', client =>
    assert.rejects(client.fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'bad_data'));
});

test('mode can be switched while running', async () => {
  await withStandin('ok', async (client, standin, baseUrl) => {
    const res = await fetch(`${baseUrl}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'down' }) });
    assert.equal(res.status, 200);
    assert.equal(standin.mode, 'down');
    await assert.rejects(client.fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'unreachable');
  });
});

test('refuses an unknown mode', async () => {
  await withStandin('ok', async (client, standin, baseUrl) => {
    const res = await fetch(`${baseUrl}/_mode`, { method: 'POST', body: JSON.stringify({ mode: 'chaos' }) });
    assert.equal(res.status, 400);
    assert.equal(standin.mode, 'ok');
  });
});
