// STORY-012 acceptance, end to end over HTTP: real sign-in with a real password
// hash and real TOTP codes, against a real (in-memory) database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from './db.js';
import { AuditWriteError, createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { AuthAdminError, base32Encode, createAuth, LIMITS, parseCookies, resolveAuthKey, totp, totpStep } from './auth.js';
import { createApp } from './app.js';
import { deploy, DeployError } from './deploy.js';

const PASSWORD = 'correct horse battery';
const START = Date.UTC(2026, 10, 4, 12, 0, 0);

async function setup(t, { limits = LIMITS, trustProxy = false, makeAudit = createAuditLog, ...appOptions } = {}) {
  const clock = { ms: START };
  const now = () => new Date(clock.ms);
  const db = openDb(':memory:');
  const audit = makeAudit(db, { now });
  const assets = createAssetStore(db, audit, { now });
  const alerts = [];
  const auth = createAuth(db, audit, { now, trustProxy, limits, scryptCost: 2 ** 10, alert: m => alerts.push(m) });
  const server = http.createServer(createApp({ db, audit, assets, auth, tyler: {}, ...appOptions }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': 'test-browser', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const { totpSecret } = await auth.addUser({ username: 'alice', role: 'asset_manager', password: PASSWORD, actor: 'test' });
  const code = (ms = clock.ms) => totp(totpSecret, totpStep(ms));
  const password = (username = 'alice', pw = PASSWORD, headers) => call('POST', '/api/auth/login', { username, password: pw }, headers);
  const signIn = async () => {
    const step1 = await password();
    assert.equal(step1.status, 200, JSON.stringify(step1.body));
    const step2 = await call('POST', '/api/auth/mfa', { challenge: step1.body.challenge, code: code() });
    assert.equal(step2.status, 200, JSON.stringify(step2.body));
    return `sid=${parseCookies(step2.headers.get('set-cookie')).sid}`;
  };
  const events = (action = null) => auth.readAttempts({ limit: 500 }).filter(e => !action || e.action === action);
  return { clock, db, audit, auth, base, call, code, password, signIn, events, alerts, totpSecret };
}

test('TOTP matches the published RFC 6238 test vector', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp(secret, totpStep(59000), 8), '94287082');
  assert.equal(totp(secret, totpStep(1111111109000), 8), '07081804');
});

test('criterion 1: correct credentials grant access only after the second factor', async t => {
  const { call, password, code, base } = await setup(t);

  const step1 = await password();
  assert.equal(step1.status, 200);
  assert.equal(step1.body.mfaRequired, true);
  assert.equal(step1.headers.get('set-cookie'), null, 'a correct password alone gives no session');

  const step2 = await call('POST', '/api/auth/mfa', { challenge: step1.body.challenge, code: code() });
  assert.equal(step2.status, 200);
  assert.equal(step2.body.user.role, 'asset_manager');
  const cookie = step2.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const headers = { cookie: `sid=${parseCookies(cookie).sid}`, 'user-agent': 'test-browser' };
  const me = await fetch(`${base}/api/auth/me`, { headers });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, 'alice');
  assert.equal((await fetch(`${base}/api/assets`, { headers })).status, 200);
});

test('criterion 1: pages are served with security headers, and the old role headers no longer work', async t => {
  const { base } = await setup(t);
  const page = await fetch(`${base}/login`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  await page.text();

  const forged = await fetch(`${base}/api/assets`, { headers: { 'x-user-id': 'mallory', 'x-user-role': 'it_administrator' } });
  assert.equal(forged.status, 401, 'nobody can claim a role with a header any more');
});

test('criterion 2: incorrect credentials are denied with the same answer, and an alert is logged', async t => {
  const { password, events, alerts } = await setup(t);
  const wrong = await password('alice', 'not the password');
  const nobody = await password('nobody', 'not the password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(nobody.body, wrong.body, 'the answer does not reveal who exists');

  const failed = events('auth.login_failed').reverse();
  assert.deepEqual(failed.map(e => e.after.reason), ['incorrect_password', 'unknown_user']);
  assert.equal(failed[0].after.alert.severity, 'warning');
  assert.equal(failed[0].after.alert.kind, 'incorrect_credentials');
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /SECURITY ALERT/);
});

test('criterion 3: every attempt is recorded with IP address and time, and never a secret', async t => {
  const { call, password, code, events, signIn, alerts } = await setup(t);
  await password('alice', 'wrong-password-value');
  const step = await password();
  await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: '000000' });
  await call('POST', '/api/auth/login', { username: 'alice' });
  await signIn();

  const all = events();
  assert.deepEqual([...new Set(all.map(e => e.action))].sort(),
    ['auth.login_failed', 'auth.login_success', 'auth.mfa_failed', 'auth.mfa_required', 'auth.user_added'].sort());
  for (const e of all.filter(x => x.action !== 'auth.user_added')) {
    assert.match(e.after.ip, /127\.0\.0\.1/, e.action);
    assert.ok(Date.parse(e.occurredAt), e.action);
    assert.equal(e.after.userAgent, 'test-browser');
  }
  const written = JSON.stringify(all) + alerts.join();
  for (const secret of [PASSWORD, 'wrong-password-value', step.body.challenge, code()]) assert.ok(!written.includes(secret), 'secret leaked');
});

