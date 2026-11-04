// STORY-006 acceptance, end to end over HTTP against a real database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createPermits } from './permits.js';
import { createApp } from './app.js';
import { deploy } from './deploy.js';
import { createAuth, parseCookies, resolveAuthKey, totp, totpStep } from './auth.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const clock = () => NOW;
const clerk = { 'x-user-id': 'clerk-1', 'x-user-role': 'permit_clerk' };
const officer = { 'x-user-id': 'officer-1', 'x-user-role': 'code_enforcement_officer' };
const officer2 = { 'x-user-id': 'officer-2', 'x-user-role': 'code_enforcement_officer' };
const admin = { 'x-user-id': 'admin-1', 'x-user-role': 'it_administrator' };
const allChecks = { code_section_verified: true, site_inspected: true };
const application = {
  permit_type: 'code_enforcement',
  submission_key: 'key-1',
  applicant_name: 'Pat Resident',
  applicant_contact: 'pat@example.test',
  property_address: '12 Broadway',
  code_section: '240-5.1',
  description: 'Temporary fence while the violation is corrected.',
};
const approve = { decision: 'approved', reason: 'Fence meets the setback.', checks: allChecks };

async function setup(t, { makeAudit = createAuditLog, file = ':memory:' } = {}) {
  const db = openDb(file);
  const audit = makeAudit(db, { now: clock });
  const assets = createAssetStore(db, audit, { now: clock });
  const permits = createPermits(db, audit, { now: clock });
  const server = http.createServer(createApp({ db, audit, assets, permits, tyler: {}, allowDevHeaders: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  };
  t.after(stop);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = officer) => {
    const res = await fetch(base + route, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const submit = async (input = application) => (await call('POST', '/api/permits', input, clerk)).body.permit;
  const decide = (id, body = approve, headers = officer) => call('POST', `/api/permits/${id}/decision`, body, headers);
  const trail = id => audit.list({ entityType: 'permit', entityId: id }).map(e => e.action).reverse();
  return { db, audit, call, submit, decide, trail, stop };
}

test('criterion 1: a submitted application can be reviewed, then approved or rejected', async t => {
  const { call, submit, decide } = await setup(t);
  const first = await submit();
  const second = await submit({ ...application, submission_key: 'key-2' });
  assert.equal(first.status, 'submitted');
  assert.equal(first.permitNumber, 'CE-2026-0001');
  assert.equal(second.permitNumber, 'CE-2026-0002');

  const queue = await call('GET', '/api/permits?status=submitted');
  assert.equal(queue.body.total, 2);
  const review = await call('GET', `/api/permits/${first.id}`);
  assert.equal(review.body.permit.applicantName, 'Pat Resident');

  const approved = await decide(first.id);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.permit.status, 'approved');

  const rejected = await decide(second.id, { decision: 'rejected', reason: 'Fence is over the height limit.' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.permit.status, 'rejected');
  assert.equal(rejected.body.permit.decisionReason, 'Fence is over the height limit.');
  assert.equal((await call('GET', '/api/permits?status=submitted')).body.total, 0);
});

test('criterion 2: an approved permit shows as approved, including after a restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app.db');

  const first = await setup(t, { file });
  const { id } = await first.submit();
  await first.decide(id);
  await first.stop();

  const second = await setup(t, { file });
  const { permit } = (await second.call('GET', `/api/permits/${id}`)).body;
  assert.equal(permit.status, 'approved');
  assert.equal(permit.decidedBy, 'officer-1');
  assert.equal(permit.decidedAt, NOW.toISOString());
  assert.deepEqual(permit.checks, allChecks);
  const queue = (await second.call('GET', '/api/permits?status=approved')).body;
  assert.deepEqual(queue.permits.map(p => p.id), [id]);
  await second.stop();
});

test('criterion 3: every permit action is on the audit trail, with who did it', async t => {
  const { call, submit, decide, trail, audit } = await setup(t);
  const { id } = await submit();
  await call('GET', `/api/permits/${id}`);
  await decide(id, { decision: 'approved', reason: 'No checks' });
  await decide(id, approve);
  await decide(id, { decision: 'rejected', reason: 'Too late' }, officer2);
  await call('GET', `/api/permits/${id}`, undefined, admin);

  assert.deepEqual(trail(id), ['permit.submit', 'permit.view', 'permit.decision_refused', 'permit.approve', 'permit.decision_refused', 'permit.access_denied']);
  const actors = audit.list({ entityType: 'permit', entityId: id }).map(e => e.actor).reverse();
  assert.deepEqual(actors, ['clerk-1', 'officer-1', 'officer-1', 'officer-1', 'officer-2', 'admin-1']);

  const history = await call('GET', `/api/permits/${id}/history`);
  assert.equal(history.body.events.length, 6);
  const decision = history.body.events.find(e => e.action === 'permit.approve');
  assert.equal(decision.before.status, 'submitted');
  assert.equal(decision.after.status, 'approved');
  assert.equal(decision.after.decisionReason, approve.reason);
});

test('the audit trail never holds the applicant\'s personal details', async t => {
  const { call, submit, decide, db } = await setup(t);
  const { id } = await submit();
  await call('GET', `/api/permits/${id}`);
  await decide(id);
  await call('POST', '/api/permits', { ...application, description: 'different' }, clerk);
  await call('POST', '/api/permits', { ...application, submission_key: '', applicant_contact: 'second@example.test' }, clerk);

  const everything = JSON.stringify(db.prepare('SELECT * FROM audit_event').all());
  for (const secret of ['Pat Resident', 'example.test', '12 Broadway', 'Temporary fence']) {
    assert.ok(!everything.includes(secret), `${secret} leaked into the audit trail`);
  }
});

test('submission errors: every wrong field is named, nothing is stored, and it is audited', async t => {
  const { call, audit } = await setup(t);
  const bad = await call('POST', '/api/permits', { permit_type: 'building', applicant_name: '   ', description: 'x'.repeat(2001) }, clerk);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.problems.map(p => p.field).sort(),
    ['applicant_contact', 'applicant_name', 'code_section', 'description', 'permit_type', 'property_address', 'submission_key']);
  assert.equal((await call('POST', '/api/permits', [], clerk)).status, 400);
  assert.equal((await call('GET', '/api/permits')).body.total, 0);

  const refused = audit.list({ entityType: 'permit' });
  assert.deepEqual(refused.map(e => e.action), ['permit.submit_rejected', 'permit.submit_rejected']);
  assert.equal(refused[0].actor, 'clerk-1');
});

