// End-to-end smoke test of the whole system (STORY-011): a real deployment on a
// throwaway database, real sign-in with real authenticator codes, and every
// module exercised over HTTP, with the SIMULATED Tyler, Caselle and ArcGIS
// stand-ins standing in for the City's systems.
//
// runSmoke() never throws for a failed check: it returns every check with what
// happened, so a report can show all of them. It throws only if it cannot start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAuth, parseCookies, resolveAuthKey, totp, totpStep } from './auth.js';
import { deploy } from './deploy.js';
import { runMigration } from './migration.js';
import { createStandin as createTyler } from '../tools/tyler-standin/server.js';
import { createStandin as createCaselle, DEFAULT_KEY } from '../tools/caselle-standin/server.js';
import { makeExport } from '../tools/cityworks-sample/make-export.js';

const ROLES = ['it_administrator', 'asset_manager', 'gis_analyst', 'financial_manager', 'code_enforcement_officer', 'permit_clerk', 'billing_manager'];
const PASSWORD = 'smoke-test-password-1';
const PAGES = ['/login', '/system', '/assets', '/permits', '/portal', '/history', '/budget'];

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

export async function runSmoke({ log = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const dbPath = path.join(dir, 'app.db');
  const checks = [];
  const started = Date.now();
  const tyler = createTyler();
  const caselle = createCaselle();
  let deployed;
  try {
    const tylerUrl = await listen(tyler.server);
    const caselleUrl = await listen(caselle.server);

    // Accounts for every staff role, and a migrated SIMULATED Cityworks export.
    const setupDb = openDb(dbPath);
    const setupAudit = createAuditLog(setupDb);
    const accounts = createAuth(setupDb, setupAudit, { secretKey: resolveAuthKey(dbPath), scryptCost: 2 ** 10 });
    const secrets = {};
    for (const role of ROLES) secrets[role] = (await accounts.addUser({ username: `smoke-${role}`, role, password: PASSWORD, actor: 'smoke' })).totpSecret;
    makeExport(path.join(dir, 'export'), { records: 6, attachments: 12 });
    const migration = await runMigration({ db: setupDb, audit: setupAudit, exportDir: path.join(dir, 'export'), attachmentsDir: path.join(dir, 'attachments'), actor: 'smoke' });
    setupDb.close();

    deployed = await deploy({ dbPath, port: 0, actor: 'smoke', tylerBaseUrl: tylerUrl, caselleBaseUrl: caselleUrl, caselleApiKey: DEFAULT_KEY, publicBaseUrl: 'http://smoke.invalid' });
    const base = deployed.url;
    const ua = { 'user-agent': 'smoke-test' };

    async function check(name, story, fn) {
      const t = Date.now();
      try {
        const detail = await fn();
        checks.push({ name, story, ok: true, detail: detail ?? '', ms: Date.now() - t });
      } catch (err) {
        checks.push({ name, story, ok: false, detail: err.message, ms: Date.now() - t });
      }
      log(checks.at(-1));
    }
    const expect = (cond, message) => { if (!cond) throw new Error(message); };
    const request = async (method, route, { cookie, body, headers = {} } = {}) => {
      const res = await fetch(base + route, {
        method, headers: { ...ua, ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
    };
    const sessions = {};
    async function signIn(role) {
      const step1 = await request('POST', '/api/auth/login', { body: { username: `smoke-${role}`, password: PASSWORD } });
      expect(step1.status === 200, `password step answered ${step1.status}`);
      const res = await fetch(`${base}/api/auth/mfa`, {
        method: 'POST', headers: { ...ua, 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: step1.body.challenge, code: totp(secrets[role], totpStep(Date.now())) }), signal: AbortSignal.timeout(15000),
      });
      expect(res.status === 200, `code step answered ${res.status}`);
      sessions[role] = `sid=${parseCookies(res.headers.get('set-cookie')).sid}`;
    }
    const as = role => sessions[role];

    await check('Deployment is healthy', 'STORY-001', async () => {
      const r = await request('GET', '/api/health');
      expect(r.status === 200 && r.body.status === 'ok', `health answered ${r.status}`);
    });
    await check('Every page is served', 'STORY-000', async () => {
      for (const p of PAGES) expect((await request('GET', p)).status === 200, `${p} did not load`);
      return `${PAGES.length} pages`;
    });
    await check('Every role signs in with password and authenticator code', 'STORY-012', async () => {
      for (const role of ROLES) await signIn(role);
      return `${ROLES.length} roles`;
    });
    await check('A wrong password is refused', 'STORY-012', async () => {
      const r = await request('POST', '/api/auth/login', { body: { username: 'smoke-asset_manager', password: 'wrong-password-123' } });
      expect(r.status === 401, `answered ${r.status}`);
    });
    await check('Assets: add, record condition, schedule maintenance', 'STORY-004', async () => {
      const add = await request('POST', '/api/assets', { cookie: as('asset_manager'), body: { asset_tag: 'SMOKE-1', name: 'Smoke hydrant', asset_type: 'hydrant', location: 'Broadway' } });
      expect(add.status === 201, `add answered ${add.status}`);
      const id = add.body.asset.id;
      const cond = await request('POST', `/api/assets/${id}/conditions`, { cookie: as('asset_manager'), body: { condition: 'fair', observed_at: new Date().toISOString() } });
      expect(cond.status === 201, `condition answered ${cond.status}`);
      const due = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-CA');
      const task = await request('POST', `/api/assets/${id}/maintenance`, { cookie: as('asset_manager'), body: { title: 'Flush', due_on: due } });
      expect(task.status === 201, `maintenance answered ${task.status}`);
      const history = await request('GET', `/api/assets/${id}/history`, { cookie: as('asset_manager') });
      expect(history.body.events.length >= 3, 'the audit trail is short');
    });
    await check('GIS sync status is readable', 'STORY-002', async () => {
      const r = await request('GET', '/api/gis/status', { cookie: as('gis_analyst') });
      expect(r.status === 200, `answered ${r.status}`);
    });
    await check('Budget comes from Tyler (SIMULATED)', 'STORY-005', async () => {
      const r = await request('GET', '/api/budget', { cookie: as('financial_manager') });
      expect(r.status === 200 && r.body.lines.length > 0, `answered ${r.status}`);
    });
    await check('Billing comes from Caselle (SIMULATED), and its outage is named', 'STORY-010', async () => {
      const r = await request('GET', '/api/billing/accounts/SIM-1001', { cookie: as('billing_manager') });
      expect(r.status === 200 && r.body.account.balanceCents === 12995, `answered ${r.status}`);
      caselle.setMode('down');
      const down = await request('GET', '/api/billing/accounts/SIM-1001', { cookie: as('billing_manager') });
      caselle.setMode('ok');
      expect(down.status === 502 && /Cannot connect to Caselle/.test(down.body.error.message), `outage answered ${down.status}`);
    });
    let permitId;
    await check('Permits: a clerk submits, an officer approves', 'STORY-006', async () => {
      const sub = await request('POST', '/api/permits', { cookie: as('permit_clerk'), body: {
        permit_type: 'code_enforcement', submission_key: 'smoke-1', applicant_name: 'Smoke Resident', applicant_contact: 'smoke@example.test',
        property_address: '1 Smoke St', code_section: '240-1', description: 'Smoke test' } });
      expect(sub.status === 201, `submit answered ${sub.status}`);
      permitId = sub.body.permit.id;
      const ok = await request('POST', `/api/permits/${permitId}/decision`, { cookie: as('code_enforcement_officer'), body: {
        decision: 'approved', reason: 'Smoke test', checks: { code_section_verified: true, site_inspected: true } } });
      expect(ok.status === 200 && ok.body.permit.status === 'approved', `decision answered ${ok.status}`);
    });
    await check('Portal: a resident applies, is confirmed, books an inspection', 'STORY-007', async () => {
      const sub = await request('POST', '/api/portal/applications', { body: {
        submission_key: 'smoke-portal-1', applicant_name: 'Smoke Resident', applicant_contact: 'smoke@example.test',
        property_address: '2 Smoke St', code_section: '240-2', description: 'Smoke test' } });
      expect(sub.status === 201 && sub.body.confirmation.status === 'sent', `submit answered ${sub.status}`);
      const day = new Date(Date.now() + 86400000);
      while ([0, 6].includes(day.getDay())) day.setDate(day.getDate() + 1);
      const date = day.toLocaleDateString('en-CA');
      const book = await request('POST', '/api/portal/inspection', { body: { date }, headers: { 'x-portal-token': sub.body.token } });
      expect(book.status === 200 && book.body.application.inspectionOn === date, `booking answered ${book.status}`);
    });
    await check('Cityworks history is migrated, trusted and read-only', 'STORY-013', async () => {
      expect(migration.verdict === 'trusted', `the migration was ${migration.verdict}`);
      const list = await request('GET', '/api/legacy/records', { cookie: as('code_enforcement_officer') });
      expect(list.status === 200 && list.body.total === 24, `search answered ${list.status} with ${list.body.total}`);
      const write = await request('PATCH', `/api/legacy/records/${encodeURIComponent(list.body.records[0].id)}`, { cookie: as('it_administrator'), body: { status: 'X' } });
      expect(write.status === 405, `a write answered ${write.status}`);
    });
    await check('Roles are enforced', 'STORY-012', async () => {
      expect((await request('GET', '/api/budget', { cookie: as('asset_manager') })).status === 403, 'an asset manager saw the budget');
      expect((await request('GET', '/api/billing/accounts/SIM-1001', { cookie: as('it_administrator') })).status === 403, 'an administrator made a billing request');
      expect((await request('GET', '/api/assets')).status === 401, 'a stranger saw assets');
    });
    await check('Every action above is on the audit trail', 'STORY-001', async () => {
      const r = await request('GET', '/api/audit?entity_type=permit', { cookie: as('it_administrator') });
      expect(r.status === 200 && r.body.events.some(e => e.action === 'permit.approve'), 'no permit approval in the audit trail');
    });
    return { ok: checks.every(c => c.ok), checks, ms: Date.now() - started };
  } finally {
    if (deployed) await deployed.stop();
    await close(tyler.server);
    await close(caselle.server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
