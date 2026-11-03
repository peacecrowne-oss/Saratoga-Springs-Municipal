// System dashboard: health, recent deployments from the audit trail, and the
// asset records. Refreshes every 30 seconds.

const REFRESH_MS = 30000;
const KEY = 'system-signin';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });

let who = load();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; }
}
function save(value) {
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* storage unavailable; sign-in lasts this visit */ }
}

const headers = () => (who ? { 'x-user-id': who.user, 'x-user-role': who.role } : {});

async function call(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...headers(), ...options.headers }, cache: 'no-store' });
  return { status: res.status, body: await res.json() };
}

const table = (head, rows) => `<div class="table-scroll"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

async function refreshHealth() {
  try {
    const { body } = await call('/api/health');
    const ok = body.status === 'ok';
    const failing = Object.entries(body.checks).filter(([, c]) => !c.ok).map(([n, c]) => `${n}: ${c.detail}`);
    $('health').innerHTML = `<span><span class="dot ${ok ? 'ok' : 'bad'}"></span>${ok ? 'System healthy' : `System unhealthy · ${esc(failing.join('; '))}`}</span>
      <span class="muted">Version ${esc(body.version)} · checked ${esc(when(new Date().toISOString()))}</span>`;
  } catch (err) {
    $('health').innerHTML = `<span><span class="dot bad"></span>The server did not answer: ${esc(err.message)}</span>`;
  }
}

async function refreshDeployments() {
  if (who?.role !== 'it_administrator') { $('deployments').textContent = 'Sign in as an IT administrator to see them.'; return; }
  try {
    const { status, body } = await call('/api/audit?entity_type=system');
    if (status !== 200) { $('deployments').textContent = body.error?.message ?? `HTTP ${status}`; return; }
    $('deployments').innerHTML = body.events.length
      ? table(['When', 'Outcome', 'By', 'Version', 'Commit', 'Checks'], body.events.map(e => `<tr>
          <td>${esc(when(e.occurredAt))}</td>
          <td>${e.action === 'system.deploy' ? 'Deployed' : `<strong>Failed</strong> (${esc(e.after?.kind)}): ${esc(e.after?.message)}`}</td>
          <td>${esc(e.actor)}</td><td>${esc(e.after?.version)}</td>
          <td>${esc(e.after?.commit ? e.after.commit.slice(0, 7) : 'unknown')}</td>
          <td>${esc((e.after?.checks ?? []).map(c => `${c.name} ${c.ok ? 'ok' : 'failed'}`).join(', '))}</td></tr>`))
      : 'No deployments recorded yet.';
  } catch (err) {
    $('deployments').textContent = `Could not load deployments: ${err.message}`;
  }
}

function gisCell(gis) {
  if (!gis) return '<span class="muted">Not synced yet</span>';
  const fields = Object.entries(gis.fields ?? {}).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  const point = gis.geometry ? `(${gis.geometry.x}, ${gis.geometry.y})` : 'no location';
  const note = gis.status === 'mismatch' ? ' · <strong>mismatch, our value will be pushed</strong>'
    : gis.status === 'error' ? ` · <strong>push failed</strong>: ${esc(gis.lastError?.description)}` : '';
  return `${esc(gis.layer)} #${esc(gis.objectId)} · ${esc(gis.status)}${note}<br><span class="muted">${esc(point)}${fields.length ? ` · ${esc(fields.join(', '))}` : ''}</span>`;
}

async function refreshAssets() {
  if (!who) return;
  try {
    const { status, body } = await call('/api/assets');
    if (status !== 200) { $('assets').textContent = body.error?.message ?? `HTTP ${status}`; return; }
    $('assets').innerHTML = body.assets.length
      ? table(['Tag', 'Name', 'Type', 'Status', 'Location', 'GIS (as last synced)', 'Created'], body.assets.map(a => `<tr>
          <td>${esc(a.assetTag)}</td><td>${esc(a.name)}</td><td>${esc(a.assetType)}</td>
          <td>${esc(a.status)}</td><td>${esc(a.location)}</td><td>${gisCell(a.gis)}</td><td>${esc(when(a.createdAt))}</td></tr>`))
      : 'No assets recorded yet.';
  } catch (err) {
    $('assets').textContent = `Could not load assets: ${err.message}`;
  }
}

async function refresh() {
  await Promise.all([refreshHealth(), refreshDeployments(), refreshAssets()]);
}

$('signin').addEventListener('submit', e => {
  e.preventDefault();
  who = { user: $('user').value.trim(), role: $('role').value };
  save(who);
  refresh();
});
if (who) { $('user').value = who.user; $('role').value = who.role; }

$('asset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = Object.fromEntries(['asset_tag', 'name', 'asset_type', 'location', 'status'].map(f => [f, $(f).value]));
  try {
    const { status, body } = await call('/api/assets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    $('asset-result').innerHTML = status === 201 ? `<p>Added ${esc(body.asset.assetTag)}.</p>`
      : status === 200 ? `<p>${esc(body.asset.assetTag)} already exists with these details; nothing changed.</p>`
      : `<div class="error" role="alert">${esc(body.error?.message ?? `HTTP ${status}`)}</div>`;
  } catch (err) {
    $('asset-result').innerHTML = `<div class="error" role="alert">The server did not answer: ${esc(err.message)}</div>`;
  }
  refreshAssets();
});

refresh();
setInterval(refresh, REFRESH_MS);
