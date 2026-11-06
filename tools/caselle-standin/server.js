// SIMULATED Caselle billing server, for development and demos only.
//
// This project has no access to a real Caselle system, so this stand-in answers
// the account interface described in server/integrations/caselle/client.js.
// Every response carries simulated: true and every account is made up.
//
//   node tools/caselle-standin/server.js            (listens on port 4300)
//   CASELLE_STANDIN_MODE=down node tools/caselle-standin/server.js
//
// It expects  Authorization: Bearer simulated-key  (or CASELLE_STANDIN_API_KEY),
// so wrong credentials can be tried. Modes, also switchable while running with
// POST /_mode  {"mode": "down"}:
//   ok        normal answers
//   down      HTTP 503, as if Caselle were offline
//   slow      never answers, to exercise timeouts
//   bad       malformed bills, to exercise validation
//   mismatch  a balance that does not match the bills

import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MODES = ['ok', 'down', 'slow', 'bad', 'mismatch'];
export const DEFAULT_KEY = 'simulated-key';

export const ACCOUNTS = {
  'SIM-1001': {
    customer_name: 'SIMULATED Customer One', service_address: 'SIMULATED · 1 Example Street', status: 'active',
    bills: [
      { bill_id: 'B-1001-09', bill_date: '2026-09-01', due_date: '2026-09-25', amount_cents: 8450, amount_due_cents: 0, status: 'paid' },
      { bill_id: 'B-1001-10', bill_date: '2026-10-01', due_date: '2026-10-25', amount_cents: 9120, amount_due_cents: 9120, status: 'open' },
      { bill_id: 'B-1001-11', bill_date: '2026-11-01', due_date: '2026-11-25', amount_cents: 8875, amount_due_cents: 3875, status: 'open' },
    ],
  },
  'SIM-1002': {
    customer_name: 'SIMULATED Customer Two', service_address: 'SIMULATED · 2 Example Avenue', status: 'final',
    bills: [{ bill_id: 'B-1002-10', bill_date: '2026-10-01', due_date: '2026-10-25', amount_cents: 4300, amount_due_cents: 0, status: 'paid' }],
  },
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function createStandin({ mode = 'ok', apiKey = DEFAULT_KEY, now = () => Date.now() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown stand-in mode "${mode}". Use one of: ${MODES.join(', ')}.`);
  const state = { mode, requests: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://standin');

    if (req.method === 'POST' && url.pathname === '/_mode') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let next;
        try { next = JSON.parse(raw).mode; } catch { return send(res, 400, { error: 'Send JSON like {"mode": "down"}.' }); }
        if (!MODES.includes(next)) return send(res, 400, { error: `mode must be one of: ${MODES.join(', ')}` });
        state.mode = next;
        send(res, 200, { simulated: true, mode: state.mode });
      });
      return;
    }

    const match = req.method === 'GET' && url.pathname.match(/^\/v1\/accounts\/([^/]+)$/);
    if (match) {
      state.requests++;
      if (state.mode === 'slow') return; // never answers
      if (state.mode === 'down') return send(res, 503, { simulated: true, error: 'Simulated Caselle outage.' });
      if (req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { simulated: true, error: 'Invalid API key.' });
      const number = decodeURIComponent(match[1]);
      const found = ACCOUNTS[number];
      if (!found) return send(res, 404, { simulated: true, error: 'No such account.' });
      const balance = found.bills.filter(b => b.status === 'open').reduce((s, b) => s + b.amount_due_cents, 0);
      const account = { account_number: number, ...found, balance_cents: balance };
      if (state.mode === 'bad') account.bills = account.bills.map(b => ({ ...b, amount_cents: '91.20', due_date: 'soon' }));
      if (state.mode === 'mismatch') account.balance_cents = balance + 100;
      return send(res, 200, { simulated: true, as_of: new Date(now()).toISOString(), account });
    }

    send(res, 404, { simulated: true, error: 'Not found.' });
  });

  return { server, state, setMode: m => { state.mode = m; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CASELLE_STANDIN_PORT ?? 4300);
  const { server, state } = createStandin({ mode: process.env.CASELLE_STANDIN_MODE ?? 'ok', apiKey: process.env.CASELLE_STANDIN_API_KEY ?? DEFAULT_KEY });
  server.listen(port, '127.0.0.1', () => {
    console.log(`SIMULATED Caselle stand-in on http://127.0.0.1:${port} (mode: ${state.mode}). Not a real Caselle system.`);
    console.log(`Accounts: ${Object.keys(ACCOUNTS).join(', ')}. API key: ${process.env.CASELLE_STANDIN_API_KEY ? '(from CASELLE_STANDIN_API_KEY)' : DEFAULT_KEY}.`);
  });
}
