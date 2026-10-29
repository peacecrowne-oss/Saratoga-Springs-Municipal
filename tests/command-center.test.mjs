// Crawls every tab of the Command Center and follows every link one level down.
// Run from the repo root:  node tests/command-center.test.mjs
//
// Checks, for real data, sample data and missing data files:
//   - every tab renders and has at least one card that drills down
//   - every link resolves to a real page
//   - sample mode labels every tab as sample
//   - nothing renders as NaN / undefined / [object Object]
//   - deleting a story from the plan removes it from the page

import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const read = p => { try { return JSON.parse(fs.readFileSync(path.join(root, p))); } catch { return null; } };

const { buildView } = await imp('assets/data.js');
const TABS = ['overview', 'outcomes', 'users', 'guardrails', 'systems', 'project', 'agents', 'knowledge', 'data-model'];
const mods = Object.fromEntries(await Promise.all(TABS.map(async t => [t, await imp(`assets/tabs/${t}.js`)])));

const own = { notes: read('knowledge/notes.json'), model: read('model/data-model.json') };
const real = { plan: read('.colaberry/plan.json'), progress: read('.colaberry/progress.json'), manifest: read('.colaberry/manifest.json'), ...own };
real.missing = Object.fromEntries(['plan', 'progress', 'manifest'].filter(k => !real[k]).map(k => [k, 'missing']));
const noFiles = { plan: null, progress: null, manifest: null, ...own, missing: { plan: 'HTTP 404', progress: 'HTTP 404', manifest: 'HTTP 404' } };

const route = (v, h) => {
  const parts = h.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return mods[parts[0]].render(v, parts);
};
const linksIn = html => new Set([...html.matchAll(/href="(#\/[^"]+)"/g)].map(m => m[1]));

const failures = [];
const fail = msg => failures.push(msg);

function crawl(label, v) {
  let out = '';
  for (const tab of TABS) {
    const html = route(v, '#/' + tab);
    out += html;
    if (v.isSample && tab !== 'data-model' && !html.includes('SAMPLE')) fail(`${label} #/${tab}: not labelled as sample`);
    if (!/class="(?:card|row|gantt-row)[^"]*" href=/.test(html)) fail(`${label} #/${tab}: no card that drills down`);
    for (const h of linksIn(html)) {
      try {
        const d = route(v, h);
        out += d;
        if (d.includes('Nothing at this address')) fail(`${label} ${h}: dead link`);
      } catch (e) { fail(`${label} ${h}: ${e.message}`); }
    }
  }
  if (/\bNaN\b|undefined|\[object Object\]/.test(out)) fail(`${label}: NaN, undefined or [object Object] rendered`);
  return out;
}

crawl('real', buildView('real', real));
crawl('sample', buildView('sample', real));
crawl('no data files', buildView('real', noFiles));

if (real.plan?.stories?.length) {
  const victim = real.plan.stories[real.plan.stories.length - 1];
  const cut = structuredClone(real);
  cut.plan.stories = cut.plan.stories.filter(s => s.id !== victim.id);
  const shown = crawl('story deleted', buildView('real', cut));
  const title = String(victim.title).replace(new RegExp(`^${victim.id}\\s*·\\s*`), '');
  if (title && shown.includes(title)) fail(`deleted story ${victim.id} is still shown: something is hard-coded`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('Command Center: all tabs reachable, every card drills down, sample labelled, nothing hard-coded.');
