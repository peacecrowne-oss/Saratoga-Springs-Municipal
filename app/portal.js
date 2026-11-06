// The public permit portal (STORY-007). No sign-in: the private link a resident
// gets on submitting is the key to their application. The token travels in the
// part of the address after #, which browsers never send to a server, and goes to
// this server only in a header. All rules live on the server.

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const day = ymd => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const pill = text => `<span class="pill ${esc(text)}">${esc(String(text).replace('_', ' '))}</span>`;
const LABELS = { applicant_name: 'Your name', applicant_contact: 'Email', property_address: 'Property address', code_section: 'Code section', description: 'What the permit is for', submission_key: 'This form', date: 'Date', body: 'This form' };

// One key per application, kept across a failed send so a retry cannot create a
// second application, and replaced once it is recorded.
let submissionKey = crypto.randomUUID();
let token = null;
let link = null;

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-portal-token'] = token;
  const res = await fetch(path, { method, cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function refusal(body, status) {
  const e = body.error ?? {};
  const problems = e.problems?.length ? `<ul style="margin:4px 0 0;padding-left:18px">${e.problems.map(p => `<li>${esc(LABELS[p.field] ?? p.field)} ${esc(p.problem)}</li>`).join('')}</ul>` : '';
  return `<div class="error" role="alert">${problems ? 'Please check:' : esc(e.message ?? `Something went wrong (HTTP ${status}).`)}${problems}</div>`;
}
const unreachable = err => `<div class="error" role="alert">We could not reach the City's server (${esc(err.message)}). Please check your connection and try again.</div>`;

function tokenFrom(text) {
  const at = String(text).indexOf('#');
  const params = new URLSearchParams(at >= 0 ? String(text).slice(at + 1) : '');
  return params.get('t');
}

function confirmationNote(c) {
  if (!c) return '';
  if (c.status === 'sent') return `<div class="done" role="status">We sent you a confirmation email.${String(c.transport).includes('SIMULATED') ? ' <span class="muted">(Demonstration system: no email actually leaves it. The message is shown below.)</span>' : ''}</div>`;
  return '<div class="flag" role="status">We could not send your confirmation email just now. Your request is recorded, and we will keep trying. Save the link above in the meantime.</div>';
}

function render(app, note = '') {
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
  const canBook = app.status === 'submitted';
  $('mine').innerHTML = `<h2>Application ${esc(app.permitNumber)}</h2>
    ${note}
    <div class="panel">
      <dl class="facts">
        <dt>Status</dt><dd>${pill(app.status)}</dd>
        <dt>Property</dt><dd>${esc(app.propertyAddress)}</dd>
        <dt>Code section</dt><dd>${esc(app.codeSection)}</dd>
        <dt>Submitted</dt><dd>${esc(when(app.submittedAt))}</dd>
        ${app.decidedAt ? `<dt>Decided</dt><dd>${esc(when(app.decidedAt))}</dd><dt>Reason</dt><dd>${esc(app.decisionReason)}</dd>` : ''}
        <dt>Inspection</dt><dd>${app.inspectionOn ? `<strong>${esc(day(app.inspectionOn))}</strong>` : '<span class="muted">Not booked yet</span>'}</dd>
      </dl>
      ${link ? `<h3>Your private link</h3><p class="muted">Bookmark it: it is the only way back to this application. Do not share it.</p><div class="link">${esc(link)}</div>` : ''}
    </div>

    ${canBook ? `<h3>${app.inspectionOn ? 'Change the inspection date' : 'Book the site inspection'}</h3>
    <form id="book" class="panel">
      <label for="date">Date <span class="hint">a weekday, from tomorrow</span></label>
      <div class="row"><input id="date" type="date" min="${tomorrow}" required value="${esc(app.inspectionOn ?? '')}"><button type="submit">${app.inspectionOn ? 'Change date' : 'Book inspection'}</button></div>
      <div id="book-result"></div>
    </form>` : ''}

    <h3>Messages to you</h3>
    <div class="panel">${app.notifications.length ? app.notifications.map(n => `<div class="message">
      <strong>${esc(n.subject)}</strong> ${pill(n.status)} <span class="muted">${n.sentAt ? esc(when(n.sentAt)) : ''}</span>
      <pre>${esc(n.body)}</pre></div>`).join('') : '<p class="muted">None yet.</p>'}</div>
    <p><button type="button" class="plain" id="leave">Start a new application</button></p>`;

  $('start').hidden = true;
  $('mine').hidden = false;
  $('book')?.addEventListener('submit', book);
  $('leave').addEventListener('click', () => { token = null; link = null; history.replaceState(null, '', '/portal'); $('mine').hidden = true; $('start').hidden = false; });
}

async function show(t, into) {
  token = t;
  try {
    const { status, body } = await call('/api/portal/application');
    if (status !== 200) { token = null; into.innerHTML = refusal(body, status); return; }
    link = `${location.origin}/portal#t=${t}`;
    history.replaceState(null, '', `/portal#t=${t}`);
    render(body.application);
  } catch (err) {
    token = null;
    into.innerHTML = unreachable(err);
  }
}

async function book(e) {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const { status, body } = await call('/api/portal/inspection', { method: 'POST', body: { date: $('date').value } });
    if (status !== 200) { $('book-result').innerHTML = refusal(body, status); return; }
    const said = body.scheduled ? `<div class="done" role="status">Your inspection is booked for ${esc(day(body.application.inspectionOn))}.</div>` : '<div class="done" role="status">That date was already booked; nothing changed.</div>';
    render(body.application, said + confirmationNote(body.confirmation));
  } catch (err) {
    $('book-result').innerHTML = unreachable(err);
  } finally {
    button.disabled = false;
  }
}

$('apply').addEventListener('submit', async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  const body = { submission_key: submissionKey };
  for (const f of ['applicant_name', 'applicant_contact', 'property_address', 'code_section', 'description']) body[f] = $(f).value;
  try {
    const { status, body: answer } = await call('/api/portal/applications', { method: 'POST', body });
    if (status !== 201 && status !== 200) { $('apply-result').innerHTML = refusal(answer, status); return; }
    $('apply').reset();
    $('apply-result').innerHTML = '';
    submissionKey = crypto.randomUUID();
    token = answer.token;
    link = `${location.origin}/portal#t=${answer.token}`;
    history.replaceState(null, '', `/portal#t=${answer.token}`);
    render(answer.application, `<div class="done" role="status">Thank you. Your application ${esc(answer.application.permitNumber)} is received.</div>${confirmationNote(answer.confirmation)}`);
  } catch (err) {
    $('apply-result').innerHTML = unreachable(err);
  } finally {
    button.disabled = false;
  }
});

$('open').addEventListener('submit', e => {
  e.preventDefault();
  const t = tokenFrom($('link').value.trim());
  if (!t) { $('open-result').innerHTML = '<div class="error" role="alert">That does not look like a link from your confirmation. It should contain #t=</div>'; return; }
  show(t, $('open-result'));
});

const initial = tokenFrom(location.href);
if (initial) show(initial, $('open-result'));
