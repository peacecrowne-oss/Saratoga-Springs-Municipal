import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTylerClient, TylerIntegrationError } from './client.js';

const goodBudget = {
  as_of: '2026-11-02T12:00:00Z',
  lines: [
    { account_code: '100-4100', description: 'Road maintenance', department: 'Public Works', fiscal_year: 2026, budgeted: 500000, actual: 120000 },
  ],
};

// Starts a throwaway server whose handler is given each request in turn.
async function withServer(handler, fn) {
  let calls = 0;
  const server = http.createServer((req, res) => handler(req, res, ++calls));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl, () => calls);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const client = baseUrl => createTylerClient({ baseUrl, timeoutMs: 200, retries: 2, retryDelayMs: 0 });

test('returns validated budget lines', async () => {
  await withServer((req, res) => json(res, 200, goodBudget), async baseUrl => {
    const budget = await client(baseUrl).fetchBudget({ fiscalYear: 2026 });
    assert.equal(budget.asOf, '2026-11-02T12:00:00.000Z');
    assert.equal(budget.simulated, false);
    assert.deepEqual(budget.lines[0], {
      accountCode: '100-4100', description: 'Road maintenance', department: 'Public Works',
      fiscalYear: 2026, budgeted: 500000, actual: 120000, remaining: 380000,
    });
  });
});

test('asks for the requested fiscal year', async () => {
  let seen;
  await withServer((req, res) => { seen = req.url; json(res, 200, goodBudget); }, async baseUrl => {
    await client(baseUrl).fetchBudget({ fiscalYear: 2026 });
    assert.equal(seen, '/budget?fiscal_year=2026');
  });
});

test('retries once after a server error, then succeeds', async () => {
  await withServer((req, res, n) => (n === 1 ? json(res, 503, {}) : json(res, 200, goodBudget)), async (baseUrl, calls) => {
    const budget = await client(baseUrl).fetchBudget({ fiscalYear: 2026 });
    assert.equal(budget.lines.length, 1);
    assert.equal(calls(), 2);
  });
});

test('times out when Tyler never answers, after the capped retries', async () => {
  await withServer(() => { /* never responds */ }, async (baseUrl, calls) => {
    await assert.rejects(client(baseUrl).fetchBudget({ fiscalYear: 2026 }),
      err => err instanceof TylerIntegrationError && err.kind === 'timeout');
    assert.equal(calls(), 3);
  });
});

test('reports Tyler as unreachable when nothing is listening', async () => {
  const deadUrl = await withServer(() => {}, async baseUrl => baseUrl);
  await assert.rejects(client(deadUrl).fetchBudget({ fiscalYear: 2026 }),
    err => err instanceof TylerIntegrationError && err.kind === 'unreachable');
});

test('does not retry when Tyler refuses the credentials', async () => {
  await withServer((req, res) => json(res, 401, {}), async (baseUrl, calls) => {
    await assert.rejects(client(baseUrl).fetchBudget({ fiscalYear: 2026 }),
      err => err instanceof TylerIntegrationError && err.kind === 'refused');
    assert.equal(calls(), 1);
  });
});

test('rejects budget data with missing or wrong fields, naming the problem', async () => {
  const bad = { as_of: '2026-11-02T12:00:00Z', lines: [{ account_code: '', fiscal_year: '2026', budgeted: 'lots', actual: 1 }] };
  await withServer((req, res) => json(res, 200, bad), async baseUrl => {
    await assert.rejects(client(baseUrl).fetchBudget({ fiscalYear: 2026 }), err =>
      err.kind === 'bad_data' && /account_code/.test(err.message) && /fiscal_year/.test(err.message) && /budgeted/.test(err.message));
  });
});

test('rejects a response that is not JSON', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('<html>oops</html>'); }, async baseUrl => {
    await assert.rejects(client(baseUrl).fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'bad_data');
  });
});

test('says so when the integration is not configured', async () => {
  await assert.rejects(createTylerClient({}).fetchBudget({ fiscalYear: 2026 }), err => err.kind === 'not_configured');
});
