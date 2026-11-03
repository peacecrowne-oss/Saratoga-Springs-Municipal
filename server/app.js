// HTTP routes for the system. Kept free of start-up concerns so tests can
// build it with an in-memory database and a fake Tyler client.
//
//   GET  /system            the system dashboard page (health, deployments, assets)
//   GET  /budget            the budget tracking dashboard page
//   GET  /api/health        is the system up: database and audit trail checks
//   GET  /api/assets        asset records, for an asset manager or IT administrator
//   POST /api/assets        create an asset record (audited; a repeat is a no-op)
//   GET  /api/assets/:id    one asset record, with its GIS view (STORY-002)
//   PATCH /api/assets/:id   change name, asset_type, status or location (audited)
//   GET  /api/budget        budget lines from Tyler, for a financial manager
//   GET  /api/audit         recent audit events in the caller's scope (?entity_type=)

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuditWriteError } from './audit.js';
import { AssetConflictError, AssetValidationError } from './assets.js';
import { checkHealth } from './health.js';
import { TylerIntegrationError } from './integrations/tyler/client.js';

const APP_DIR = new URL('../app/', import.meta.url);
const PAGES = {
  '/system': ['system.html', 'text/html; charset=utf-8'],
  '/system.js': ['system.js', 'text/javascript; charset=utf-8'],
  '/budget': ['budget.html', 'text/html; charset=utf-8'],
  '/budget.js': ['budget.js', 'text/javascript; charset=utf-8'],
};

export const BUDGET_ROLES = ['financial_manager'];
export const ASSET_ROLES = ['asset_manager', 'it_administrator'];
export const ASSET_READ_ROLES = [...ASSET_ROLES, 'gis_analyst'];
// Which audit events each role may read. The first is the default.
export const AUDIT_SCOPES = {
  financial_manager: ['budget'],
  asset_manager: ['asset'],
  gis_analyst: ['gis_sync', 'asset', 'gis_feature'],
  it_administrator: ['system', 'asset', 'gis_sync', 'gis_feature', 'budget'],
};

const MAX_BODY_BYTES = 64 * 1024;

class BadRequest extends Error {}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, kind, message, extra = {}) => send(res, status, { error: { kind, message, ...extra } });

// DEVELOPMENT ONLY: the caller states who they are in two headers.
// STORY-012 (authentication) replaces this with real sign-in.
function identify(req) {
  const user = String(req.headers['x-user-id'] ?? '').trim();
  const role = String(req.headers['x-user-role'] ?? '').trim();
  return user && role ? { user, role } : null;
}

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

export function createApp({ db, audit, assets, tyler, version = null, currentFiscalYear = () => new Date().getFullYear() }) {
  function getHealth(res) {
    const health = checkHealth(db);
    return send(res, health.status === 'ok' ? 200 : 503, { ...health, version });
  }

  function allowAssets(req, res, roles = ASSET_ROLES) {
    const who = identify(req);
    if (!who) { fail(res, 401, 'unauthenticated', 'Sign in to work with assets.'); return null; }
    if (!roles.includes(who.role)) { fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to ${roles === ASSET_ROLES ? 'change' : 'view'} assets.`); return null; }
    return who;
  }

  async function patchAsset(req, res, id) {
    const who = allowAssets(req, res);
    if (!who) return;
    const input = await readJson(req);
    try {
      const result = assets.update({ actor: who.user, id, input });
      if (!result) return fail(res, 404, 'not_found', `No asset with id ${id}.`);
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof AssetValidationError) return fail(res, 400, 'invalid', err.message, { problems: err.problems });
      throw err;
    }
  }

  async function postAsset(req, res) {
    const who = allowAssets(req, res);
    if (!who) return;
    const input = await readJson(req);
    try {
      const { created, asset } = assets.create({ actor: who.user, input });
      return send(res, created ? 201 : 200, { created, asset });
    } catch (err) {
      if (err instanceof AssetValidationError) return fail(res, 400, 'invalid', err.message, { problems: err.problems });
      if (err instanceof AssetConflictError) return fail(res, 409, 'conflict', err.message, { existing: err.existing });
      throw err;
    }
  }

  function getAssets(req, res) {
    if (!allowAssets(req, res, ASSET_READ_ROLES)) return;
    return send(res, 200, { assets: assets.list() });
  }

  function getAsset(req, res, id) {
    if (!allowAssets(req, res, ASSET_READ_ROLES)) return;
    const asset = assets.get(id);
    return asset ? send(res, 200, { asset }) : fail(res, 404, 'not_found', `No asset with id ${id}.`);
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
    if (req.method === 'POST' && pathname === '/api/assets') return await postAsset(req, res);
    if (req.method === 'PATCH' && pathname.startsWith('/api/assets/')) return await patchAsset(req, res, decodeURIComponent(pathname.slice('/api/assets/'.length)));
    if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', `${req.method} is not supported here.`);
    if (pathname === '/') { res.writeHead(302, { location: '/system' }); return res.end(); }
    if (pathname === '/api/health') return getHealth(res);
    if (pathname === '/api/assets') return getAssets(req, res);
    if (pathname.startsWith('/api/assets/')) return getAsset(req, res, decodeURIComponent(pathname.slice('/api/assets/'.length)));
    if (pathname === '/api/budget') return await getBudget(req, res, url);
    if (pathname === '/api/audit') return getAudit(req, res, url);
    if (PAGES[pathname]) return await page(res, PAGES[pathname]);
    return fail(res, 404, 'not_found', 'Not found.');
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      return await route(req, res, url);
    } catch (err) {
      if (err instanceof BadRequest) return fail(res, 400, 'bad_request', err.message);
      if (err instanceof AuditWriteError) {
        console.error(err);
        return fail(res, 500, 'audit_unavailable', 'The audit trail is unavailable, so nothing was done or shown. Nothing happened unlogged.');
      }
      console.error(err);
      return fail(res, 500, 'internal', 'Something went wrong on the server.');
    }
  };
}
