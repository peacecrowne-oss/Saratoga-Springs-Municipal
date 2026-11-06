// Reads utility billing accounts from Caselle (REQ-011, STORY-010).
//
// No Caselle API documentation or sandbox is available to this project, so this
// client speaks an account interface defined here:
//
//   GET {CASELLE_BASE_URL}/v1/accounts/{account_number}
//   Authorization: Bearer {CASELLE_API_KEY}
//   → { as_of: ISO time, simulated?: boolean,
//       account: { account_number, customer_name, service_address, status,
//                  balance_cents, bills: [{ bill_id, bill_date, due_date,
//                  amount_cents, amount_due_cents, status }] } }
//
// Money is whole cents, never floating point. Mapping this to Caselle's real API
// is confined to this file.
//
// Every call has a timeout and a capped number of retries. Only failures that may
// clear up on their own (no answer, timeout, 5xx, 429) are retried.

export class CaselleIntegrationError extends Error {
  // kind: not_configured | unreachable | timeout | refused | not_found | bad_response | bad_data
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'CaselleIntegrationError';
    this.kind = kind;
  }
}

export const ACCOUNT_STATUSES = ['active', 'final', 'closed'];
export const BILL_STATUSES = ['open', 'paid', 'void'];
export const ACCOUNT_NUMBER = /^[A-Za-z0-9-]{1,32}$/;

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`));

export function createCaselleClient({
  baseUrl,
  apiKey,
  timeoutMs = 5000,
  retries = 2,
  retryDelayMs = 500,
  fetchImpl = fetch,
  sleep = defaultSleep,
} = {}) {
  async function attempt(url, accountNumber) {
    const headers = { accept: 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { retry: true, error: new CaselleIntegrationError('timeout', `Caselle did not answer within ${timeoutMs} ms.`, { cause: err }) };
      }
      return { retry: true, error: new CaselleIntegrationError('unreachable', `Could not reach Caselle at ${url.origin}.`, { cause: err }) };
    }

    if (res.status === 401 || res.status === 403) {
      return { retry: false, error: new CaselleIntegrationError('refused', `Caselle refused the request (HTTP ${res.status}). Check the integration credentials (CASELLE_API_KEY).`) };
    }
    if (res.status === 404) {
      return { retry: false, error: new CaselleIntegrationError('not_found', `Caselle has no account ${accountNumber}.`) };
    }
    if (res.status >= 500 || res.status === 429) {
      return { retry: true, error: new CaselleIntegrationError('unreachable', `Caselle is unavailable (HTTP ${res.status}).`) };
    }
    if (!res.ok) {
      return { retry: false, error: new CaselleIntegrationError('bad_response', `Caselle answered HTTP ${res.status}.`) };
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      const kind = err.name === 'TimeoutError' ? 'timeout' : 'bad_data';
      return { retry: kind === 'timeout', error: new CaselleIntegrationError(kind, 'Caselle sent a response that is not valid JSON.', { cause: err }) };
    }
    return { value: validateAccount(body, accountNumber) };
  }

  return {
    configured: Boolean(baseUrl),

    async fetchAccount(accountNumber) {
      if (!baseUrl) {
        throw new CaselleIntegrationError('not_configured', 'The Caselle integration is not configured (CASELLE_BASE_URL is not set).');
      }
      const url = new URL(`v1/accounts/${encodeURIComponent(accountNumber)}`, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');

      let last;
      for (let i = 0; i <= retries; i++) {
        if (i > 0) await sleep(retryDelayMs * i);
        const result = await attempt(url, accountNumber);
        if (!result.error) return result.value;
        last = result.error;
        if (!result.retry) break;
      }
      throw last;
    },
  };
}

// Rejects anything that is not a well-formed account, naming what is wrong. The
// balance must equal what the open bills still owe, so a figure that does not
// add up is refused rather than shown.
export function validateAccount(body, requested) {
  if (!body || typeof body !== 'object' || !body.account || typeof body.account !== 'object') {
    throw new CaselleIntegrationError('bad_data', 'Caselle sent no account data.');
  }
  const a = body.account;
  const problems = [];
  const asOf = new Date(body.as_of);
  if (typeof body.as_of !== 'string' || isNaN(asOf)) problems.push('as_of is missing or not a date');
  if (a.account_number !== requested) problems.push(`account_number is ${JSON.stringify(a.account_number)}, not the ${requested} that was asked for`);
  if (typeof a.customer_name !== 'string' || !a.customer_name.trim()) problems.push('customer_name is missing');
  if (!ACCOUNT_STATUSES.includes(a.status)) problems.push(`status must be one of ${ACCOUNT_STATUSES.join(', ')}`);
  if (!Number.isSafeInteger(a.balance_cents)) problems.push('balance_cents is not a whole number of cents');
  if (!Array.isArray(a.bills)) problems.push('bills is missing');

  const bills = (Array.isArray(a.bills) ? a.bills : []).map((b, i) => {
    const at = `bill ${i + 1}`;
    if (!b || typeof b !== 'object') { problems.push(`${at} is not an object`); return null; }
    if (typeof b.bill_id !== 'string' || !b.bill_id) problems.push(`${at}: bill_id is missing`);
    if (!isDay(b.bill_date)) problems.push(`${at}: bill_date is not a date`);
    if (!isDay(b.due_date)) problems.push(`${at}: due_date is not a date`);
    if (!Number.isSafeInteger(b.amount_cents) || b.amount_cents < 0) problems.push(`${at}: amount_cents is not a non-negative whole number`);
    if (!Number.isSafeInteger(b.amount_due_cents) || b.amount_due_cents < 0) problems.push(`${at}: amount_due_cents is not a non-negative whole number`);
    else if (b.amount_due_cents > b.amount_cents) problems.push(`${at}: more is due than was billed`);
    if (!BILL_STATUSES.includes(b.status)) problems.push(`${at}: status must be one of ${BILL_STATUSES.join(', ')}`);
    return {
      billId: b.bill_id, billDate: b.bill_date, dueDate: b.due_date,
      amountCents: b.amount_cents, amountDueCents: b.amount_due_cents, status: b.status,
    };
  });

  if (!problems.length) {
    const owed = bills.filter(b => b.status === 'open').reduce((sum, b) => sum + b.amountDueCents, 0);
    if (owed !== a.balance_cents) problems.push(`balance_cents is ${a.balance_cents} but the open bills owe ${owed}`);
  }
  if (problems.length) {
    throw new CaselleIntegrationError('bad_data', `Caselle sent account data that failed validation: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}.`);
  }
  return {
    asOf: asOf.toISOString(),
    simulated: body.simulated === true,
    account: {
      accountNumber: a.account_number,
      customerName: a.customer_name,
      serviceAddress: typeof a.service_address === 'string' ? a.service_address : '',
      status: a.status,
      balanceCents: a.balance_cents,
      bills,
    },
  };
}
