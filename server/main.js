// Deploys and runs the system on this machine:  npm run deploy  (or npm start)
// then open http://127.0.0.1:3000/system
//
// Settings come from the environment, or from a local .env file that is never
// committed:
//   HOST              default 127.0.0.1
//   PORT              default 3000
//   DB_PATH           default data/app.db
//   TRUST_PROXY       1 when behind a TLS reverse proxy: required to listen on anything
//                     but this machine; takes the client IP from X-Forwarded-For and
//                     marks the session cookie Secure
//   AUTH_SECRET_KEY   32 bytes, base64, encrypting authenticator secrets (default: a
//                     key file created beside the database; see docs/SECURITY.md)
//   DEPLOY_ACTOR      who is deploying, for the audit trail (default: OS user@host)
//   DEPLOY_COMMIT     the commit being deployed (default: git rev-parse HEAD)
//   TYLER_BASE_URL    where Tyler's budget API is, e.g. http://127.0.0.1:4100
//                     for the SIMULATED stand-in (npm run standin)
//   TYLER_API_KEY     only if the Tyler endpoint needs one
//   PUBLIC_BASE_URL   the portal's public address, for the links sent to residents
//                     (default: http://HOST:PORT)
//
// Exits non-zero, naming the failed step, if the deployment does not come up.

import { deploy, DeployError } from './deploy.js';

try {
  const { url, event, stop, users } = await deploy();
  const d = event.after;
  console.log(`Deployed ${d.version} (${d.commit ?? 'commit unknown'}) on ${d.host} in ${d.durationMs} ms.`);
  console.log(`Checks: ${d.checks.map(c => `${c.name} ok`).join(', ')}.`);
  console.log(`Audit entry ${event.id} (system.deploy) written at ${event.occurredAt}.`);
  console.log(`System dashboard: ${url}/system`);
  console.log(`Public portal:    ${url}/portal`);
  console.log('Resident emails: SIMULATED. No mail service is connected, so nothing is actually sent; the portal shows each message.');
  if (!users) console.log('No user accounts yet, so nobody can sign in. Create one: npm run auth-admin -- add-user <username> --role it_administrator');
  if (!d.tylerConfigured) console.log('Tyler integration: not configured (set TYLER_BASE_URL). The budget page will say so.');

  const shutdown = async signal => {
    console.log(`${signal}: stopping.`);
    await stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (err) {
  if (!(err instanceof DeployError)) throw err;
  console.error(`DEPLOYMENT FAILED (${err.kind}): ${err.message}`);
  if (err.details.checks) console.error(`Checks: ${err.details.checks.map(c => `${c.name} ${c.ok ? 'ok' : 'FAILED'}`).join(', ')}.`);
  console.error(err.details.auditRecorded
    ? 'The failure was written to the audit trail as system.deploy_failed.'
    : `The failure could NOT be written to the audit trail${err.details.auditError ? `: ${err.details.auditError}` : '.'}`);
  process.exitCode = 1;
}
