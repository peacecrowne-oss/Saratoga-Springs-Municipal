// The one place every tab gets its data from.
// Real mode reads the files the platform commits beside this page; sample mode
// swaps in the made-up dataset from sample.js. Tabs never read files directly.

import { SAMPLE } from './sample.js';

// Written by the platform on every sync.
export const DATA_FILES = {
  plan: '.colaberry/plan.json',
  progress: '.colaberry/progress.json',
  manifest: '.colaberry/manifest.json',
};

// Written by you; the platform never touches these.
export const PROJECT_FILES = {
  notes: 'knowledge/notes.json',
  model: 'model/data-model.json',
};

async function loadJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export async function loadReal() {
  const files = { ...DATA_FILES, ...PROJECT_FILES };
  const keys = Object.keys(files);
  const results = await Promise.all(keys.map(k => loadJson(files[k])));
  const out = { missing: {} };
  keys.forEach((k, i) => {
    out[k] = results[i].ok ? results[i].data : null;
    if (!results[i].ok) out.missing[k] = results[i].reason;
  });
  return out;
}

const arr = x => (Array.isArray(x) ? x : []);

// Builds the view every tab works from. `real` is what loadReal() returned;
// the manifest stamp always comes from the real files, even in sample mode.
export function buildView(mode, real) {
  const isSample = mode === 'sample';
  const src = isSample ? SAMPLE : real;
  const plan = src.plan;
  const progress = src.progress;
  const derived = plan?.derived ?? {};
  return {
    mode,
    isSample,
    plan,
    progress,
    manifest: real.manifest,
    missing: isSample ? {} : real.missing,
    project: plan?.project ?? null,
    schedule: plan?.schedule ?? null,
    releases: arr(plan?.releases),
    stories: joinStories(plan, progress),
    totals: progress?.totals ?? null,
    requirements: arr(plan?.requirements),
    agents: arr(plan?.agents),
    measures: arr(derived.measures),
    roles: arr(derived.roles),
    guardrails: arr(derived.guardrails),
    systems: arr(derived.systems),
    counts: derived.counts ?? null,
    // Nothing in this repo can observe a live connection. When your system
    // exposes a health check, read it here; until then every system is unknown.
    systemStatus: isSample ? SAMPLE.systemStatus : {},
    notes: isSample ? SAMPLE.notes : real.notes,
    model: real.model,
  };
}

// plan.stories[].id ↔ progress.stories[].id
function joinStories(plan, progress) {
  const byId = new Map(arr(progress?.stories).map(s => [s.id, s]));
  return arr(plan?.stories).map(s => {
    const p = byId.get(s.id);
    return { ...s, progress: p ?? null, state: p?.verification?.state ?? null };
  });
}

export const releaseKey = r => r?.key ?? r?.id ?? null;
export const releaseName = r => r?.name ?? r?.title ?? releaseKey(r) ?? 'Unnamed release';

// Which release the calendar says we are in today, from plan.releases dates.
export function currentRelease(releases, today) {
  const sorted = [...releases].sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
  const active = sorted.find(r => r.starts_on <= today && today <= r.ends_on);
  if (active) return { release: active, relation: 'in' };
  const next = sorted.find(r => r.starts_on > today);
  if (next) return { release: next, relation: 'before' };
  if (sorted.length) return { release: sorted[sorted.length - 1], relation: 'after' };
  return null;
}
