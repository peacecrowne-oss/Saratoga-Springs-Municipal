// Manages sign-in accounts on this machine:
//
//   npm run auth-admin -- add-user <username> --role <role> [--name "Full Name"]
//   npm run auth-admin -- reset-authenticator <username>
//   npm run auth-admin -- set-password <username>
//   npm run auth-admin -- disable <username>
//
// add-user and set-password read a password piped to stdin, or generate one. Any
// generated password and authenticator secret are shown once, here, and nowhere
// else: hand them to the person securely. Every action is audited.

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { DEFAULT_DB_PATH, openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { AuthAdminError, ROLES, createAuth, resolveAuthKey } from './auth.js';

const [command, username, ...rest] = process.argv.slice(2);
const option = name => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};

async function pipedPassword() {
  if (process.stdin.isTTY) return null;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() || null;
}

const showAuthenticator = ({ totpSecret, totpUri }) => {
  console.log('\nAdd this to an authenticator app (shown once):');
  console.log(`  Secret key: ${totpSecret}`);
  console.log(`  Or URI:     ${totpUri}`);
};

const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
const db = openDb(dbPath);
const auth = createAuth(db, createAuditLog(db), { secretKey: resolveAuthKey(dbPath) });
const actor = `admin:${os.userInfo().username}@${os.hostname()}`;

try {
  if (!username) throw new AuthAdminError('Usage: add-user | reset-authenticator | set-password | disable <username>');
  if (command === 'add-user') {
    if (!option('role')) throw new AuthAdminError(`Give a --role, one of: ${ROLES.join(', ')}.`);
    const piped = await pipedPassword();
    const password = piped ?? randomBytes(18).toString('base64url');
    const result = await auth.addUser({ username, role: option('role'), displayName: option('name') ?? null, password, actor });
    console.log(`Added ${result.username} as ${result.role}.`);
    if (!piped) console.log(`Generated password (shown once): ${password}`);
    showAuthenticator(result);
  } else if (command === 'reset-authenticator') {
    const result = auth.resetAuthenticator({ username, actor });
    console.log(`Reset the authenticator for ${result.username} and ended their sessions.`);
    showAuthenticator(result);
  } else if (command === 'set-password') {
    const piped = await pipedPassword();
    const password = piped ?? randomBytes(18).toString('base64url');
    await auth.setPassword({ username, password, actor });
    console.log(`Changed the password for ${username} and ended their sessions.`);
    if (!piped) console.log(`Generated password (shown once): ${password}`);
  } else if (command === 'disable') {
    auth.disableUser({ username, actor });
    console.log(`Disabled ${username} and ended their sessions.`);
  } else {
    throw new AuthAdminError(`Unknown command "${command}". Use add-user, reset-authenticator, set-password or disable.`);
  }
} catch (err) {
  if (!(err instanceof AuthAdminError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
