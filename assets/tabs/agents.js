import { esc, link, sampleTag, card, grid, missingNote, emptyState, back, table, stateBadge, storyLink, storyOwner } from '../ui.js';

// An agent is "scoped" once the plan says what it does and what starts it.
const isScoped = a => Boolean(a.purpose || a.trigger || a.trigger_type);

// plan.agents[] when present; otherwise the owners named on the stories.
function roster(v) {
  if (v.agents.length) return v.agents.map(a => ({ ...a, owns: Array.isArray(a.owns) ? a.owns : [] }));
  const byOwner = new Map();
  v.stories.forEach(s => {
    const o = storyOwner(s);
    if (o) byOwner.set(o, [...(byOwner.get(o) ?? []), s.id]);
  });
  return [...byOwner].map(([name, owns]) => ({ name, owns }));
}

const list = xs => (Array.isArray(xs) && xs.length ? `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : null);
const skills = a => (Array.isArray(a.skills) && a.skills.length ? a.skills.map(esc).join(', ') : 'No skills registered yet');

export function render(v, parts) {
  if (parts[1] === 'roster') return rosterPage(v);
  if (parts[1]) return agent(v, parts[1]);

  const all = roster(v);
  const anyScoped = all.some(isScoped);
  return `<h1>AI agents${sampleTag(v)}</h1>
    <p class="lede">The agents this system is designed around, from <code>plan.agents</code>. Nothing here has run yet, so there is no run history, last-run time or success rate.</p>
    ${all.length && !anyScoped ? `<div class="banner paused">Your plan does not scope any AI agents yet. These are the <strong>owners</strong> of your stories, not AI agents. Each becomes an agent card once the plan says what it does, what triggers it and how much it may do alone.</div>` : ''}
    ${grid([
      card(v, { href: link('agents', 'roster'), label: 'Roster', value: all.length ? `${all.length} ${anyScoped ? 'agents' : 'owners'}` : null, note: anyScoped ? 'By autonomy level' : (missingNote(v, 'plan') || 'No scoped agents yet') }),
      ...all.map(a => card(v, {
        href: link('agents', a.name),
        label: isScoped(a) ? (a.autonomy_level ?? 'autonomy not set') : 'Story owner, not a scoped agent',
        value: a.name,
        note: `Owns ${a.owns.length ? a.owns.map(esc).join(', ') : 'no stories'}<br>Skills: ${skills(a)}<br><strong>No runs recorded</strong>`,
      })),
    ])}`;
}

function rosterPage(v) {
  const b = back('#/agents', 'AI agents');
  const counts = v.counts?.agents_by_autonomy;
  const all = roster(v);
  if (!all.length) return b + `<h1>Roster</h1>` + emptyState('Every agent, grouped by how much it may do without a person.', missingNote(v, 'plan') || 'Your plan has no agents or story owners.');
  return b + `<h1>Roster${sampleTag(v)}</h1>
    ${counts && Object.keys(counts).length
      ? `<p class="lede">From <code>plan.derived.counts.agents_by_autonomy</code>.</p>` + table(['Autonomy level', 'Agents'], Object.entries(counts).map(([k, n]) => [esc(k), esc(n)]))
      : '<p class="lede">No autonomy breakdown yet: no agent in your plan has an autonomy level.</p>'}
    <h2>Everyone on it</h2>
    ${table(['Name', 'Kind', 'Owns'], all.map(a => [`<a href="${link('agents', a.name)}">${esc(a.name)}</a>`, isScoped(a) ? 'Scoped agent' : 'Story owner', a.owns.map(esc).join(', ') || '—']))}`;
}

function agent(v, name) {
  const b = back('#/agents', 'AI agents');
  const a = roster(v).find(x => x.name === name);
  if (!a) return b + `<h1>${esc(name)}</h1>` + emptyState('This agent\'s design and the stories it owns.', missingNote(v, 'plan') || 'No agent or owner by this name is in your plan.');
  const notSet = '<span class="muted">Not defined in your plan yet</span>';
  const field = (label, val) => `<dt>${label}</dt><dd>${val ?? notSet}</dd>`;
  return b + `<h1>${esc(a.name)}${sampleTag(v)}</h1>
    ${isScoped(a) ? '' : '<p class="lede">This is a story owner, not an AI agent. The design fields below stay empty until your plan scopes an agent for this work.</p>'}
    <dl class="facts">
      ${field('Purpose', a.purpose ? esc(a.purpose) : null)}
      ${field('Trigger', a.trigger ? `${esc(a.trigger_type ?? '')} · ${esc(a.trigger)}` : null)}
      ${field('Inputs', list(a.inputs))}
      ${field('Outputs', list(a.outputs))}
      ${field('Autonomy', a.autonomy_level ? esc(a.autonomy_level) : null)}
      ${field('Approval gates', list(a.approval_gates))}
      ${field('Escalation', list(a.escalation_rules))}
      <dt>Skills</dt><dd>${skills(a)}</dd>
      <dt>Runs</dt><dd><strong>No runs recorded.</strong> Run history appears once this agent is built and running.</dd>
    </dl>
    <h2>Stories it owns</h2>
    ${a.owns.length ? table(['Story', 'State'], a.owns.map(id => [storyLink(v, id), stateBadge(v.stories.find(s => s.id === id)?.state)])) : '<p class="lede">None.</p>'}`;
}
