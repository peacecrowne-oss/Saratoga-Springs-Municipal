// Reads budget data from Tyler Technologies (REQ-007, REQ-014).
//
// No Tyler API documentation or sandbox is available to this project, so this
// client speaks a budget interface defined here:
//
//   GET {TYLER_BASE_URL}/budget?fiscal_year=2026
//   → { as_of: ISO time, simulated?: boolean,
//       lines: [{ account_code, description?, department?, fiscal_year, budgeted, actual }] }
//
// Mapping this to Tyler's real API is confined to this file.
//
// Every call has a timeout and a capped number of retries. Only failures that
// may clear up on their own (no answer, timeout, 5xx, 429) are retried.

export class TylerIntegrationError extends Error {
  // kind: not_configured | unreachable | timeout | refused | bad_response | bad_data
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'TylerIntegrationError';
    this.kind = kind;
  }
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createTylerClient({
  baseUrl,
  apiKey,
  timeoutMs = 5000,
  retries = 2,
  retryDelayMs = 500,
  fetchImpl = fetch,
  sleep = defaultSleep,
} = {}) {
  async function attempt(url) {
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { retry: true, error: new TylerIntegrationError('timeout', `Tyler did not answer within ${timeoutMs} ms.`, { cause: err }) };
      }
      return { retry: true, error: new TylerIntegrationError('unreachable', `Could not reach Tyler at ${url.origin}.`, { cause: err }) };
    }

    if (res.status === 401 || res.status === 403) {
      return { retry: false, error: new TylerIntegrationError('refused', `Tyler refused the request (HTTP ${res.status}). Check the integration credentials.`) };
    }
    if (res.status >= 500 || res.status === 429) {
      return { retry: true, error: new TylerIntegrationError('unreachable', `Tyler is unavailable (HTTP ${res.status}).`) };
    }
    if (!res.ok) {
      return { retry: false, error: new TylerIntegrationError('bad_response', `Tyler answered HTTP ${res.status}.`) };
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      const kind = err.name === 'TimeoutError' ? 'timeout' : 'bad_data';
      return { retry: kind === 'timeout', error: new TylerIntegrationError(kind, 'Tyler sent a response that is not valid JSON.', { cause: err }) };
    }
    return { value: validateBudget(body) };
  }

  return {
    async fetchBudget({ fiscalYear }) {
      if (!baseUrl) {
        throw new TylerIntegrationError('not_configured', 'The Tyler integration is not configured (TYLER_BASE_URL is not set).');
      }
      const url = new URL(`budget?fiscal_year=${encodeURIComponent(fiscalYear)}`, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');

      let last;
      for (let i = 0; i <= retries; i++) {
        if (i > 0) await sleep(retryDelayMs * i);
        const result = await attempt(url);
        if (!result.error) return result.value;
        last = result.error;
        if (!result.retry) break;
      }
      throw last;
    },
  };
}

// Rejects anything that is not a well-formed budget, naming what is wrong,
// so incorrect data never reaches the dashboard.
export function validateBudget(body) {
  const problems = [];
  if (!body || typeof body !== 'object') {
    throw new TylerIntegrationError('bad_data', 'Tyler sent no budget data.');
  }
  const asOf = new Date(body.as_of);
  if (typeof body.as_of !== 'string' || isNaN(asOf)) problems.push('as_of is missing or not a date');
  if (!Array.isArray(body.lines)) problems.push('lines is missing');

  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l, i) => {
    const at = `line ${i + 1}`;
    if (!l || typeof l !== 'object') { problems.push(`${at} is not an object`); return null; }
    if (typeof l.account_code !== 'string' || !l.account_code.trim()) problems.push(`${at}: account_code is missing`);
    if (!Number.isInteger(l.fiscal_year)) problems.push(`${at}: fiscal_year is not a whole number`);
    if (!Number.isFinite(l.budgeted) || l.budgeted < 0) problems.push(`${at}: budgeted is not a non-negative number`);
    if (!Number.isFinite(l.actual)) problems.push(`${at}: actual is not a number`);
    return {
      accountCode: l.account_code,
      description: typeof l.description === 'string' ? l.description : '',
      department: typeof l.department === 'string' ? l.department : '',
      fiscalYear: l.fiscal_year,
      budgeted: l.budgeted,
      actual: l.actual,
      remaining: l.budgeted - l.actual,
    };
  });

  if (problems.length) {
    throw new TylerIntegrationError('bad_data', `Tyler sent budget data that failed validation: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}.`);
  }
  return { asOf: asOf.toISOString(), simulated: body.simulated === true, lines };
}