test('submitting twice creates one permit; the same key with other details is refused', async t => {
  const { call, trail } = await setup(t);
  const first = await call('POST', '/api/permits', application, clerk);
  assert.equal(first.status, 201);
  const retry = await call('POST', '/api/permits', application, clerk);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.permit.id, first.body.permit.id);

  const changed = await call('POST', '/api/permits', { ...application, code_section: '999' }, clerk);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.kind, 'submission_conflict');
  assert.equal((await call('GET', '/api/permits')).body.total, 1);
  assert.deepEqual(trail(first.body.permit.id), ['permit.submit']);
});

test('approval failures: a decision is final, and repeating it changes nothing', async t => {
  const { submit, decide, trail, call } = await setup(t);
  const { id } = await submit();
  await decide(id);

  const again = await decide(id);
  assert.equal(again.status, 200);
  assert.equal(again.body.decided, false);

  const reversed = await decide(id, { decision: 'rejected', reason: 'Changed my mind' }, officer2);
  assert.equal(reversed.status, 409);
  assert.equal(reversed.body.error.kind, 'already_decided');
  assert.equal((await call('GET', `/api/permits/${id}`)).body.permit.status, 'approved');
  assert.deepEqual(trail(id).filter(a => a === 'permit.approve'), ['permit.approve']);

  const unknown = await decide('nope');
  assert.equal(unknown.status, 404);
  const invalid = await decide((await submit({ ...application, submission_key: 'key-2' })).id, { decision: 'maybe' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error.problems.map(p => p.field), ['decision', 'reason']);
});

test('approval failures: if the decision cannot be audited, it does not happen', async t => {
  const makeAudit = (db, options) => {
    const real = createAuditLog(db, options);
    return {
      ...real,
      record(event) {
        if (event.action === 'permit.approve') throw new AuditWriteError('disk full');
        return real.record(event);
      },
    };
  };
  const { submit, decide, call, trail } = await setup(t, { makeAudit });
  const { id } = await submit();

  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const result = await decide(id);
  assert.equal(result.status, 500);
  assert.equal(result.body.error.kind, 'audit_unavailable');
  assert.equal((await call('GET', `/api/permits/${id}`)).body.permit.status, 'submitted');
  assert.ok(!trail(id).includes('permit.approve'));
});

test('compliance: approval needs every check, and a reason is always required', async t => {
  const { submit, decide, call, audit } = await setup(t);
  const { id } = await submit();

  const unchecked = await decide(id, { decision: 'approved', reason: 'Looks fine', checks: { code_section_verified: true } });
  assert.equal(unchecked.status, 409);
  assert.equal(unchecked.body.error.kind, 'compliance_block');
  assert.deepEqual(unchecked.body.error.problems.map(p => p.field), ['site_inspected']);

  const truthy = await decide(id, { decision: 'approved', reason: 'Looks fine', checks: { code_section_verified: 'yes', site_inspected: 1 } });
  assert.equal(truthy.status, 409);

  const noReason = await decide(id, { decision: 'rejected', reason: '  ' });
  assert.equal(noReason.status, 400);

  assert.equal((await call('GET', `/api/permits/${id}`)).body.permit.status, 'submitted');
  assert.equal(audit.list({ entityType: 'permit', entityId: id }).filter(e => e.action === 'permit.decision_refused').length, 3);

  // A rejection does not need the checks: the point may be that they failed.
  assert.equal((await decide(id, { decision: 'rejected', reason: 'Site not safe to inspect' })).status, 200);
});

test('compliance: nobody decides an application they submitted', async t => {
  const { call, decide } = await setup(t);
  const { body } = await call('POST', '/api/permits', application, officer);
  const own = await decide(body.permit.id);
  assert.equal(own.status, 409);
  assert.equal(own.body.error.kind, 'compliance_block');
  assert.match(own.body.error.message, /another officer/);
  assert.equal((await decide(body.permit.id, approve, officer2)).status, 200);
});

test('access: clerks cannot decide, administrators cannot read applicants, strangers are turned away', async t => {
  const { call, submit, decide, trail } = await setup(t);
  const { id } = await submit();

  assert.equal((await decide(id, approve, clerk)).status, 403);
  assert.equal((await call('GET', `/api/permits/${id}`, undefined, admin)).status, 403);
  assert.equal((await call('GET', '/api/permits', undefined, admin)).status, 403);
  assert.equal((await call('GET', '/api/permits', undefined, {})).status, 401);
  assert.equal((await call('POST', '/api/permits', application, {})).status, 401);
  assert.ok(trail(id).includes('permit.access_denied'));

  // Administrators do see the permit audit events, which leave personal details out.
  const events = await call('GET', '/api/audit?entity_type=permit', undefined, admin);
  assert.equal(events.status, 200);
  assert.ok(events.body.events.length > 0);
  assert.equal((await call('GET', '/api/audit', undefined, officer)).status, 200);
});

test('the review queue carries no personal details, and a personal search term finds nothing', async t => {
  const { call, submit } = await setup(t);
  await submit();
  const { body } = await call('GET', '/api/permits?q=240-5');
  assert.equal(body.total, 1);
  const text = JSON.stringify(body);
  for (const secret of ['Pat Resident', 'example.test', '12 Broadway', 'Temporary fence']) assert.ok(!text.includes(secret));
  assert.equal((await call('GET', '/api/permits?q=Pat')).body.total, 0);
  assert.equal((await call('GET', '/api/permits?status=lost')).status, 400);
  assert.equal((await call('GET', '/api/permits?limit=0')).status, 400);
});

test('a real officer signs in on a real deployment and approves a permit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permits-deploy-'));
  const dbPath = path.join(dir, 'app.db');
  const adminDb = openDb(dbPath);
  const accounts = createAuth(adminDb, createAuditLog(adminDb), { secretKey: resolveAuthKey(dbPath), scryptCost: 2 ** 10 });
  const password = 'correct horse battery';
  const add = (username, role) => accounts.addUser({ username, role, password, actor: 'test' });
  const people = { clara: await add('clara', 'permit_clerk'), omar: await add('omar', 'code_enforcement_officer') };
  adminDb.close();

  const deployed = await deploy({ dbPath, port: 0, actor: 'test' });
  t.after(async () => {
    await deployed.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const signIn = async username => {
    const post = (route, body) => fetch(deployed.url + route, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'test' }, body: JSON.stringify(body) });
    const { challenge } = await (await post('/api/auth/login', { username, password })).json();
    const res = await post('/api/auth/mfa', { challenge, code: totp(people[username].totpSecret, totpStep(Date.now())) });
    assert.equal(res.status, 200);
    return `sid=${parseCookies(res.headers.get('set-cookie')).sid}`;
  };
  const as = (cookie, method, route, body) => fetch(deployed.url + route, {
    method, headers: { cookie, 'user-agent': 'test', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const forged = await fetch(`${deployed.url}/api/permits`, { headers: { 'x-user-id': 'mallory', 'x-user-role': 'code_enforcement_officer' } });
  assert.equal(forged.status, 401);

  const page = await fetch(`${deployed.url}/permits`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /permits\.js/);
  assert.equal((await fetch(`${deployed.url}/permits.js`)).status, 200);

  const clara = await signIn('clara');
  const created = await as(clara, 'POST', '/api/permits', application);
  assert.equal(created.status, 201);
  const { permit } = await created.json();
  assert.equal((await as(clara, 'POST', `/api/permits/${permit.id}/decision`, approve)).status, 403);

  const omar = await signIn('omar');
  const decided = await as(omar, 'POST', `/api/permits/${permit.id}/decision`, approve);
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).permit.decidedBy, 'omar');
  const check = await (await as(omar, 'GET', `/api/permits/${permit.id}`)).json();
  assert.equal(check.permit.status, 'approved');
});
