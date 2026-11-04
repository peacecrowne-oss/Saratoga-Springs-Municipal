// The sign-in page: password, then authenticator code, then back where you were.

const $ = id => document.getElementById(id);
let challenge = null;

// Only a path on this site, so a crafted link cannot send someone elsewhere after login.
function destination() {
  const next = new URLSearchParams(location.search).get('next') ?? '';
  return /^\/(?![/\\])/.test(next) ? next : '/system';
}

const show = text => { $('message').textContent = text; $('message').hidden = !text; };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json() };
}

async function submit(form, send) {
  const button = form.querySelector('button');
  button.disabled = true;
  show('');
  try {
    await send();
  } catch (err) {
    show(`The server did not answer: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

function backToPassword(message) {
  challenge = null;
  $('code-step').hidden = true;
  $('password-step').hidden = false;
  $('password').value = '';
  $('code').value = '';
  $('password').focus();
  show(message);
}

$('password-step').addEventListener('submit', e => {
  e.preventDefault();
  submit(e.target, async () => {
    const { ok, body } = await post('/api/auth/login', { username: $('username').value, password: $('password').value });
    $('password').value = '';
    if (!ok) { show(body.error?.message ?? 'Could not sign in.'); return; }
    challenge = body.challenge;
    $('password-step').hidden = true;
    $('code-step').hidden = false;
    $('code').focus();
  });
});

$('code-step').addEventListener('submit', e => {
  e.preventDefault();
  submit(e.target, async () => {
    const { ok, body } = await post('/api/auth/mfa', { challenge, code: $('code').value });
    $('code').value = '';
    if (ok) { location.replace(destination()); return; }
    if (body.error?.kind === 'invalid_code') { show(body.error.message); return; }
    backToPassword(body.error?.message ?? 'Could not sign in.');
  });
});
