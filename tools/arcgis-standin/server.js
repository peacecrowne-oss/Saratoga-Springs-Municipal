// SIMULATED ArcGIS Enterprise feature layer, for development and demos only.
//
// This project has no access to the City's ArcGIS Enterprise 11.3, so this
// stand-in answers the slice of the ESRI REST API that
// server/integrations/arcgis/client.js uses, in ESRI's own shapes: errors as
// HTTP 200 with { error: { code, message } }, tokens from generateToken,
// editor tracking on every edit. The layer is named "SIMULATED · City Assets"
// and holds only what the sync job and the demo put in it.
//
//   node tools/arcgis-standin/server.js        (listens on port 4200)
//
//   token URL:  http://127.0.0.1:4200/portal/sharing/rest/generateToken
//   layer URL:  http://127.0.0.1:4200/server/rest/services/CityAssets/FeatureServer/0
//   sign-in:    gis-sync / SIMULATED-password
//
// Modes, also switchable while running with  POST /_mode  {"mode": "auth"}:
//   ok      normal answers
//   down    HTTP 503, as if ArcGIS were offline
//   slow    never answers, to exercise timeouts
//   auth    rejects every sign-in and every token
//   schema  the layer is missing the STATUS field
//   lossy   reports success but cuts NAME to 10 characters, to exercise read-back
//
// Simulate a GIS analyst editing a feature:
//   POST /_edit  {"asset_tag": "HYD-0001", "attributes": {"MATERIAL": "Ductile iron"}, "geometry": {"x": -73.78, "y": 43.08}}
//     add "quiet": true for an edit that skips editor tracking (a direct database change)
// Simulate a feature being deleted in GIS:
//   POST /_delete  {"asset_tag": "HYD-0001"}

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MODES = ['ok', 'down', 'slow', 'auth', 'schema', 'lossy'];
export const STANDIN_USER = 'gis-sync';
export const STANDIN_PASSWORD = 'SIMULATED-password';
export const TOKEN_PATH = '/portal/sharing/rest/generateToken';
export const LAYER_PATH = '/server/rest/services/CityAssets/FeatureServer/0';

const FIELDS = [
  { name: 'OBJECTID', type: 'esriFieldTypeOID' },
  { name: 'ASSET_TAG', type: 'esriFieldTypeString', length: 64 },
  { name: 'NAME', type: 'esriFieldTypeString', length: 200 },
  { name: 'ASSET_TYPE', type: 'esriFieldTypeString', length: 64 },
  { name: 'STATUS', type: 'esriFieldTypeString', length: 32 },
  { name: 'LOCATION_DESC', type: 'esriFieldTypeString', length: 200 },
  { name: 'MATERIAL', type: 'esriFieldTypeString', length: 64 },
  { name: 'DIAMETER_IN', type: 'esriFieldTypeDouble' },
  { name: 'INSTALL_YEAR', type: 'esriFieldTypeSmallInteger' },
  { name: 'created_user', type: 'esriFieldTypeString' },
  { name: 'created_date', type: 'esriFieldTypeDate' },
  { name: 'last_edited_user', type: 'esriFieldTypeString' },
  { name: 'last_edited_date', type: 'esriFieldTypeDate' },
];
const EDIT_FIELDS = { creatorField: 'created_user', creationDateField: 'created_date', editorField: 'last_edited_user', editDateField: 'last_edited_date' };
const WRITABLE = new Set(FIELDS.filter(f => f.type !== 'esriFieldTypeOID' && !Object.values(EDIT_FIELDS).includes(f.name)).map(f => f.name));

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const esriError = (res, code, message, details = []) => send(res, 200, { error: { code, message, details } });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

// The where clauses the sync job sends, and nothing else.
function matcher(where) {
  const w = where.trim();
  if (w === '1=1') return () => true;
  let m = w.match(/^ASSET_TAG\s*=\s*'((?:[^']|'')*)'$/);
  if (m) { const tag = m[1].replace(/''/g, "'"); return f => f.attributes.ASSET_TAG === tag; }
  m = w.match(/^last_edited_date\s*>=\s*TIMESTAMP\s*'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'$/i);
  if (m) { const at = Date.parse(m[1].replace(' ', 'T') + 'Z'); return f => f.attributes.last_edited_date >= at; }
  m = w.match(/^OBJECTID\s+IN\s*\(([\d,\s]+)\)$/i);
  if (m) { const ids = new Set(m[1].split(',').map(Number)); return f => ids.has(f.attributes.OBJECTID); }
  return null;
}

