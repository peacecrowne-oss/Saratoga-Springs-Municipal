// Cityworks history (STORY-013): search and open migrated records. Read-only:
// this page sends nothing but GET requests.

import { BACK_TO_LIST, currentUser, detailOpened } from '/session.js';

const PAGE = 50;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = t => String(t ?? '').replace(/_/g, ' ');
let offset = 0;

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  return { status: res.status, body: await res.json() };
}
const refusal = (body, status) => `<div class="error" role="alert">${esc(body.error?.message ?? `HTTP ${status}`)}</div>`;
const unreachable = err => `<div class="error" role="alert">The server did not answer: ${esc(err.message)}</div>`;

async function showMigration() {
  try {
    const { status, body } = await get('/api/legacy/migration');
    if (status === 403) return;
    if (status === 404) { $('migration').innerHTML = '<p class="muted">No migration has been run yet, so there are no historical records.</p>'; return; }
    if (status !== 200) { $('migration').innerHTML = refusal(body, status); return; }
    const r = body.report;
    $('migration').innerHTML = `<div class="panel"><strong>Latest migration: ${r.verdict === 'trusted' ? 'TRUSTED' : 'NOT TRUSTED'}</strong>${r.source.simulated ? ' <span class="muted">(SIMULATED export)</span>' : ''}
      <div class="muted" style="font-size:13px">${esc(r.finishedAt)} · ${r.records.map(x => `${esc(label(x.type))} ${x.target}`).join(' · ')} · ${r.attachments.stored} attachments · ${r.gis.linked} GIS links, ${r.gis.unresolved} to resolve, ${r.gis.orphaned} orphaned</div>
      ${r.failures.map(f => `<div class="flag">${esc(f)}</div>`).join('')}</div>`;
  } catch (err) {
    $('migration').innerHTML = unreachable(err);
  }
}

async function search() {
  const p = new URLSearchParams({ limit: PAGE, offset });
  for (const [k, v] of Object.entries({ q: $('q').value.trim(), type: $('type').value, department: $('department').value.trim() })) if (v) p.set(k, v);
  if ($('open').checked) p.set('open', '1');
  try {
    const { status, body } = await get(`/api/legacy/records?${p}`);
    if (status !== 200) { $('results').innerHTML = refusal(body, status); $('pager').textContent = ''; return; }
    $('results').innerHTML = body.records.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Number</th><th>Type</th><th>Status</th><th>Department</th><th>Opened</th><th>Address</th><th>Description</th></tr></thead>
      <tbody>${body.records.map(r => `<tr class="pick" data-id="${esc(r.id)}" tabindex="0"><td>${esc(r.caseNumber)}</td><td>${esc(label(r.recordType))}</td><td>${esc(r.status)}</td>
        <td>${esc(r.department)}</td><td>${esc(r.openedAt)}</td><td>${esc(r.address)}</td><td>${esc(r.summary)}</td></tr>`).join('')}</tbody></table></div>`
      : 'No records match.';
    $('pager').innerHTML = body.total > PAGE
      ? `${offset + 1}–${offset + body.records.length} of ${body.total} <button class="plain" id="prev" ${offset ? '' : 'disabled'}>Previous</button> <button class="plain" id="next" ${offset + PAGE < body.total ? '' : 'disabled'}>Next</button>`
      : `${body.total} record${body.total === 1 ? '' : 's'}`;
    $('prev')?.addEventListener('click', () => { offset = Math.max(0, offset - PAGE); search(); });
    $('next')?.addEventListener('click', () => { offset += PAGE; search(); });
  } catch (err) {
    $('results').innerHTML = unreachable(err);
  }
}

async function open(id) {
  try {
    const { status, body } = await get(`/api/legacy/records/${encodeURIComponent(id)}`);
    if (status !== 200) { $('detail').innerHTML = refusal(body, status); return; }
    const r = body.record;
    const base = `/api/legacy/records/${encodeURIComponent(r.id)}/attachments/`;
    $('detail').innerHTML = `<div class="panel">
      ${BACK_TO_LIST}
      <h2 style="margin-top:0">${esc(r.caseNumber)} <span class="pill ro">READ-ONLY</span></h2>
      <dl class="facts">
        <dt>Type</dt><dd>${esc(label(r.recordType))}</dd><dt>Status</dt><dd>${esc(r.status)}</dd>
        <dt>Department</dt><dd>${esc(r.department)}</dd><dt>Opened</dt><dd>${esc(r.openedAt)}</dd>
        <dt>Closed</dt><dd>${esc(r.closedAt) || '<span class="muted">Not closed</span>'}</dd><dt>Address</dt><dd>${esc(r.address)}</dd>
        <dt>Description</dt><dd>${esc(r.summary)}</dd><dt>Cityworks source</dt><dd>${esc(r.sourceTable)} ${esc(r.sourceId)}</dd>
      </dl>
      <h3>GIS features</h3>
      ${r.gisLinks.length ? `<ul>${r.gisLinks.map(l => `<li>${esc(l.layer)} · ${esc(l.featureId)}${l.resolvedBy === 'resolution' ? ' <span class="muted">(resolved by hand)</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">None linked.</p>'}
      ${r.gisIssues.map(i => `<div class="flag">GIS relationship not linked (${esc(i.problem)}): ${esc(i.detail)}</div>`).join('')}
      <h3>Attachments</h3>
      ${r.attachments.length ? `<ul>${r.attachments.map(a => `<li><a href="${base}${encodeURIComponent(a.id)}">${esc(a.fileName)}</a> <span class="muted">${a.size} bytes</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
      ${r.data.fees?.length ? `<h3>Fees</h3><pre>${esc(JSON.stringify(r.data.fees, null, 2))}</pre>` : ''}
      ${r.data.people?.length ? `<h3>People</h3><pre>${esc(JSON.stringify(r.data.people, null, 2))}</pre>` : ''}
      <h3>Everything Cityworks held</h3><pre>${esc(JSON.stringify(r.data.source, null, 2))}</pre>
    </div>`;
    detailOpened($('detail'), 'results');
  } catch (err) {
    $('detail').innerHTML = unreachable(err);
  }
}

function onPick(e) {
  if (e.type === 'keydown' && e.key !== 'Enter') return;
  const row = e.target.closest('tr.pick');
  if (row) open(row.dataset.id);
}
$('results').addEventListener('click', onPick);
$('results').addEventListener('keydown', onPick);
$('filters').addEventListener('submit', e => { e.preventDefault(); offset = 0; search(); });

await currentUser();
showMigration();
search();
