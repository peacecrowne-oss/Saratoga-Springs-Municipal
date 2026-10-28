import { DATA_FILES, loadReal, buildView, releaseKey, releaseName, currentRelease } from './data.js';

// While true, Overview shows the review banner and the other tabs show
// "Not built yet". Flip to false once the remaining eight tabs are built.
const PAUSED_AT_OVERVIEW = true;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'outcomes', label: 'Outcomes', will: 'One card per measure from plan.derived.measures, and the numeric target for each once your plan has one.' },
  { id: 'users', label: 'Users & use case', will: 'Each role from plan.derived.roles, drilling down to the story narratives it came from.' },
  { id: 'guardrails', label: 'Guardrails', will: 'Each SAFE requirement, and whether the stories that fulfil it are verified.' },
  { id: 'systems', label: 'Systems', will: 'One row per system from plan.derived.systems, each with a grey "not checked from here" indicator until your system reports otherwise.' },
  { id: 'project', label: 'Project management', will: 'A Gantt view of plan.releases, and every story with its current and baseline due dates and its state.' },
  { id: 'agents', label: 'AI agents', will: 'One card per agent (or story owner, until the plan scopes agents), with "no runs recorded" until one runs.' },
  { id: 'knowledge', label: 'Knowledge base', will: 'Requirements, stories and the fulfilled_by traceability table, with a chat panel that cites its tab.' },
  { id: 'data-model', label: 'Data model', will: 'The tables your requirements imply, with fields and relationships, for you to review before anything is created.' },
];

const MODE_KEY = 'cc-mode';
const DAY = 86400000;

let real = null;
let mode = readMode();

// ---------- helpers ----------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'sample' ? 'sample' : 'real'; } catch { return 'real'; }
}

function saveMode(m) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable; mode lasts this visit */ }
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  return isNaN(d) ? null : d;
}

function fmtDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

function relAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function daysBetween(fromIso, toIso) {
  const a = parseDate(fromIso), b = parseDate(toIso);
  return a && b ? Math.round((b - a) / DAY) : null;
}

const STATE_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', verified: 'Verified' };

function stateBadge(state) {
  if (!state) return '<span class="state"><span class="dot"></span>No progress recorded</span>';
  return `<span class="state ${esc(state)}"><span class="dot"></span>${esc(STATE_LABEL[state] ?? state)}</span>`;
}

function sampleTag(v) { return v.isSample ? ' <span class="tag sample">SAMPLE</span>' : ''; }

function card(v, { href, label, value, note }) {
  const hasValue = value !== null && value !== undefined && value !== '';
  return `<a class="card${v.isSample ? ' is-sample' : ''}" href="${href}">
    <div class="label">${esc(label)}${sampleTag(v)}</div>
    <div class="value${hasValue ? '' : ' none'}">${hasValue ? esc(value) : 'Not in your data yet'}</div>
    ${note ? `<div class="note">${note}</div>` : ''}
  </a>`;
}

function missingNote(v, file) {
  return v.missing[file]
    ? `<code>${esc(DATA_FILES[file])}</code> is not committed yet. Sync from the portal.`
    : '';
}

function emptyState(what, needs) {
  return `<div class="empty"><strong>What will be here:</strong> ${what}<br><strong>What has to happen first:</strong> ${needs}</div>`;
}

const back = (href, label) => `<div class="crumbs"><a href="${href}">← ${esc(label)}</a></div>`;

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
  const missing = Object.keys(v.missing);
  if (missing.length) {
    return `<div class="banner missing">Not committed yet: ${missing.map(k => `<code>${esc(DATA_FILES[k])}</code>`).join(', ')}. The platform writes these when you sync from the portal. Until then this page shows empty states, not numbers.</div>`;
  }
  return '';
}

// ---------- overview ----------

function whereWeAre(v) {
  if (!v.releases.length) return { value: null, note: missingNote(v, 'plan') || 'Your plan has no releases yet.' };
  const cur = currentRelease(v.releases, todayIso());
  const r = cur.release;
  const value = `${releaseKey(r)} · ${releaseName(r)}`;
  const note = cur.relation === 'in' ? `Running ${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}`
    : cur.relation === 'before' ? `Next up, starts ${fmtDate(r.starts_on)}`
    : `Last release ended ${fmtDate(r.ends_on)}`;
  return { value, note, cur };
}

