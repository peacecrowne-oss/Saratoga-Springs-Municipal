// Asset Management Dashboard (STORY-004): the inventory, one asset's lifecycle,
// condition and maintenance, and everything still to do. All rules live on the
// server; this page shows what it answers, including why it refused.

import { BACK_TO_LIST, currentUser, detailOpened } from '/session.js';

const PAGE = 50;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const pill = (text, cls = text) => `<span class="pill ${esc(cls)}">${esc(text)}</span>`;

let offset = 0;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// What the server refused, naming each wrong field when it did.
function refusal(body, status) {
  const e = body.error ?? {};
  const problems = e.problems?.length ? `<ul style="margin:4px 0 0;padding-left:18px">${e.problems.map(p => `<li>${esc(p.field)} ${esc(p.problem)}</li>`).join('')}</ul>` : '';
  return `<div class="error" role="alert">${problems ? 'Please fix:' : esc(e.message ?? `HTTP ${status}`)}${problems}</div>`;
}
const unreachable = err => `<div class="error" role="alert">The server did not answer: ${esc(err.message)}</div>`;

async function refreshInventory() {
  const p =new URLSearchParams({ limit: PAGE, offset });
  const filters = { q: $('q').value.trim(), asset_type: $('asset_type_filter').value.trim(), status: $('status_filter').value, condition: $('condition_filter').value };
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  try {
    const { status, body } = await call(`/api/assets?${p}`);
    if (status !== 200) { $('inventory').innerHTML = refusal(body, status); $('pager').textContent = ''; return; }
    $('inventory').innerHTML = body.assets.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Tag</th><th>Name</th><th>Type</th><th>Status</th><th>Condition</th><th>Next maintenance</th><th>Flags</th></tr></thead>
      <tbody>${body.assets.map(a => `<tr class="pick" data-id="${esc(a.id)}" tabindex="0">
        <td>${esc(a.assetTag)}</td><td>${esc(a.name)}</td><td>${esc(a.assetType)}</td><td>${pill(a.status)}</td>
        <td>${a.condition ? pill(a.condition.condition) : '<span class="muted">No reading yet</span>'}</td>
        <td>${a.nextMaintenance ? esc(a.nextMaintenance.dueOn) : '<span class="muted">None</span>'}${a.overdueMaintenance ? ` ${pill(`${a.overdueMaintenance} overdue`, 'overdue')}` : ''}</td>
        <td>${a.discrepancies.map(d => esc(d.message)).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`
      : 'No assets match.';
    $('pager').innerHTML = body.total > PAGE
      ? `${offset + 1}–${offset + body.assets.length} of ${body.total} <button class="plain" id="prev" ${offset ? '' : 'disabled'}>Previous</button> <button class="plain" id="next" ${offset + PAGE < body.total ? '' : 'disabled'}>Next</button>`
      : `${body.total} asset${body.total === 1 ? '' : 's'}`;
    $('prev')?.addEventListener('click', () => { offset = Math.max(0, offset - PAGE); refreshInventory(); });
    $('next')?.addEventListener('click', () => { offset += PAGE; refreshInventory(); });
  } catch (err) {
    $('inventory').innerHTML = unreachable(err);
  }
}

async function refreshDue() {
  try {
    const { status, body } = await call('/api/maintenance');
    if (status !== 200) { $('due').innerHTML = refusal(body, status); return; }
    $('due').innerHTML = body.tasks.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Due</th><th>Asset</th><th>Task</th></tr></thead>
      <tbody>${body.tasks.map(t => `<tr class="pick" data-id="${esc(t.assetId)}" tabindex="0"><td>${esc(t.dueOn)} ${t.overdue ? pill('overdue') : ''}</td><td>${esc(t.assetTag)} · ${esc(t.assetName)}</td><td>${esc(t.title)}</td></tr>`).join('')}</tbody></table></div>`
      : 'Nothing scheduled.';
  } catch (err) {
    $('due').innerHTML = unreachable(err);
  }
}

const describe = e => {
  const a = e.after ?? {};
  switch (e.action) {
    case 'asset.create': return 'Added';
    case 'asset.update': return Object.keys(a).filter(k => k !== 'updatedAt' && a[k] !== e.before?.[k]).map(k => `${k}: ${e.before?.[k] ?? 'none'} → ${a[k] ?? 'none'}`).join(', ');
    case 'asset.condition_recorded': return `Condition ${a.condition}${a.outOfOrder ? ' (late reading)' : ''}`;
    case 'asset.condition_discrepancy': return (a.discrepancies ?? []).map(d => d.message).join(' ');
    case 'asset.update_rejected': return `Refused: ${a.message}`;
    case 'asset.update_denied': return `Refused: the ${a.role} role cannot change assets`;
    case 'maintenance.schedule': case 'maintenance.complete': case 'maintenance.cancel': return `${a.title}, due ${a.dueOn}`;
    case 'gis.push': return `Sent to GIS (${a.operation})`;
    case 'gis.pull': return `Updated from GIS by ${a.editedBy ?? 'unknown'}`;
    case 'gis.mismatch': return (a.fields ?? []).map(f => `${f.field}: system ${f.system}, GIS ${f.gis}`).join('; ');
    case 'gis.push_failed': return `GIS refused: ${a.error?.description ?? ''}`;
    default: return '';
  }
};

async function openAsset(id, note = '') {
  try {
    const [{ status, body }, history] = await Promise.all([call(`/api/assets/${encodeURIComponent(id)}`), call(`/api/assets/${encodeURIComponent(id)}/history`)]);
    if (status !== 200) { $('detail').innerHTML = refusal(body, status); return; }
    const a = body.asset;
    const moves = a.nextStatuses.map(s => `<option>${esc(s)}</option>`).join('');
    const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('detail').innerHTML = `<div class="panel">
      ${BACK_TO_LIST}
      <h2 style="margin-top:0">${esc(a.assetTag)} · ${esc(a.name)}</h2>
      <div id="note">${note}</div>
      <div class="facts">
        <span>Lifecycle status: ${pill(a.status)}</span>
        <span>Condition: ${a.condition ? `${pill(a.condition.condition)} <span class="muted">observed ${esc(when(a.condition.observedAt))} by ${esc(a.condition.recordedBy)}</span>` : '<span class="muted">No reading yet</span>'}</span>
        <span>Type: ${esc(a.assetType)}</span>
        <span>Location: ${esc(a.location) || '<span class="muted">Not set</span>'}</span>
      </div>
      ${a.discrepancies.map(d => `<div class="flag" role="status">${esc(d.message)}</div>`).join('')}

      <h3>Change lifecycle status</h3>
      ${moves ? `<form id="move"><select id="move-to" aria-label="New status">${moves}</select><button type="submit">Change status</button></form>` : `<p class="muted">${esc(a.status)} is final.</p>`}

      ${a.status === 'retired' ? '' : `<h3>Record condition</h3>
      <form id="reading">
        <select id="reading-condition" aria-label="Condition"><option>good</option><option>fair</option><option>poor</option><option>critical</option></select>
        <input id="reading-at" type="datetime-local" aria-label="Observed at" value="${nowLocal}" required>
        <input id="reading-notes" aria-label="Notes" placeholder="notes (optional)">
        <select id="reading-status" aria-label="Also change status to"><option value="">keep status</option>${moves}</select>
        <button type="submit">Record</button>
      </form>

      <h3>Schedule maintenance</h3>
      <form id="task">
        <input id="task-title" aria-label="Task" placeholder="task" required>
        <input id="task-due" type="date" aria-label="Due" required>
        <button type="submit">Schedule</button>
      </form>`}

      <h3>Maintenance</h3>
      ${a.maintenance.length ? `<div class="table-scroll"><table><thead><tr><th>Due</th><th>Task</th><th>Status</th><th></th></tr></thead><tbody>${a.maintenance.map(t => `<tr>
        <td>${esc(t.dueOn)} ${t.overdue ? pill('overdue') : ''}</td><td>${esc(t.title)}</td><td>${esc(t.status)}</td>
        <td>${t.status === 'scheduled' ? `<button class="plain" data-task="${esc(t.id)}" data-to="completed">Complete</button> <button class="plain" data-task="${esc(t.id)}" data-to="cancelled">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None scheduled.</p>'}

      <h3>Condition history</h3>
      ${a.conditionHistory.length ? `<div class="table-scroll"><table><thead><tr><th>Observed</th><th>Condition</th><th>Notes</th><th>By</th></tr></thead><tbody>${a.conditionHistory.map(r => `<tr><td>${esc(when(r.observedAt))}</td><td>${pill(r.condition)}</td><td>${esc(r.notes)}</td><td>${esc(r.recordedBy)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No readings yet.</p>'}

      <h3>Audit trail</h3>
      ${history.status !== 200 ? refusal(history.body, history.status) : `<div class="table-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${history.body.events.map(e => `<tr><td>${esc(when(e.occurredAt))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(describe(e))}</td></tr>`).join('')}</tbody></table></div>`}
    </div>`;
    wire(a);
    detailOpened($('detail'), 'inventory', { scroll: !note });
  } catch (err) {
    $('detail').innerHTML = unreachable(err);
  }
}

// Sends one change, then reloads the asset showing what happened.
async function act(id, path, method, body, success) {
  try {
    const { status, body: answer } = await call(path, { method, body });
    const ok = status >= 200 && status < 300;
    const raised = (answer.raised ?? []).map(d => `<div class="flag" role="status">${esc(d.message)}</div>`).join('');
    await openAsset(id, ok ? `<div class="done">${esc(success(status))}</div>${raised}` : refusal(answer, status));
    await Promise.all([refreshInventory(), refreshDue()]);
  } catch (err) {
    $('note').innerHTML = unreachable(err);
  }
}

function wire(a) {
  const base = `/api/assets/${encodeURIComponent(a.id)}`;
  $('move')?.addEventListener('submit', e => {
    e.preventDefault();
    act(a.id, base, 'PATCH', { status: $('move-to').value, expected_updated_at: a.updatedAt }, () => `Status changed to ${$('move-to')?.value ?? 'the new status'}.`);
  });
  $('reading')?.addEventListener('submit', e => {
    e.preventDefault();
    const body = { condition: $('reading-condition').value, observed_at: new Date($('reading-at').value).toISOString(), notes: $('reading-notes').value };
    if ($('reading-status').value) body.status = $('reading-status').value;
    act(a.id, `${base}/conditions`, 'POST', body, s => (s === 201 ? 'Condition recorded.' : 'That reading was already recorded; nothing changed.'));
  });
  $('task')?.addEventListener('submit', e => {
    e.preventDefault();
    act(a.id, `${base}/maintenance`, 'POST', { title: $('task-title').value, due_on: $('task-due').value }, s => (s === 201 ? 'Maintenance scheduled.' : 'That task was already scheduled; nothing changed.'));
  });
  $('detail').querySelectorAll('button[data-task]').forEach(b => b.addEventListener('click', () => {
    act(a.id, `${base}/maintenance/${encodeURIComponent(b.dataset.task)}`, 'PATCH', { status: b.dataset.to }, () => `Task marked ${b.dataset.to}.`);
  }));
}

function onPick(e) {
  if (e.type === 'keydown' && e.key !== 'Enter') return;
  const row = e.target.closest('tr.pick');
  if (row) openAsset(row.dataset.id);
}
for (const id of ['inventory', 'due']) {
  $(id).addEventListener('click', onPick);
  $(id).addEventListener('keydown', onPick);
}

$('filters').addEventListener('submit', e => { e.preventDefault(); offset = 0; refreshInventory(); });

$('add').addEventListener('submit', async e => {
  e.preventDefault();
  const body = Object.fromEntries(['asset_tag', 'name', 'asset_type', 'location', 'status'].map(f => [f, $(f).value]));
  try {
    const { status, body: answer } = await call('/api/assets', { method: 'POST', body });
    if (status === 201) { $('add-result').innerHTML = `<div class="done">Added ${esc(answer.asset.assetTag)}.</div>`; $('add').reset(); openAsset(answer.asset.id); }
    else if (status === 200) { $('add-result').innerHTML = `<div class="done">${esc(answer.asset.assetTag)} already exists with these details; nothing changed.</div>`; openAsset(answer.asset.id); }
    else $('add-result').innerHTML = refusal(answer, status);
    refreshInventory();
  } catch (err) {
    $('add-result').innerHTML = unreachable(err);
  }
});

await currentUser();
refreshInventory();
refreshDue();
