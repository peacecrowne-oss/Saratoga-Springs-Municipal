// Permitting Dashboard (STORY-006): the review queue, one permit with its decision
// and audit trail, and the application form. All rules live on the server; this
// page shows what it answers, including why it refused.

import { currentUser } from '/session.js';

const PAGE = 50;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const pill = text => `<span class="pill ${esc(text)}">${esc(text)}</span>`;

let offset = 0;
// One key per application, kept across a failed send so a retry cannot create a
// second permit, and replaced once the application is recorded.
let submissionKey = crypto.randomUUID();

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
  return `<div class="error" role="alert">${esc(e.message ?? `HTTP ${status}`)}${problems}</div>`;
}
const unreachable = err => `<div class="error" role="alert">The server did not answer: ${esc(err.message)}</div>`;

async function refreshQueue() {
  const p = new URLSearchParams({ limit: PAGE, offset });
  const filters = { q: $('q').value.trim(), status: $('status_filter').value };
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  try {
    const { status, body } = await call(`/api/permits?${p}`);
    if (status !== 200) { $('queue').innerHTML = refusal(body, status); $('pager').textContent = ''; return; }
    $('queue').innerHTML = body.permits.length ? `<div class="table-scroll"><table>
      <thead><tr><th>Number</th><th>Code section</th><th>Status</th><th>Submitted</th><th>Decided</th></tr></thead>
      <tbody>${body.permits.map(a => `<tr class="pick" data-id="${esc(a.id)}" tabindex="0">
        <td>${esc(a.permitNumber)}</td><td>${esc(a.codeSection)}</td><td>${pill(a.status)}</td>
        <td>${esc(when(a.submittedAt))} by ${esc(a.submittedBy)}</td>
        <td>${a.decidedAt ? `${esc(when(a.decidedAt))} by ${esc(a.decidedBy)}` : '<span class="muted">Not yet</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : 'No permits match.';
    $('pager').innerHTML = body.total > PAGE
      ? `${offset + 1}–${offset + body.permits.length} of ${body.total} <button class="plain" id="prev" ${offset ? '' : 'disabled'}>Previous</button> <button class="plain" id="next" ${offset + PAGE < body.total ? '' : 'disabled'}>Next</button>`
      : `${body.total} permit${body.total === 1 ? '' : 's'}`;
    $('prev')?.addEventListener('click', () => { offset = Math.max(0, offset - PAGE); refreshQueue(); });
    $('next')?.addEventListener('click', () => { offset += PAGE; refreshQueue(); });
  } catch (err) {
    $('queue').innerHTML = unreachable(err);
  }
}

const describe = e => {
  const a = e.after ?? {};
  switch (e.action) {
    case 'permit.submit': return `Submitted, citing ${a.codeSection}`;
    case 'permit.approve': case 'permit.reject': return a.decisionReason;
    case 'permit.decision_refused': return `Refused: ${a.message}`;
    case 'permit.access_denied': return `Refused: the ${a.role} role cannot do this`;
    case 'permit.view': return 'Opened the permit';
    default: return '';
  }
};

async function openPermit(id, note = '') {
  try {
    const base = `/api/permits/${encodeURIComponent(id)}`;
    const { status, body } = await call(base);
    if (status !== 200) { $('detail').innerHTML = refusal(body, status); return; }
    const history = await call(`${base}/history`);
    const p = body.permit;
    $('detail').innerHTML = `<div class="panel">
      <h2 style="margin-top:0">${esc(p.permitNumber)} ${pill(p.status)}</h2>
      <div id="note">${note}</div>
      <dl class="facts">
        <dt>Applicant</dt><dd>${esc(p.applicantName)}</dd>
        <dt>Contact</dt><dd>${esc(p.applicantContact)}</dd>
        <dt>Property</dt><dd>${esc(p.propertyAddress)}</dd>
        <dt>Code section</dt><dd>${esc(p.codeSection)}</dd>
        <dt>Description</dt><dd>${esc(p.description)}</dd>
        <dt>Submitted</dt><dd>${esc(when(p.submittedAt))} by ${esc(p.submittedBy)}</dd>
        ${p.decidedAt ? `<dt>Decision</dt><dd>${esc(p.status)}, ${esc(when(p.decidedAt))} by ${esc(p.decidedBy)}</dd><dt>Reason</dt><dd>${esc(p.decisionReason)}</dd>` : ''}
      </dl>

      ${p.status === 'submitted' ? `<h3>Decide</h3>
      <form id="decide">
        <textarea id="reason" aria-label="Reason for the decision" placeholder="reason for the decision" required></textarea>
        <label><input type="checkbox" id="code_section_verified"> Code section verified</label>
        <label><input type="checkbox" id="site_inspected"> Site inspected</label>
        <button type="submit" data-decision="approved">Approve</button>
        <button type="submit" class="plain" data-decision="rejected">Reject</button>
      </form>` : ''}

      <h3>Audit trail</h3>
      ${history.status !== 200 ? refusal(history.body, history.status) : `<div class="table-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${history.body.events.map(e => `<tr><td>${esc(when(e.occurredAt))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(describe(e))}</td></tr>`).join('')}</tbody></table></div>`}
    </div>`;
    $('decide')?.addEventListener('submit', e => { e.preventDefault(); decide(p.id, e.submitter.dataset.decision); });
  } catch (err) {
    $('detail').innerHTML = unreachable(err);
  }
}

async function decide(id, decision) {
  const body = {
    decision,
    reason: $('reason').value,
    checks: { code_section_verified: $('code_section_verified').checked, site_inspected: $('site_inspected').checked },
  };
  try {
    const { status, body: answer } = await call(`/api/permits/${encodeURIComponent(id)}/decision`, { method: 'POST', body });
    if (status !== 200) { $('note').innerHTML = refusal(answer, status); return; }
    const said = answer.decided ? `${answer.permit.permitNumber} ${decision}.` : `${answer.permit.permitNumber} was already ${decision}; nothing changed.`;
    await openPermit(id, `<div class="done" role="status">${esc(said)}</div>`);
    await refreshQueue();
  } catch (err) {
    $('note').innerHTML = unreachable(err);
  }
}

function onPick(e) {
  if (e.type === 'keydown' && e.key !== 'Enter') return;
  const row = e.target.closest('tr.pick');
  if (row) openPermit(row.dataset.id);
}
$('queue').addEventListener('click', onPick);
$('queue').addEventListener('keydown', onPick);

$('filters').addEventListener('submit', e => { e.preventDefault(); offset = 0; refreshQueue(); });

$('submit').addEventListener('submit', async e => {
  e.preventDefault();
  const body = { permit_type: 'code_enforcement', submission_key: submissionKey };
  for (const f of ['applicant_name', 'applicant_contact', 'property_address', 'code_section', 'description']) body[f] = $(f).value;
  try {
    const { status, body: answer } = await call('/api/permits', { method: 'POST', body });
    if (status === 201 || status === 200) {
      $('submit-result').innerHTML = `<div class="done" role="status">${status === 201 ? 'Submitted' : 'Already submitted'} as ${esc(answer.permit.permitNumber)}.</div>`;
      $('submit').reset();
      submissionKey = crypto.randomUUID();
      refreshQueue();
    } else {
      $('submit-result').innerHTML = refusal(answer, status);
    }
  } catch (err) {
    $('submit-result').innerHTML = unreachable(err);
  }
});

await currentUser();
refreshQueue();