export function createArcGisStandin({ mode = 'ok', now = () => Date.now(), maxRecordCount = 1000, tokenTtlMs = 60 * 60000 } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown stand-in mode "${mode}". Use one of: ${MODES.join(', ')}.`);
  const state = { mode };
  const features = new Map(); // objectId → { attributes, geometry }
  const tokens = new Map();   // token → { user, expires }
  let nextId = 1;
  let lastEdit = 0;

  const editTime = () => (lastEdit = Math.max(now(), lastEdit + 1));

  function stamp(attributes, user, created) {
    const at = editTime();
    if (created) Object.assign(attributes, { created_user: user, created_date: at });
    return Object.assign(attributes, { last_edited_user: user, last_edited_date: at });
  }

  function badFields(attributes) {
    return Object.keys(attributes).filter(k => k !== 'OBJECTID' && !WRITABLE.has(k));
  }

  function addFeature({ attributes = {}, geometry = null }, user) {
    const bad = badFields(attributes);
    if (bad.length) return { success: false, error: { code: 1000, description: `Unknown or read-only fields: ${bad.join(', ')}` } };
    const objectId = nextId++;
    features.set(objectId, { attributes: stamp({ ...lossy(attributes), OBJECTID: objectId }, user, true), geometry });
    return { objectId, globalId: `{${randomUUID().toUpperCase()}}`, success: true };
  }

  const lossy = attributes => (state.mode === 'lossy' && typeof attributes.NAME === 'string'
    ? { ...attributes, NAME: attributes.NAME.slice(0, 10) }
    : attributes);

  function updateFeature({ attributes = {}, geometry }, user, { quiet = false } = {}) {
    const objectId = attributes.OBJECTID;
    const feature = features.get(objectId);
    if (!feature) return { objectId, success: false, error: { code: 1019, description: 'Object is missing' } };
    const bad = badFields(attributes);
    if (bad.length) return { objectId, success: false, error: { code: 1000, description: `Unknown or read-only fields: ${bad.join(', ')}` } };
    Object.assign(feature.attributes, lossy(attributes));
    if (geometry !== undefined) feature.geometry = geometry;
    if (!quiet) stamp(feature.attributes, user, false);
    return { objectId, success: true };
  }

  function userFor(token) {
    const t = tokens.get(token);
    return t && t.expires > now() ? t.user : null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://standin');
      const raw = req.method === 'POST' ? await readBody(req) : '';

      // Test and demo controls: always answer, whatever the mode.
      if (url.pathname.startsWith('/_')) {
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch { return send(res, 400, { simulated: true, error: 'Send JSON.' }); }
        }
        if (url.pathname === '/_mode') {
          if (!MODES.includes(body.mode)) return send(res, 400, { simulated: true, error: `mode must be one of: ${MODES.join(', ')}` });
          state.mode = body.mode;
          return send(res, 200, { simulated: true, mode: state.mode });
        }
        if (url.pathname === '/_edit') {
          const entry = [...features.values()].find(f => f.attributes.ASSET_TAG === body.asset_tag);
          if (!entry) return send(res, 404, { simulated: true, error: `No feature with ASSET_TAG ${body.asset_tag}.` });
          const result = updateFeature({ attributes: { ...body.attributes, OBJECTID: entry.attributes.OBJECTID }, geometry: body.geometry }, body.user ?? 'gis.analyst', { quiet: body.quiet === true });
          return send(res, result.success ? 200 : 400, { simulated: true, ...result, feature: entry });
        }
        if (url.pathname === '/_delete') {
          const entry = [...features.values()].find(f => f.attributes.ASSET_TAG === body.asset_tag);
          if (!entry) return send(res, 404, { simulated: true, error: `No feature with ASSET_TAG ${body.asset_tag}.` });
          features.delete(entry.attributes.OBJECTID);
          return send(res, 200, { simulated: true, deleted: entry.attributes.OBJECTID });
        }
        if (url.pathname === '/_features') return send(res, 200, { simulated: true, features: [...features.values()] });
        if (url.pathname === '/_expire_tokens') { tokens.clear(); return send(res, 200, { simulated: true }); }
        return send(res, 404, { simulated: true, error: 'Not found.' });
      }

      if (state.mode === 'slow') return; // never answers
      if (state.mode === 'down') return send(res, 503, { simulated: true, error: 'Simulated ArcGIS outage.' });

      const params = new URLSearchParams(req.method === 'POST' ? raw : url.search);

      if (url.pathname === TOKEN_PATH && req.method === 'POST') {
        if (state.mode === 'auth' || params.get('username') !== STANDIN_USER || params.get('password') !== STANDIN_PASSWORD) {
          return esriError(res, 400, 'Unable to generate token.', ['Invalid username or password.']);
        }
        const token = `SIMULATED-${randomUUID()}`;
        const expires = now() + tokenTtlMs;
        tokens.set(token, { user: STANDIN_USER, expires });
        return send(res, 200, { token, expires, ssl: false });
      }

      if (!url.pathname.startsWith(LAYER_PATH)) return esriError(res, 400, 'Invalid URL');
      const token = params.get('token');
      if (!token) return esriError(res, 499, 'Token Required');
      const user = state.mode === 'auth' ? null : userFor(token);
      if (!user) return esriError(res, 498, 'Invalid token.');

      const op = url.pathname.slice(LAYER_PATH.length);
      if (op === '' || op === '/') {
        return send(res, 200, {
          name: 'SIMULATED · City Assets',
          type: 'Feature Layer',
          geometryType: 'esriGeometryPoint',
          objectIdField: 'OBJECTID',
          // Roughly the Saratoga Springs area, in longitude and latitude.
          extent: { xmin: -74.0, ymin: 42.9, xmax: -73.5, ymax: 43.3, spatialReference: { wkid: 4326 } },
          maxRecordCount,
          capabilities: 'Query,Create,Update',
          editFieldsInfo: EDIT_FIELDS,
          fields: state.mode === 'schema' ? FIELDS.filter(f => f.name !== 'STATUS') : FIELDS,
        });
      }

      if (op === '/query') {
        const match = matcher(params.get('where') ?? '1=1');
        if (!match) return esriError(res, 400, 'Unable to complete operation.', [`Unsupported where clause: ${params.get('where')}`]);
        const offset = Number(params.get('resultOffset') ?? 0);
        const count = Math.min(Number(params.get('resultRecordCount') ?? maxRecordCount), maxRecordCount);
        const all = [...features.values()].filter(match).sort((a, b) => a.attributes.OBJECTID - b.attributes.OBJECTID);
        const page = all.slice(offset, offset + count);
        return send(res, 200, {
          objectIdFieldName: 'OBJECTID',
          features: page.map(f => ({ attributes: { ...f.attributes }, geometry: f.geometry })),
          exceededTransferLimit: offset + count < all.length,
        });
      }

      if (op === '/applyEdits' && req.method === 'POST') {
        let adds, updates;
        try {
          adds = JSON.parse(params.get('adds') ?? '[]');
          updates = JSON.parse(params.get('updates') ?? '[]');
        } catch {
          return esriError(res, 400, 'Unable to complete operation.', ['adds and updates must be JSON arrays.']);
        }
        return send(res, 200, {
          addResults: adds.map(f => addFeature(f, user)),
          updateResults: updates.map(f => updateFeature(f, user)),
          deleteResults: [],
        });
      }

      return esriError(res, 400, 'Invalid URL');
    } catch (err) {
      console.error(err);
      send(res, 500, { simulated: true, error: err.message });
    }
  });

  return {
    server,
    features,
    setMode: m => { state.mode = m; },
    get mode() { return state.mode; },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ARCGIS_STANDIN_PORT ?? 4200);
  const { server, mode } = createArcGisStandin({ mode: process.env.ARCGIS_STANDIN_MODE ?? 'ok' });
  server.listen(port, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${port}`;
    console.log(`SIMULATED ArcGIS stand-in on ${base} (mode: ${mode}). Not a real ArcGIS system.`);
    console.log(`  ARCGIS_TOKEN_URL=${base}${TOKEN_PATH}`);
    console.log(`  ARCGIS_LAYER_URL=${base}${LAYER_PATH}`);
    console.log(`  ARCGIS_USERNAME=${STANDIN_USER}  ARCGIS_PASSWORD=${STANDIN_PASSWORD}`);
  });
}
