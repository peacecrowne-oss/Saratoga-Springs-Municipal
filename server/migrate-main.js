// Runs the Cityworks migration (STORY-013):
//
//   npm run migrate -- <export-dir> [--resolutions <file.json>] [--report-dir <dir>]
//
// The export layout is described in server/migration.js. For a SIMULATED export:
//   node tools/cityworks-sample/make-export.js data/sample-export
//
// Writes the reconciliation report as JSON and Markdown (default data/migration-reports/).
// Settings: DB_PATH (as for deploy), ATTACHMENTS_DIR (default: attachments/ beside
// the database), MIGRATION_MAX_ATTACHMENT_BYTES (a storage quota, if any).
//
// Exit codes: 0 trusted, 3 completed but not trusted, 1 refused or failed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DB_PATH, openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { MIGRATION_LIMITS, MigrationRefused, reportMarkdown, runMigration } from './migration.js';

const [exportDir, ...rest] = process.argv.slice(2);
const option = name => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
if (!exportDir) {
  console.error('Usage: npm run migrate -- <export-dir> [--resolutions <file.json>] [--report-dir <dir>]');
  process.exit(2);
}

const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
const reportDir = option('report-dir') ?? path.join(path.dirname(dbPath), 'migration-reports');
const quota = process.env.MIGRATION_MAX_ATTACHMENT_BYTES;
const db = openDb(dbPath);
try {
  const started = Date.now();
  const report = await runMigration({
    db,
    audit: createAuditLog(db),
    exportDir,
    attachmentsDir: process.env.ATTACHMENTS_DIR ?? path.join(path.dirname(dbPath), 'attachments'),
    actor: `migration:${os.userInfo().username}@${os.hostname()}`,
    resolutionsFile: option('resolutions') ?? null,
    limits: { ...MIGRATION_LIMITS, ...(quota && { maxTotalBytes: Number(quota) }) },
  });
  fs.mkdirSync(reportDir, { recursive: true });
  const base = path.join(reportDir, report.runId);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, reportMarkdown(report));

  console.log(`Migration ${report.runId} finished in ${Date.now() - started} ms${report.source.simulated ? ' (SIMULATED export)' : ''}.`);
  console.log(`Records: ${report.records.map(r => `${r.type} ${r.target}/${r.source}`).join(', ')}.`);
  console.log(`Attachments: ${report.attachments.stored} stored, ${report.attachments.verified} verified, ${report.attachments.notMigrated} not migrated.`);
  console.log(`GIS: ${report.gis.linked} linked, ${report.gis.unresolved} to resolve, ${report.gis.orphaned} orphaned.`);
  console.log(`VERDICT: ${report.verdict === 'trusted' ? 'TRUSTED' : 'NOT TRUSTED'}`);
  for (const f of report.failures) console.log(`  - ${f}`);
  console.log(`Report: ${base}.md`);
  if (report.verdict !== 'trusted') process.exitCode = 3;
} catch (err) {
  if (!(err instanceof MigrationRefused)) throw err;
  console.error(`MIGRATION REFUSED (${err.kind}): ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
