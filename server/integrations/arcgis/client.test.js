import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArcGisStandin, LAYER_PATH, TOKEN_PATH, STANDIN_USER, STANDIN_PASSWORD } from '../../../tools/arcgis-standin/server.js';
import { ArcGisError, createArcGisClient, sqlString, sqlTimestamp } from './client.js';

async function withStandin(options, fn) {
  const standin = createArcGisStandin(options);
  await new Promise(resolve => standin.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${standin.server.address().port}`;
  const make = (overrides = {}) => createArcGisClient({
    layerUrl: base + LAYER_PATH, tokenUrl: base + TOKEN_PATH,
    username: STANDIN_USER, password: STANDIN_PASSWORD,
    timeoutMs: 300, retries: 2, retryDelayMs: 0, ...overrides,
  });
  try {
    return await fn({ standin, base, make });
  } finally {
    standin.server.closeAllConnections();
    await new Promise(resolve => standin.server.close(resolve));
  }
}

const rejectsWith = kind => err => { assert.ok(err instanceof ArcGisError, err.message); assert.equal(err.kind, kind); return true; };

test('signs in, describes the layer, adds a feature and queries it back', async () => {
  await withStandin({}, async ({ make }) => {
    const client = make();
    const layer = await client.describeLayer();
    assert.match(layer.name, /^SIMULATED/);
    const { addResults } = await client.applyEdits({ adds: [{ attributes: { ASSET_TAG: "O'Neil-1", NAME: 'n' } }] });
    assert.equal(addResults[0].success, true);
    const { features } = await client.query({ where: `ASSET_TAG = ${sqlString("O'Neil-1")}` });
    assert.equal(features.length, 1);
    assert.equal(features[0].attributes.OBJECTID, addResults[0].objectId);
  });
});

test('authentication failure: a wrong password is reported as auth, not retried forever', async () => {
  await withStandin({}, async ({ make }) => {
    await assert.rejects(make({ password: 'wrong' }).describeLayer(), rejectsWith('auth'));
  });
});

test('an expired token is refreshed once and the call succeeds', async () => {
  await withStandin({}, async ({ base, make }) => {
    const client = make();
    await client.describeLayer();
    await fetch(`${base}/_expire_tokens`, { method: 'POST' });
    const layer = await client.describeLayer();
    assert.equal(layer.objectIdField, 'OBJECTID');
  });
});

test('a token that keeps being rejected is an auth failure', async () => {
  await withStandin({}, async ({ standin, make }) => {
    const client = make();
    await client.describeLayer();
    standin.setMode('auth');
    await assert.rejects(client.describeLayer(), rejectsWith('auth'));
  });
});

test('network latency: a layer that never answers times out after the capped retries', async () => {
  await withStandin({ mode: 'slow' }, async ({ make }) => {
    let calls = 0;
    const counting = (u, o) => { calls++; return fetch(u, o); };
    await assert.rejects(make({ fetchImpl: counting }).describeLayer(), rejectsWith('timeout'));
    assert.equal(calls, 3, 'one try and two retries, then it stops');
  });
});

test('an outage is reported as unreachable; applyEdits is never retried, so it cannot duplicate', async () => {
  await withStandin({}, async ({ standin, make }) => {
    let calls = 0;
    const client = make({ fetchImpl: (u, o) => { if (String(u).includes('applyEdits')) calls++; return fetch(u, o); } });
    await client.describeLayer();
    standin.setMode('down');
    await assert.rejects(client.describeLayer(), rejectsWith('unreachable'));
    await assert.rejects(client.applyEdits({ adds: [{ attributes: { ASSET_TAG: 'X' } }] }), rejectsWith('unreachable'));
    assert.equal(calls, 1);
  });
});

test('not configured is reported plainly', async () => {
  await assert.rejects(createArcGisClient({}).describeLayer(), rejectsWith('not_configured'));
});

test('where-clause helpers quote safely', () => {
  assert.equal(sqlString("a'b"), "'a''b'");
  assert.equal(sqlTimestamp(Date.UTC(2026, 10, 3, 2, 5, 7, 900)), "TIMESTAMP '2026-11-03 02:05:07'");
});
