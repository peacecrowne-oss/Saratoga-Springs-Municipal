import { releaseKey, releaseName, currentRelease, isDated } from '../data.js';
import { esc, link, todayIso, fmtDate, daysBetween, stateBadge, sampleTag, card, grid, missingNote, emptyState, back, table, storyRelease } from '../ui.js';

export function whereWeAre(v) {
  if (!v.releases.length) return { value: null, note: missingNote(v, 'plan') || 'Your plan has no releases yet.' };
  const cur = currentRelease(v.releases, todayIso());
  if (!cur) return { value: null, note: 'No release in your plan has dates yet.' };
  const r = cur.release;
  const value = `${releaseKey(r)} · ${releaseName(r)}`;
  const note = cur.relation === 'in' ? `Running ${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}`
    : cur.relation === 'before' ? `Next up, starts ${fmtDate(r.starts_on)}`
    : `Last release ended ${fmtDate(r.ends_on)}`;
  return { value, note, cur };
}

export function render(v, parts) {
  return parts[1] ? detail(v, parts[1], parts[2]) : main(v);
}

function main(v) {
  const t = v.totals;
  const where = whereWeAre(v);
  const demo = v.schedule?.demo_day;
  const demoIn = demo ? daysBetween(todayIso(), demo) : null;

  const releasesHtml = v.releases.length
    ? grid(v.releases.map(r => card(v, {
        href: link('overview', 'release', releaseKey(r)),
        label: `${releaseKey(r)}${r.is_demo_target ? ' · demo target' : ''}`,
        value: releaseName(r),
        note: `${(r.story_ids ?? []).length} stories · ${isDated(r) ? `${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}` : 'no dates in your plan'}`,
      })))
    : emptyState('One card per release, with its dates and stories.', missingNote(v, 'plan') || 'Your plan needs releases.');

  const liveRows = v.stories.length
    ? table(['Story', 'Release', 'Due', 'State'], v.stories.map(s => [
        `<a href="${link('project', 'story', s.id)}"><strong>${esc(s.id)}</strong></a> ${esc(s.title)}${sampleTag(v)}`,
        esc(storyRelease(s) ?? '—'),
        fmtDate(s.due_on),
        stateBadge(s.state),
      ]))
    : emptyState('Every story in your plan and whether it is verified.', missingNote(v, 'plan') || 'Your plan needs stories.');

  return `
    <h1>${esc(v.project?.name ?? 'Project name not in your data yet')}${sampleTag(v)}</h1>
    <p class="lede">${v.project?.descriptor ? esc(v.project.descriptor) : (missingNote(v, 'plan') || 'Your plan has no project descriptor.')}</p>

    ${grid([
      card(v, { href: link('overview', 'about'), label: 'What this is', value: v.project?.name ? 'About the system' : null, note: missingNote(v, 'plan') || 'What the system does and who it is for' }),
      card(v, { href: link('overview', 'schedule'), label: 'Where we are', value: where.value, note: where.note }),
      card(v, { href: link('overview', 'stories'), label: 'Stories verified', value: t ? `${t.stories_verified ?? 0} of ${t.stories_total ?? 0}` : null, note: missingNote(v, 'progress') }),
      card(v, { href: link('overview', 'criteria'), label: 'Criteria passed', value: t ? `${t.criteria_passed ?? 0} of ${t.criteria_total ?? 0}` : null, note: missingNote(v, 'progress') }),
      card(v, { href: link('overview', 'points'), label: 'Points awarded', value: t ? (t.points_awarded ?? 0) : null, note: missingNote(v, 'progress') }),
      card(v, { href: link('overview', 'demo'), label: 'Demo day', value: demo ? fmtDate(demo) : null, note: demo ? (demoIn > 0 ? `${demoIn} days away` : demoIn === 0 ? 'Today' : `${-demoIn} days ago`) : missingNote(v, 'plan') }),
    ])}

    <h2>Releases</h2>
    ${releasesHtml}

    <h2>What is live and what is not</h2>
    <p class="lede">A story counts as live only once the platform has verified it. Everything else is planned or in progress.</p>
    ${liveRows}`;
}

function detail(v, sub, arg) {
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
        <dt>Demo release</dt><dd>${demoRel ? `<a href="${link('overview', 'release', releaseKey(demoRel))}">${esc(releaseKey(demoRel))} · ${esc(releaseName(demoRel))}</a>` : esc(s.demo_release_key ?? '—')}</dd>
      </dl>`;
  }

  if (sub === 'stories' || sub === 'points') {
    const isPoints = sub === 'points';
    const title = isPoints ? 'Points awarded' : 'Stories verified';
    if (!t) return ov + `<h1>${title}</h1>` + emptyState(isPoints ? 'Points awarded per verified story.' : 'Each story and its verification state, with the commit that verified it.', missingNote(v, 'progress') || 'The progress file has no totals yet.');
    const head = isPoints ? `${t.points_awarded ?? 0} points awarded` : `${t.stories_verified ?? 0} of ${t.stories_total ?? 0} stories verified`;
    return ov + `<h1>${title}${sampleTag(v)}</h1><p class="lede">${esc(head)}, from <code>progress.totals</code>.</p>
      ${v.stories.length ? table(['Story', 'State', 'Commit', 'Points'], v.stories.map(s => [
          `<strong>${esc(s.id)}</strong> ${esc(s.title)}`,
          stateBadge(s.state),
          s.progress?.verification?.commit_sha ? `<code>${esc(String(s.progress.verification.commit_sha).slice(0, 10))}</code>` : '—',
          esc(s.progress?.verification?.points_awarded ?? '—'),
        ]))
        : emptyState('The per-story breakdown.', missingNote(v, 'plan') || 'Your plan has no stories.')}`;
  }

  if (sub === 'criteria') {
    if (!t) return ov + `<h1>Criteria passed</h1>` + emptyState('Every acceptance criterion and whether it is ticked.', missingNote(v, 'progress') || 'The progress file has no totals yet.');
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
      ${rows.length ? table(['Story', 'Due', 'First due', 'State'], rows.map(s => {
          const slip = daysBetween(s.due_baseline_on, s.due_on);
          return [
            `<a href="${link('project', 'story', s.id)}"><strong>${esc(s.id)}</strong></a> ${esc(s.title)}`,
            fmtDate(s.due_on),
            `${fmtDate(s.due_baseline_on)}${slip > 0 ? ` <span class="tag">slipped ${slip}d</span>` : ''}`,
            stateBadge(s.state),
          ];
        }))
        : emptyState('The stories in this release.', 'This release has no story_ids yet.')}`;
  }

  return ov + emptyState('Nothing at this address.', 'Go back to Overview.');
}
