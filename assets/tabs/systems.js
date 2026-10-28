import { esc, link, sampleTag, card, grid, missingNote, emptyState, back, table, relAge, systemName, storyLink } from '../ui.js';

const LABEL = { connected: 'Connected', not_connected: 'Not connected', error: 'Error' };

// Grey and "not checked from here" unless something actually reported a state.
function indicator(v, name) {
  const s = v.systemStatus[name];
  if (!s) return { cls: '', text: 'Not checked from here', checked: 'Never' };
  const cls = s.state === 'connected' ? 'verified' : s.state === 'error' ? 'error' : '';
  const when = new Date(s.checked_at);
  return { cls, text: LABEL[s.state] ?? s.state, checked: isNaN(when) ? 'Unknown' : `${when.toLocaleString('en-GB')} (${relAge(Date.now() - when)})`, detail: s.detail };
}

const dot = i => `<span class="state ${i.cls}"><span class="dot"></span>${esc(i.text)}</span>`;

function checks(v) {
  return back('#/systems', 'Systems') + `<h1>Connection checks${sampleTag(v)}</h1>
    <p class="lede">A system's indicator turns green, red or amber only when your running system tests that connection and reports the result, with the time it checked. Nothing in this repo can do that, so on this page every system starts grey: not checked from here.</p>
    ${emptyState('The latest check for each system: connected, not connected or error, and when.', 'Build a connection for the system and have it report a health check that this page can read.')}`;
}

export function render(v, parts) {
  if (parts[1] === 'checks') return checks(v);
  if (parts[1]) return detail(v, parts[1]);
  const names = v.systems.map(systemName).filter(Boolean);
  return `<h1>Systems: what this connects to${sampleTag(v)}</h1>
    <p class="lede">From <code>plan.derived.systems</code>. Your plan names these systems, but nothing in this repo can tell whether one is connected. Each stays grey until your running system reports its own status.</p>
    ${names.length ? `<div class="rows">${names.map(n => {
        const i = indicator(v, n);
        return `<a class="row${v.isSample ? ' is-sample' : ''}" href="${link('systems', n)}">
          <span class="row-name">${esc(n)}${sampleTag(v)}</span>
          ${dot(i)}
          <span class="row-meta">Last checked: ${esc(i.checked)}</span>
        </a>`;
      }).join('')}</div>`
      : emptyState('One row per system, each with a status indicator and when it was last checked.', missingNote(v, 'plan') || 'Your plan names no systems.')}
    <h2>How status is checked</h2>
    ${grid([card(v, { href: link('systems', 'checks'), label: 'Connection checks', note: 'Why every indicator is grey until your system reports' })])}`;
}

function detail(v, name) {
  const b = back('#/systems', 'Systems');
  if (!v.systems.map(systemName).includes(name)) return b + `<h1>${esc(name)}</h1>` + emptyState('This system, its connection status and what depends on it.', missingNote(v, 'plan') || 'This system is not in your plan.');
  const i = indicator(v, name);
  const needle = name.toLowerCase();
  const reqs = v.requirements.filter(r => String(r.statement ?? '').toLowerCase().includes(needle));
  const stories = v.stories.filter(s => String(s.title ?? '').toLowerCase().includes(needle));
  return b + `<h1>${esc(name)}${sampleTag(v)}</h1>
    <dl class="facts">
      <dt>Status</dt><dd>${dot(i)}${i.detail ? ` · ${esc(i.detail)}` : ''}</dd>
      <dt>Last checked</dt><dd>${esc(i.checked)}</dd>
    </dl>
    ${v.systemStatus[name] ? '' : '<p class="lede">No connection has been built or checked yet. When your system can test this connection, its result shows here with the time it was checked.</p>'}
    <h2>Requirements that name it</h2>
    ${reqs.length ? table(['Requirement', 'Statement'], reqs.map(r => [`<a href="${link('knowledge', 'req', r.id)}"><strong>${esc(r.id)}</strong></a>`, esc(r.statement)])) : '<p class="lede">None by name.</p>'}
    <h2>Stories that name it</h2>
    ${stories.length ? `<ul>${stories.map(s => `<li>${storyLink(v, s.id)}</li>`).join('')}</ul>` : '<p class="lede">None by name.</p>'}`;
}
