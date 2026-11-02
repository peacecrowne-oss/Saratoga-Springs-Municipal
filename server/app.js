// HTTP routes for the system. Kept free of start-up concerns so tests can
// build it with an in-memory database and a fake Tyler client.
//
//   GET /budget             the budget tracking dashboard page
//   GET /api/budget         budget lines from Tyler, for a financial manager
//   GET /api/audit          recent budget audit events, for a financial manager

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuditWriteError } from './audit.js';
import { TylerIntegrationError } from './integrations/tyler/client.js';

const APP_DIR = new URL('../app/', import.meta.url);
const PAGES = {
  '/budget': ['budget.html', 'text/html; charset=utf-8'],
  '/budget.js': ['budget.js', 'text/javascript; charset=utf-8'],
};

export const BUDGET_ROLES = ['financial_manager'];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status, kind, message) => send(res, status, { error: { kind, message } });

// DEVELOPMENT ONLY: the caller states who they are in two headers.
// STORY-009 (role-based access control) replaces this with real sign-in.
function identify(req) {
  const user = String(req.headers['x-user-id'] ?? '').trim();
  const role = String(req.headers['x-user-role'] ?? '').trim();
  return user && role ? { user, role } : null;
}

export function createApp({ audit, tyler, currentFiscalYear = () => new Date().getFullYear() }) {
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

  function getAudit(req, res) {
    const who = identify(req);
    if (!who) return fail(res, 401, 'unauthenticated', 'Sign in to view the audit trail.');
    if (!BUDGET_ROLES.includes(who.role)) return fail(res, 403, 'forbidden', `The ${who.role} role is not allowed to view the budget audit trail.`);
    return send(res, 200, { events: audit.list({ entityType: 'budget', limit: 20 }) });
  }

  async function page(res, [file, type]) {
    const body = await fs.readFile(fileURLToPath(new URL(file, APP_DIR)));
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Only GET is supported.');
      if (url.pathname === '/') { res.writeHead(302, { location: '/budget' }); return res.end(); }
      if (url.pathname === '/api/budget') return await getBudget(req, res, url);
      if (url.pathname === '/api/audit') return getAudit(req, res);
      if (PAGES[url.pathname]) return await page(res, PAGES[url.pathname]);
      return fail(res, 404, 'not_found', 'Not found.');
    } catch (err) {
      if (err instanceof AuditWriteError) {
        console.error(err);
        return fail(res, 500, 'audit_unavailable', 'The audit trail is unavailable, so the budget is withheld. Nothing was shown unlogged.');
      }
      console.error(err);
      return fail(res, 500, 'internal', 'Something went wrong on the server.');
    }
  };
}
