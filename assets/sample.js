// SAMPLE DATA — entirely made up, for seeing the shape of the Command Center.
// It is not this project's plan and must never be demoed as if it were.
// Dates are relative to today so the sample always looks mid-build.

const day = 86400000;
const iso = offset => new Date(Date.now() + offset * day).toISOString().slice(0, 10);

const stories = [
  { id: 'SAMPLE-1', title: 'Sample: import asset register', release: 's0', due_on: iso(-6), due_baseline_on: iso(-6) },
  { id: 'SAMPLE-2', title: 'Sample: audit log for edits', release: 's0', due_on: iso(-4), due_baseline_on: iso(-5) },
  { id: 'SAMPLE-3', title: 'Sample: map view of assets', release: 's1', due_on: iso(-1), due_baseline_on: iso(-2) },
  { id: 'SAMPLE-4', title: 'Sample: permit application form', release: 's1', due_on: iso(1), due_baseline_on: iso(1) },
  { id: 'SAMPLE-5', title: 'Sample: reviewer queue', release: 's2', due_on: iso(5), due_baseline_on: iso(4) },
  { id: 'SAMPLE-6', title: 'Sample: status emails', release: 's2', due_on: iso(7), due_baseline_on: iso(7) },
].map(s => ({ ...s, narrative: `As a sample user, I want ${s.title.replace('Sample: ', '')}, so that the sample looks real.` }));

const states = ['verified', 'verified', 'submitted', 'in_progress', 'not_started', 'not_started'];

export const SAMPLE = {
  plan: {
    schema_version: 1,
    project: {
      name: 'Sample Town Asset & Permit Portal',
      descriptor: 'Made-up sample project used to preview the Command Center layout.',
    },
    schedule: {
      build_start: iso(-8), build_end: iso(10), demo_day: iso(10), demo_release_key: 's2',
    },
    releases: [
      { key: 's0', name: 'Sample release 0', starts_on: iso(-8), ends_on: iso(-4), story_ids: ['SAMPLE-1', 'SAMPLE-2'], is_demo_target: false },
      { key: 's1', name: 'Sample release 1', starts_on: iso(-3), ends_on: iso(2), story_ids: ['SAMPLE-3', 'SAMPLE-4'], is_demo_target: false },
      { key: 's2', name: 'Sample release 2', starts_on: iso(3), ends_on: iso(10), story_ids: ['SAMPLE-5', 'SAMPLE-6'], is_demo_target: true },
    ],
    stories,
  },
  progress: {
    schema_version: 2,
    totals: { stories_verified: 2, stories_total: 6, criteria_passed: 11, criteria_total: 27, points_awarded: 8 },
    stories: stories.map((s, i) => ({
      id: s.id,
      verification: {
        state: states[i],
        commit: states[i] === 'verified' ? `sample${i}abc` : null,
        points: states[i] === 'verified' ? 4 : 0,
      },
    })),
  },
};
