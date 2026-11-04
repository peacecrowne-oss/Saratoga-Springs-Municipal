// HTTP routes for the system. Kept free of start-up concerns so tests can
// build it with an in-memory database and a fake Tyler client.
//
//   GET  /system            the system dashboard page (health, deployments, assets)
//   GET  /budget            the budget tracking dashboard page
//   GET  /api/health        is the system up: database and audit trail checks
//   GET  /assets            the Asset Management Dashboard page (STORY-004)
//   GET  /api/assets        the inventory: ?status= &asset_type= &condition= &q= &limit= &offset=
//   POST /api/assets        create an asset record (audited; a repeat is a no-op)
//   GET  /api/assets/:id    one asset: lifecycle, condition, maintenance, GIS view
//   PATCH /api/assets/:id   change name, asset_type, status or location (audited)
//   GET  /api/assets/:id/history        that asset's audit trail
//   POST /api/assets/:id/conditions     record a condition reading, optionally moving the status
//   POST /api/assets/:id/maintenance    schedule a maintenance task
//   PATCH /api/assets/:id/maintenance/:taskId   complete or cancel a task
//   GET  /api/maintenance   everything still to do, soonest first
//   GET  /api/gis/status    the GIS sync now: last run, last failure, what needs attention
//   GET  /api/gis/log       the GIS sync's history (?errors=1 for only what went wrong)
//   GET  /login             the sign-in page (STORY-012)
//   POST /api/auth/login    step 1: username and password
//   POST /api/auth/mfa      step 2: the authenticator code; sets the session cookie
//   POST /api/auth/logout   ends the session
//   GET  /api/auth/me       who is signed in
//   GET  /api/auth/attempts every login attempt, for administrators (?alerts=1)
//   GET  /api/budget       budget lines from Tyler, for a financial manager
//   GET  /api/audit         recent audit events in the caller's scope (?entity_type=)

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuditWriteError } from './audit.js';
import { AssetConflictError, AssetStaleError, AssetTransitionError, AssetValidationError } from './assets.js';
import { AssetCareConflict, createAssetCare } from './asset-care.js';
import { createAuth } from './auth.js';
import { checkHealth } from './health.js';
import { describeGisEvent, gisStatus, readGisLog } from './gis-log.js';
import { TylerIntegrationError } from './integrations/tyler/client.js';

const APP_DIR = new URL('../app/', import.meta.url);
const PAGES = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/session.js': ['session.js', 'text/javascript; charset=utf-8'],
  '/system':['system.html', 'text/html; charset=utf-8'],
  '/system.js': ['system.js', 'text/javascript; charset=utf-8'],
  '/assets': ['assets.html', 'text/html; charset=utf-8'],
  '/assets.js': ['assets.js', 'text/javascript; charset=utf-8'],
  '/budget': ['budget.html', 'text/html; charset=utf-8'],
  '/budget.js': ['budget.js', 'text/javascript; charset=utf-8'],
};

export const BUDGET_ROLES = ['financial_manager'];
export const ASSET_ROLES = ['asset_manager', 'it_administrator'];
export const ASSET_READ_ROLES = [...ASSET_ROLES, 'gis_analyst'];
export const GIS_LOG_ROLES = ['gis_analyst', 'it_administrator'];
export const AUTH_LOG_ROLES = ['system_administrator', 'it_administrator'];
// Which audit events each role may read. The first is the default.
export const AUDIT_SCOPES = {
  financial_manager: ['budget'],
  asset_manager: ['asset'],
  gis_analyst: ['gis_sync', 'asset', 'gis_feature'],
  it_administrator: ['system', 'asset', 'gis_sync', 'gis_feature', 'budget', 'auth'],
  system_administrator: ['auth', 'system'],
};

const MAX_BODY_BYTES = 64 * 1024;

class BadRequest extends Error {}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, kind, message, extra = {}) => send(res, status, { error: { kind, message, ...extra } });

// Who the request is, as established by the session in handle() below.
const identify = req => req.who ?? null;

