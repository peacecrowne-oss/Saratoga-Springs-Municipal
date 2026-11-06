// STORY-007 acceptance, end to end over HTTP against a real database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createPermits } from './permits.js';
import { createNotifier, MAX_ATTEMPTS, NotificationError, simulatedTransport } from './notify.js';
import { createPortal, PORTAL_LIMITS } from './portal.js';
import { createApp } from './app.js';
import { deploy } from './deploy.js';

// A Wednesday, at noon UTC: the same calendar day in every US time zone.
const NOW = new Date('2026-11-04T12:00:00.000Z');
const clock = () => NOW;
const THURSDAY = '2026-11-05';
const FRIDAY = '2026-11-06';
const SATURDAY = '2026-11-07';
const officer = { 'x-user-id': 'officer-1', 'x-user-role': 'code_enforcement_officer' };
const admin = { 'x-user-id': 'admin-1', 'x-user-role': 'it_administrator' };
const application = {
  submission_key: 'browser-key-1',
  applicant_name: 'Pat Resident',
  applicant_contact: 'pat@example.test',
  property_address: '12 Broadway',
  code_section: '240-5.1',
  description: 'Temporary fence while the violation is corrected.',
};
const PERSONAL = ['Pat Resident', 'pat@example.test', '12 Broadway', 'Temporary fence'];

