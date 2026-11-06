// Generates the final test report (STORY-011):
//
//   npm run test-report
//
// Runs the whole automated test suite, then the end-to-end smoke test, then reads
// the user acceptance results and the latest migration from the database
// (DB_PATH, default data/app.db). Writes docs/TEST-REPORT.md, a JSON copy in
// data/test-reports/, and a row the Testing Dashboard shows.
//
// Exit codes: 0 complete and READY, 3 complete but NOT READY, 1 incomplete.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DB_PATH, openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createUat } from './uat.js';
import { createLegacy } from './legacy.js';
import { runSmoke } from './smoke.js';
import { buildReport, readTestResults, reportMarkdown, storyCoverage } from './final-report.js';

const readJson = file => { let t = fs.readFileSync(file, 'utf8'); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); return JSON.parse(t); };
const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
const outDir = path.join(path.dirname(dbPath), 'test-reports');
fs.mkdirSync(outDir, { recursive: true });
const resultsFile = path.join(os.tmpdir(), `test-results-${randomUUID()}.jsonl`);

console.log('Running the automated test suite…');
const suite = spawnSync(process.execPath, [
  '--disable-warning=ExperimentalWarning', '--test', '--test-timeout=180000',
  '--test-reporter=./tools/test-report/reporter.mjs', `--test-reporter-destination=${resultsFile}`,
  '--test-reporter=dot', '--test-reporter-destination=stdout',
], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60000 });
if (suite.error) console.error(`The test suite could not run: ${suite.error.message}`);
const automated = readTestResults(resultsFile);
fs.rmSync(resultsFile, { force: true });

console.log('\nRunning the end-to-end smoke test…');
let smoke = null;
try {
  smoke = await runSmoke({ log: c => console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `: ${c.detail}`}`) });
} catch (err) {
  console.error(`The smoke test could not start: ${err.stack ?? err.message}`);
}

const db = openDb(dbPath);
try {
  const audit = createAuditLog(db);
  const uat = createUat(db, audit).status();
  const migration = createLegacy(db).latestRun();
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { timeout: 5000 }).toString().trim(); } catch (err) { console.error(`git rev-parse failed: ${err.message.split('\n')[0]}`); }
  const coverage = storyCoverage(readJson('.colaberry/progress.json'), fs.existsSync('.colaberry/plan.json') ? readJson('.colaberry/plan.json') : null);

  const report = buildReport({ automated, smoke, uat, migration, coverage, generatedAt: new Date().toISOString(), commit });
  const markdown = reportMarkdown(report);
  fs.writeFileSync('docs/TEST-REPORT.md', markdown);
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  db.prepare('INSERT INTO test_report (id, generated_at, status, verdict, report) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), report.generatedAt, report.status, report.verdict, JSON.stringify(report));
  audit.record({ actor: `report:${os.userInfo().username}@${os.hostname()}`, action: 'test_report.generated', entityType: 'test_report', entityId: stamp,
    after: { status: report.status, verdict: report.verdict, missing: report.missing, reasons: report.reasons, commit } });

  console.log(`\nReport: ${report.status.toUpperCase()} · Verdict: ${report.verdict === 'ready' ? 'READY' : 'NOT READY'}`);
  for (const m of report.missing) console.log(`  missing: ${m}`);
  for (const r of report.reasons) console.log(`  - ${r}`);
  console.log('Written to docs/TEST-REPORT.md');
  process.exitCode = report.status !== 'complete' ? 1 : report.verdict === 'ready' ? 0 : 3;
} finally {
  db.close();
}
