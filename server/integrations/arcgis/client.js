// Talks to one ArcGIS Enterprise feature layer over the ESRI REST API (REQ-004).
//
//   POST {tokenUrl}                   generateToken: username, password → { token, expires }
//   GET  {layerUrl}?f=json            layer metadata: fields, objectIdField, editFieldsInfo
//   POST {layerUrl}/query             where, outFields, resultOffset, resultRecordCount
//                                     → { features: [{ attributes, geometry }], exceededTransferLimit }
//   POST {layerUrl}/applyEdits        adds, updates (JSON arrays) → { addResults, updateResults }
//
// ESRI reports most errors as HTTP 200 with { error: { code, message } };
// codes 498 (invalid token) and 499 (token required) mean authentication.
// An expired token is refreshed once; a second refusal is an auth failure.
//
// Every call has a timeout and capped retries on failures that may clear up
// on their own (no answer, timeout, 5xx, 429). applyEdits is never retried
// here: if an add timed out after the layer saved it, a retry would create a
// duplicate feature. The sync job instead finds the feature by asset tag on
// its next run.

export class ArcGisError extends Error {
  // kind: not_configured | unreachable | timeout | auth | refused | bad_response
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'ArcGisError';
    this.kind = kind;
  }
}

const AUTH_CODES = new Set([498, 499]);
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createArcGisClient({
  layerUrl,
  tokenUrl,
  username,
  password,
  referer = 'saratoga-springs-municipal',
  timeoutMs = 10000,
  retries = 2,
  retryDelayMs = 500,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  let token = null;

  async function attempt(url, params, method) {
    const form = new URLSearchParams({ f: 'json', ...params });
    const target = new URL(url);
    const init = { method, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) };
    if (method === 'GET') {
      for (const [k, v] of form) target.searchParams.set(k, v);
    } else {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = form.toString();
    }

    let res;
    try {
      res = await fetchImpl(target, init);
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { retry: true, error: new ArcGisError('timeout', `ArcGIS did not answer within ${timeoutMs} ms (${target.pathname}).`, { cause: err }) };
      }
      return { retry: true, error: new ArcGisError('unreachable', `Could not reach ArcGIS at ${target.origin}.`, { cause: err }) };
    }
    if (res.status === 401 || res.status === 403) {
      return { retry: false, error: new ArcGisError('auth', `ArcGIS refused the request (HTTP ${res.status}). Check the integration credentials.`) };
    }
    if (res.status >= 500 || res.status === 429) {
      return { retry: true, error: new ArcGisError('unreachable', `ArcGIS is unavailable (HTTP ${res.status}).`) };
    }
    if (!res.ok) {
      return { retry: false, error: new ArcGisError('bad_response', `ArcGIS answered HTTP ${res.status} (${target.pathname}).`) };
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      const kind = err.name === 'TimeoutError' ? 'timeout' : 'bad_response';
      return { retry: kind === 'timeout', error: new ArcGisError(kind, `ArcGIS sent a response that is not valid JSON (${target.pathname}).`, { cause: err }) };
    }
    if (body?.error) {
      const { code, message, details } = body.error;
      const text = `${message ?? 'error'}${details?.length ? ` (${details.join('; ')})` : ''}`;
      if (AUTH_CODES.has(code)) return { retry: false, authExpired: true, error: new ArcGisError('auth', `ArcGIS rejected the token: ${text}.`) };
      return { retry: false, error: new ArcGisError('refused', `ArcGIS refused the request, code ${code}: ${text}.`) };
    }
    return { value: body };
  }

  async function withRetries(url, params, method, maxRetries) {
    let last;
    for (let i = 0; i <= maxRetries; i++) {
      if (i > 0) await sleep(retryDelayMs * i);
      const result = await attempt(url, params, method);
      if (!result.error) return result;
      last = result;
      if (!result.retry) break;
    }
    return last;
  }

  async function getToken() {
    if (!tokenUrl) return null;
    if (token && token.expires - 60000 > now()) return token.value;
    if (!username || !password) {
      throw new ArcGisError('not_configured', 'ArcGIS needs a token but ARCGIS_USERNAME or ARCGIS_PASSWORD is not set.');
    }
    const result = await withRetries(tokenUrl, { username, password, client: 'referer', referer, expiration: '60' }, 'POST', retries);
    if (result.error) {
      if (result.error.kind === 'refused') throw new ArcGisError('auth', `ArcGIS would not issue a token: ${result.error.message}`);
      throw result.error;
    }
    if (typeof result.value.token !== 'string') throw new ArcGisError('auth', 'ArcGIS answered generateToken without a token.');
    token = { value: result.value.token, expires: Number(result.value.expires) || now() + 30 * 60000 };
    return token.value;
  }

  async function call(path, params = {}, { method = 'POST', retry = true } = {}) {
    if (!layerUrl) throw new ArcGisError('not_configured', 'The ArcGIS integration is not configured (ARCGIS_LAYER_URL is not set).');
    const url = path ? `${layerUrl.replace(/\/$/, '')}/${path}` : layerUrl;
    for (let refreshed = false; ; refreshed = true) {
      const t = await getToken();
      const result = await withRetries(url, t ? { ...params, token: t } : params, method, retry ? retries : 0);
      if (!result.error) return result.value;
      if (result.authExpired && tokenUrl && !refreshed) { token = null; continue; }
      throw result.error;
    }
  }

  return {
    async describeLayer() {
      const body = await call('', {}, { method: 'GET' });
      if (!Array.isArray(body.fields)) throw new ArcGisError('bad_response', 'The layer description has no fields list.');
      return body;
    },

    async query({ where = '1=1', outFields = '*', resultOffset = 0, resultRecordCount = 1000 } = {}) {
      const body = await call('query', {
        where, outFields, returnGeometry: 'true', orderByFields: 'OBJECTID',
        resultOffset: String(resultOffset), resultRecordCount: String(resultRecordCount),
      });
      if (!Array.isArray(body.features)) throw new ArcGisError('bad_response', 'The query answer has no features list.');
      return { features: body.features, exceededTransferLimit: body.exceededTransferLimit === true };
    },

    async applyEdits({ adds = [], updates = [] }) {
      const params = { rollbackOnFailure: 'false' };
      if (adds.length) params.adds = JSON.stringify(adds);
      if (updates.length) params.updates = JSON.stringify(updates);
      const body = await call('applyEdits', params, { retry: false });
      return { addResults: body.addResults ?? [], updateResults: body.updateResults ?? [] };
    },
  };
}

// ESRI where-clause literal: single quotes doubled.
export const sqlString = value => `'${String(value).replace(/'/g, "''")}'`;

// ESRI standardized-query timestamp, UTC, to the second (rounded down).
export const sqlTimestamp = ms => `TIMESTAMP '${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}'`;