test('criterion 3: if an attempt cannot be recorded, nobody gets in', async t => {
  let failing = false;
  const flaky = (db, options) => {
    const real = createAuditLog(db, options);
    return { ...real, record(event) { if (failing) throw new AuditWriteError('disk full'); return real.record(event); } };
  };
  const { call, password, code } = await setup(t, { makeAudit: flaky });
  const step = await password();
  failing = true;
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const denied = await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() });
  assert.equal(denied.status, 500);
  assert.equal(denied.body.error.kind, 'audit_unavailable');
  assert.equal(denied.headers.get('set-cookie'), null);
  assert.equal((await password()).status, 500);
});

test('criterion 3: administrators can review attempts; others cannot', async t => {
  const { auth, call, totpSecret, password, signIn } = await setup(t);
  await password('alice', 'wrong-password-value');
  const manager = await signIn();
  assert.equal((await call('GET', '/api/auth/attempts', undefined, { cookie: manager })).status, 403);
  assert.ok(totpSecret);

  const admin = await auth.addUser({ username: 'sam', role: 'system_administrator', password: PASSWORD, actor: 'test' });
  const step1 = await password('sam');
  const step2 = await call('POST', '/api/auth/mfa', { challenge: step1.body.challenge, code: totp(admin.totpSecret, totpStep(START)) });
  const cookie = `sid=${parseCookies(step2.headers.get('set-cookie')).sid}`;
  const log = await call('GET', '/api/auth/attempts?alerts=1', undefined, { cookie });
  assert.equal(log.status, 200);
  assert.deepEqual(log.body.events.map(e => e.action), ['auth.login_failed']);
  assert.equal((await call('GET', '/api/audit?entity_type=auth', undefined, { cookie })).status, 200);
});

test('incorrect password: a malformed attempt is still recorded', async t => {
  const { base, events } = await setup(t);
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(res.status, 401);
  assert.equal(events('auth.login_failed')[0].after.reason, 'malformed');
});

test('second factor: wrong codes fail, a used code cannot be reused, and a challenge dies after 5 tries', async t => {
  const { call, password, code, signIn, clock, events } = await setup(t, { limits: { ...LIMITS, perUserAndIp: 100, perUser: 100 } });
  await signIn();

  const replay = await password();
  const reused = await call('POST', '/api/auth/mfa', { challenge: replay.body.challenge, code: code() });
  assert.equal(reused.status, 401);
  assert.equal(events('auth.mfa_failed')[0].after.reason, 'code_reused');

  clock.ms += 90000;
  const step = await password();
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: '000000' });
    assert.equal(r.body.error.kind, 'invalid_code');
  }
  const dead = await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() });
  assert.equal(dead.body.error.kind, 'challenge_expired', 'even the right code is too late');
});

test('second factor: a code from the wrong moment fails, a slightly drifted clock passes, a challenge expires', async t => {
  const { call, password, code, clock } = await setup(t);
  let step = await password();
  assert.equal((await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code(START - 5 * 60000) })).status, 401);
  assert.equal((await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code(START - 30000) })).status, 200);

  clock.ms += 120000;
  step = await password();
  clock.ms += LIMITS.challengeMs + 1000;
  const late = await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() });
  assert.equal(late.body.error.kind, 'challenge_expired');
});

test('second factor: the code must come from the browser that gave the password', async t => {
  const { call, password, code, events } = await setup(t);
  const step = await password();
  const moved = await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() }, { 'user-agent': 'other-browser' });
  assert.equal(moved.status, 401);
  assert.equal(events('auth.mfa_failed')[0].after.reason, 'challenge_moved');
  assert.equal((await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() })).status, 401, 'and that challenge is now dead');
});

