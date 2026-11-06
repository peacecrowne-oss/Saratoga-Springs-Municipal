// SIMULATED Cityworks export, for development, tests and demos only.
//
// This project has no access to the City's Cityworks database, so this writes an
// export in the layout server/migration.js reads, filled with made-up records:
//
//   <dir>/cityworks.db       the SQL export, loaded into SQLite
//   <dir>/manifest.json      what the export says it contains
//   <dir>/attachments/...    the attached documents
//   <dir>/gis-features.json  a snapshot of the ArcGIS feature ids, by layer
//
//   node tools/cityworks-sample/make-export.js <dir> [--records 50] [--attachments 200]
//
// Faults can be injected to exercise the migration's failure paths (see FAULTS).

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const LAYERS = ['WATER_HYDRANT', 'WATER_MAIN', 'SEWER_MANHOLE', 'ROAD_SEGMENT'];
export const DEPARTMENTS = ['Public Works', 'Water', 'Building', 'Code Enforcement', 'Planning'];

const TABLES = {
  WORKORDER: ['WORKORDERID', 'DESCRIPTION', 'STATUS', 'DOMAIN', 'INITIATEDATE', 'ACTUALFINISHDATE', 'WOADDRESS'],
  REQUEST: ['REQUESTID', 'DESCRIPTION', 'STATUS', 'DOMAIN', 'DATETIMEINIT', 'DATETIMECLOSED', 'PROBADDRESS'],
  INSPECTION: ['INSPECTIONID', 'INSPTEMPLATENAME', 'STATUS', 'DOMAIN', 'INSPDATE', 'DATETIMECLOSED', 'INSPADDRESS'],
  CA_OBJECT: ['CA_OBJECT_ID', 'CASE_NUMBER', 'CASE_CATEGORY', 'CASE_NAME', 'CASE_STATUS', 'DEPARTMENT', 'DATE_ENTERED', 'CLOSED_DATE', 'LOCATION'],
  WORKORDERENTITY: ['WORKORDERID', 'ENTITYTYPE', 'ENTITYUID'],
  REQUESTENTITY: ['REQUESTID', 'ENTITYTYPE', 'ENTITYUID'],
  INSPECTIONENTITY: ['INSPECTIONID', 'ENTITYTYPE', 'ENTITYUID'],
  CA_OBJECT_ENTITY: ['CA_OBJECT_ID', 'ENTITYTYPE', 'ENTITYUID'],
  ATTACHMENT: ['ATTACHMENTID', 'PARENTTYPE', 'PARENTID', 'FILENAME', 'FILEPATH', 'FILESIZE'],
  CA_FEE: ['CA_OBJECT_ID', 'FEE_CODE', 'AMOUNT', 'AMOUNT_PAID'],
  CA_PEOPLE: ['CA_OBJECT_ID', 'ROLE_TYPE', 'NAME', 'PHONE'],
};

