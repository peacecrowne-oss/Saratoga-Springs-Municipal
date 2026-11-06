// User acceptance testing (STORY-011): the scenarios testers run, and what they
// found. A result is never edited: a retest is a new result, and the latest one
// for a scenario is what counts. Each result is audited.
//
// Acceptance holds only when every scenario has been run, its latest result is a
// pass, and no critical issue is open. A critical failure stays open until that
// scenario passes again.

import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

export const OUTCOMES = ['pass', 'fail', 'blocked'];
export const SEVERITIES = ['none', 'minor', 'major', 'critical'];

// Each scenario names the role to sign in as and the page to start from.
export const SCENARIOS = [
  { id: 'UAT-01', story: 'STORY-012', role: 'any', page: '/login', title: 'Sign in with password and authenticator code', expected: 'You reach the system dashboard; a wrong code is refused.' },
  { id: 'UAT-02', story: 'STORY-001', role: 'it_administrator', page: '/system', title: 'Check the system is up', expected: 'Health is OK and the latest deployment is listed.' },
  { id: 'UAT-03', story: 'STORY-004', role: 'asset_manager', page: '/assets', title: 'Add an asset, record its condition and schedule maintenance', expected: 'The asset shows its status, condition and next task, and its audit trail lists each change.' },
  { id: 'UAT-04', story: 'STORY-004', role: 'asset_manager', page: '/assets', title: 'Try an impossible status change', expected: 'A retired asset cannot be made active again; the refusal is explained.' },
  { id: 'UAT-05', story: 'STORY-002', role: 'gis_analyst', page: '/system', title: 'Review the GIS sync', expected: 'The GIS panel shows the last sync and any errors in plain words.' },
  { id: 'UAT-06', story: 'STORY-006', role: 'permit_clerk', page: '/permits', title: 'Submit a code enforcement application', expected: 'It appears in the queue with a CE number.' },
  { id: 'UAT-07', story: 'STORY-006', role: 'code_enforcement_officer', page: '/permits', title: 'Approve an application with both checks, reject another', expected: 'Statuses show approved and rejected with reasons; approval without the checks is refused.' },
  { id: 'UAT-08', story: 'STORY-007', role: 'resident (no sign-in)', page: '/portal', title: 'Apply on the public portal', expected: 'A confirmation and a private link are shown.' },
  { id: 'UAT-09', story: 'STORY-007', role: 'resident (no sign-in)', page: '/portal', title: 'Book and then move the inspection', expected: 'The new date shows on the portal and on the Permitting page.' },
  { id: 'UAT-10', story: 'STORY-013', role: 'code_enforcement_officer', page: '/history', title: 'Look up a historical Cityworks case', expected: 'The case opens, is marked READ-ONLY, and its attachment downloads.' },
  { id: 'UAT-11', story: 'STORY-013', role: 'it_administrator', page: '/history', title: 'Read the migration reconciliation', expected: 'The verdict and counts are shown, with anything left to resolve.' },
  { id: 'UAT-12', story: 'STORY-010', role: 'billing_manager', page: '(command line or API)', title: 'Look up a Caselle billing account', expected: 'The account and bills are shown; with Caselle stopped, the answer says it cannot connect.' },
  { id: 'UAT-13', story: 'STORY-005', role: 'financial_manager', page: '/budget', title: 'View the budget from Tyler', expected: 'Budget lines are shown; with Tyler stopped, the page says so.' },
  { id: 'UAT-14', story: 'STORY-012', role: 'any', page: 'any', title: 'Sign out, and try a page you are not allowed', expected: 'Signing out returns you to sign-in; a forbidden page explains the refusal.' },
];
const BY_ID = new Map(SCENARIOS.map(s => [s.id, s]));

export class UatValidationError extends Error {
  constructor(problems) {
    super(`The result is not valid: ${problems.map(p => `${p.field} ${p.problem}`).join('; ')}.`);
    this.name = 'UatValidationError';
    this.problems = problems;
  }
}

const fromRow = row => ({
  id: row.id, scenarioId: row.scenario_id, tester: row.tester, outcome: row.outcome,
  severity: row.severity, notes: row.notes, recordedAt: row.recorded_at,
});

export function createUat(db, audit, { now = () => new Date() } = {}) {
  const byKey = db.prepare('SELECT * FROM uat_result WHERE result_key = ?');
  const insert = db.prepare('INSERT INTO uat_result (id, result_key, scenario_id, tester, outcome, severity, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const all = db.prepare('SELECT * FROM uat_result ORDER BY recorded_at, rowid');

  function status() {
    const results = all.all().map(fromRow);
    const scenarios = SCENARIOS.map(s => {
      const mine = results.filter(r => r.scenarioId === s.id);
      const latest = mine.at(-1) ?? null;
      return { ...s, latest, history: mine.slice(-10).reverse() };
    });
    const executed = scenarios.filter(s => s.latest).length;
    const passed = scenarios.filter(s => s.latest?.outcome === 'pass').length;
    const openCritical = scenarios.filter(s => s.latest && s.latest.outcome !== 'pass' && s.latest.severity === 'critical');
    const openIssues = scenarios.filter(s => s.latest && s.latest.outcome !== 'pass');
    const reasons = [];
    if (executed < SCENARIOS.length) reasons.push(`${SCENARIOS.length - executed} of ${SCENARIOS.length} scenarios have not been run`);
    if (openCritical.length) reasons.push(`${openCritical.length} critical issue(s) open: ${openCritical.map(s => s.id).join(', ')}`);
    const nonCritical = openIssues.length - openCritical.length;
    if (nonCritical) reasons.push(`${nonCritical} scenario(s) not passing: ${openIssues.filter(s => !openCritical.includes(s)).map(s => s.id).join(', ')}`);
    return {
      scenarios,
      summary: {
        total: SCENARIOS.length, executed, passed, openIssues: openIssues.length, openCritical: openCritical.length,
        testers: [...new Set(results.map(r => r.tester))], accepted: reasons.length === 0, reasons,
      },
    };
  }

  return {
    status,

    // Records one result. The same result_key twice records it once.
    record({ tester, input }) {
      const problems = [];
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UatValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
      if (!BY_ID.has(input.scenario_id)) problems.push({ field: 'scenario_id', problem: 'is not a known scenario' });
      if (!OUTCOMES.includes(input.outcome)) problems.push({ field: 'outcome', problem: `must be one of ${OUTCOMES.join(', ')}` });
      const severity = input.outcome === 'pass' ? 'none' : input.severity;
      if (input.outcome !== 'pass' && !SEVERITIES.slice(1).includes(severity)) problems.push({ field: 'severity', problem: 'must be minor, major or critical when the scenario did not pass' });
      const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
      if (input.outcome !== 'pass' && !notes) problems.push({ field: 'notes', problem: 'must say what went wrong' });
      if (typeof input.result_key !== 'string' || !input.result_key.trim() || input.result_key.length > 100) problems.push({ field: 'result_key', problem: 'is required' });
      if (problems.length) throw new UatValidationError(problems);

      return transaction(db, () => {
        const existing = byKey.get(input.result_key);
        if (existing) return { recorded: false, result: fromRow(existing) };
        const id = randomUUID();
        const at = now().toISOString();
        insert.run(id, input.result_key, input.scenario_id, tester, input.outcome, severity, notes || null, at);
        const result = fromRow(byKey.get(input.result_key));
        audit.record({ actor: tester, action: 'uat.recorded', entityType: 'uat', entityId: input.scenario_id, after: result });
        return { recorded: true, result };
      });
    },
  };
}
