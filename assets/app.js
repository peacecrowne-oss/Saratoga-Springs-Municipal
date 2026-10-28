import { DATA_FILES, loadReal, buildView } from './data.js';
import { esc, relAge, sampleTag, DAY } from './ui.js';
import * as overview from './tabs/overview.js';
import * as outcomes from './tabs/outcomes.js';
import * as users from './tabs/users.js';
import * as guardrails from './tabs/guardrails.js';
import * as systems from './tabs/systems.js';
import * as project from './tabs/project.js';
import * as agents from './tabs/agents.js';
import * as knowledge from './tabs/knowledge.js';
import * as dataModel from './tabs/data-model.js';

const TABS = [
  { id: 'overview', label: 'Overview', mod: overview },
  { id: 'outcomes', label: 'Outcomes', mod: outcomes },
  { id: 'users', label: 'Users & use case', mod: users },
  { id: 'guardrails', label: 'Guardrails', mod: guardrails },
  { id: 'systems', label: 'Systems', mod: systems },
  { id: 'project', label: 'Project management', mod: project },
  { id: 'agents', label: 'AI agents', mod: agents },
  { id: 'knowledge', label: 'Knowledge base', mod: knowledge },
  { id: 'data-model', label: 'Data model', mod: dataModel },
];

const MODE_KEY = 'cc-mode';

let real = null;
let mode = readMode();

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'sample' ? 'sample' : 'real'; } catch { return 'real'; }
}

function saveMode(m) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable; mode lasts this visit */ }
}

// ---------- header ----------

function renderStamp() {
  const gen = real?.manifest?.generated_at;
  const d = gen ? new Date(gen) : null;
  if (!d || isNaN(d)) {
    return `<span class="stamp warn">No data yet: <code>${esc(DATA_FILES.manifest)}</code> not found. Sync from the portal to refresh.</span>`;
  }
  const age = Date.now() - d.getTime();
  const abs = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const text = `Data as of ${abs} (${relAge(age)})`;
  return age > 7 * DAY
    ? `<span class="stamp warn">${esc(text)}. Sync from the portal to refresh.</span>`
    : `<span class="stamp">${esc(text)}</span>`;
}

function renderHeader(v, tabId) {
  const name = v.project?.name ?? 'Command Center';
  const nav = TABS.map(t =>
    `<a href="#/${t.id}"${t.id === tabId ? ' aria-current="page"' : ''}>${esc(t.label)}</a>`
  ).join('');
  document.getElementById('header').innerHTML = `
    <div class="wrap">
      <div class="header-top">
        <a class="brand" href="#/overview">${esc(name)}${sampleTag(v)}<small>Command Center</small></a>
        <div class="header-meta">
          ${renderStamp()}
          <div class="mode-switch" role="group" aria-label="Data mode">
            <button type="button" data-mode="real" aria-pressed="${!v.isSample}">Real</button>
            <button type="button" class="sample" data-mode="sample" aria-pressed="${v.isSample}">Sample</button>
          </div>
        </div>
      </div>
      <nav class="tabs" aria-label="Command Center tabs">${nav}</nav>
    </div>`;
  document.querySelectorAll('.mode-switch button').forEach(b =>
    b.addEventListener('click', () => { mode = b.dataset.mode; saveMode(mode); render(); })
  );
}

function globalBanners(v) {
  if (v.isSample) {
    return `<div class="banner sample">SAMPLE DATA: everything on this screen is made up to show the layout. It is not this project. Switch to Real before demoing.</div>`;
  }
  const missing = Object.keys(DATA_FILES).filter(k => v.missing[k]);
  if (missing.length) {
    return `<div class="banner missing">Not committed yet: ${missing.map(k => `<code>${esc(DATA_FILES[k])}</code>`).join(', ')}. The platform writes these when you sync from the portal. Until then this page shows empty states, not numbers.</div>`;
  }
  return '';
}

// ---------- router ----------

function render() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/').map(decodeURIComponent);
  const tab = TABS.find(t => t.id === parts[0]) ?? TABS[0];
  const v = buildView(mode, real);

  renderHeader(v, tab.id);
  document.getElementById('main').innerHTML = `<div class="wrap">${globalBanners(v)}${tab.mod.render(v, parts)}</div>`;
  tab.mod.mount?.(v);
  document.title = `${tab.label} · Command Center`;
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

real = await loadReal();
render();
