// The headless Caselle job (STORY-010): a billing request made from the command
// line, with the same rules and audit record as the API.
//
//   npm run caselle -- account <account_number>
//
// Settings: CASELLE_BASE_URL, CASELLE_API_KEY, DB_PATH (as for deploy). For the
// SIMULATED stand-in:  npm run caselle-standin, then CASELLE_BASE_URL=http://127.0.0.1:4300
// and CASELLE_API_KEY=simulated-key.
//
// Exits non-zero when the billing information could not be retrieved.

import os from 'node:os';
import { DEFAULT_DB_PATH, openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createBilling } from './billing.js';
import { createCaselleClient } from './integrations/caselle/client.js';

const [command, accountNumber] = process.argv.slice(2);
if (command !== 'account' || !accountNumber) {
  console.error('Usage: npm run caselle -- account <account_number>');
  process.exit(2);
}

const db = openDb(process.env.DB_PATH ?? DEFAULT_DB_PATH);
try {
  const billing = createBilling({
    audit: createAuditLog(db),
    caselle: createCaselleClient({ baseUrl: process.env.CASELLE_BASE_URL, apiKey: process.env.CASELLE_API_KEY }),
  });
  const actor = `job:${os.userInfo().username}@${os.hostname()}`;
  const { status, body } = await billing.lookup({ actor, accountNumber, context: { via: 'caselle-job' } });
  if (status !== 200) {
    console.error(`BILLING REQUEST FAILED (${body.error.kind}): ${body.error.message}`);
    process.exitCode = 1;
  } else {
    const a = body.account;
    const money = c => `$${(c / 100).toFixed(2)}`;
    console.log(`${a.accountNumber} · ${a.status} · balance ${money(a.balanceCents)} · as of ${body.asOf}${body.simulated ? ' · SIMULATED data' : ''}`);
    for (const b of a.bills) console.log(`  ${b.billId}  billed ${b.billDate}  due ${b.dueDate}  ${money(b.amountCents)}  owed ${money(b.amountDueCents)}  ${b.status}`);
  }
  console.log(`Logged to the audit trail as ${actor}.`);
} finally {
  db.close();
}