function renderOverview(v) {
  const t = v.totals;
  const where = whereWeAre(v);
  const demo = v.schedule?.demo_day;
  const demoIn = demo ? daysBetween(todayIso(), demo) : null;

  const releasesHtml = v.releases.length
    ? `<div class="grid">${v.releases.map(r => card(v, {
        href: `#/overview/release/${encodeURIComponent(releaseKey(r))}`,
        label: `${releaseKey(r)}${r.is_demo_target ? ' · demo target' : ''}`,
        value: releaseName(r),
        note: `${(r.story_ids ?? []).length} stories · ${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}`,
      })).join('')}</div>`
    : emptyState('One card per release, with its dates and stories.', `${missingNote(v, 'plan') || 'Your plan needs releases.'}`);

  const liveRows = v.stories.length
    ? `<div class="table-scroll"><table>
        <thead><tr><th>Story</th><th>Release</th><th>Due</th><th>State</th></tr></thead>
        <tbody>${v.stories.map(s => `<tr>
          <td><strong>${esc(s.id)}</strong> ${esc(s.title)}${sampleTag(v)}</td>
          <td>${esc(s.release ?? '—')}</td>
          <td>${fmtDate(s.due_on)}</td>
          <td>${stateBadge(s.state)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : emptyState('Every story in your plan and whether it is verified.', missingNote(v, 'plan') || 'Your plan needs stories.');

  return `
    ${PAUSED_AT_OVERVIEW ? `<div class="banner paused"><strong>Build paused for your review.</strong> Only Overview is built. Check it against your plan, then say <strong>build the rest</strong> and the other eight tabs get built.</div>` : ''}
    <h1>${esc(v.project?.name ?? 'Project name not in your data yet')}${sampleTag(v)}</h1>
    <p class="lede">${v.project?.descriptor ? esc(v.project.descriptor) : (missingNote(v, 'plan') || 'Your plan has no project descriptor.')}</p>

    <div class="grid">
      ${card(v, { href: '#/overview/about', label: 'What this is', value: v.project?.name ? 'About the system' : null, note: missingNote(v, 'plan') || 'What the system does and who it is for' })}
      ${card(v, { href: '#/overview/schedule', label: 'Where we are', value: where.value, note: where.note })}
      ${card(v, { href: '#/overview/stories', label: 'Stories verified', value: t ? `${t.stories_verified ?? 0} of ${t.stories_total ?? 0}` : null, note: missingNote(v, 'progress') })}
      ${card(v, { href: '#/overview/criteria', label: 'Criteria passed', value: t ? `${t.criteria_passed ?? 0} of ${t.criteria_total ?? 0}` : null, note: missingNote(v, 'progress') })}
      ${card(v, { href: '#/overview/points', label: 'Points awarded', value: t ? (t.points_awarded ?? 0) : null, note: missingNote(v, 'progress') })}
      ${card(v, { href: '#/overview/demo', label: 'Demo day', value: demo ? fmtDate(demo) : null, note: demo ? (demoIn > 0 ? `${demoIn} days away` : demoIn === 0 ? 'Today' : `${-demoIn} days ago`) : missingNote(v, 'plan') })}
    </div>

    <h2>Releases</h2>
    ${releasesHtml}

    <h2>What is live and what is not</h2>
    <p class="lede">A story counts as live only once the platform has verified it. Everything else is planned or in progress.</p>
    ${liveRows}`;
}

function renderOverviewDetail(v, sub, arg) {
  const ov = back('#/overview', 'Overview');
  const t = v.totals;

  if (sub === 'about') {
    if (!v.project) return ov + `<h1>About the system</h1>` + emptyState('The project name and descriptor from your plan.', missingNote(v, 'plan'));
    return ov + `<h1>${esc(v.project.name)}${sampleTag(v)}</h1>
      <p class="lede">${esc(v.project.descriptor ?? '')}</p>
      <dl class="facts">
        ${Object.entries(v.project).filter(([, val]) => typeof val !== 'object').map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}
      </dl>`;
  }

  if (sub === 'schedule' || sub === 'demo') {
    const s = v.schedule;
    const title = sub === 'demo' ? 'Demo day' : 'Where we are in the term';
    if (!s) return ov + `<h1>${title}</h1>` + emptyState('Build start, build end, demo day and the release the demo targets.', missingNote(v, 'plan') || 'Your plan has no schedule.');
    const where = whereWeAre(v);
    const demoRel = v.releases.find(r => releaseKey(r) === s.demo_release_key);
    return ov + `<h1>${title}${sampleTag(v)}</h1>
      <dl class="facts">
        <dt>Today</dt><dd>${fmtDate(todayIso())}</dd>
        <dt>Current release</dt><dd>${where.value ? `${esc(where.value)} (${esc(where.note)})` : '—'}</dd>
        <dt>Build starts</dt><dd>${fmtDate(s.build_start)}</dd>
        <dt>Build ends</dt><dd>${fmtDate(s.build_end)}</dd>
        <dt>Demo day</dt><dd>${fmtDate(s.demo_day)}</dd>
        <dt>Demo release</dt><dd>${demoRel ? `<a href="#/overview/release/${encodeURIComponent(releaseKey(demoRel))}">${esc(releaseKey(demoRel))} · ${esc(releaseName(demoRel))}</a>` : esc(s.demo_release_key ?? '—')}</dd>
      </dl>`;
  }

  if (sub === 'stories' || sub === 'points') {
    const isPoints = sub === 'points';
    const title = isPoints ? 'Points awarded' : 'Stories verified';
    if (!t) return ov + `<h1>${title}</h1>` + emptyState(isPoints ? 'Points awarded per verified story.' : 'Each story and its verification state, with the commit that verified it.', missingNote(v, 'progress'));
    const head = isPoints ? `${t.points_awarded ?? 0} points awarded` : `${t.stories_verified ?? 0} of ${t.stories_total ?? 0} stories verified`;
    return ov + `<h1>${title}${sampleTag(v)}</h1><p class="lede">${esc(head)}, from <code>progress.totals</code>.</p>
      ${v.stories.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Story</th><th>State</th><th>Verified commit</th><th>Points</th></tr></thead>
        <tbody>${v.stories.map(s => `<tr>
          <td><strong>${esc(s.id)}</strong> ${esc(s.title)}</td>
          <td>${stateBadge(s.state)}</td>
          <td>${s.progress?.verification?.commit ? `<code>${esc(String(s.progress.verification.commit).slice(0, 10))}</code>` : '—'}</td>
          <td>${s.progress?.verification?.points ?? '—'}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyState('The per-story breakdown.', missingNote(v, 'plan') || 'Your plan has no stories.')}`;
  }

  if (sub === 'criteria') {
    if (!t) return ov + `<h1>Criteria passed</h1>` + emptyState('Every acceptance criterion and whether it is ticked.', missingNote(v, 'progress'));
    const withCriteria = (v.progress?.stories ?? []).filter(s => Array.isArray(s.criteria) && s.criteria.length);
    return ov + `<h1>Criteria passed${sampleTag(v)}</h1>
      <p class="lede">${esc(`${t.criteria_passed ?? 0} of ${t.criteria_total ?? 0}`)} criteria passed, from <code>progress.totals</code>.</p>
      ${withCriteria.length ? withCriteria.map(s => `<h2>${esc(s.id)}</h2><ul>${s.criteria.map(c => `<li>${c.passed ? '✅' : '⬜'} ${esc(c.text)}</li>`).join('')}</ul>`).join('')
        : emptyState('Each story\'s criteria with a tick or a blank.', 'No story in the progress file lists its criteria yet.')}`;
  }

  if (sub === 'release') {
    const r = v.releases.find(x => releaseKey(x) === arg);
    if (!r) return ov + `<h1>Release ${esc(arg)}</h1>` + emptyState('This release\'s dates and stories.', missingNote(v, 'plan') || 'No release with this key is in your plan.');
    const ids = r.story_ids ?? [];
    const rows = ids.map(id => v.stories.find(s => s.id === id) ?? { id, title: '(not in plan.stories)' });
    return ov + `<h1>${esc(releaseKey(r))} · ${esc(releaseName(r))}${r.is_demo_target ? ' <span class="tag demo">Demo target</span>' : ''}${sampleTag(v)}</h1>
      <p class="lede">${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)} · ${ids.length} stories</p>
      ${rows.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Story</th><th>Due</th><th>First due</th><th>State</th></tr></thead>
        <tbody>${rows.map(s => {
          const slip = daysBetween(s.due_baseline_on, s.due_on);
          return `<tr>
            <td><strong>${esc(s.id)}</strong> ${esc(s.title)}</td>
            <td>${fmtDate(s.due_on)}</td>
            <td>${fmtDate(s.due_baseline_on)}${slip > 0 ? ` <span class="tag">slipped ${slip}d</span>` : ''}</td>
            <td>${stateBadge(s.state)}</td></tr>`;
        }).join('')}</tbody></table></div>`
        : emptyState('The stories in this release.', 'This release has no story_ids yet.')}`;
  }

  return ov + emptyState('Nothing at this address.', 'Go back to Overview.');
}

// ---------- other tabs (paused) ----------

function renderPlaceholder(tab) {
  return `<h1>${esc(tab.label)}</h1>
    <div class="empty"><strong>Not built yet.</strong> Say <strong>build the rest</strong> when Overview looks right.<br><br>
    <strong>What will be here:</strong> ${esc(tab.will)}</div>`;
}

// ---------- router ----------

function render() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/').map(decodeURIComponent);
  const tab = TABS.find(t => t.id === parts[0]) ?? TABS[0];
  const v = buildView(mode, real);

  renderHeader(v, tab.id);
  let body;
  if (tab.id === 'overview') body = parts[1] ? renderOverviewDetail(v, parts[1], parts[2]) : renderOverview(v);
  else body = renderPlaceholder(tab);

  document.getElementById('main').innerHTML = `<div class="wrap">${globalBanners(v)}${body}</div>`;
  document.title = `${tab.label} · Command Center`;
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

real = await loadReal();
render();
