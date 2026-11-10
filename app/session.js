// Who is signed in, for every page. Someone not signed in goes to /login and comes
// back afterwards. The session itself lives in an HttpOnly cookie that scripts
// cannot read, so there is nothing for a page to store.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function goToLogin() {
  location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  return new Promise(() => {}); // the page is leaving; nothing after this should run
}

async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  } finally {
    location.replace('/login');
  }
}

// For a detail panel: brings it into view and wires its "Back to the list"
// button, which closes the panel and returns to the list it was opened from.
export function detailOpened(panel, listId, { scroll = true } = {}) {
  panel.querySelector('[data-back-to-list]')?.addEventListener('click', () => {
    panel.innerHTML = '';
    document.getElementById(listId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export const BACK_TO_LIST = '<button type="button" class="plain back-to-list" data-back-to-list>← Back to the list</button>';

// Resolves to { username, role } once it has shown them in #session.
export async function currentUser() {
  const res = await fetch('/api/auth/me', { cache: 'no-store' });
  if (res.status === 401) return goToLogin();
  if (!res.ok) throw new Error(`Could not check who is signed in (HTTP ${res.status}).`);
  const { user } = await res.json();
  const box = document.getElementById('session');
  // Sign out sits at the foot of the sidebar's links (under Permit portal) when the
  // page has the sidebar, otherwise beside the name.
  const nav = document.querySelector('.sidebar nav');
  if (box) box.innerHTML = `<span>${esc(user.username)} · ${esc(user.role)}</span>${nav ? '' : ' <button type="button" id="sign-out">Sign out</button>'}`;
  if (nav && !document.getElementById('sign-out')) nav.insertAdjacentHTML('beforeend', '<button type="button" id="sign-out" class="nav-signout">Sign out</button>');
  document.getElementById('sign-out')?.addEventListener('click', signOut);
  return user;
}
