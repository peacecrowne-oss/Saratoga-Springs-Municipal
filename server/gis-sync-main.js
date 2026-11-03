// Runs the GIS Sync Job:  npm run gis-sync            (once; exits 1 on failure)
//                         npm run gis-sync -- --watch  (every GIS_SYNC_INTERVAL_S seconds)
//
// Settings come from the environment, or from a local .env file that is never
// committed:
//   DB_PATH              default data/app.db (the same file the server uses)
//   ARCGIS_LAYER_URL     the feature layer, e.g. .../FeatureServer/0
//   ARCGIS_TOKEN_URL     generateToken URL; leave unset for a layer that needs no token
//   ARCGIS_USERNAME      the integration account
//   ARCGIS_PASSWORD      its password (never commit it)
//   GIS_SYNC_INTERVAL_S  default 300, for --watch
//
// For the SIMULATED stand-in (npm run arcgis-standin), it prints the values to use.

import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createArcGisClient } from './integrations/arcgis/client.js';
import { runGisSync } from './gis-sync.js';

const env = process.env;
const db = openDb();
const audit = createAuditLog(db);
const client = createArcGisClient({
  layerUrl: env.ARCGIS_LAYER_URL,
  tokenUrl: env.ARCGIS_TOKEN_URL,
  username: env.ARCGIS_USERNAME,
  password: env.ARCGIS_PASSWORD,
});

async function once() {
  try {
    const r = await runGisSync({ db, audit, client });
    console.log(`${new Date().toISOString()} GIS sync with "${r.layer}"${r.simulated ? ' (SIMULATED)' : ''}: ` +
      `pulled ${r.pulled}, mismatches ${r.mismatches}, unknown features ${r.unknown}, pushed ${r.pushed}, push failures ${r.pushFailed}, ${r.durationMs} ms.`);
    return r.ok;
  } catch (err) {
    if (!err.kind) throw err;
    console.error(`${new Date().toISOString()} GIS SYNC FAILED (${err.kind}): ${err.message} Written to the audit trail as gis.sync_failed.`);
    return false;
  }
}

if (process.argv.includes('--watch')) {
  const seconds = Number(env.GIS_SYNC_INTERVAL_S ?? 300);
  console.log(`GIS sync every ${seconds} s. Ctrl+C to stop.`);
  let running = false;
  const tick = async () => {
    if (running) return; // never two runs at once
    running = true;
    try { await once(); } finally { running = false; }
  };
  await tick();
  const timer = setInterval(tick, seconds * 1000);
  process.once('SIGINT', () => { clearInterval(timer); db.close(); process.exit(0); });
} else {
  const ok = await once();
  db.close();
  process.exitCode = ok ? 0 : 1;
}
