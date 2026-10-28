import { esc, link, sampleTag, card, grid, missingNote, emptyState, back, table, stateBadge, roleName, storyOwner } from '../ui.js';

// Stories this role appears in: "As a <role>, …" narratives, or stories it owns.
function storiesFor(v, role) {
  const r = role.toLowerCase();
  return v.stories.filter(s => {
    const n = String(s.narrative ?? '').toLowerCase();
    return n.startsWith(`as a ${r}`) || n.startsWith(`as an ${r}`) || String(storyOwner(s) ?? '').toLowerCase().replace(/_/g, ' ') === r;
  });
}

export function render(v, parts) {
  if (parts[1] === 'use-case') return useCase(v);
  if (parts[1] === 'role') return role(v, parts[2]);

  const roles = v.roles.map(roleName).filter(Boolean);
  const cards = [
    card(v, { href: link('users', 'use-case'), label: 'Use case', note: v.project?.descriptor ? esc(v.project.descriptor) : (missingNote(v, 'plan') || 'Your plan has no descriptor.') }),
    ...roles.map(r => {
      const n = storiesFor(v, r).length;
      return card(v, { href: link('users', 'role', r), label: 'Role', value: r, note: `${n} stor${n === 1 ? 'y' : 'ies'} in your plan` });
    }),
  ];
  return `<h1>Users and use case${sampleTag(v)}</h1>
    <p class="lede">Who this is for and what they are trying to get done. Roles come from <code>plan.derived.roles</code>, taken from your stories' "As a …" lines.</p>
    ${roles.length ? '' : emptyState('One card per role in your stories.', missingNote(v, 'plan') || 'Your plan has no roles yet.')}
    ${grid(cards)}`;
}

function useCase(v) {
  const b = back('#/users', 'Users and use case');
  if (!v.project) return b + `<h1>Use case</h1>` + emptyState('What the system is for, and the roles it serves.', missingNote(v, 'plan'));
  return b + `<h1>Use case${sampleTag(v)}</h1>
    <p class="lede">${esc(v.project.descriptor ?? '')}</p>
    <h2>Roles it serves</h2>
    ${v.roles.length ? `<ul>${v.roles.map(roleName).map(r => `<li><a href="${link('users', 'role', r)}">${esc(r)}</a></li>`).join('')}</ul>` : '<p class="lede">No roles in your plan yet.</p>'}`;
}

function role(v, name) {
  const b = back('#/users', 'Users and use case');
  const known = v.roles.map(roleName).includes(name);
  if (!known) return b + `<h1>${esc(name)}</h1>` + emptyState('This role and the stories written for it.', missingNote(v, 'plan') || 'This role is not in your plan.');
  const stories = storiesFor(v, name);
  return b + `<h1>${esc(name)}${sampleTag(v)}</h1>
    <p class="lede">What this role is trying to get done, in their own stories' words.</p>
    ${stories.length ? table(['Story', 'What they want', 'State'], stories.map(s => [
        `<a href="${link('project', 'story', s.id)}"><strong>${esc(s.id)}</strong></a>`,
        esc(s.narrative ?? s.title),
        stateBadge(s.state),
      ]))
      : emptyState('The stories this role appears in.', 'No story narrative in your plan names this role yet.')}`;
}
