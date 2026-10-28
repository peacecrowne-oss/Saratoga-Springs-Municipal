import { esc, link, sampleTag, card, grid, missingNote, emptyState, back } from '../ui.js';

const TARGET_NOTE = 'No numeric target in your plan yet';

export function render(v, parts) {
  if (parts[1] === 'targets') return targets(v);
  if (parts[1]) return measure(v, parts[1]);

  const cards = v.measures.map(m => card(v, {
    href: link('outcomes', m.id),
    label: m.id,
    note: `${esc(m.statement)}<br><br><em>${TARGET_NOTE}. Nothing measures this yet.</em>`,
  }));
  cards.push(card(v, { href: link('outcomes', 'targets'), label: 'Targets', value: null, note: 'Where the numbers each measure must reach will go' }));

  return `<h1>Outcomes${sampleTag(v)}</h1>
    <p class="lede">The numbers this system has to move. Each measure comes from <code>plan.derived.measures</code>. Your plan states what should move, but not by how much, so no card shows a target or a current value.</p>
    ${v.measures.length ? '' : emptyState('One card per measure your plan commits to.', missingNote(v, 'plan') || 'Your plan has no measures yet.')}
    ${grid(cards)}`;
}

function measure(v, id) {
  const m = v.measures.find(x => x.id === id);
  const b = back('#/outcomes', 'Outcomes');
  if (!m) return b + `<h1>${esc(id)}</h1>` + emptyState('This measure, its target and its current value.', missingNote(v, 'plan') || 'No measure with this id is in your plan.');
  return b + `<h1>${esc(m.id)}${sampleTag(v)}</h1>
    <p class="lede">${esc(m.statement)}</p>
    <dl class="facts">
      <dt>Target</dt><dd>${TARGET_NOTE}.</dd>
      <dt>Current value</dt><dd>Nothing measures this yet. It will appear once your running system reports it.</dd>
      <dt>Trend</dt><dd>No readings recorded.</dd>
    </dl>`;
}

function targets(v) {
  return back('#/outcomes', 'Outcomes') + `<h1>Targets${sampleTag(v)}</h1>` +
    emptyState('For each measure: a baseline, a target and a date to hit it by.',
      'Add numeric targets to your measures in the portal and sync. This page will not make one up.');
}
