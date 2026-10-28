import { releaseKey, releaseName } from '../data.js';
import { esc, link, todayIso, fmtDate, daysBetween, stateBadge, sampleTag, card, grid, missingNote, emptyState, back, table, storyRelease, storyOwner, criterionText } from '../ui.js';

const slipTag = s => {
  const slip = daysBetween(s.due_baseline_on, s.due_on);
  return slip > 0 ? ` <span class="tag warn">slipped ${slip}d</span>` : slip < 0 ? ` <span class="tag">${-slip}d early</span>` : '';
};

function gantt(v) {
  const s = v.schedule ?? {};
  const starts = v.releases.map(r => r.starts_on).filter(Boolean).sort();
  const ends = [...v.releases.map(r => r.ends_on), s.build_end, s.demo_day].filter(Boolean).sort();
  const from = s.build_start ?? starts[0];
  const to = ends[ends.length - 1];
  const span = daysBetween(from, to) + 1;
  if (!from || !to || !(span > 0)) return '';
  const pct = d => Math.max(0, Math.min(100, (daysBetween(from, d) / span) * 100));
  const today = todayIso();
  const marker = (d, cls, label) => d && d >= from && d <= to ? `<span class="gantt-marker ${cls}" style="left:${pct(d)}%" title="${esc(label)}"></span>` : '';
  return `<div class="gantt">
    <div class="gantt-scale"><span>${fmtDate(from)}</span><span>${fmtDate(to)}</span></div>
    ${v.releases.map(r => `<a class="gantt-row" href="${link('project', 'release', releaseKey(r))}">
        <span class="gantt-label">${esc(releaseKey(r))} · ${esc(releaseName(r))}</span>
        <span class="gantt-track">
          <span class="gantt-bar${r.is_demo_target ? ' demo' : ''}${v.isSample ? ' sample' : ''}" style="left:${pct(r.starts_on)}%;width:${Math.max(1.5, pct(r.ends_on) - pct(r.starts_on) + 100 / span)}%"></span>
          ${marker(today, 'today', `Today, ${fmtDate(today)}`)}
          ${marker(s.demo_day, 'demo', `Demo day, ${fmtDate(s.demo_day)}`)}
        </span>
      </a>`).join('')}
    <div class="gantt-legend"><span><i class="today"></i>Today</span><span><i class="demo"></i>Demo day</span><span><i class="bar demo"></i>Demo release</span></div>
  </div>`;
}

export function render(v, parts) {
  if (parts[1] === 'story') return story(v, parts[2]);
  if (parts[1] === 'release') return release(v, parts[2]);
  if (parts[1] === 'schedule') return schedule(v);

  const s = v.schedule;
  const tasks = [...v.stories].sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)));
  return `<h1>Project management${sampleTag(v)}</h1>
    <p class="lede">Releases from <code>plan.releases</code>, due dates from <code>plan.stories</code>, state from <code>progress.json</code>. Each story shows its current due date and the date it was first given, so any slippage stays visible.</p>
    ${grid([
      card(v, { href: link('project', 'schedule'), label: 'Build window', value: s ? `${fmtDate(s.build_start)} → ${fmtDate(s.build_end)}` : null, note: s ? `Demo day ${fmtDate(s.demo_day)}` : missingNote(v, 'plan') }),
    ])}
    <h2>Releases</h2>
    ${v.releases.length ? gantt(v) : emptyState('A Gantt bar per release across the build window, with today and demo day marked.', missingNote(v, 'plan') || 'Your plan has no releases.')}
    <h2>Tasks</h2>
    ${tasks.length ? table(['Story', 'Release', 'Due', 'First due', 'State'], tasks.map(t => [
        `<a href="${link('project', 'story', t.id)}"><strong>${esc(t.id)}</strong></a> ${esc(t.title)}${sampleTag(v)}`,
        esc(storyRelease(t) ?? '—'),
        fmtDate(t.due_on) + slipTag(t),
        fmtDate(t.due_baseline_on),
        stateBadge(t.state),
      ]))
      : emptyState('Every story with its due date, first due date and state.', missingNote(v, 'plan') || 'Your plan has no stories.')}`;
}

