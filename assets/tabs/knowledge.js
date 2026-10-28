import { PROJECT_FILES } from '../data.js';
import { esc, link, fmtDate, sampleTag, card, grid, missingNote, emptyState, back, table, stateBadge, storyLink, roleName, systemName } from '../ui.js';

const covers = r => (Array.isArray(r.fulfilled_by) ? r.fulfilled_by : []);
const isGap = r => String(r.priority).toLowerCase() === 'must' && !covers(r).length;

function coverage(v, r) {
  const ids = covers(r);
  if (!ids.length) return isGap(r) ? '<span class="tag warn">Gap: no story covers this</span>' : '—';
  return ids.map(id => `${storyLink(v, id)} ${stateBadge(v.stories.find(s => s.id === id)?.state)}`).join('<br>');
}

export function render(v, parts) {
  const sub = parts[1];
  if (sub === 'requirements') return requirements(v);
  if (sub === 'traceability') return traceability(v);
  if (sub === 'stories') return stories(v);
  if (sub === 'notes') return notes(v);
  if (sub === 'req') return requirement(v, parts[2]);

  const gaps = v.requirements.filter(isGap);
  const n = v.notes ?? {};
  const noteCount = (n.decisions?.length ?? 0) + (n.notes?.length ?? 0);
  return `<h1>Knowledge base${sampleTag(v)}</h1>
    <p class="lede">Everything the project knows about itself. Requirements and stories come from your plan. Decisions and notes are yours, in <code>${PROJECT_FILES.notes}</code>, and you add to them as you go.</p>
    ${grid([
      card(v, { href: link('knowledge', 'requirements'), label: 'Requirements', value: v.plan ? v.requirements.length : null, note: missingNote(v, 'plan') || 'Every requirement in your plan' }),
      card(v, { href: link('knowledge', 'traceability'), label: 'Traceability', value: v.plan ? (gaps.length ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'}` : 'No gaps') : null, note: missingNote(v, 'plan') || 'Requirement → stories → verified' }),
      card(v, { href: link('knowledge', 'stories'), label: 'Stories', value: v.plan ? v.stories.length : null, note: missingNote(v, 'plan') || 'Every story and its narrative' }),
      card(v, { href: link('knowledge', 'notes'), label: 'Decisions & notes', value: v.notes ? noteCount : null, note: v.notes ? 'Added by you as the build goes' : `<code>${PROJECT_FILES.notes}</code> not found` }),
    ])}
    ${gaps.length ? `<h2>Gaps</h2><p class="lede">"Must" requirements that no story covers yet:</p><ul>${gaps.map(r => `<li><a href="${link('knowledge', 'req', r.id)}"><strong>${esc(r.id)}</strong></a> ${esc(r.statement)}</li>`).join('')}</ul>` : ''}
    <h2>Ask about this project</h2>
    <div class="chat" id="chat">
      <div class="chat-log" id="chat-log"><div class="chat-msg bot">I answer only from the data on this page, and say which tab each answer comes from. If your data doesn't hold the answer, I'll tell you rather than guess. Try "what is REQ-009", "when is demo day", "which systems" or "audit".</div></div>
      <form class="chat-form" id="chat-form"><input id="chat-input" type="text" autocomplete="off" placeholder="Ask a question about this project…" aria-label="Question"><button type="submit">Ask</button></form>
    </div>`;
}

function requirements(v) {
  const b = back('#/knowledge', 'Knowledge base');
  if (!v.requirements.length) return b + `<h1>Requirements</h1>` + emptyState('Every requirement with its kind, priority and cluster.', missingNote(v, 'plan') || 'Your plan has no requirements.');
  return b + `<h1>Requirements${sampleTag(v)}</h1>` + table(['ID', 'Statement', 'Kind', 'Priority', 'Cluster'], v.requirements.map(r => [
    `<a href="${link('knowledge', 'req', r.id)}"><strong>${esc(r.id)}</strong></a>`, esc(r.statement), esc(r.kind ?? '—'), esc(r.priority ?? '—'), esc(r.cluster ?? '—'),
  ]));
}

function traceability(v) {
  const b = back('#/knowledge', 'Knowledge base');
  if (!v.requirements.length) return b + `<h1>Traceability</h1>` + emptyState('Every requirement, the stories that cover it, and whether they are verified.', missingNote(v, 'plan') || 'Your plan has no requirements.');
  return b + `<h1>Traceability${sampleTag(v)}</h1>
    <p class="lede">From <code>plan.requirements[].fulfilled_by</code>. A "must" requirement with no story is a real gap, and it is shown, not hidden.</p>` +
    table(['Requirement', 'Priority', 'Covered by'], v.requirements.map(r => [
      `<a href="${link('knowledge', 'req', r.id)}"><strong>${esc(r.id)}</strong></a> ${esc(r.statement)}`, esc(r.priority ?? '—'), coverage(v, r),
    ]));
}

function stories(v) {
  const b = back('#/knowledge', 'Knowledge base');
  if (!v.stories.length) return b + `<h1>Stories</h1>` + emptyState('Every story and the narrative it was written from.', missingNote(v, 'plan') || 'Your plan has no stories.');
  return b + `<h1>Stories${sampleTag(v)}</h1>` + table(['Story', 'Narrative', 'State'], v.stories.map(s => [storyLink(v, s.id), esc(s.narrative ?? '—'), stateBadge(s.state)]));
}

function notes(v) {
  const b = back('#/knowledge', 'Knowledge base');
  if (!v.notes) return b + `<h1>Decisions & notes</h1>` + emptyState('The decisions you make and the notes you keep as the build goes.', `<code>${PROJECT_FILES.notes}</code> could not be read.`);
  const d = v.notes.decisions ?? [], n = v.notes.notes ?? [];
  return b + `<h1>Decisions & notes${sampleTag(v)}</h1>
    <p class="lede">To add one, append an entry to <code>${PROJECT_FILES.notes}</code> and push. This page never rewrites that file.</p>
    <h2>Decisions</h2>
    ${d.length ? table(['Date', 'Decision', 'Why'], d.map(x => [fmtDate(x.date), esc(x.statement), esc(x.rationale ?? '—')])) : '<p class="lede">No decisions recorded yet.</p>'}
    <h2>Notes</h2>
    ${n.length ? table(['Date', 'Note'], n.map(x => [fmtDate(x.date), esc(x.text)])) : '<p class="lede">No notes yet.</p>'}`;
}

function requirement(v, id) {
  const b = back('#/knowledge/requirements', 'Requirements');
  const r = v.requirements.find(x => x.id === id);
  if (!r) return b + `<h1>${esc(id)}</h1>` + emptyState('This requirement and the stories that cover it.', missingNote(v, 'plan') || 'No requirement with this id is in your plan.');
  return b + `<h1>${esc(r.id)}${sampleTag(v)}</h1>
    <p class="lede">${esc(r.statement)}</p>
    <dl class="facts">
      <dt>Kind</dt><dd>${esc(r.kind ?? '—')}</dd>
      <dt>Priority</dt><dd>${esc(r.priority ?? '—')}</dd>
      <dt>Cluster</dt><dd>${esc(r.cluster ?? '—')}</dd>
      <dt>Covered by</dt><dd>${coverage(v, r)}</dd>
    </dl>`;
}

// ---------- chat: answers only from the loaded data, citing the tab ----------

const cite = (tab, href) => ` <a class="cite" href="${href}">[${tab}]</a>`;

function answer(v, q) {
  const text = q.toLowerCase();
  const out = [];

  for (const id of text.toUpperCase().match(/\b(REQ|STORY|SREQ|SAMPLE)-\d+\b/g) ?? []) {
    const r = v.requirements.find(x => x.id === id);
    if (r) out.push(`<strong>${esc(r.id)}</strong> (${esc(r.kind)}, ${esc(r.priority)}): ${esc(r.statement)}${cite('Knowledge base', link('knowledge', 'req', r.id))}`);
    const s = v.stories.find(x => x.id === id);
    if (s) out.push(`<strong>${esc(s.id)}</strong> ${esc(s.title)}: due ${fmtDate(s.due_on)}, ${stateBadge(s.state)}${cite('Project management', link('project', 'story', s.id))}`);
  }
  if (out.length) return out;

  if (/demo|deadline|build (end|start)|schedule/.test(text) && v.schedule) {
    out.push(`Build runs ${fmtDate(v.schedule.build_start)} → ${fmtDate(v.schedule.build_end)}. Demo day is ${fmtDate(v.schedule.demo_day)}.${cite('Project management', link('project', 'schedule'))}`);
  }
  if (/how many|verified|progress|points|criteria/.test(text) && v.totals) {
    const t = v.totals;
    out.push(`${t.stories_verified ?? 0} of ${t.stories_total ?? 0} stories verified, ${t.criteria_passed ?? 0} of ${t.criteria_total ?? 0} criteria passed, ${t.points_awarded ?? 0} points.${cite('Overview', '#/overview')}`);
  }
  if (/system|integrat|connect/.test(text) && v.systems.length) {
    out.push(`Your plan names ${v.systems.map(systemName).map(esc).join(', ')}. None is checked from here, so their connection status is unknown.${cite('Systems', '#/systems')}`);
  }
  if (/role|user|who/.test(text) && v.roles.length) {
    out.push(`Roles in your stories: ${v.roles.map(roleName).map(esc).join(', ')}.${cite('Users and use case', '#/users')}`);
  }
  if (/guardrail|safe|never|security/.test(text) && v.guardrails.length) {
    out.push(`Guardrails: ${v.guardrails.map(g => `${esc(g.id)} ${esc(g.statement)}`).join('; ')}.${cite('Guardrails', '#/guardrails')}`);
  }
  if (/gap|uncovered|missing/.test(text) && v.requirements.length) {
    const gaps = v.requirements.filter(isGap);
    out.push((gaps.length ? `Uncovered "must" requirements: ${gaps.map(r => esc(r.id)).join(', ')}.` : 'Every "must" requirement has at least one story.') + cite('Knowledge base', link('knowledge', 'traceability')));
  }
  if (out.length) return out;

  // Fall back to keyword matches in requirement statements and story titles.
  const words = text.split(/\W+/).filter(w => w.length > 3);
  if (words.length) {
    const hit = s => words.some(w => String(s ?? '').toLowerCase().includes(w));
    v.requirements.filter(r => hit(r.statement)).slice(0, 4).forEach(r =>
      out.push(`<strong>${esc(r.id)}</strong>: ${esc(r.statement)}${cite('Knowledge base', link('knowledge', 'req', r.id))}`));
    v.stories.filter(s => hit(s.title)).slice(0, 4).forEach(s =>
      out.push(`<strong>${esc(s.id)}</strong> ${esc(s.title)}${cite('Project management', link('project', 'story', s.id))}`));
  }
  return out;
}

export function mount(v) {
  const form = document.getElementById('chat-form');
  if (!form) return;
  const log = document.getElementById('chat-log');
  const input = document.getElementById('chat-input');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const lines = answer(v, q);
    const reply = lines.length
      ? lines.map(l => `<div>${l}</div>`).join('')
      : (v.plan ? "I can't answer that from your data. Nothing on this page covers it." : "I can't answer that: your plan file isn't committed yet, so there's no data to answer from.");
    log.insertAdjacentHTML('beforeend', `<div class="chat-msg you">${esc(q)}</div><div class="chat-msg bot">${v.isSample ? '<span class="tag sample">SAMPLE</span> ' : ''}${reply}</div>`);
    input.value = '';
    log.scrollTop = log.scrollHeight;
  });
}
