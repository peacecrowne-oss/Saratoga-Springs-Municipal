// The one place every tab gets its data from.
// Real mode reads the files the platform commits beside this page; sample mode
// swaps in the made-up dataset from sample.js. Tabs never read files directly.

import { SAMPLE } from './sample.js';

export const DATA_FILES = {
  plan: '.colaberry/plan.json',
  progress: '.colaberry/progress.json',
  manifest: '.colaberry/manifest.json',
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
  const [plan, progress, manifest] = await Promise.all([
    loadJson(DATA_FILES.plan),
    loadJson(DATA_FILES.progress),
    loadJson(DATA_FILES.manifest),
  ]);
  return {
    plan: plan.ok ? plan.data : null,
    progress: progress.ok ? progress.data : null,
    manifest: manifest.ok ? manifest.data : null,
    missing: Object.fromEntries(
      [['plan', plan], ['progress', progress], ['manifest', manifest]]
        .filter(([, r]) => !r.ok)
        .map(([k, r]) => [k, r.reason])
    ),
  };
}

// Builds the view every tab works from. `real` is what loadReal() returned;
// the manifest stamp always comes from the real files, even in sample mode.
export function buildView(mode, real) {
  const src = mode === 'sample' ? SAMPLE : real;
  const plan = src.plan;
  const progress = src.progress;
  return {
    mode,
    isSample: mode === 'sample',
    plan,
    progress,
    manifest: real.manifest,
    missing: mode === 'sample' ? {} : real.missing,
    project: plan?.project ?? null,
    schedule: plan?.schedule ?? null,
    releases: Array.isArray(plan?.releases) ? plan.releases : [],
    stories: joinStories(plan, progress),
    totals: progress?.totals ?? null,
  };
}

// plan.stories[].id ↔ progress.stories[].id
function joinStories(plan, progress) {
  const planStories = Array.isArray(plan?.stories) ? plan.stories : [];
  const byId = new Map(
    (Array.isArray(progress?.stories) ? progress.stories : []).map(s => [s.id, s])
  );
  return planStories.map(s => {
    const p = byId.get(s.id);
    return {
      ...s,
      progress: p ?? null,
      state: p?.verification?.state ?? null,
    };
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
