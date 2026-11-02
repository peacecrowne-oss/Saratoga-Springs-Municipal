// SIMULATED Tyler Technologies budget server, for development and demos only.
//
// This project has no access to a real Tyler system, so this stand-in answers
// the budget interface described in server/integrations/tyler/client.js. Every
// response carries simulated: true and every figure is made up.
//
//   node tools/tyler-standin/server.js            (listens on port 4100)
//   TYLER_STANDIN_MODE=down node tools/tyler-standin/server.js
//
// Modes, also switchable while running with  POST /_mode  {"mode": "down"}:
//   ok    normal answers
//   down  HTTP 503, as if Tyler were offline
//   slow  never answers, to exercise timeouts
//   bad   malformed budget lines, to exercise validation

import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MODES = ['ok', 'down', 'slow', 'bad'];

const LINES = [
  { account_code: 'SIM-100-4100', department: 'SIMULATED · Public Works', description: 'Road maintenance', budgeted: 1250000 },
  { account_code: 'SIM-100-4200', department: 'SIMULATED · Public Works', description: 'Snow and ice removal', budgeted: 640000 },
  { account_code: 'SIM-200-5100', department: 'SIMULATED · Water', description: 'Water main repairs', budgeted: 890000 },
  { account_code: 'SIM-300-6100', department: 'SIMULATED · Parks', description: 'Park facilities upkeep', budgeted: 310000 },
  { account_code: 'SIM-400-7100', department: 'SIMULATED · Planning', description: 'Permit processing', budgeted: 175000 },
];

// Spend grows through the fiscal year (taken as the calendar year), so the
// figures move between requests the way a live ledger would.
function budgetFor(fiscalYear, now) {
  const start = Date.UTC(fiscalYear, 0, 1);
  const end = Date.UTC(fiscalYear + 1, 0, 1);
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return {
    simulated: true,
    as_of: new Date(now).toISOString(),
    lines: LINES.map((l, i) => ({
      ...l,
      fiscal_year: fiscalYear,
      actual: Math.round(l.budgeted * elapsed * (0.8 + 0.1 * i)),
    })),
  };
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function createStandin({ mode = 'ok', now = () => Date.now() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown stand-in mode "${mode}". Use one of: ${MODES.join(', ')}.`);
  const state = { mode };

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

    if (req.method === 'GET' && url.pathname === '/budget') {
      if (state.mode === 'slow') return; // never answers
      if (state.mode === 'down') return send(res, 503, { simulated: true, error: 'Simulated Tyler outage.' });
      const fiscalYear = Number(url.searchParams.get('fiscal_year'));
      if (!Number.isInteger(fiscalYear)) return send(res, 400, { simulated: true, error: 'fiscal_year must be a whole number.' });
      const budget = budgetFor(fiscalYear, now());
      if (state.mode === 'bad') budget.lines = budget.lines.map(l => ({ ...l, budgeted: 'n/a', account_code: '' }));
      return send(res, 200, budget);
    }

    send(res, 404, { simulated: true, error: 'Not found.' });
  });

  return { server, setMode: m => { state.mode = m; }, get mode() { return state.mode; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TYLER_STANDIN_PORT ?? 4100);
  const { server, mode } = createStandin({ mode: process.env.TYLER_STANDIN_MODE ?? 'ok' });
  server.listen(port, '127.0.0.1', () => {
    console.log(`SIMULATED Tyler stand-in on http://127.0.0.1:${port} (mode: ${mode}). Not a real Tyler system.`);
  });
}
