// Sign-in (STORY-012, REQ-010): password, then a time-based code, then a session.
//
// Accounts are local for now. REQ-010 asks for the City's Active Directory, which
// this project cannot reach: verifyPassword() below is the one place a directory
// would plug in. See docs/SECURITY.md.
//
// Every attempt is written to the audit trail with its IP address and time, before
// the answer goes out. If that write fails the login is refused: an attempt that
// cannot be recorded does not get in. Passwords, codes and tokens are never logged.
//
// Failure paths:
//   incorrect password     same answer whether or not the user exists; alert logged
//   wrong code             counted with password failures; a challenge dies after 5
//   brute force            lockout by user + IP, by user, and by IP; alert logged once
//   session hijack         a session used from another IP or browser is revoked
//   expired session        idle and absolute limits, enforced on every request

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { transaction } from './db.js';

const scryptAsync = promisify(scrypt);

export const ROLES = ['system_administrator', 'it_administrator', 'asset_manager', 'gis_analyst', 'financial_manager', 'code_enforcement_officer', 'permit_clerk', 'billing_manager', 'citizen'];
export const SESSION_COOKIE = 'sid';

export const LIMITS = {
  windowMs: 15 * 60000,
  perUserAndIp: 5,  // low: one person mistyping, or someone guessing from one place
  perUser: 20,      // higher, so an attacker elsewhere cannot easily lock a person out
  perIp: 50,        // higher, because a whole office can share one address
  challengeMs: 5 * 60000,
  challengeAttempts: 5,
  sessionIdleMs: 30 * 60000,
  sessionMaxMs: 8 * 60 * 60000,
  serviceSessionMs: 60000,
};
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const MAX_LOGGED = 200;
const TOTP_STEP_S = 30;
const TOTP_WINDOW = 1; // one step either side, for clock drift

export class AuthAdminError extends Error {}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const clip = text => String(text ?? '').slice(0, MAX_LOGGED);

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of text) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

