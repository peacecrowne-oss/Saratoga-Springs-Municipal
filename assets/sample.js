// SAMPLE DATA — entirely made up, for seeing the shape of the Command Center.
// It is not this project's plan and must never be demoed as if it were.
// Dates are relative to today so the sample always looks mid-build.

const day = 86400000;
const iso = offset => new Date(Date.now() + offset * day).toISOString().slice(0, 10);
const stamp = offsetMins => new Date(Date.now() - offsetMins * 60000).toISOString();

const stories = [
  { id: 'SAMPLE-1', title: 'Sample: import asset register', release: 's0', owner_agent: 'sample clerk', due_on: iso(-6), due_baseline_on: iso(-6) },
  { id: 'SAMPLE-2', title: 'Sample: audit log for edits', release: 's0', owner_agent: 'sample auditor', due_on: iso(-4), due_baseline_on: iso(-5) },
  { id: 'SAMPLE-3', title: 'Sample: map view of assets', release: 's1', owner_agent: 'sample clerk', due_on: iso(-1), due_baseline_on: iso(-2) },
  { id: 'SAMPLE-4', title: 'Sample: permit application form', release: 's1', owner_agent: 'sample resident', due_on: iso(1), due_baseline_on: iso(1) },
  { id: 'SAMPLE-5', title: 'Sample: reviewer queue', release: 's2', owner_agent: 'sample inspector', due_on: iso(5), due_baseline_on: iso(4) },
  { id: 'SAMPLE-6', title: 'Sample: status emails', release: 's2', owner_agent: 'sample resident', due_on: iso(7), due_baseline_on: iso(7) },
].map(s => ({
  ...s,
  narrative: `As a ${s.owner_agent}, I want ${s.title.replace('Sample: ', '')}, so that the sample looks real.`,
  acceptance: [
    `Given the sample, when ${s.title.replace('Sample: ', '')} is used, then it works.`,
    'Given the sample, when it fails, then the user is told.',
  ],
}));

const states = ['verified', 'verified', 'submitted', 'in_progress', 'not_started', 'not_started'];

export const SAMPLE = {
  plan: {
    schema_version: 1,
    project: {
      name: 'Sample Town Asset & Permit Portal',
      descriptor: 'Made-up sample project used to preview the Command Center layout.',
    },
    schedule: { build_start: iso(-8), build_end: iso(10), demo_day: iso(10), demo_release_key: 's2' },
    releases: [
      { key: 's0', name: 'Sample release 0', starts_on: iso(-8), ends_on: iso(-4), story_ids: ['SAMPLE-1', 'SAMPLE-2'], is_demo_target: false },
      { key: 's1', name: 'Sample release 1', starts_on: iso(-3), ends_on: iso(2), story_ids: ['SAMPLE-3', 'SAMPLE-4'], is_demo_target: false },
      { key: 's2', name: 'Sample release 2', starts_on: iso(3), ends_on: iso(10), story_ids: ['SAMPLE-5', 'SAMPLE-6'], is_demo_target: true },
    ],
    stories,
    requirements: [
      { id: 'SREQ-1', statement: 'Sample: keep a register of every asset.', kind: 'FUNC', priority: 'must', cluster: 'assets', fulfilled_by: ['SAMPLE-1', 'SAMPLE-3'] },
      { id: 'SREQ-2', statement: 'Sample: record who changed what, and when.', kind: 'SAFE', priority: 'must', cluster: 'trust', fulfilled_by: ['SAMPLE-2'] },
      { id: 'SREQ-3', statement: 'Sample: only reviewers may approve a permit.', kind: 'SAFE', priority: 'must', cluster: 'trust', fulfilled_by: ['SAMPLE-5'] },
      { id: 'SREQ-4', statement: 'Sample: residents can apply for a permit online.', kind: 'FUNC', priority: 'must', cluster: 'permits', fulfilled_by: ['SAMPLE-4', 'SAMPLE-6'] },
      { id: 'SREQ-5', statement: 'Sample: export a monthly report to the Sample Finance system.', kind: 'CONSTRAINT', priority: 'must', cluster: 'finance', fulfilled_by: [] },
    ],
    agents: [
      {
        name: 'Sample intake agent', purpose: 'Checks a sample permit application is complete before a reviewer sees it.',
        trigger_type: 'event', trigger: 'application submitted', inputs: ['application', 'attachments'], outputs: ['completeness report'],
        autonomy_level: 'suggest', approval_gates: ['reviewer accepts report'], escalation_rules: ['missing documents → applicant'],
        skills: ['read sample forms'], owns: ['SAMPLE-4', 'SAMPLE-5'],
      },
      {
        name: 'Sample notifier', purpose: 'Sends sample status emails when an application changes state.',
        trigger_type: 'event', trigger: 'application status changed', inputs: ['application status'], outputs: ['email'],
        autonomy_level: 'act_with_approval', approval_gates: ['template approved once'], escalation_rules: ['bounce → clerk'],
        skills: [], owns: ['SAMPLE-6'],
      },
    ],
    derived: {
      measures: [
        { id: 'SM-1', statement: 'Sample: shorten permit turnaround.' },
        { id: 'SM-2', statement: 'Sample: fewer incomplete applications.' },
      ],
      roles: ['sample clerk', 'sample auditor', 'sample resident', 'sample inspector'],
      guardrails: [
        { id: 'SREQ-2', statement: 'Sample: record who changed what, and when.' },
        { id: 'SREQ-3', statement: 'Sample: only reviewers may approve a permit.' },
      ],
      systems: ['Sample GIS', 'Sample Finance', 'Sample Document Store'],
      counts: { agents_by_autonomy: { suggest: 1, act_with_approval: 1 } },
    },
  },
  progress: {
    schema_version: 2,
    totals: { stories_verified: 2, stories_total: 6, criteria_passed: 5, criteria_total: 12, points_awarded: 8 },
    stories: stories.map((s, i) => ({
      id: s.id,
      criteria: s.acceptance.map((text, j) => ({ text, passed: i < 2 || (i === 2 && j === 0) })),
      verification: {
        state: states[i],
        commit_sha: states[i] === 'verified' ? `sample${i}abc` : null,
        points_awarded: states[i] === 'verified' ? 4 : 0,
      },
    })),
  },
  systemStatus: {
    'Sample GIS': { state: 'connected', checked_at: stamp(4) },
    'Sample Finance': { state: 'error', checked_at: stamp(12), detail: 'Sample: credentials expired' },
  },
  notes: {
    decisions: [{ date: iso(-5), statement: 'Sample: store map locations as points, not shapes.', rationale: 'Sample: simpler first release.' }],
    notes: [{ date: iso(-2), text: 'Sample: reviewers asked for a weekly digest.' }],
  },
};