function schedule(v) {
  const b = back('#/project', 'Project management');
  const s = v.schedule;
  if (!s) return b + `<h1>Build window</h1>` + emptyState('Build start, build end, demo day and the demo release.', missingNote(v, 'plan') || 'Your plan has no schedule.');
  const prep = daysBetween(s.build_end, s.demo_day);
  return b + `<h1>Build window${sampleTag(v)}</h1>
    <dl class="facts">
      <dt>Build starts</dt><dd>${fmtDate(s.build_start)}</dd>
      <dt>Build ends</dt><dd>${fmtDate(s.build_end)}</dd>
      <dt>Demo day</dt><dd>${fmtDate(s.demo_day)}</dd>
      <dt>Demo prep</dt><dd>${prep > 0 ? `${prep} days between build end and demo day` : 'None: build ends on demo day'}</dd>
      <dt>Demo release</dt><dd>${esc(s.demo_release_key ?? '—')}</dd>
    </dl>`;
}

function release(v, key) {
  const b = back('#/project', 'Project management');
  const r = v.releases.find(x => releaseKey(x) === key);
  if (!r) return b + `<h1>Release ${esc(key)}</h1>` + emptyState('This release and its stories.', missingNote(v, 'plan') || 'No release with this key is in your plan.');
  const rows = (r.story_ids ?? []).map(id => v.stories.find(s => s.id === id) ?? { id, title: '(not in plan.stories)' });
  return b + `<h1>${esc(releaseKey(r))} · ${esc(releaseName(r))}${r.is_demo_target ? ' <span class="tag demo">Demo target</span>' : ''}${sampleTag(v)}</h1>
    <p class="lede">${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}</p>
    ${rows.length ? table(['Story', 'Due', 'First due', 'State'], rows.map(s => [
        `<a href="${link('project', 'story', s.id)}"><strong>${esc(s.id)}</strong></a> ${esc(s.title)}`,
        fmtDate(s.due_on) + slipTag(s), fmtDate(s.due_baseline_on), stateBadge(s.state),
      ])) : emptyState('The stories in this release.', 'This release has no story_ids yet.')}`;
}

function story(v, id) {
  const b = back('#/project', 'Project management');
  const s = v.stories.find(x => x.id === id);
  if (!s) return b + `<h1>${esc(id)}</h1>` + emptyState('This story: narrative, dates, owner, criteria and verification.', missingNote(v, 'plan') || 'No story with this id is in your plan.');
  const ver = s.progress?.verification ?? {};
  const planned = Array.isArray(s.acceptance_criteria) ? s.acceptance_criteria.map(criterionText) : [];
  const ticks = new Map((s.progress?.criteria ?? []).map(c => [c.text, c.passed]));
  return b + `<h1>${esc(s.id)} · ${esc(s.title)}${sampleTag(v)}</h1>
    ${s.narrative ? `<p class="lede">${esc(s.narrative)}</p>` : ''}
    <dl class="facts">
      <dt>Release</dt><dd>${storyRelease(s) ? `<a href="${link('project', 'release', storyRelease(s))}">${esc(storyRelease(s))}</a>` : '—'}</dd>
      <dt>Owner</dt><dd>${esc(storyOwner(s) ?? '—')}</dd>
      <dt>Due</dt><dd>${fmtDate(s.due_on)}${slipTag(s)}</dd>
      <dt>First due</dt><dd>${fmtDate(s.due_baseline_on)}</dd>
      <dt>State</dt><dd>${stateBadge(s.state)}</dd>
      <dt>Verified commit</dt><dd>${ver.commit ? `<code>${esc(String(ver.commit).slice(0, 10))}</code>` : '—'}</dd>
      <dt>Points</dt><dd>${esc(ver.points ?? '—')}</dd>
    </dl>
    <h2>Acceptance criteria</h2>
    ${planned.length ? `<ul>${planned.map(t => `<li>${ticks.get(t) === true ? '✅' : '⬜'} ${esc(t)}</li>`).join('')}</ul>`
      : emptyState('The criteria this story is checked against.', 'Your plan lists none for this story.')}`;
}
