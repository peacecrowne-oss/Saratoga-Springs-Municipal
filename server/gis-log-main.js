// Reviews the GIS Sync Job:  npm run gis-log            (recent events)
//                            npm run gis-log -- --errors (only what went wrong)
//
// Reads the same database as the job (DB_PATH, default data/app.db).

import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { describeGisEvent, gisStatus, readGisLog } from './gis-log.js';

const db = openDb();
const audit = createAuditLog(db);
const errorsOnly = process.argv.includes('--errors');

const status = gisStatus(db, audit);
console.log(`Last run: ${status.lastRun?.occurredAt ?? 'none recorded'} · last failure: ${status.lastFailure?.occurredAt ?? 'none recorded'} · whole layer last compared: ${status.lastReconcileAt ?? 'never'}`);
console.log(`Assets linked by status: ${Object.entries(status.links).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'} · no GIS point yet: ${status.awaitingLocation}`);
if (status.attention.length) {
  console.log('\nNeeds attention now:');
  for (const a of status.attention) {
    const why = a.lastError?.description ?? a.spatialProblem?.message ?? (a.mismatch ? 'A field we own was edited in GIS.' : a.status);
    console.log(`  ${a.assetTag}  ${a.status}  ${why}`);
  }
}

const events = readGisLog(audit, { errorsOnly }).reverse();
console.log(`\n${errorsOnly ? 'Errors and flags' : 'Events'}, oldest first${events.length ? '' : ': none recorded'}:`);
for (const e of events) console.log(`  ${e.occurredAt}  ${e.action.padEnd(20)} ${describeGisEvent(e)}`);

db.close();
