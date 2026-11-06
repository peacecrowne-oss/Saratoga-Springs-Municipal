// STORY-011: the end-to-end smoke test, user acceptance results, and the final
// test report, with its completeness and verdict rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createApp } from './app.js';
import { createUat, SCENARIOS } from './uat.js';
import { runSmoke } from './smoke.js';
import { buildReport, KNOWN_GAPS, reportMarkdown, storyCoverage } from './final-report.js';

const tester = { 'x-user-id': 'tester-1', 'x-user-role': 'asset_manager' };

async function setup(t) {
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  const server = http.createServer(createApp({ db, audit, assets: createAssetStore(db, audit), tyler: {}, allowDevHeaders: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = tester) => {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  let n = 0;
  const record = (scenario_id, outcome, extra = {}) => call('POST', '/api/testing/uat', { scenario_id, outcome, result_key: `k${n++}`, ...extra });
  return { db, audit, call, record, base };
}

const passAll = async record => { for (const s of SCENARIOS) await record(s.id, 'pass'); };

test('criterion 1: final testing exercises every module end to end, and everything works', async () => {
  const smoke = await runSmoke();
  const failed = smoke.checks.filter(c => !c.ok);
  assert.deepEqual(failed, [], failed.map(c => `${c.name}: ${c.detail}`).join('; '));
  const stories = new Set(smoke.checks.map(c => c.story));
  for (const s of ['STORY-000', 'STORY-001', 'STORY-002', 'STORY-004', 'STORY-005', 'STORY-006', 'STORY-007', 'STORY-010', 'STORY-012', 'STORY-013']) {
    assert.ok(stories.has(s), `the smoke test covers ${s}`);
  }
});

test('criterion 2: acceptance holds when every scenario passes and no critical issue is open', async t => {
  const { call, record } = await setup(t);
  let { body } = await call('GET', '/api/testing/uat');
  assert.equal(body.summary.accepted, false);
  assert.match(body.summary.reasons[0], /14 of 14 scenarios have not been run/);

  await passAll(record);
  ({ body } = await call('GET', '/api/testing/uat'));
  assert.equal(body.summary.accepted, true);
  assert.equal(body.summary.openCritical, 0);
  assert.deepEqual(body.summary.testers, ['tester-1']);
});

test('critical issues found: a critical failure blocks acceptance until a retest passes', async t => {
  const { call, record, audit } = await setup(t);
  await passAll(record);
  const failed = await record('UAT-07', 'fail', { severity: 'critical', notes: 'Approve button does nothing' });
  assert.equal(failed.status, 201);
  let { body } = await call('GET', '/api/testing/uat');
  assert.equal(body.summary.accepted, false);
  assert.equal(body.summary.openCritical, 1);
  assert.match(body.summary.reasons.join(' '), /critical issue\(s\) open: UAT-07/);

  await record('UAT-07', 'pass');
  ({ body } = await call('GET', '/api/testing/uat'));
  assert.equal(body.summary.accepted, true);
  const history = body.scenarios.find(s => s.id === 'UAT-07').history;
  assert.deepEqual(history.map(h => h.outcome), ['pass', 'fail', 'pass'], 'the failure stays in the history');
  assert.equal(audit.list({ entityType: 'uat', limit: 100 }).length, SCENARIOS.length + 2);
});

test('user acceptance fails: a non-critical failure or a blocked scenario also keeps it from being accepted', async t => {
  const { call, record } = await setup(t);
  await passAll(record);
  await record('UAT-03', 'blocked', { severity: 'major', notes: 'Could not sign in as asset manager' });
  const { body } = await call('GET', '/api/testing/uat');
  assert.equal(body.summary.accepted, false);
  assert.equal(body.summary.openCritical, 0);
  assert.match(body.summary.reasons.join(' '), /UAT-03/);
});

test('acceptance results are validated, idempotent and need a signed-in staff member', async t => {
  const { call, record } = await setup(t);
  const bad = await call('POST', '/api/testing/uat', { scenario_id: 'UAT-99', outcome: 'fail', result_key: 'x' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.problems.map(p => p.field).sort(), ['notes', 'scenario_id', 'severity']);
  const first = await record('UAT-01', 'pass', { result_key: 'same' });
  const again = await record('UAT-01', 'pass', { result_key: 'same' });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.recorded, false);
  assert.equal((await call('GET', '/api/testing/uat', undefined, {})).status, 401);
  assert.equal((await call('GET', '/api/testing/uat', undefined, { 'x-user-id': 'c', 'x-user-role': 'citizen' })).status, 403);
});

const automatedOk = { total: 10, passed: 10, failed: 0, skipped: 0, failures: [], byFile: [{ file: 'a.test.js', passed: 10, failed: 0 }] };
const smokeOk = { ok: true, checks: [{ name: 'x', story: 'STORY-001', ok: true, detail: '' }] };
const coverageOk = [{ id: 'STORY-001', tests: ['a.test.js'], covered: true }, { id: 'STORY-011', tests: [], covered: false }];

function uatWith(db, fn) {
  const uat = createUat(db, createAuditLog(db));
  fn?.(uat);
  return uat.status();
}

test('criterion 3: the report is complete, says READY only when everything holds, and is written out', () => {
  const db = openDb(':memory:');
  const uat = uatWith(db, u => SCENARIOS.forEach((s, i) => u.record({ tester: 't', input: { scenario_id: s.id, outcome: 'pass', result_key: `r${i}` } })));
  const report = buildReport({ automated: automatedOk, smoke: smokeOk, uat, migration: null, coverage: coverageOk, generatedAt: '2026-11-06T00:00:00Z', commit: 'abc1234' });
  assert.equal(report.status, 'complete');
  assert.equal(report.verdict, 'ready');
  assert.deepEqual(report.criticalIssues, []);
  const md = reportMarkdown(report);
  for (const section of ['## Automated tests', '## End-to-end smoke test', '## User acceptance', '## Cityworks migration', '## Tests on record per story', '## Known gaps']) {
    assert.ok(md.includes(section), `the report has ${section}`);
  }
  assert.match(md, /\*\*Report: COMPLETE\*\* · \*\*Verdict: READY\*\*/);
  assert.equal(report.knownGaps, KNOWN_GAPS);
  db.close();
});

test('test report incomplete: missing results, a missing smoke test or an untested story are named', () => {
  const db = openDb(':memory:');
  const uat = uatWith(db);
  const report = buildReport({ automated: null, smoke: null, uat, migration: null,
    coverage: [{ id: 'STORY-001', tests: [], covered: false }, ...coverageOk.slice(1)], generatedAt: 'now', commit: null });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.verdict, 'not_ready');
  assert.equal(report.missing.length, 3);
  assert.match(report.missing.join(' '), /STORY-001/);
  assert.match(reportMarkdown(report), /Report: INCOMPLETE/);
  db.close();
});

test('critical issues found: failing tests, smoke checks and critical UAT results are listed and block READY', () => {
  const db = openDb(':memory:');
  const uat = uatWith(db, u => u.record({ tester: 't', input: { scenario_id: 'UAT-02', outcome: 'fail', severity: 'critical', notes: 'Health is red', result_key: 'r' } }));
  const report = buildReport({
    automated: { ...automatedOk, failed: 1, failures: [{ name: 'broken thing', file: '/x/b.test.js', error: 'boom' }] },
    smoke: { ok: false, checks: [{ name: 'Portal', story: 'STORY-007', ok: false, detail: 'answered 500' }] },
    uat, migration: null, coverage: coverageOk, generatedAt: 'now', commit: 'x',
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.verdict, 'not_ready');
  assert.equal(report.criticalIssues.length, 3);
  assert.match(report.criticalIssues.join(' '), /broken thing.*Portal.*Health is red/s);
  db.close();
});

test('critical issues found: any one failure on its own keeps the verdict NOT READY', () => {
  const db = openDb(':memory:');
  const accepted = uatWith(db, u => SCENARIOS.forEach((s, i) => u.record({ tester: 't', input: { scenario_id: s.id, outcome: 'pass', result_key: `r${i}` } })));
  const notAccepted = uatWith(openDb(':memory:'));
  const good = { automated: automatedOk, smoke: smokeOk, uat: accepted, migration: null, coverage: coverageOk, generatedAt: 'now', commit: 'x' };
  assert.equal(buildReport(good).verdict, 'ready');
  for (const [label, change, reason] of [
    ['a failed test', { automated: { ...automatedOk, failed: 1, failures: [{ name: 'n', file: 'f', error: 'e' }] } }, /automated test/],
    ['a failed smoke check', { smoke: { ok: false, checks: [{ name: 'x', story: 'S', ok: false, detail: 'd' }] } }, /smoke check/],
    ['acceptance not done', { uat: notAccepted }, /user acceptance/],
  ]) {
    const report = buildReport({ ...good, ...change });
    assert.equal(report.status, 'complete', label);
    assert.equal(report.verdict, 'not_ready', label);
    assert.match(report.reasons.join(' '), reason, label);
  }
  db.close();
});

test('story coverage comes from the tests on record for each story in the plan', () => {
  const progress = { stories: [{ id: 'STORY-001', tests_added: ['a.test.js'] }, { id: 'STORY-002', tests_added: [] }] };
  const plan = { stories: [{ id: 'STORY-001' }, { id: 'STORY-002' }, { id: 'STORY-003' }] };
  assert.deepEqual(storyCoverage(progress, plan).map(c => c.covered), [true, false, false]);
});

test('the Testing Dashboard is served and shows the latest report', async t => {
  const { base, call, db } = await setup(t);
  assert.equal((await fetch(`${base}/testing`)).status, 200);
  assert.equal((await call('GET', '/api/testing/report')).status, 404);
  db.prepare("INSERT INTO test_report (id, generated_at, status, verdict, report) VALUES ('r1', '2026-11-06', 'complete', 'not_ready', '{\"status\":\"complete\"}')").run();
  const { status, body } = await call('GET', '/api/testing/report');
  assert.equal(status, 200);
  assert.equal(body.report.status, 'complete');
});
