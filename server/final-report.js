// The final test report (STORY-011): automated tests, an end-to-end smoke test
// against a real deployment, user acceptance results, the latest migration
// reconciliation, and what is known not to be built.
//
// A report is COMPLETE only when every section has real content: the test suite
// ran and produced results, the smoke test ran, every story in the plan has tests
// on record, the acceptance scenarios are listed, and the known gaps are stated.
// Otherwise it says INCOMPLETE and names what is missing.
//
// The verdict is separate. READY needs a complete report, every automated test and
// smoke check passing, and user acceptance accepted (every scenario run, all
// passing, no critical issue open). Anything else is NOT READY, with the reasons.

import fs from 'node:fs';
import path from 'node:path';

// What is known not to be built or not proven, stated in every report.
export const KNOWN_GAPS = [
  { requirement: 'REQ-010', gap: 'No Windows Active Directory or single sign-on: accounts are local (password + authenticator code).' },
  { requirement: 'REQ-011', gap: 'Only Caselle is integrated, and only against a SIMULATED stand-in. Granicus/311, ComplianceGO, Bluebeam Revu, Utilisync and XpressBillPay are not built.' },
  { requirement: 'REQ-004', gap: 'ArcGIS is exercised only against a SIMULATED stand-in, not ArcGIS Enterprise 11.3.' },
  { requirement: 'REQ-014', gap: 'Tyler budget data comes only from a SIMULATED stand-in.' },
  { requirement: 'REQ-002', gap: 'On-premises deployment is built; near-real-time replication to City-managed servers is not.' },
  { requirement: 'REQ-007', gap: 'Only code enforcement permits exist; Planning, Building, Business Licensing, ACE Court and the other permit types do not.' },
  { requirement: 'REQ-012', gap: 'The migration is proven on a SIMULATED export; table and column names must be checked against the City\'s real Cityworks export. Workflow definitions are not migrated.' },
  { requirement: 'STORY-007', gap: 'Resident email is SIMULATED: no mail service is connected.' },
  { requirement: 'all', gap: 'No penetration test or City security review has been done.' },
];

export function readTestResults(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const tests = lines.filter(t => t.nesting === 0);
  return {
    total: tests.length,
    passed: tests.filter(t => t.ok && !t.skipped).length,
    failed: tests.filter(t => !t.ok).length,
    skipped: tests.filter(t => t.skipped).length,
    failures: tests.filter(t => !t.ok).map(t => ({ name: t.name, file: t.file, error: t.error })),
    byFile: Object.entries(tests.reduce((m, t) => {
      const f = t.file ? path.relative(process.cwd(), t.file).replace(/\\/g, '/') : '(unknown)';
      m[f] ??= { passed: 0, failed: 0 };
      m[f][t.ok ? 'passed' : 'failed']++;
      return m;
    }, {})).map(([file, c]) => ({ file, ...c })),
  };
}

// Which stories have tests on record, from .colaberry/progress.json.
export function storyCoverage(progress, plan) {
  const ids = plan?.stories?.map(s => s.id) ?? progress.stories.map(s => s.id);
  return ids.map(id => {
    const s = progress.stories.find(x => x.id === id);
    const tests = s?.tests_added ?? [];
    return { id, tests, covered: tests.length > 0 };
  });
}

export function buildReport({ automated, smoke, uat, migration, coverage, generatedAt, commit, selfStory = 'STORY-011' }) {
  const missing = [];
  if (!automated) missing.push('automated test results (the test suite did not produce any)');
  else if (automated.total === 0) missing.push('automated test results (no tests ran)');
  if (!smoke) missing.push('the end-to-end smoke test (it did not run)');
  if (!uat?.scenarios?.length) missing.push('the user acceptance scenarios');
  const uncovered = coverage.filter(c => !c.covered && c.id !== selfStory);
  if (uncovered.length) missing.push(`tests on record for ${uncovered.map(c => c.id).join(', ')}`);
  if (!KNOWN_GAPS.length) missing.push('the known gaps');
  const complete = missing.length === 0;

  const reasons = [];
  if (!complete) reasons.push('the report is incomplete');
  if (automated?.failed) reasons.push(`${automated.failed} automated test(s) failed`);
  if (smoke && !smoke.ok) reasons.push(`${smoke.checks.filter(c => !c.ok).length} smoke check(s) failed`);
  if (uat && !uat.summary.accepted) reasons.push(...uat.summary.reasons.map(r => `user acceptance: ${r}`));
  const critical = [
    ...(automated?.failures ?? []).map(f => `Automated test failed: ${f.name} (${f.file ? path.basename(f.file) : '?'}): ${f.error}`),
    ...(smoke?.checks ?? []).filter(c => !c.ok).map(c => `Smoke check failed: ${c.name}: ${c.detail}`),
    ...(uat?.scenarios ?? []).filter(s => s.latest && s.latest.outcome !== 'pass' && s.latest.severity === 'critical').map(s => `UAT ${s.id} critical: ${s.latest.notes}`),
  ];
  return {
    generatedAt, commit,
    status: complete ? 'complete' : 'incomplete', missing,
    verdict: complete && reasons.length === 0 ? 'ready' : 'not_ready', reasons,
    criticalIssues: critical,
    automated, smoke, uat: uat && { summary: uat.summary, scenarios: uat.scenarios.map(({ history, ...s }) => s) },
    migration: migration && { verdict: migration.verdict, finishedAt: migration.finishedAt, simulated: migration.source?.simulated, failures: migration.failures, records: migration.records, attachments: migration.attachments?.stored, gis: migration.gis },
    coverage, knownGaps: KNOWN_GAPS,
  };
}