// FOR TESTS ONLY, and only when createApp is told allowDevHeaders. Nothing that
// starts the real system can turn this on.
function devIdentity(req) {
  const user = String(req.headers['x-user-id'] ?? '').trim();
  const role = String(req.headers['x-user-role'] ?? '').trim();
  return user && role ? { user, role } : null;
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest(`The request body is larger than ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new BadRequest(`The request body is not valid JSON: ${err.message}`);
  }
}

export function createApp({ db, audit, assets, care = createAssetCare(db, audit, assets), auth = createAuth(db, audit), tyler, version = null, allowDevHeaders = false, currentFiscalYear = () => new Date().getFullYear() }) {
  // ── Sign-in ────────────────────────────────────────────────────────────────

  // The body of a sign-in step. A malformed one is still an attempt, so it is
  // recorded rather than rejected before it reaches the auth service.
  async function signInBody(req) {
    try {
      return await readJson(req);
    } catch (err) {
      if (err instanceof BadRequest) return null;
      throw err;
    }
  }

  async function postLogin(req, res) {
    const result = await auth.login(await signInBody(req), auth.context(req));
    if (!result.ok) return fail(res, result.status, result.kind, result.message);
    return send(res, 200, { mfaRequired: true, challenge: result.challenge, expiresAt: result.expiresAt });
  }

  async function postMfa(req, res) {
    const result = await auth.verifyCode(await signInBody(req), auth.context(req));
    if (!result.ok) return fail(res, result.status, result.kind, result.message);
    res.setHeader('set-cookie', auth.cookie(result.token));
    return send(res, 200, { user: result.user });
  }

  function postLogout(req, res) {
    const who = identify(req);
    if (who?.sessionId) auth.logout(who, auth.context(req));
    res.setHeader('set-cookie', auth.clearCookie());
    return send(res, 200, { signedOut: true });
  }

  function getMe(req, res) {
    const who = identify(req);
    if (!who) return fail(res, 401, 'unauthenticated', 'Sign in to continue.');
    return send(res, 200, { user: { username: who.user, role: who.role } });
  }

  function getAttempts(req, res, url) {
    const who = identify(req);
    if (!who) return fail(res, 401, 'unauthenticated', 'Sign in to review login attempts.');
    if (!AUTH_LOG_ROLES.includes(who.role)) return fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to review login attempts.`);
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(res, 400, 'bad_request', 'limit must be a whole number from 1 to 500.');
    return send(res, 200, { events: auth.readAttempts({ alertsOnly: url.searchParams.get('alerts') === '1', limit }) });
  }

  // Stops another site making a signed-in person's browser change something:
  // the session cookie is SameSite=Strict, and writes must also come from this
  // origin and carry JSON, which a plain cross-site form cannot send.
  function crossSiteProblem(req) {
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.headers.host) return 'The request came from another site.';
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return 'The request must be sent as JSON.';
    return null;
  }

  function getHealth(res) {
    const health = checkHealth(db);
    return send(res, health.status === 'ok' ? 200 : 503, { ...health, version });
  }

  function allowRead(req, res) {
    const who = identify(req);
    if (!who) { fail(res, 401, 'unauthenticated', 'Sign in to work with assets.'); return null; }
    if (!ASSET_READ_ROLES.includes(who.role)) { fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to view assets.`); return null; }
    return who;
  }

  // A refused attempt to change an asset is on the record too.
  function allowWrite(req, res, assetId = null) {
    const who = identify(req);
    if (!who) { fail(res, 401, 'unauthenticated', 'Sign in to work with assets.'); return null; }
    if (!ASSET_ROLES.includes(who.role)) {
      audit.record({ actor: who.user, action: 'asset.update_denied', entityType: 'asset', entityId: assetId, after: { role: who.role, method: req.method, path: req.url } });
      fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to change assets.`);
      return null;
    }
    return who;
  }

  const noAsset = (res, id) => fail(res, 404, 'not_found', `No asset with id ${id}.`);

  async function patchAsset(req, res, id) {
    const who = allowWrite(req, res, id);
    if (!who) return;
    const result = assets.update({ actor: who.user, id, input: await readJson(req) });
    if (!result) return noAsset(res, id);
    return send(res, 200, { updated: result.updated, asset: care.view(assets.get(id), { detail: true }) });
  }

  async function postAsset(req, res) {
    const who = allowWrite(req, res);
    if (!who) return;
    const { created, asset } = assets.create({ actor: who.user, input: await readJson(req) });
    return send(res, created ? 201 : 200, { created, asset });
  }

  function getAssets(req, res, url) {
    if (!allowRead(req, res)) return;
    const p = url.searchParams;
    return send(res, 200, care.search({
      status: p.get('status') || undefined,
      assetType: p.get('asset_type') || undefined,
      condition: p.get('condition') || undefined,
      q: p.get('q') || undefined,
      limit: p.has('limit') ? Number(p.get('limit')) : undefined,
      offset: p.has('offset') ? Number(p.get('offset')) : undefined,
    }));
  }

  function getAsset(req, res, id) {
    if (!allowRead(req, res)) return;
    const asset = assets.get(id);
    return asset ? send(res, 200, { asset: care.view(asset, { detail: true }) }) : noAsset(res, id);
  }

  function getAssetHistory(req, res, id) {
    if (!allowRead(req, res)) return;
    if (!assets.get(id)) return noAsset(res, id);
    return send(res, 200, { events: audit.list({ entityType: 'asset', entityId: id, limit: 50 }) });
  }

  async function postCondition(req, res, id) {
    const who = allowWrite(req, res, id);
    if (!who) return;
    const result = care.recordCondition({ actor: who.user, assetId: id, input: await readJson(req) });
    if (!result) return noAsset(res, id);
    return send(res, result.recorded ? 201 : 200, result);
  }

  async function postMaintenance(req, res, id) {
    const who = allowWrite(req, res, id);
    if (!who) return;
    const result = care.scheduleMaintenance({ actor: who.user, assetId: id, input: await readJson(req) });
    if (!result) return noAsset(res, id);
    return send(res, result.created ? 201 : 200, result);
  }

  async function patchMaintenance(req, res, id, taskId) {
    const who = allowWrite(req, res, id);
    if (!who) return;
    const result = care.closeMaintenance({ actor: who.user, assetId: id, taskId, input: await readJson(req) });
    if (!result) return fail(res, 404, 'not_found', `No maintenance task ${taskId} on asset ${id}.`);
    return send(res, 200, result);
  }

  function allowGisLog(req, res) {
    const who = identify(req);
    if (!who) { fail(res, 401, 'unauthenticated', 'Sign in to review the GIS sync.'); return null; }
    if (!GIS_LOG_ROLES.includes(who.role)) { fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to review the GIS sync.`); return null; }
    return who;
  }

  function getGisLog(req, res, url) {
    if (!allowGisLog(req, res)) return;
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(res, 400, 'bad_request', 'limit must be a whole number from 1 to 500.');
    const errorsOnly = url.searchParams.get('errors') === '1';
    const events = readGisLog(audit, { errorsOnly, limit }).map(e => ({ ...e, summary: describeGisEvent(e) }));
    return send(res, 200, { events });
  }

  function getGisStatus(req, res) {
    if (!allowGisLog(req, res)) return;
    return send(res, 200, gisStatus(db, audit));
  }

  function getMaintenance(req, res) {
    if (!allowRead(req, res)) return;
    return send(res, 200, { tasks: care.openMaintenance() });
  }

  async function getBudget(req, res, url) {
    const who = identify(req);
    if (!who) return fail(res, 401, 'unauthenticated', 'Sign in to view budgets.');

    const fiscalYear = url.searchParams.has('fiscal_year') ? Number(url.searchParams.get('fiscal_year')) : currentFiscalYear();
    if (!Number.isInteger(fiscalYear)) return fail(res, 400, 'bad_request', 'fiscal_year must be a whole number.');

    const event = { actor: who.user, entityType: 'budget', entityId: String(fiscalYear) };

    if (!BUDGET_ROLES.includes(who.role)) {
      audit.record({ ...event, action: 'budget.view_denied', after: { role: who.role } });
      return fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to view budgets.`);
    }

    let budget;
    try {
      budget = await tyler.fetchBudget({ fiscalYear });
    } catch (err) {
      if (!(err instanceof TylerIntegrationError)) throw err;
      audit.record({ ...event, action: 'budget.view_failed', after: { kind: err.kind, message: err.message } });
      return send(res, 502, { connected: false, error: { kind: err.kind, message: err.message } });
    }

    // Logged before the data is sent: if this throws, the budget is withheld.
    audit.record({ ...event, action: 'budget.view', after: { lines: budget.lines.length, asOf: budget.asOf, simulated: budget.simulated } });
    return send(res, 200, { connected: true, fiscalYear, ...budget });
  }

  function getAudit(req, res, url) {
    const who = identify(req);
    if (!who) return fail(res, 401, 'unauthenticated', 'Sign in to view the audit trail.');
    const scopes = AUDIT_SCOPES[who.role] ?? [];
    const entityType = url.searchParams.get('entity_type') ?? scopes[0];
    if (!entityType || !scopes.includes(entityType)) {
      return fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to view ${entityType ?? 'the'} audit events.`);
    }
    return send(res, 200, { events: audit.list({ entityType, limit: 20 }) });
  }

  async function page(res, [file, type]) {
    const body = await fs.readFile(fileURLToPath(new URL(file, APP_DIR)));
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const { method } = req;

    if (pathname === '/login') { if (method === 'GET') return await page(res, PAGES['/login']); }
    if (pathname.startsWith('/api/auth/')) {
      if (method === 'POST' && pathname === '/api/auth/login') return await postLogin(req, res);
      if (method === 'POST' && pathname === '/api/auth/mfa') return await postMfa(req, res);
      if (method === 'POST' && pathname === '/api/auth/logout') return postLogout(req, res);
      if (method === 'GET' && pathname === '/api/auth/me') return getMe(req, res);
      if (method === 'GET' && pathname === '/api/auth/attempts') return getAttempts(req, res, url);
      return fail(res, 404, 'not_found', 'Not found.');
    }

    // /api/assets/:id[/:part[/:partId]]
    if (pathname === '/api/assets') {
      if (method === 'GET') return getAssets(req, res, url);
      if (method === 'POST') return await postAsset(req, res);
      return fail(res, 405, 'method_not_allowed', `${method} is not supported here.`);
    }
    if (pathname.startsWith('/api/assets/')) {
      const [id, part, partId, ...rest] = pathname.slice('/api/assets/'.length).split('/').map(decodeURIComponent);
      if (rest.length) return fail(res, 404, 'not_found', 'Not found.');
      if (part === undefined) {
        if (method === 'GET') return getAsset(req, res, id);
        if (method === 'PATCH') return await patchAsset(req, res, id);
      } else if (part === 'history' && partId === undefined && method === 'GET') {
        return getAssetHistory(req, res, id);
      } else if (part === 'conditions' && partId === undefined && method === 'POST') {
        return await postCondition(req, res, id);
      } else if (part === 'maintenance' && partId === undefined && method === 'POST') {
        return await postMaintenance(req, res, id);
      } else if (part === 'maintenance' && partId !== undefined && method === 'PATCH') {
        return await patchMaintenance(req, res, id, partId);
      }
      return fail(res, 404, 'not_found', 'Not found.');
    }

    if (method !== 'GET') return fail(res, 405, 'method_not_allowed', `${method} is not supported here.`);
    if (pathname === '/') { res.writeHead(302, { location: '/system' }); return res.end(); }
    if (pathname === '/api/health') return getHealth(res);
    if (pathname === '/api/maintenance') return getMaintenance(req, res);
    if (pathname === '/api/gis/log') return getGisLog(req, res, url);
    if (pathname === '/api/gis/status') return getGisStatus(req, res);
    if (pathname === '/api/budget') return await getBudget(req, res, url);
    if (pathname === '/api/audit') return getAudit(req, res, url);
    if (PAGES[pathname]) return await page(res, PAGES[pathname]);
    return fail(res, 404, 'not_found', 'Not found.');
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const isApi = url.pathname.startsWith('/api/');
      const isSignIn = url.pathname === '/api/auth/login' || url.pathname === '/api/auth/mfa';

      const { who, problem } = auth.authenticate(req);
      // A dead session must be told so, except where the person is signing in again.
      if (problem && isApi && !isSignIn && url.pathname !== '/api/health') {
        res.setHeader('set-cookie', auth.clearCookie());
        return fail(res, 401, problem.kind, problem.message);
      }
      req.who = who ?? (allowDevHeaders ? devIdentity(req) : null);

      if (isApi && req.method !== 'GET' && (who || isSignIn)) {
        const crossSite = crossSiteProblem(req);
        if (crossSite) return fail(res, 403, 'cross_site', crossSite);
      }

      return await route(req, res, url);
    } catch (err) {
      if (err instanceof BadRequest) return fail(res, 400, 'bad_request', err.message);
      if (err instanceof URIError) return fail(res, 400, 'bad_request', 'The address is not valid.');
      if (err instanceof AssetValidationError) return fail(res, 400, 'invalid', err.message, { problems: err.problems });
      if (err instanceof AssetConflictError) return fail(res, 409, 'conflict', err.message, { existing: err.existing });
      if (err instanceof AssetTransitionError) return fail(res, 409, err.kind, err.message, { from: err.from, to: err.to, allowed: err.allowed });
      if (err instanceof AssetStaleError) return fail(res, 409, err.kind, err.message, { current: err.current });
      if (err instanceof AssetCareConflict) return fail(res, 409, err.kind, err.message);
      if (err instanceof AuditWriteError) {
        console.error(err);
        return fail(res, 500, 'audit_unavailable', 'The audit trail is unavailable, so nothing was done or shown. Nothing happened unlogged.');
      }
      console.error(err);
      return fail(res, 500, 'internal', 'Something went wrong on the server.');
    }
  };
}
