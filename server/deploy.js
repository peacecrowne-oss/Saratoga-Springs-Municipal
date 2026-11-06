// Deploys the system on this machine (REQ-002: on-premises) and proves it is
// up before calling the deployment done (STORY-001):
//
//   1. open the database and create its tables   (core_init_failed)
//   2. start listening on host:port               (network)
//   3. GET /api/health until it answers ok        (unreachable / unhealthy)
//   4. read /api/assets as the deployer           (core_check_failed)
//   5. write a system.deploy audit event          (audit_failed)
//
// A deployment is only complete once step 5 is written. Any failure after
// step 1 is itself audited as system.deploy_failed, the server is closed,
// and a DeployError is thrown naming the step that failed.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { createAuth, resolveAuthKey, SESSION_COOKIE } from './auth.js';
import { createTylerClient } from './integrations/tyler/client.js';
import { createApp } from './app.js';
import { createPermits } from './permits.js';
import { createNotifier, simulatedTransport } from './notify.js';
import { createPortal } from './portal.js';

export class DeployError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'DeployError';
    this.kind = kind;
    this.details = details;
  }
}

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function currentCommit() {
  if (process.env.DEPLOY_COMMIT) return { commit: process.env.DEPLOY_COMMIT };
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { commit: sha.toString().trim() };
  } catch (err) {
    return { commit: null, commitError: `git rev-parse failed: ${err.message.split('\n')[0]}` };
  }
}

