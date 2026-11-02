// Starts the system:  npm start   (then open http://127.0.0.1:3000/budget)
//
// Settings come from the environment, or from a local .env file that is never
// committed:
//   PORT              default 3000
//   DB_PATH           default data/app.db
//   TYLER_BASE_URL    where Tyler's budget API is, e.g. http://127.0.0.1:4100
//                     for the SIMULATED stand-in (npm run standin)
//   TYLER_API_KEY     only if the Tyler endpoint needs one

import http from 'node:http';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createTylerClient } from './integrations/tyler/client.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const audit = createAuditLog(openDb());
const tyler = createTylerClient({ baseUrl: process.env.TYLER_BASE_URL, apiKey: process.env.TYLER_API_KEY });

http.createServer(createApp({ audit, tyler })).listen(port, '127.0.0.1', () => {
  console.log(`Budget dashboard: http://127.0.0.1:${port}/budget`);
  console.log(process.env.TYLER_BASE_URL
    ? `Tyler integration: ${process.env.TYLER_BASE_URL}`
    : 'Tyler integration: not configured (set TYLER_BASE_URL). The dashboard will say so.');
});
