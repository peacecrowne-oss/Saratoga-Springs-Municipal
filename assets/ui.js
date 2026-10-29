// Shared rendering helpers for every tab.

import { DATA_FILES, PROJECT_FILES } from './data.js';

export const DAY = 86400000;

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const link = (...parts) => '#/' + parts.map(p => encodeURIComponent(String(p))).join('/');

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  return isNaN(d) ? null : d;
}

export function fmtDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

export function relAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function daysBetween(fromIso, toIso) {
  const a = parseDate(fromIso), b = parseDate(toIso);
  return a && b ? Math.round((b - a) / DAY) : null;
}

const STATE_LABEL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', verified: 'Verified' };

export function stateBadge(state) {
  // No verification block means "not measured", which is different from not_started.
  if (!state) return '<span class="state"><span class="dot"></span>Not checked yet</span>';
  return `<span class="state ${esc(state)}"><span class="dot"></span>${esc(STATE_LABEL[state] ?? state)}</span>`;
}

export function sampleTag(v) { return v.isSample ? ' <span class="tag sample">SAMPLE</span>' : ''; }

// A card always links somewhere. Pass `value` for a headline (null renders
// "Not in your data yet"); leave it out for a text-only card.
export function card(v, { href, label, value, note }) {
  const hasValueKey = arguments[1] && 'value' in arguments[1];
  const hasValue = value !== null && value !== undefined && value !== '';
  return `<a class="card${v.isSample ? ' is-sample' : ''}" href="${href}">
    <div class="label">${esc(label)}${sampleTag(v)}</div>
    ${hasValueKey ? `<div class="value${hasValue ? '' : ' none'}">${hasValue ? esc(value) : 'Not in your data yet'}</div>` : ''}
    ${note ? `<div class="note">${note}</div>` : ''}
  </a>`;
}

export const grid = items => `<div class="grid">${items.join('')}</div>`;

export function missingNote(v, file) {
  const path = DATA_FILES[file] ?? PROJECT_FILES[file];
  return v.missing[file] ? `<code>${esc(path)}</code> is not committed yet. Sync from the portal.` : '';
}

export function emptyState(what, needs) {
  return `<div class="empty"><strong>What will be here:</strong> ${what}<br><strong>What has to happen first:</strong> ${needs}</div>`;
}

export const back = (href, label) => `<div class="crumbs"><a href="${href}">← ${esc(label)}</a></div>`;

export function table(head, rows) {
  return `<div class="table-scroll"><table>
    <thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// Field names follow docs/DATA_CONTRACT.md.
export const storyRelease = s => s?.release ?? null;
export const storyOwner = s => s?.owner_agent || null;
export const criterionText = c => (typeof c === 'string' ? c : c?.text ?? c?.statement ?? '');
export const roleName = r => (typeof r === 'string' ? r : r?.name ?? r?.role ?? '');
export const systemName = s => (typeof s === 'string' ? s : s?.name ?? '');

export function storyLink(v, id) {
  const s = v.stories.find(x => x.id === id);
  return `<a href="${link('project', 'story', id)}"><strong>${esc(id)}</strong></a>${s ? ' ' + esc(s.title) : ' <span class="tag">not in plan.stories</span>'}`;
}