export function reportMarkdown(r) {
  const yes = b => (b ? 'pass' : '**FAIL**');
  const L = [
    '# Final test report',
    '',
    `Generated ${r.generatedAt} on commit \`${r.commit ?? 'unknown'}\`.`,
    '',
    `**Report: ${r.status.toUpperCase()}** · **Verdict: ${r.verdict === 'ready' ? 'READY' : 'NOT READY'}**`,
    '',
  ];
  if (r.missing.length) L.push('## Missing from this report', '', ...r.missing.map(m => `- ${m}`), '');
  if (r.reasons.length) L.push('## Why it is not ready', '', ...r.reasons.map(m => `- ${m}`), '');
  L.push('## Critical issues', '', ...(r.criticalIssues.length ? r.criticalIssues.map(c => `- ${c}`) : ['None found.']), '');

  L.push('## Automated tests', '');
  if (r.automated) {
    L.push(`${r.automated.passed} passed, ${r.automated.failed} failed, ${r.automated.skipped} skipped, of ${r.automated.total}.`, '',
      '| File | Passed | Failed |', '|---|---:|---:|', ...r.automated.byFile.map(f => `| ${f.file} | ${f.passed} | ${f.failed} |`), '');
  } else L.push('Not run.', '');

  L.push('## End-to-end smoke test', '', 'A real deployment on a throwaway database, real sign-in, every module over HTTP. Tyler, Caselle and the Cityworks export are SIMULATED.', '');
  if (r.smoke) L.push('| Check | Story | Result | Detail |', '|---|---|---|---|', ...r.smoke.checks.map(c => `| ${c.name} | ${c.story} | ${yes(c.ok)} | ${String(c.detail).replace(/\|/g, '\\|')} |`), '');
  else L.push('Not run.', '');

  L.push('## User acceptance', '');
  if (r.uat) {
    const s = r.uat.summary;
    L.push(`${s.executed} of ${s.total} scenarios run, ${s.passed} passing, ${s.openIssues} open issue(s), ${s.openCritical} critical. Testers: ${s.testers.length ? s.testers.join(', ') : 'none yet'}.`,
      `Accepted: **${s.accepted ? 'yes' : 'no'}**${s.reasons.length ? ` (${s.reasons.join('; ')})` : ''}.`, '',
      '| Scenario | Story | Title | Latest result | By | Notes |', '|---|---|---|---|---|---|',
      ...r.uat.scenarios.map(x => `| ${x.id} | ${x.story} | ${x.title} | ${x.latest ? `${x.latest.outcome}${x.latest.severity !== 'none' ? ` (${x.latest.severity})` : ''}` : 'not run'} | ${x.latest?.tester ?? ''} | ${(x.latest?.notes ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '');
  }

  L.push('## Cityworks migration', '');
  if (r.migration) L.push(`Latest run: **${r.migration.verdict === 'trusted' ? 'TRUSTED' : 'NOT TRUSTED'}**${r.migration.simulated ? ' (SIMULATED export)' : ''}, ${r.migration.finishedAt}. ${r.migration.records.map(x => `${x.type} ${x.target}`).join(', ')}; ${r.migration.attachments} attachments; ${r.migration.gis.linked} GIS links, ${r.migration.gis.orphaned} orphaned, ${r.migration.gis.unresolved} unresolved.`, '');
  else L.push('No migration has been run on this database.', '');

  L.push('## Tests on record per story', '', '| Story | Test files |', '|---|---|', ...r.coverage.map(c => `| ${c.id} | ${c.tests.length ? c.tests.join(', ') : '**none**'} |`), '');
  L.push('## Known gaps', '', ...r.knownGaps.map(g => `- **${g.requirement}**: ${g.gap}`), '');
  return L.join('\n');
}