// faults: {
//   missingFeature: n       links to a feature id that GIS does not have
//   ambiguous: n            links with no layer, to an id that two layers share
//   unknownRecord: n        links whose record is not in the export
//   missingFile: n          attachment rows whose file is not in the export
//   dropTable: 'REQUEST'    leave a table out entirely
//   renameColumn: ['REQUEST', 'STATUS', 'REQSTATUS']   schema drift
//   manifestOff: 'WORKORDER'  the manifest claims one more row than there is
//   unknownCategory: n      CA_OBJECT rows that are neither permits nor licenses
// }
export function makeExport(dir, { records = 10, attachments = 20, faults = {}, version = '15.8 (SIMULATED)' } = {}) {
  fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  const dbPath = path.join(dir, 'cityworks.db');
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);

  const columns = structuredClone(TABLES);
  if (faults.renameColumn) {
    const [table, from, to] = faults.renameColumn;
    columns[table] = columns[table].map(c => (c === from ? to : c));
  }
  for (const [table, cols] of Object.entries(columns)) {
    if (table === faults.dropTable) continue;
    db.exec(`CREATE TABLE ${table} (${cols.map(c => `${c} TEXT`).join(', ')})`);
  }
  const insert = (table, values) => {
    if (table === faults.dropTable) return;
    db.prepare(`INSERT INTO ${table} VALUES (${columns[table].map(() => '?').join(', ')})`).run(...values.map(v => (v === null ? null : String(v))));
  };

  const features = Object.fromEntries(LAYERS.map((l, i) => [l, Array.from({ length: Math.max(records, 4) }, (_, n) => String((i + 1) * 10000 + n))]));
  features.WATER_MAIN.push('20000-SHARED');
  features.SEWER_MANHOLE.push('20000-SHARED');

  const day = n => new Date(Date.UTC(2014, 0, 1) + n * 86400000 * 3).toISOString().slice(0, 10);
  const parents = [];
  const status = (n, open, closed) => (n % 4 === 0 ? open : closed);

  db.exec('BEGIN');
  for (let n = 0; n < records; n++) {
    const dept = DEPARTMENTS[n % DEPARTMENTS.length];
    const layer = LAYERS[n % LAYERS.length];
    const feature = features[layer][n];
    insert('WORKORDER', [`WO-${n}`, `SIMULATED work order ${n}`, status(n, 'OPEN', 'CLOSED'), dept, day(n), n % 4 === 0 ? null : day(n + 5), `${n} Example St`]);
    insert('WORKORDERENTITY', [`WO-${n}`, layer, feature]);
    insert('REQUEST', [`SR-${n}`, `SIMULATED service request ${n}`, status(n, 'INPROG', 'CLOSED'), dept, day(n), n % 4 === 0 ? null : day(n + 2), `${n} Example Ave`]);
    insert('REQUESTENTITY', [`SR-${n}`, layer, feature]);
    insert('INSPECTION', [`IN-${n}`, `SIMULATED inspection ${n}`, status(n, 'SCHEDULED', 'COMPLETE'), dept, day(n), n % 4 === 0 ? null : day(n + 1), `${n} Example Rd`]);
    insert('INSPECTIONENTITY', [`IN-${n}`, layer, feature]);
    const category = n % 2 === 0 ? 'PERMIT' : 'LICENSE';
    insert('CA_OBJECT', [`CA-${n}`, `${category === 'PERMIT' ? 'BP' : 'BL'}-${2014 + (n % 10)}-${String(n).padStart(4, '0')}`, category,
      `SIMULATED ${category.toLowerCase()} ${n}`, status(n, 'ISSUED', 'CLOSED'), dept, day(n), n % 4 === 0 ? null : day(n + 30), `${n} Example Ln`]);
    insert('CA_OBJECT_ENTITY', [`CA-${n}`, layer, feature]);
    insert('CA_FEE', [`CA-${n}`, 'PERMIT-FEE', 125 + n, n % 4 === 0 ? 0 : 125 + n]);
    insert('CA_PEOPLE', [`CA-${n}`, 'APPLICANT', `SIMULATED Applicant ${n}`, '555-0100']);
    parents.push(['WORKORDER', `WO-${n}`], ['REQUEST', `SR-${n}`], ['INSPECTION', `IN-${n}`], ['CA_OBJECT', `CA-${n}`]);
  }
  for (let n = 0; n < (faults.unknownCategory ?? 0); n++) {
    insert('CA_OBJECT', [`CA-X${n}`, `XX-${n}`, 'COMPLAINT', 'SIMULATED complaint', 'OPEN', 'Planning', day(n), null, '1 Odd St']);
  }
  for (let n = 0; n < (faults.missingFeature ?? 0); n++) insert('WORKORDERENTITY', [`WO-${n % records}`, 'WATER_HYDRANT', `GONE-${n}`]);
  for (let n = 0; n < (faults.ambiguous ?? 0); n++) insert('REQUESTENTITY', [`SR-${n % records}`, '', '20000-SHARED']);
  for (let n = 0; n < (faults.unknownRecord ?? 0); n++) insert('INSPECTIONENTITY', [`IN-MISSING-${n}`, 'ROAD_SEGMENT', features.ROAD_SEGMENT[0]]);

  let bytes = 0;
  for (let n = 0; n < attachments; n++) {
    const [parentType, parentId] = parents[n % parents.length];
    const rel = `attachments/${String(Math.floor(n / 1000)).padStart(4, '0')}/doc-${n}.txt`;
    const content = `SIMULATED attachment ${n} for ${parentType} ${parentId}\n`;
    const missing = n < (faults.missingFile ?? 0);
    if (!missing) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    bytes += Buffer.byteLength(content);
    insert('ATTACHMENT', [`AT-${n}`, parentType, parentId, `doc-${n}.txt`, rel, Buffer.byteLength(content)]);
  }
  db.exec('COMMIT');

  const tables = {};
  for (const table of Object.keys(TABLES)) {
    if (table === faults.dropTable) continue;
    tables[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n + (table === faults.manifestOff ? 1 : 0);
  }
  db.close();

  const manifest = { simulated: true, cityworks_version: version, exported_at: new Date().toISOString(), tables, attachments: { files: attachments, bytes } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'gis-features.json'), JSON.stringify({ simulated: true, layers: features }));
  return { dir, manifest, records, attachments };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, ...rest] = process.argv.slice(2);
  const option = (name, fallback) => (rest.includes(`--${name}`) ? Number(rest[rest.indexOf(`--${name}`) + 1]) : fallback);
  if (!dir) {
    console.error('Usage: node tools/cityworks-sample/make-export.js <dir> [--records N] [--attachments N]');
    process.exit(2);
  }
  const started = Date.now();
  const { manifest } = makeExport(dir, { records: option('records', 50), attachments: option('attachments', 200) });
  console.log(`Wrote a SIMULATED Cityworks export to ${dir} in ${Date.now() - started} ms: ${Object.entries(manifest.tables).map(([t, n]) => `${t} ${n}`).join(', ')}; ${manifest.attachments.files} attachments.`);
}