test('brute force: the user is locked after 5 failures, even with the right password, and alerted once', async t => {
  const { password, signIn, events, alerts, clock } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await password('alice', `guess number ${i}`)).status, 401);

  const locked = await password();
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.kind, 'locked');
  assert.equal((await password('alice', 'one more guess')).status, 429);
  assert.equal(events('auth.login_failed').length, 5, 'blocked tries are not even checked');
  assert.equal(events('auth.login_blocked').length, 2);

  const detected = events('auth.brute_force_detected');
  assert.equal(detected.length, 1);
  assert.equal(detected[0].after.scope, 'user_and_ip');
  assert.equal(alerts.filter(a => a.includes('brute_force')).length, 1);

  clock.ms += LIMITS.windowMs + 1000;
  await signIn();
});

test('brute force: a burst sent all at once cannot slip past the limit', async t => {
  const { password, events } = await setup(t);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => password('alice', `parallel guess ${i}`)));
  assert.ok(events('auth.login_failed').length <= LIMITS.perUserAndIp, `${events('auth.login_failed').length} passwords were checked`);
  assert.ok(results.some(r => r.status === 429));
});

test('brute force: guessing many usernames from one address locks that address', async t => {
  const { password, events } = await setup(t, { limits: { ...LIMITS, perIp: 6 } });
  for (let i = 0; i < 6; i++) await password(`user${i}`, 'a wrong password');
  const blocked = await password('alice');
  assert.equal(blocked.status, 429, 'even a correct password, from this address');
  assert.equal(events('auth.brute_force_detected')[0].after.scope, 'ip');
});

test('brute force: a successful sign-in clears that user\'s count', async t => {
  const { password, signIn, clock } = await setup(t);
  for (let i = 0; i < 4; i++) await password('alice', `guess number ${i}`);
  clock.ms += 1000;
  await signIn();
  for (let i = 0; i < 4; i++) assert.equal((await password('alice', `guess again ${i}`)).status, 401);
  assert.equal((await password()).status, 200);
});

test('brute force: the client IP cannot be forged with a header', async t => {
  const { password, events } = await setup(t);
  await password('alice', 'a wrong password', { 'x-forwarded-for': '6.6.6.6' });
  assert.match(events('auth.login_failed')[0].after.ip, /127\.0\.0\.1/);
});

test('behind a trusted proxy, the address the proxy saw is recorded', async t => {
  const { password, events } = await setup(t, { trustProxy: true });
  await password('alice', 'a wrong password', { 'x-forwarded-for': '6.6.6.6, 10.1.2.3' });
  assert.equal(events('auth.login_failed')[0].after.ip, '10.1.2.3');
});

test('session hijacking: a session used from another browser is ended and alerted', async t => {
  const { call, signIn, events, alerts } = await setup(t);
  const cookie = await signIn();
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 200);

  const stolen = await call('GET', '/api/auth/me', undefined, { cookie, 'user-agent': 'attacker-browser' });
  assert.equal(stolen.status, 401);
  assert.equal(stolen.body.error.kind, 'session_invalid');
  const [event] = events('auth.session_hijack_suspected');
  assert.equal(event.after.userAgent, 'attacker-browser');
  assert.equal(event.after.sessionUserAgent, 'test-browser');
  assert.ok(alerts.some(a => a.includes('session_hijack')));

  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 401, 'it is dead for the real browser too');
});