// A transport that records what it was asked to send, and can be told to fail.
function fakeTransport() {
  const sent = [];
  const t = {
    name: 'fake',
    mode: 'ok',
    sent,
    async send(message, { signal }) {
      if (t.mode === 'down') throw new NotificationError('unreachable', 'connection refused');
      if (t.mode === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      sent.push(message);
      return {};
    },
  };
  return t;
}

async function setup(t, { transport = fakeTransport(), limits = PORTAL_LIMITS, timeoutMs = 1000 } = {}) {
  const db = openDb(':memory:');
  const audit = createAuditLog(db, { now: clock });
  const assets = createAssetStore(db, audit, { now: clock });
  const permits = createPermits(db, audit, { now: clock });
  const notifier = createNotifier(db, audit, { transport, now: clock, timeoutMs, sleep: async () => {} });
  const portal = createPortal(db, audit, permits, notifier, { secretKey: randomBytes(32), publicBaseUrl: 'https://permits.example.test', now: clock, limits });
  const server = http.createServer(createApp({ db, audit, assets, permits, notifier, portal, tyler: {}, allowDevHeaders: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json', 'user-agent': 'resident-browser', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const apply = (input = application) => call('POST', '/api/portal/applications', input);
  const look = token => call('GET', '/api/portal/application', undefined, { 'x-portal-token': token });
  const book = (token, date) => call('POST', '/api/portal/inspection', { date }, { 'x-portal-token': token });
  const events = () => db.prepare('SELECT * FROM audit_event ORDER BY rowid').all().map(e => ({ ...e, after: JSON.parse(e.after ?? 'null') }));
  return { db, audit, notifier, transport, base, call, apply, look, book, events };
}

const quietly = async (t, fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('criterion 1: a resident submits on the portal and receives a confirmation', async t => {
  const { apply, transport, call } = await setup(t);
  const { status, body } = await apply();
  assert.equal(status, 201);
  assert.equal(body.application.permitNumber, 'CE-2026-0001');
  assert.equal(body.application.status, 'submitted');
  assert.equal(body.confirmation.status, 'sent');

  assert.equal(transport.sent.length, 1);
  const [message] = transport.sent;
  assert.equal(message.to, 'pat@example.test');
  assert.match(message.subject, /CE-2026-0001/);
  assert.ok(message.body.includes(`https://permits.example.test/portal#t=${body.token}`), 'the confirmation carries the private link');

  const [shown] = body.application.notifications;
  assert.equal(shown.kind, 'application_received');
  assert.equal(shown.status, 'sent');

  // It is a real permit, in the officers' queue.
  const queue = await call('GET', '/api/permits', undefined, officer);
  assert.equal(queue.body.permits[0].submittedBy, 'public');
});

test('criterion 2: a booked inspection shows its date on the portal', async t => {
  const { apply, look, book, call, transport } = await setup(t);
  const { body } = await apply();

  const booked = await book(body.token, THURSDAY);
  assert.equal(booked.status, 200);
  assert.equal(booked.body.scheduled, true);
  assert.equal(booked.body.confirmation.status, 'sent');
  assert.equal((await look(body.token)).body.application.inspectionOn, THURSDAY);

  const moved = await book(body.token, FRIDAY);
  assert.equal(moved.status, 200);
  assert.equal((await look(body.token)).body.application.inspectionOn, FRIDAY);

  const same = await book(body.token, FRIDAY);
  assert.equal(same.body.scheduled, false);
  assert.equal(transport.sent.length, 3, 'application, booking, move: a repeat sends nothing');

  // The officer sees the same date.
  const queue = await call('GET', '/api/permits', undefined, officer);
  assert.equal(queue.body.permits[0].inspectionOn, FRIDAY);
});

test('criterion 3: every public interaction is on the audit trail, with address and time', async t => {
  const { apply, look, book, events } = await setup(t);
  const { body } = await apply();
  await look(body.token);
  await book(body.token, THURSDAY);
  await book(body.token, SATURDAY);
  await look('not-a-real-link');
  await apply({ ...application, submission_key: 'browser-key-2', applicant_contact: 'not an email' });

  const publicEvents = events().filter(e => e.actor_id === 'public' || e.actor_id.startsWith('resident:'));
  assert.deepEqual(publicEvents.map(e => e.action), [
    'permit.submit', 'portal.view', 'portal.inspection_scheduled', 'portal.inspection_refused', 'portal.access_denied', 'permit.submit_rejected',
  ]);
  for (const e of publicEvents) {
    assert.equal(e.after.ip, '127.0.0.1', `${e.action} has the address`);
    assert.equal(e.after.userAgent, 'resident-browser');
    assert.ok(e.occurred_at);
  }
  assert.equal(publicEvents[1].actor_id, 'resident:CE-2026-0001');
  assert.ok(events().some(e => e.action === 'notification.sent'));
});

test('the audit trail never holds the resident\'s personal details or link', async t => {
  const { apply, look, book, db } = await setup(t);
  const { body } = await apply();
  await look(body.token);
  await book(body.token, THURSDAY);
  const everything = JSON.stringify(db.prepare('SELECT * FROM audit_event').all());
  for (const secret of [...PERSONAL, body.token]) assert.ok(!everything.includes(secret), `${secret} leaked into the audit trail`);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM permit_access').all()).includes(body.token), 'only the hash of the link is stored');
});

test('officers see the history without residents\' addresses; administrators can review them', async t => {
  const { apply, call } = await setup(t);
  const { body } = await apply();
  const { id } = (await call('GET', '/api/permits', undefined, officer)).body.permits[0];

  const history = await call('GET', `/api/permits/${id}/history`, undefined, officer);
  assert.ok(history.body.events.length > 0);
  assert.ok(history.body.events.every(e => e.after?.ip === undefined && e.after?.userAgent === undefined));
  assert.ok((await call('GET', '/api/audit?entity_type=permit', undefined, officer)).body.events.every(e => e.after?.ip === undefined));
  assert.ok((await call('GET', '/api/audit?entity_type=permit', undefined, admin)).body.events.some(e => e.after?.ip === '127.0.0.1'));
  assert.ok(body.token);
});

test('portal access: a wrong or missing link is refused and logged, and a flood of misses is stopped', async t => {
  const { look, call, apply, events } = await setup(t, { limits: { ...PORTAL_LIMITS, missedLinksPerIp: 3 } });
  const { body } = await apply();

  const wrong = await look('x'.repeat(43));
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error.kind, 'unknown_link');
  assert.equal((await call('GET', '/api/portal/application')).status, 404);
  await look('guess-3');

  const flooded = await look('guess-4');
  assert.equal(flooded.status, 429);
  assert.equal((await look(body.token)).status, 429, 'blocked for that address while it lasts');
  assert.deepEqual(events().filter(e => e.action.startsWith('portal.')).map(e => e.action),
    ['portal.access_denied', 'portal.access_denied', 'portal.access_denied', 'portal.rate_limited', 'portal.rate_limited']);
});

test('portal access: needs no sign-in, ignores a stale staff cookie, and refuses other sites', async t => {
  const { base, apply, look } = await setup(t);
  const page = await fetch(`${base}/portal`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /portal\.js/);

  const { body } = await apply();
  const stale = await fetch(`${base}/api/portal/application`, { headers: { cookie: 'sid=expired-session', 'x-portal-token': body.token, 'user-agent': 'resident-browser' } });
  assert.equal(stale.status, 200);

  const forged = await fetch(`${base}/api/portal/applications`, {
    method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(application),
  });
  assert.equal(forged.status, 403);
  const form = await fetch(`${base}/api/portal/applications`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 403);
  assert.equal((await look(body.token)).status, 200);
});

test('submission errors: every wrong field is named, nothing is stored, and nothing is sent', async t => {
  const { apply, call, transport } = await setup(t);
  const bad = await apply({ submission_key: 'k', applicant_contact: 'pat at home', description: '' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.error.problems.map(p => p.field).sort(), ['applicant_contact', 'applicant_name', 'code_section', 'description', 'property_address']);
  assert.match(bad.body.error.problems.find(p => p.field === 'applicant_contact').problem, /email/);
  assert.equal((await apply([])).status, 400);
  assert.equal((await call('POST', '/api/portal/applications', undefined)).status, 400);
  assert.equal((await call('GET', '/api/permits', undefined, officer)).body.total, 0);
  assert.equal(transport.sent.length, 0);
});

test('submission errors: a retried submission returns the same application and link, and emails once', async t => {
  const { apply, transport, call } = await setup(t);
  const first = await apply();
  const retry = await apply();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.token, first.body.token);
  assert.equal(transport.sent.length, 1);
  assert.equal((await call('GET', '/api/permits', undefined, officer)).body.total, 1);

  const changed = await apply({ ...application, description: 'Something else' });
  assert.equal(changed.status, 409);
});

test('submission errors: a flood of applications from one address is stopped, but a retry is not', async t => {
  const { apply, events } = await setup(t, { limits: { ...PORTAL_LIMITS, submissionsPerIpPerHour: 2 } });
  assert.equal((await apply()).status, 201);
  assert.equal((await apply({ ...application, submission_key: 'k2' })).status, 201);
  const third = await apply({ ...application, submission_key: 'k3' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error.kind, 'rate_limited');
  assert.equal((await apply()).status, 200, 'the first, retried, still gets its answer');
  assert.ok(events().some(e => e.action === 'portal.rate_limited'));
});

test('notification failure: the application stands, the resident is told, and it is sent later, once', async t => {
  const transport = fakeTransport();
  transport.mode = 'down';
  const { apply, look, notifier, events } = await setup(t, { transport });

  const { status, body } = await quietly(t, () => apply());
  assert.equal(status, 201, 'the application is recorded even though the email failed');
  assert.equal(body.confirmation.status, 'failed');
  assert.match(body.confirmation.error, /connection refused/);
  assert.equal(body.application.notifications[0].status, 'failed');
  const failed = events().find(e => e.action === 'notification.failed');
  assert.equal(failed.after.attempts, 3, 'one try and two capped retries');

  transport.mode = 'ok';
  await notifier.retryDue();
  await notifier.retryDue();
  assert.equal(transport.sent.length, 1, 'sent once, however many times the retry runs');
  assert.equal((await look(body.token)).body.application.notifications[0].status, 'sent');
});

test('notification failure: a hung mail service times out, and repeated failures stop at a cap', async t => {
  const transport = fakeTransport();
  transport.mode = 'hang';
  const { apply, notifier, db } = await setup(t, { transport, timeoutMs: 30 });
  const { body } = await quietly(t, () => apply());
  assert.equal(body.confirmation.status, 'failed');
  assert.match(body.confirmation.error, /timeout/);

  transport.mode = 'down';
  await quietly(t, async () => { for (let i = 0; i < 5; i++) await notifier.retryDue(); });
  const row = db.prepare('SELECT status, attempts FROM notification').get();
  assert.equal(row.status, 'gave_up');
  assert.equal(row.attempts, MAX_ATTEMPTS);
  transport.mode = 'ok';
  await notifier.retryDue();
  assert.equal(transport.sent.length, 0, 'a message that was given up on is not retried');
});

test('notification: two senders at once send a message only once', async t => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const audit = createAuditLog(db, { now: clock });
  const transport = fakeTransport();
  const notifier = createNotifier(db, audit, { transport, now: clock });
  const permits = createPermits(db, audit, { now: clock });
  const { permit } = permits.submit({ actor: 'clerk', input: { ...application, permit_type: 'code_enforcement' } });
  const n = notifier.enqueue({ permitId: permit.id, kind: 'test', dedupeKey: 'k', recipient: 'a@b.test', subject: 's', body: 'b' });
  assert.equal(notifier.enqueue({ permitId: permit.id, kind: 'test', dedupeKey: 'k', recipient: 'a@b.test', subject: 's', body: 'b' }).id, n.id);
  await Promise.all([notifier.deliver(n.id), notifier.deliver(n.id), notifier.retryDue()]);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].idempotencyKey, n.id);
  assert.equal(simulatedTransport().name, 'simulated');
});

test('inspection rules: a weekday after today, within 60 days, with room that day, before a decision', async t => {
  const { apply, book, call } = await setup(t, { limits: { ...PORTAL_LIMITS, inspectionsPerDay: 1 } });
  const { body } = await apply();
  const t1 = body.token;

  for (const [date, field] of [['2026-11-04', 'date'], ['2026-11-03', 'date'], [SATURDAY, 'date'], ['2027-02-01', 'date'], ['2026-02-30', 'date'], ['soon', 'date']]) {
    const r = await book(t1, date);
    assert.equal(r.status, 400, `${date} refused`);
    assert.equal(r.body.error.problems[0].field, field);
  }

  const other = await apply({ ...application, submission_key: 'k2' });
  assert.equal((await book(other.body.token, THURSDAY)).status, 200);
  const full = await book(t1, THURSDAY);
  assert.equal(full.status, 409);
  assert.equal(full.body.error.kind, 'date_full');

  const { id } = (await call('GET', '/api/permits?status=submitted', undefined, officer)).body.permits[0];
  await call('POST', `/api/permits/${id}/decision`, { decision: 'rejected', reason: 'Not needed' }, officer);
  const decided = await book(t1, FRIDAY);
  assert.equal(decided.status, 409);
  assert.equal(decided.body.error.kind, 'permit_decided');
});

test('a real deployment serves the portal without sign-in, end to end', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-deploy-'));
  const deployed = await deploy({ dbPath: path.join(dir, 'app.db'), port: 0, actor: 'test', publicBaseUrl: 'https://permits.example.test' });
  t.after(async () => {
    await deployed.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (route, body, token) => fetch(deployed.url + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token && { 'x-portal-token': token }) }, body: JSON.stringify(body),
  });

  assert.equal((await fetch(`${deployed.url}/portal`)).status, 200);
  assert.equal((await fetch(`${deployed.url}/portal.js`)).status, 200);
  const submitted = await post('/api/portal/applications', application);
  assert.equal(submitted.status, 201);
  const answer = await submitted.json();
  assert.equal(answer.confirmation.status, 'sent');
  assert.match(answer.confirmation.transport, /SIMULATED/);
  assert.match(answer.link, /^https:\/\/permits\.example\.test\/portal#t=/);

  const tomorrow = new Date(Date.now() + 86400000);
  while ([0, 6].includes(tomorrow.getDay())) tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toLocaleDateString('en-CA');
  assert.equal((await post('/api/portal/inspection', { date }, answer.token)).status, 200);
  const status = await (await fetch(`${deployed.url}/api/portal/application`, { headers: { 'x-portal-token': answer.token } })).json();
  assert.equal(status.application.inspectionOn, date);
  assert.equal(status.application.notifications.length, 2);
});