function deployer() {
  if (process.env.DEPLOY_ACTOR) return process.env.DEPLOY_ACTOR;
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch (err) {
    return `unknown@${os.hostname()} (${err.message})`;
  }
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const closeServer = server => new Promise(resolve => {
  if (!server.listening) return resolve();
  server.close(() => resolve());
  server.closeAllConnections();
});

export async function deploy({
  dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH,
  host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 3000),
  tylerBaseUrl = process.env.TYLER_BASE_URL,
  tylerApiKey = process.env.TYLER_API_KEY,
  actor = deployer(),
  checkTimeoutMs = 3000,
  checkRetries = 3,
  retryDelayMs = 500,
  fetchImpl = fetch,
  sleep = defaultSleep,
  makeAudit = createAuditLog,
  now = () => new Date(),
  trustProxy = process.env.TRUST_PROXY === '1',
  allowDevHeaders = false, // tests only: deliberately not readable from the environment
  publicBaseUrl = process.env.PUBLIC_BASE_URL, // the portal address put in residents' links
  notifyTransport = simulatedTransport(),
  notifyRetryMs = 60000,
} = {}) {
  const started = now();
  const checks = [];
  const details = () => ({
    version: VERSION,
    ...currentCommit(),
    node: process.version,
    host: os.hostname(),
    listen: `${host}:${port}`,
    database: dbPath,
    tylerConfigured: Boolean(tylerBaseUrl),
    checks,
    startedAt: started.toISOString(),
    durationMs: now() - started,
  });

  // 1. Core: database and its tables. Without it nothing can be audited.
  let db;
  try {
    db = openDb(dbPath);
    checks.push({ name: 'database', ok: true });
  } catch (err) {
    checks.push({ name: 'database', ok: false, detail: err.message });
    throw new DeployError('core_init_failed',
      `The database at ${dbPath} could not be opened: ${err.message}. Nothing was started, and no audit entry could be written because the audit trail lives in that database.`,
      { ...details(), auditRecorded: false });
  }

  const audit = makeAudit(db);
  const assets = createAssetStore(db, audit);
  const tyler = createTylerClient({ baseUrl: tylerBaseUrl, apiKey: tylerApiKey });
  // Passwords must not cross a network in clear text. This server speaks plain
  // HTTP, so anything but this machine has to come through a TLS proxy.
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !trustProxy) {
    db.close();
    throw new DeployError('insecure_transport',
      `Refusing to listen on ${host} without TLS: sign-in would send passwords in clear text. Put a TLS reverse proxy in front and set TRUST_PROXY=1, or listen on 127.0.0.1.`,
      { ...details(), auditRecorded: false });
  }
  let secretKey;
  try {
    secretKey = resolveAuthKey(dbPath);
  } catch (err) {
    db.close();
    throw new DeployError('core_init_failed', `The sign-in key could not be loaded: ${err.message}. Nothing was started.`, { ...details(), auditRecorded: false });
  }
  const auth = createAuth(db, audit, { secretKey, trustProxy });
  const permits = createPermits(db, audit);
  const notifier = createNotifier(db, audit, { transport: notifyTransport });
  const portal = createPortal(db, audit, permits, notifier, { secretKey, publicBaseUrl: publicBaseUrl ?? `http://${host}:${port}` });
  const server = http.createServer(createApp({ db, audit, assets, permits, notifier, portal, auth, tyler, version: VERSION, allowDevHeaders }));

  async function abort(kind, message) {
    await closeServer(server);
    const failure = { ...details(), kind, message };
    let auditRecorded = false;
    let auditError;
    try {
      audit.record({ actor, action: 'system.deploy_failed', entityType: 'system', entityId: 'deployment', after: failure });
      auditRecorded = true;
    } catch (err) {
      auditError = err.message;
    }
    db.close();
    return new DeployError(kind, message, { ...failure, auditRecorded, ...(auditError && { auditError }) });
  }

  // 2. Network: take the port.
  try {
    await listen(server, port, host);
    checks.push({ name: 'listen', ok: true });
  } catch (err) {
    checks.push({ name: 'listen', ok: false, detail: err.code ?? err.message });
    throw await abort('network', `Could not listen on ${host}:${port} (${err.code ?? err.message}).`);
  }
  const url = `http://${host}:${server.address().port}`;

  // 3 and 4. Health, then one real call to a core function. Both over HTTP,
  // each with a timeout and capped retries.
  async function call(path, headers = {}) {
    let last;
    for (let attempt = 1; attempt <= checkRetries + 1; attempt++) {
      try {
        const res = await fetchImpl(url + path, { headers, signal: AbortSignal.timeout(checkTimeoutMs) });
        const body = await res.json();
        return { status: res.status, body, attempts: attempt };
      } catch (err) {
        last = err;
        if (attempt <= checkRetries) await sleep(retryDelayMs);
      }
    }
    throw Object.assign(last, { attempts: checkRetries + 1 });
  }

  let health;
  try {
    health = await call('/api/health');
  } catch (err) {
    checks.push({ name: 'health', ok: false, detail: err.message, attempts: err.attempts });
    throw await abort('unreachable', `The system did not answer its health check at ${url} after ${err.attempts} attempts: ${err.message}.`);
  }
  if (health.status !== 200 || health.body.status !== 'ok') {
    checks.push({ name: 'health', ok: false, detail: health.body.checks, attempts: health.attempts });
    throw await abort('unhealthy', `The health check at ${url} answered ${health.status}: ${JSON.stringify(health.body.checks)}.`);
  }
  checks.push({ name: 'health', ok: true, attempts: health.attempts });

  // The check signs in like anyone else, with a session that lives only for it.
  const probe = auth.serviceSession('deploy-check', 'it_administrator');
  let core;
  try {
    core = await call('/api/assets', { cookie: `${SESSION_COOKIE}=${probe.token}` });
    auth.endServiceSession(probe.id);
  } catch (err) {
    checks.push({ name: 'assets', ok: false, detail: err.message, attempts: err.attempts });
    throw await abort('core_check_failed', `The asset records did not answer at ${url}: ${err.message}.`);
  }
  if (core.status !== 200 || !Array.isArray(core.body.assets)) {
    checks.push({ name: 'assets', ok: false, detail: `HTTP ${core.status}` });
    throw await abort('core_check_failed', `The asset records answered ${core.status} at ${url}.`);
  }
  checks.push({ name: 'assets', ok: true, assets: core.body.assets.length });

  // 5. The deployment is not done until it is on the record.
  let event;
  try {
    event = audit.record({ actor, action: 'system.deploy', entityType: 'system', entityId: 'deployment', after: { ...details(), url } });
  } catch (err) {
    checks.push({ name: 'audit', ok: false, detail: err.message });
    await closeServer(server);
    db.close();
    throw new DeployError('audit_failed',
      `The system started but the deployment could not be written to the audit trail (${err.message}), so it was stopped. A deployment that is not on the record does not count.`,
      { ...details(), auditRecorded: false });
  }

  // Messages to residents that did not go out are retried in the background.
  let retrying = null;
  const retryTimer = setInterval(() => {
    if (retrying) return;
    retrying = notifier.retryDue()
      .catch(err => console.error(`[notification retry failed] ${err.stack ?? err.message}`))
      .finally(() => { retrying = null; });
  }, notifyRetryMs);
  retryTimer.unref();

  return {
    url,
    event,
    server,
    db,
    notifier,
    users: auth.countUsers(),
    async stop() {
      clearInterval(retryTimer);
      await retrying;
      await closeServer(server);
      db.close();
    },
  };
}
