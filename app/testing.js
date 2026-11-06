// Testing Dashboard (STORY-011): the latest test report, and user acceptance
// scenarios with a form to record each result.

import { currentUser } from '/session.js';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const refusal = (body, status) => {
  const e = body.error ?? {};
  return `<div class="error" role="alert">${esc(e.message ?? `HTTP ${status}`)}${e.problems?.length ? `<ul>${e.problems.map(p => `<li>${esc(p.field)} ${esc(p.problem)}</li>`).join('')}</ul>` : ''}</div>`;
};

async function showReport() {
  const { status, body } = await call('/api/testing/report');
  if (status === 404) { $('report').innerHTML = 'No report yet. Run <code>npm run test-report</code> on the server.'; return; }
  if (status !== 200) { $('report').innerHTML = refusal(body, status); return; }
  const r = body.report;
  const good = r.status === 'complete' && r.verdict === 'ready';
  $('report').classList.remove('muted');
  $('report').innerHTML = `<div class="verdict ${good ? 'good' : 'bad'}">Report ${esc(r.status.toUpperCase())} · ${r.verdict === 'ready' ? 'READY' : 'NOT READY'}</div>
    <div class="muted" style="font-size:13px">${esc(when(r.generatedAt))} · commit ${esc(r.commit ?? '?')}</div>
    <p>Automated: ${r.automated ? `${r.automated.passed} passed, ${r.automated.failed} failed` : 'not run'} · Smoke: ${r.smoke ? `${r.smoke.checks.filter(c => c.ok).length}/${r.smoke.checks.length} checks` : 'not run'} · Acceptance: ${r.uat ? `${r.uat.summary.executed}/${r.uat.summary.total} run, ${r.uat.summary.openCritical} critical open` : '—'}</p>
    ${r.missing.length ? `<strong>Missing</strong><ul>${r.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    ${r.reasons.length ? `<strong>Why not ready</strong><ul>${r.reasons.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    <strong>Critical issues</strong>${r.criticalIssues.length ? `<ul>${r.criticalIssues.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ' <span class="muted">none found</span>'}`;
}

async function showUat(note = '') {
  const { status, body } = await call('/api/testing/uat');
  if (status !== 200) { $('scenarios').innerHTML = refusal(body, status); return; }
  const s = body.summary;
  $('summary').innerHTML = `<div class="panel"><div class="verdict ${s.accepted ? 'good' : 'bad'}">${s.accepted ? 'Accepted' : 'Not accepted yet'}</div>
    <div>${s.executed} of ${s.total} run · ${s.passed} passing · ${s.openIssues} open · ${s.openCritical} critical</div>
    ${s.reasons.length ? `<ul>${s.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}${note}</div>`;
  $('scenarios').innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Scenario</th><th>Sign in as · start at</th><th>Expected</th><th>Latest</th><th>Record a result</th></tr></thead>
    <tbody>${body.scenarios.map(x => `<tr>
      <td><strong>${esc(x.id)}</strong> <span class="muted">${esc(x.story)}</span><br>${esc(x.title)}</td>
      <td>${esc(x.role)}<br><span class="muted">${esc(x.page)}</span></td>
      <td>${esc(x.expected)}</td>
      <td>${x.latest ? `<span class="pill ${esc(x.latest.outcome)}">${esc(x.latest.outcome)}${x.latest.severity !== 'none' ? ` · ${esc(x.latest.severity)}` : ''}</span><br><span class="muted" style="font-size:12px">${esc(x.latest.tester)}, ${esc(when(x.latest.recordedAt))}</span>${x.latest.notes ? `<br>${esc(x.latest.notes)}` : ''}` : '<span class="muted">not run</span>'}</td>
      <td><form data-id="${esc(x.id)}">
        <select name="outcome" aria-label="Outcome"><option value="pass">pass</option><option value="fail">fail</option><option value="blocked">blocked</option></select>
        <select name="severity" aria-label="Severity"><option value="minor">minor</option><option value="major">major</option><option value="critical">critical</option></select>
        <input name="notes" aria-label="Notes" placeholder="notes (required unless pass)">
        <button type="submit">Record</button></form></td></tr>`).join('')}</tbody></table></div>`;
  $('scenarios').querySelectorAll('form').forEach(f => f.addEventListener('submit', record));
}

async function record(e) {
  e.preventDefault();
  const f = e.target;
  const body = { scenario_id: f.dataset.id, outcome: f.outcome.value, severity: f.outcome.value === 'pass' ? 'none' : f.severity.value, notes: f.notes.value, result_key: crypto.randomUUID() };
  const { status, body: answer } = await call('/api/testing/uat', { method: 'POST', body });
  if (status !== 201 && status !== 200) { f.insertAdjacentHTML('afterend', refusal(answer, status)); return; }
  await showUat(`<div class="done" role="status">Recorded ${esc(answer.result.scenarioId)}: ${esc(answer.result.outcome)}.</div>`);
}

await currentUser();
showReport();
showUat();
