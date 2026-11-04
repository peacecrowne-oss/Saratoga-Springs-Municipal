// Budget tracking dashboard. Reads /api/budget every minute and shows either
// the budget or the integration error — never stale figures after a failure.

import { currentUser } from '/session.js';

const REFRESH_MS = 60000;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const when = iso => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  return { status: res.status, body: await res.json() };
}

function status(cls, text) {
  $('status').innerHTML = `<span><span class="dot ${cls}"></span>${esc(text)}</span><span class="muted">Checked ${esc(when(new Date().toISOString()))}</span>`;
}

function renderBudget(b) {
  $('sim').innerHTML = b.simulated
    ? '<div class="banner sim">SIMULATED TYLER DATA: these figures come from the development stand-in, not a real Tyler system.</div>'
    : '';
  status('ok', `Connected to Tyler · data as of ${when(b.asOf)}`);
  const total = k => b.lines.reduce((sum, l) => sum + l[k], 0);
  $('budget').innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Account</th><th>Department</th><th>Description</th><th class="num">Budgeted</th><th class="num">Actual</th><th class="num">Remaining</th></tr></thead>
    <tbody>${b.lines.map(l => `<tr>
      <td>${esc(l.accountCode)}</td><td>${esc(l.department)}</td><td>${esc(l.description)}</td>
      <td class="num">${money(l.budgeted)}</td><td class="num">${money(l.actual)}</td><td class="num">${money(l.remaining)}</td>
    </tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">Fiscal year ${esc(b.fiscalYear)} total</td>
      <td class="num">${money(total('budgeted'))}</td><td class="num">${money(total('actual'))}</td><td class="num">${money(total('remaining'))}</td></tr></tfoot>
  </table></div>`;
}

function renderError({ kind, message }, integration) {
  $('sim').innerHTML = '';
  status(integration ? 'bad' : '', integration ? 'Not connected to Tyler' : 'Not shown');
  const title = integration ? 'Budget data is unavailable: there is a problem with the Tyler integration.' : 'Budget data is not shown.';
  $('budget').innerHTML = `<div class="error" role="alert"><strong>${esc(title)}</strong>${esc(message)} <span class="muted">(${esc(kind)})</span></div>`;
}

async function refreshAudit() {
  try {
    const { status: code, body } = await getJson('/api/audit');
    if (code !== 200) { $('audit').textContent = body.error?.message ?? 'Not available.'; return; }
    $('audit').innerHTML = body.events.length
      ? `<div class="table-scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${
          body.events.map(e => `<tr><td>${esc(when(e.occurredAt))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(e.after ? (e.after.message ?? e.after.role ?? `${e.after.lines} lines`) : '')}</td></tr>`).join('')
        }</tbody></table></div>`
      : 'No budget activity recorded yet.';
  } catch (err) {
    $('audit').textContent = `Could not load the audit trail: ${err.message}`;
  }
}

async function refresh() {
  try {
    const { status: code, body } = await getJson('/api/budget');
    if (code === 200) renderBudget(body);
    else renderError(body.error ?? { kind: 'unknown', message: `HTTP ${code}` }, code === 502);
  } catch (err) {
    renderError({ kind: 'server_unreachable', message: `The budget server did not answer: ${err.message}` }, false);
  }
  await refreshAudit();
}

await currentUser();
refresh();
setInterval(refresh, REFRESH_MS);