export function totp(secretBase32, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const at = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(at) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export const totpStep = ms => Math.floor(ms / 1000 / TOTP_STEP_S);

// ── Secrets at rest ──────────────────────────────────────────────────────────

// AUTH_SECRET_KEY (base64, 32 bytes) wins. Otherwise a key file is created beside
// the database, which is only as safe as that folder: see docs/SECURITY.md.
export function resolveAuthKey(dbPath, env = process.env) {
  if (env.AUTH_SECRET_KEY) {
    const key = Buffer.from(env.AUTH_SECRET_KEY, 'base64');
    if (key.length !== 32) throw new Error('AUTH_SECRET_KEY must be 32 bytes, base64 encoded.');
    return key;
  }
  if (dbPath === ':memory:') return randomBytes(32);
  const file = path.join(path.dirname(dbPath), 'auth.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

function seal(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function unseal(key, sealed) {
  const [iv, tag, data] = sealed.split('.').map(p => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── The service ──────────────────────────────────────────────────────────────

export function createAuth(db, audit, {
  secretKey = randomBytes(32),
  now = () => new Date(),
  trustProxy = false,
  scryptCost = 2 ** 15,
  limits = LIMITS,
  alert = message => console.warn(message),
} = {}) {
  const userBy = db.prepare('SELECT * FROM auth_user WHERE username = ?');
  const insertUser = db.prepare('INSERT INTO auth_user (username, display_name, role, password_hash, totp_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const setPasswordHash = db.prepare('UPDATE auth_user SET password_hash = ? WHERE username = ?');
  const setTotp = db.prepare('UPDATE auth_user SET totp_secret = ?, last_totp_step = 0 WHERE username = ?');
  const setStep = db.prepare('UPDATE auth_user SET last_totp_step = ? WHERE username = ?');
  const setDisabled = db.prepare('UPDATE auth_user SET disabled_at = ? WHERE username = ?');
  const insertChallenge = db.prepare('INSERT INTO auth_challenge (id_hash, username, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)');
  const challengeBy = db.prepare('SELECT * FROM auth_challenge WHERE id_hash = ?');
  const bumpChallenge = db.prepare('UPDATE auth_challenge SET attempts = attempts + 1 WHERE id_hash = ?');
  const burnChallenge = db.prepare('UPDATE auth_challenge SET used_at = ? WHERE id_hash = ?');
  const insertSession = db.prepare(`
    INSERT INTO auth_session (id, token_hash, username, role, kind, ip, user_agent, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sessionBy = db.prepare(`
    SELECT s.*, u.role AS live_role, u.disabled_at, u.username AS live_user
    FROM auth_session s LEFT JOIN auth_user u ON u.username = s.username WHERE s.token_hash = ?
  `);
  const touchSession = db.prepare('UPDATE auth_session SET last_seen_at = ? WHERE id = ?');
  const revokeSession = db.prepare('UPDATE auth_session SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
  const revokeUserSessions = db.prepare('UPDATE auth_session SET revoked_at = ?, revoked_reason = ? WHERE username = ? AND revoked_at IS NULL');
  const lastSuccess = db.prepare("SELECT MAX(occurred_at) AS at FROM audit_event WHERE action = 'auth.login_success' AND entity_id = ?");
  const FAILED = "action IN ('auth.login_failed', 'auth.mfa_failed') AND occurred_at >= ?";
  const failuresByUserIp = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE ${FAILED} AND entity_id = ? AND json_extract(after, '$.ip') = ?`);
  const failuresByUser = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE ${FAILED} AND entity_id = ?`);
  const failuresByIp = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE ${FAILED} AND json_extract(after, '$.ip') = ?`);

  const cleanName = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const iso = ms => new Date(ms).toISOString();

  // Attempts whose password is still being checked. Hashing is slow on purpose, so
  // without this a burst sent at once would all pass the lockout check together.
  const inFlight = new Map();
  const flight = (key, by) => {
    const n = (inFlight.get(key) ?? 0) + by;
    if (n > 0) inFlight.set(key, n); else inFlight.delete(key);
  };

  async function hashPassword(password) {
    const salt = randomBytes(16);
    const N = scryptCost;
    const hash = await scryptAsync(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
    return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  async function checkHash(password, stored) {
    const [, N, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: 8, p: 1, maxmem: 256 * Number(N) * 8 });
    return timingSafeEqual(actual, expected);
  }

  // An unknown user takes as long as a known one, so timing does not reveal who exists.
  let decoy = null;
  // The one place a directory (Active Directory) would plug in.
  async function verifyPassword(user, password) {
    if (user) return checkHash(password, user.password_hash);
    decoy ??= await hashPassword(randomBytes(16).toString('hex'));
    await checkHash(password, decoy);
    return false;
  }

  function context(req) {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() : '';
    return { ip: forwarded || req.socket?.remoteAddress || 'unknown', userAgent: clip(req.headers['user-agent']) };
  }

  const record = (action, username, ctx, details = {}) => audit.record({
    actor: username || 'unknown', action, entityType: 'auth', entityId: username || 'unknown',
    after: { ip: ctx.ip, userAgent: ctx.userAgent, ...details },
  });

  function raiseAlert(kind, username, ctx, message) {
    alert(`[SECURITY ALERT] ${JSON.stringify({ kind, username: clip(username), ip: ctx.ip, message })}`);
    return { severity: 'warning', kind, message };
  }

  function failureCounts(username, ip) {
    const windowStart = iso(now().getTime() - limits.windowMs);
    // A successful login clears that user's count; the per-address count keeps running.
    const since = username ? (lastSuccess.get(username).at ?? windowStart) : windowStart;
    const from = since > windowStart ? since : windowStart;
    return {
      userIp: username ? failuresByUserIp.get(from, username, ip).n : 0,
      user: username ? failuresByUser.get(from, username).n : 0,
      ip: failuresByIp.get(windowStart, ip).n,
    };
  }

  function lockReason(username, ip) {
    const c = failureCounts(username, ip);
    if (c.userIp + (inFlight.get(`${username}|${ip}`) ?? 0) >= limits.perUserAndIp) return 'user_and_ip';
    if (c.user + (inFlight.get(`u|${username}`) ?? 0) >= limits.perUser) return 'user';
    if (c.ip + (inFlight.get(`i|${ip}`) ?? 0) >= limits.perIp) return 'ip';
    return null;
  }

  // Written once, on the failure that reaches a limit.
  function noticeBruteForce(username, ctx) {
    const c = failureCounts(username, ctx.ip);
    const reached = c.userIp === limits.perUserAndIp ? ['user_and_ip', c.userIp]
      : c.user === limits.perUser ? ['user', c.user]
      : c.ip === limits.perIp ? ['ip', c.ip] : null;
    if (!reached) return;
    const message = `${reached[1]} failed attempts in ${limits.windowMs / 60000} minutes (${reached[0]}). Further attempts are refused until they age out.`;
    record('auth.brute_force_detected', username, ctx, { scope: reached[0], failures: reached[1], alert: raiseAlert('brute_force', username, ctx, message) });
  }

  const DENIED = { ok: false, status: 401, kind: 'invalid_credentials', message: 'Incorrect username or password.' };
  const BAD_CODE = { ok: false, status: 401, kind: 'invalid_code', message: 'That code is not valid. Check your authenticator app and try again.' };
  const LOCKED = { ok: false, status: 429, kind: 'locked', message: 'Too many failed attempts. Please wait and try again later.' };

  function issueSession(username, role, kind, ctx, lifetimeMs) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const at = now().toISOString();
    insertSession.run(id, sha256(token), username, role, kind, ctx.ip, ctx.userAgent, at, at, iso(now().getTime() + lifetimeMs));
    return { token, id };
  }

  return {
    context,

    // ── Sign-in ──────────────────────────────────────────────────────────────

    async login(input, ctx) {
      const username = cleanName(input?.username);
      const password = input?.password;
      if (!username || typeof password !== 'string' || !password || password.length > MAX_PASSWORD) {
        record('auth.login_failed', clip(username), ctx, { reason: 'malformed', alert: raiseAlert('malformed_login', username, ctx, 'A login attempt was missing its username or password.') });
        return DENIED;
      }
      const name = clip(username);

      const locked = lockReason(name, ctx.ip);
      if (locked) {
        record('auth.login_blocked', name, ctx, { reason: locked });
        return LOCKED;
      }

      const keys = [`${name}|${ctx.ip}`, `u|${name}`, `i|${ctx.ip}`];
      keys.forEach(k => flight(k, 1));
      let correct;
      let user;
      try {
        user = userBy.get(name);
        correct = await verifyPassword(user, password);
      } finally {
        keys.forEach(k => flight(k, -1));
      }

      if (!correct || user.disabled_at) {
        const reason = !user ? 'unknown_user' : user.disabled_at ? 'account_disabled' : 'incorrect_password';
        record('auth.login_failed', name, ctx, { reason, alert: raiseAlert('incorrect_credentials', name, ctx, 'Access denied: incorrect credentials.') });
        noticeBruteForce(name, ctx);
        return DENIED;
      }

      const challenge = randomBytes(32).toString('base64url');
      const expiresAt = iso(now().getTime() + limits.challengeMs);
      transaction(db, () => {
        insertChallenge.run(sha256(challenge), name, ctx.ip, ctx.userAgent, expiresAt);
        record('auth.mfa_required', name, ctx, { expiresAt });
      });
      return { ok: true, mfaRequired: true, challenge, expiresAt };
    },

    async verifyCode(input, ctx) {
      const found = typeof input?.challenge === 'string' ? challengeBy.get(sha256(input.challenge)) : undefined;
      const nowMs = now().getTime();
      if (!found || found.used_at || found.expires_at <= iso(nowMs)) {
        const username = found?.username ?? '';
        record('auth.mfa_failed', username, ctx, { reason: !found ? 'unknown_challenge' : found.used_at ? 'challenge_closed' : 'challenge_expired', alert: raiseAlert('mfa_failed', username, ctx, 'A sign-in code was sent for a challenge that is not open.') });
        return { ok: false, status: 401, kind: 'challenge_expired', message: 'This sign-in has expired. Please start again.' };
      }
      const name = found.username;

      if (found.ip !== ctx.ip || found.user_agent !== ctx.userAgent) {
        burnChallenge.run(iso(nowMs), found.id_hash);
        record('auth.mfa_failed', name, ctx, { reason: 'challenge_moved', challengeIp: found.ip, alert: raiseAlert('mfa_failed', name, ctx, 'The second sign-in step came from a different IP address or browser than the first.') });
        return { ok: false, status: 401, kind: 'challenge_expired', message: 'This sign-in has expired. Please start again.' };
      }

      const locked = lockReason(name, ctx.ip);
      if (locked) {
        burnChallenge.run(iso(nowMs), found.id_hash);
        record('auth.login_blocked', name, ctx, { reason: locked, step: 'mfa' });
        return LOCKED;
      }

      const user = userBy.get(name);
      if (!user || user.disabled_at) {
        burnChallenge.run(iso(nowMs), found.id_hash);
        record('auth.mfa_failed', name, ctx, { reason: 'account_disabled', alert: raiseAlert('mfa_failed', name, ctx, 'A disabled account tried to finish signing in.') });
        return BAD_CODE;
      }

      let secret;
      try {
        secret = unseal(secretKey, user.totp_secret);
      } catch (err) {
        record('auth.mfa_failed', name, ctx, { reason: 'secret_unreadable', alert: raiseAlert('mfa_config', name, ctx, 'The stored authenticator secret could not be read. Has the auth key changed?') });
        throw err;
      }

      const code = String(input?.code ?? '').trim();
      const current = totpStep(nowMs);
      let matched = null;
      if (/^\d{6}$/.test(code)) {
        for (let s = current - TOTP_WINDOW; s <= current + TOTP_WINDOW; s++) {
          if (timingSafeEqual(Buffer.from(totp(secret, s)), Buffer.from(code))) { matched = s; break; }
        }
      }
      if (matched === null || matched <= user.last_totp_step) {
        const reason = matched === null ? 'incorrect_code' : 'code_reused';
        transaction(db, () => {
          bumpChallenge.run(found.id_hash);
          if (found.attempts + 1 >= limits.challengeAttempts) burnChallenge.run(iso(nowMs), found.id_hash);
          record('auth.mfa_failed', name, ctx, { reason, alert: raiseAlert('mfa_failed', name, ctx, `Second factor failed: ${reason}.`) });
        });
        noticeBruteForce(name, ctx);
        return BAD_CODE;
      }

      return transaction(db, () => {
        burnChallenge.run(iso(nowMs), found.id_hash);
        setStep.run(matched, name);
        const { token, id } = issueSession(name, user.role, 'user', ctx, limits.sessionMaxMs);
        record('auth.login_success', name, ctx, { sessionId: id, role: user.role, factors: ['password', 'totp'] });
        return { ok: true, token, user: { username: name, displayName: user.display_name, role: user.role } };
      });
    },

    // ── Sessions ─────────────────────────────────────────────────────────────

    // Who this request is: { who }, { problem } if it has a session that cannot be
    // honoured, or neither if it has none.
    authenticate(req) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) return {};
      const s = sessionBy.get(sha256(token));
      if (!s || s.revoked_at) return { problem: { kind: 'session_invalid', message: 'Your session is no longer valid. Please sign in again.' } };

      const ctx = context(req);
      const nowMs = now().getTime();
      const at = iso(nowMs);

      if (s.kind === 'user' && (!s.live_user || s.disabled_at)) {
        revokeSession.run(at, 'account_disabled', s.id);
        return { problem: { kind: 'session_invalid', message: 'Your session is no longer valid. Please sign in again.' } };
      }
      const idleLimit = Date.parse(s.last_seen_at) + limits.sessionIdleMs;
      if (s.expires_at <= at || idleLimit <= nowMs) {
        const reason = s.expires_at <= at ? 'max_age' : 'idle';
        transaction(db, () => {
          revokeSession.run(at, `expired_${reason}`, s.id);
          record('auth.session_expired', s.username, ctx, { sessionId: s.id, reason });
        });
        return { problem: { kind: 'session_expired', message: 'Your session has expired. Please sign in again.' } };
      }
      if (s.kind === 'user' && (s.ip !== ctx.ip || s.user_agent !== ctx.userAgent)) {
        const message = 'A session was used from a different IP address or browser than it was signed in from, so it was ended.';
        transaction(db, () => {
          revokeSession.run(at, 'hijack_suspected', s.id);
          record('auth.session_hijack_suspected', s.username, ctx, { sessionId: s.id, sessionIp: s.ip, sessionUserAgent: s.user_agent, alert: raiseAlert('session_hijack', s.username, ctx, message) });
        });
        return { problem: { kind: 'session_invalid', message: 'Your session is no longer valid. Please sign in again.' } };
      }

      if (nowMs - Date.parse(s.last_seen_at) >= 60000) touchSession.run(at, s.id);
      return { who: { user: s.username, role: s.live_role ?? s.role, sessionId: s.id } };
    },

    logout(who, ctx) {
      transaction(db, () => {
        revokeSession.run(now().toISOString(), 'logout', who.sessionId);
        record('auth.logout', who.user, ctx, { sessionId: who.sessionId });
      });
    },

    // For the deploy command's own check. Short-lived and not bound to a browser.
    serviceSession(name, role) {
      return issueSession(name, role, 'service', { ip: null, userAgent: null }, limits.serviceSessionMs);
    },

    endServiceSession(id) {
      revokeSession.run(now().toISOString(), 'service_done', id);
    },

    cookie(token, { secure = trustProxy } = {}) {
      return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${limits.sessionMaxMs / 1000}${secure ? '; Secure' : ''}`;
    },

    clearCookie({ secure = trustProxy } = {}) {
      return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
    },

    readAttempts({ alertsOnly = false, limit = 100 } = {}) {
      return alertsOnly
        ? audit.listActions({ only: ['auth.login_failed', 'auth.mfa_failed', 'auth.login_blocked', 'auth.brute_force_detected', 'auth.session_hijack_suspected'], limit })
        : audit.listActions({ prefix: 'auth.', limit });
    },

    // ── Account administration (used by npm run auth-admin) ──────────────────

    async addUser({ username, displayName = null, role, password, actor }) {
      const name = cleanName(username);
      if (!/^[a-z0-9._-]{2,64}$/.test(name)) throw new AuthAdminError('A username is 2 to 64 letters, digits, dots, dashes or underscores.');
      if (!ROLES.includes(role)) throw new AuthAdminError(`The role must be one of: ${ROLES.join(', ')}.`);
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthAdminError(`A password needs at least ${MIN_PASSWORD} characters.`);
      if (userBy.get(name)) throw new AuthAdminError(`${name} already exists; nothing was changed.`);
      const hash = await hashPassword(password);
      const secret = base32Encode(randomBytes(20));
      transaction(db, () => {
        insertUser.run(name, displayName, role, hash, seal(secretKey, secret), now().toISOString());
        audit.record({ actor, action: 'auth.user_added', entityType: 'auth', entityId: name, after: { role, displayName } });
      });
      return { username: name, role, totpSecret: secret, totpUri: totpUri(name, secret) };
    },

    resetAuthenticator({ username, actor }) {
      const name = cleanName(username);
      if (!userBy.get(name)) throw new AuthAdminError(`There is no user ${name}.`);
      const secret = base32Encode(randomBytes(20));
      transaction(db, () => {
        setTotp.run(seal(secretKey, secret), name);
        revokeUserSessions.run(now().toISOString(), 'authenticator_reset', name);
        audit.record({ actor, action: 'auth.authenticator_reset', entityType: 'auth', entityId: name });
      });
      return { username: name, totpSecret: secret, totpUri: totpUri(name, secret) };
    },

    async setPassword({ username, password, actor }) {
      const name = cleanName(username);
      if (!userBy.get(name)) throw new AuthAdminError(`There is no user ${name}.`);
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new AuthAdminError(`A password needs at least ${MIN_PASSWORD} characters.`);
      const hash = await hashPassword(password);
      transaction(db, () => {
        setPasswordHash.run(hash, name);
        revokeUserSessions.run(now().toISOString(), 'password_changed', name);
        audit.record({ actor, action: 'auth.password_changed', entityType: 'auth', entityId: name });
      });
    },

    disableUser({ username, actor }) {
      const name = cleanName(username);
      if (!userBy.get(name)) throw new AuthAdminError(`There is no user ${name}.`);
      transaction(db, () => {
        setDisabled.run(now().toISOString(), name);
        revokeUserSessions.run(now().toISOString(), 'account_disabled', name);
        audit.record({ actor, action: 'auth.user_disabled', entityType: 'auth', entityId: name });
      });
    },

    countUsers: () => db.prepare('SELECT COUNT(*) AS n FROM auth_user WHERE disabled_at IS NULL').get().n,
  };
}

const totpUri = (name, secret) =>
  `otpauth://totp/${encodeURIComponent(`Saratoga Springs Municipal:${name}`)}?secret=${secret}&issuer=${encodeURIComponent('Saratoga Springs Municipal')}&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}`;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}