test('expired session: idle and absolute limits both end it, with a clear answer', async t => {
  const { call, signIn, clock, events } = await setup(t);
  let cookie = await signIn();
  clock.ms += LIMITS.sessionIdleMs + 1000;
  const idle = await call('GET', '/api/auth/me', undefined, { cookie });
  assert.equal(idle.status, 401);
  assert.equal(idle.body.error.kind, 'session_expired');
  assert.match(idle.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(events('auth.session_expired')[0].after.reason, 'idle');

  clock.ms += 60000;
  cookie = await signIn();
  for (let i = 0; i < 20; i++) { // stays active, past the absolute limit
    clock.ms += LIMITS.sessionIdleMs - 1000;
    await call('GET', '/api/auth/me', undefined, { cookie });
  }
  assert.equal(events('auth.session_expired')[0].after.reason, 'max_age');
});

test('signing out ends the session, and it cannot be used again', async t => {
  const { call, signIn, events } = await setup(t);
  const cookie = await signIn();
  assert.equal((await call('POST', '/api/auth/logout', {}, { cookie })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 401);
  assert.equal(events('auth.logout').length, 1);
});

test('another site cannot make a signed-in browser change something', async t => {
  const { base, call, signIn } = await setup(t);
  const cookie = await signIn();
  const asset = { asset_tag: 'HYD-1', name: 'x', asset_type: 'y' };
  const forged = await call('POST', '/api/assets', asset, { cookie, origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.kind, 'cross_site');
  const form = await fetch(`${base}/api/assets`, { method: 'POST', headers: { cookie, 'user-agent': 'test-browser', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 403);
  await form.text();
  assert.equal((await call('POST', '/api/assets', asset, { cookie, origin: base })).status, 201);
});

test('account administration: rules, no duplicates, and changes end existing sessions', async t => {
  const { auth, call, signIn, password, events } = await setup(t);
  await assert.rejects(auth.addUser({ username: 'bob', role: 'wizard', password: PASSWORD, actor: 'a' }), AuthAdminError);
  await assert.rejects(auth.addUser({ username: 'bob', role: 'citizen', password: 'short', actor: 'a' }), /12 characters/);
  await assert.rejects(auth.addUser({ username: 'ALICE', role: 'citizen', password: PASSWORD, actor: 'a' }), /already exists/);
  assert.deepEqual(events('auth.user_added').map(e => e.entityId), ['alice']);

  let cookie = await signIn();
  await auth.setPassword({ username: 'alice', password: 'a brand new passphrase', actor: 'a' });
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 401);
  assert.equal((await password()).status, 401, 'the old password is gone');
  assert.equal((await password('alice', 'a brand new passphrase')).status, 200);

  auth.disableUser({ username: 'alice', actor: 'a' });
  assert.equal((await password('alice', 'a brand new passphrase')).status, 401);
  assert.equal(events('auth.login_failed')[0].after.reason, 'account_disabled');
});

test('account administration: resetting an authenticator stops the old codes working', async t => {
  const { auth, call, password, code } = await setup(t);
  const fresh = auth.resetAuthenticator({ username: 'alice', actor: 'a' });
  const step = await password();
  assert.equal((await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: code() })).status, 401);
  assert.equal((await call('POST', '/api/auth/mfa', { challenge: step.body.challenge, code: totp(fresh.totpSecret, totpStep(START)) })).status, 200);
});

test('stored secrets: no password or authenticator secret is readable in the database', async t => {
  const { db, totpSecret, signIn } = await setup(t);
  await signIn();
  const dump = JSON.stringify([db.prepare('SELECT * FROM auth_user').all(), db.prepare('SELECT * FROM auth_session').all(), db.prepare('SELECT * FROM auth_challenge').all()]);
  assert.ok(!dump.includes(PASSWORD));
  assert.ok(!dump.includes(totpSecret));
});

test('the sign-in key: from the environment if set, otherwise a stable file beside the database', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'app.db');
  const first = resolveAuthKey(dbPath, {});
  assert.equal(first.length, 32);
  assert.deepEqual(resolveAuthKey(dbPath, {}), first, 'the same key next time');
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.deepEqual(resolveAuthKey(dbPath, { AUTH_SECRET_KEY: key }), Buffer.alloc(32, 7));
  assert.throws(() => resolveAuthKey(dbPath, { AUTH_SECRET_KEY: 'short' }), /32 bytes/);
});

test('the deployed system has no way to claim a role with a header, and its own check still passes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deployed = await deploy({ dbPath: path.join(dir, 'app.db'), port: 0, actor: 'it-1', checkRetries: 0 });
  try {
    assert.ok(deployed.event.after.checks.find(c => c.name === 'assets').ok);
    assert.equal(deployed.users, 0);
    const forged = await fetch(`${deployed.url}/api/assets`, { headers: { 'x-user-id': 'mallory', 'x-user-role': 'it_administrator' } });
    assert.equal(forged.status, 401);
    const left = deployed.db.prepare("SELECT revoked_reason FROM auth_session WHERE kind = 'service'").get();
    assert.equal(left.revoked_reason, 'service_done', 'the check leaves no live session behind');
  } finally {
    await deployed.stop();
  }
});

test('deploying to the network without TLS is refused, so passwords never cross it in clear text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(deploy({ dbPath: path.join(dir, 'app.db'), host: '0.0.0.0', port: 0, actor: 'it-1', trustProxy: false }), err => {
    assert.ok(err instanceof DeployError);
    assert.equal(err.kind, 'insecure_transport');
    return true;
  });
});
