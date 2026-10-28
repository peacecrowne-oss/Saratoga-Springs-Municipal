import { esc, link, sampleTag, card, grid, missingNote, emptyState, back, table, stateBadge, storyLink } from '../ui.js';

// requirement.fulfilled_by → story ids → progress verification.state
export function enforcement(v, id) {
  const req = v.requirements.find(r => r.id === id);
  const ids = Array.isArray(req?.fulfilled_by) ? req.fulfilled_by : [];
  const stories = ids.map(sid => v.stories.find(s => s.id === sid) ?? { id: sid, state: null });
  const kept = stories.length > 0 && stories.every(s => s.state === 'verified');
  let status;
  if (!stories.length) status = 'No story covers this yet. A promise you have made and not yet kept.';
  else if (kept) status = 'Enforced: every story that covers it is verified.';
  else status = 'A promise you have made and not yet kept: the stories that enforce it are not all verified.';
  return { req, stories, kept, status };
}

function howEnforced(v) {
  return back('#/guardrails', 'Guardrails') + `<h1>How a guardrail counts as enforced${sampleTag(v)}</h1>
    <p class="lede">Each guardrail is a SAFE requirement. Its <code>fulfilled_by</code> lists the stories that build the protection, and the guardrail counts as enforced only once every one of those stories is verified in <code>progress.json</code>. Until then this page calls it a promise you have made and not yet kept.</p>
    ${v.plan ? '' : emptyState('The status of each guardrail.', missingNote(v, 'plan'))}`;
}

export function render(v, parts) {
  if (parts[1] === 'how') return howEnforced(v);
  if (parts[1]) return detail(v, parts[1]);

  const noSafe = v.plan && !v.guardrails.length;
  const cards = v.guardrails.map(g => {
    const e = enforcement(v, g.id);
    return card(v, {
      href: link('guardrails', g.id),
      label: g.id,
      note: `${esc(g.statement)}<br><br><span class="state${e.kept ? ' verified' : ''}"><span class="dot"></span>${e.kept ? 'Enforced' : 'Promise not yet kept'}</span>`,
    });
  });
  return `<h1>Guardrails: what must never happen${sampleTag(v)}</h1>
    <p class="lede">The promises your system makes, from <code>plan.derived.guardrails</code>. A guardrail counts as enforced only when every story that fulfils it is verified.</p>
    ${noSafe ? `<div class="banner missing">Your plan has no SAFE requirement, so there are no guardrails. That is worth fixing before you build further.</div>` : ''}
    ${v.guardrails.length ? '' : emptyState('One card per guardrail, showing whether anything in the build enforces it.', missingNote(v, 'plan') || 'Add a SAFE requirement to your plan.')}
    ${grid([...cards, card(v, { href: link('guardrails', 'how'), label: 'How this is judged', note: 'What has to be true before a guardrail counts as enforced' })])}`;
}

function detail(v, id) {
  const b = back('#/guardrails', 'Guardrails');
  const g = v.guardrails.find(x => x.id === id);
  if (!g) return b + `<h1>${esc(id)}</h1>` + emptyState('This guardrail and the stories that enforce it.', missingNote(v, 'plan') || 'No guardrail with this id is in your plan.');
  const e = enforcement(v, id);
  return b + `<h1>${esc(g.id)}${sampleTag(v)}</h1>
    <p class="lede">${esc(g.statement)}</p>
    <p><strong>${esc(e.status)}</strong></p>
    ${e.stories.length ? table(['Story that enforces it', 'State'], e.stories.map(s => [storyLink(v, s.id), stateBadge(s.state)]))
      : emptyState('The stories that enforce this guardrail.', e.req ? 'This requirement has an empty fulfilled_by in your plan.' : 'The requirement is not in plan.requirements.')}`;
}
