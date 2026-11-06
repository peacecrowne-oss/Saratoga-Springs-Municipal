// STORY-013 acceptance: a SIMULATED Cityworks export migrated into a real
// database on disk, then read back over HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.js';
import { createAuditLog } from './audit.js';
import { createAssetStore } from './assets.js';
import { checkGisLinks, MIGRATION_LIMITS, MigrationRefused, reportMarkdown, runMigration } from './migration.js';
import { createApp } from './app.js';
import { makeExport } from '../tools/cityworks-sample/make-export.js';

const run = promisify(execFile);
const it = { 'x-user-id': 'it-1', 'x-user-role': 'it_administrator' };
const officer = { 'x-user-id': 'ce-1', 'x-user-role': 'code_enforcement_officer' };
const billing = { 'x-user-id': 'bm-1', 'x-user-role': 'billing_manager' };

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  const db = openDb(path.join(dir, 'app.db'));
  const audit = createAuditLog(db);
  t.after(() => { try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const exportDir = path.join(dir, 'export');
  const attachmentsDir = path.join(dir, 'attachments');
  const migrate = (options = {}) => runMigration({ db, audit, exportDir, attachmentsDir, actor: 'it-1', ...options });
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { dir, db, audit, exportDir, attachmentsDir, migrate, count };
}

// Reads rows from the export and closes it at once: Windows will not delete an open file.
function sourceRows(exportDir, sql) {
  const src = new DatabaseSync(path.join(exportDir, 'cityworks.db'), { readOnly: true });
  try { return src.prepare(sql).all(); } finally { src.close(); }
}

async function serve(t, db, audit) {
  const server = http.createServer(createApp({ db, audit, assets: createAssetStore(db, audit), tyler: {}, allowDevHeaders: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, route, headers = it, body) => {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}

test('criterion 1: permits, licenses, service requests, inspections and work orders import with their GIS relationships', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 12, attachments: 30 });
  const report = await w.migrate();

  assert.equal(report.verdict, 'trusted', report.failures.join('; '));
  assert.deepEqual(Object.fromEntries(report.records.map(r => [r.type, r.target])),
    { permit: 6, license: 6, service_request: 12, inspection: 12, work_order: 12 });

  // Each record carries exactly the feature its Cityworks row pointed at.
  for (const [table, parent, type] of [['WORKORDERENTITY', 'WORKORDERID', 'work_order'], ['REQUESTENTITY', 'REQUESTID', 'service_request'], ['INSPECTIONENTITY', 'INSPECTIONID', 'inspection']]) {
    for (const row of sourceRows(w.exportDir, `SELECT * FROM ${table}`)) {
      const link = w.db.prepare('SELECT * FROM legacy_gis_link WHERE record_id = ?').get(`${type}:${row[parent]}`);
      assert.equal(link.layer, row.ENTITYTYPE);
      assert.equal(link.feature_id, row.ENTITYUID);
    }
  }
  const permit = JSON.parse(w.db.prepare("SELECT data FROM legacy_record WHERE id = 'permit:CA-0'").get().data);
  assert.equal(permit.fees.length, 1, 'fees come with the permit');
  assert.equal(permit.people[0].NAME, 'SIMULATED Applicant 0', 'and people');
  assert.equal(report.gis.linked, 48);
  assert.equal(report.gis.orphaned, 0);
});

test('criterion 1: running it again changes nothing and duplicates nothing', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 8, attachments: 20 });
  await w.migrate();
  const before = ['legacy_record', 'legacy_gis_link', 'legacy_attachment'].map(w.count);
  const files = fs.readdirSync(w.attachmentsDir, { recursive: true }).length;
  const again = await w.migrate();
  assert.equal(again.verdict, 'trusted');
  assert.deepEqual(['legacy_record', 'legacy_gis_link', 'legacy_attachment'].map(w.count), before);
  assert.equal(fs.readdirSync(w.attachmentsDir, { recursive: true }).length, files);
  assert.equal(again.attachments.bytesCopied, 0, 'nothing is copied twice');
});

test('criterion 2: every attachment is linked to its record and retrievable, byte for byte', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 10, attachments: 2000 });
  const report = await w.migrate();
  assert.equal(report.attachments.source, 2000);
  assert.equal(report.attachments.stored, 2000);
  assert.equal(report.attachments.verified, 2000);

  const call = await serve(t, w.db, w.audit);
  const types = { WORKORDER: 'work_order', REQUEST: 'service_request', INSPECTION: 'inspection' };
  for (const row of sourceRows(w.exportDir, "SELECT * FROM ATTACHMENT WHERE PARENTTYPE <> 'CA_OBJECT' AND CAST(SUBSTR(ATTACHMENTID, 4) AS INTEGER) % 97 = 0")) {
    const recordId = `${types[row.PARENTTYPE]}:${row.PARENTID}`;
    const { body } = await call('GET', `/api/legacy/records/${encodeURIComponent(recordId)}`);
    const listed = body.record.attachments.find(a => a.id === `att:${row.ATTACHMENTID}`);
    assert.ok(listed, `${row.ATTACHMENTID} is listed on ${recordId}`);
    const file = await call('GET', `/api/legacy/records/${encodeURIComponent(recordId)}/attachments/${encodeURIComponent(listed.id)}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(file.body, fs.readFileSync(path.join(w.exportDir, row.FILEPATH)));
  }
});

test('criterion 2: a stored file that has gone missing is reported, not served as empty', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 4, attachments: 4 });
  await w.migrate();
  const a = w.db.prepare('SELECT * FROM legacy_attachment LIMIT 1').get();
  fs.rmSync(a.stored_path);
  const call = await serve(t, w.db, w.audit);
  const res = await call('GET', `/api/legacy/records/${encodeURIComponent(a.record_id)}/attachments/${encodeURIComponent(a.id)}`);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.kind, 'attachment_missing');
  assert.ok(w.audit.list({ entityType: 'legacy' }).some(e => e.action === 'legacy.attachment_missing'));
  const rerun = await w.migrate();
  assert.equal(rerun.verdict, 'trusted', 'a rerun restores the missing file');
  assert.ok(fs.existsSync(a.stored_path));
});

test('criterion 3: a historical case is viewable, clearly read-only, and cannot be changed', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 6, attachments: 6 });
  await w.migrate();
  const call = await serve(t, w.db, w.audit);

  const list = await call('GET', '/api/legacy/records?type=permit', officer);
  assert.equal(list.status, 200);
  assert.equal(list.body.readOnly, true);
  assert.ok(list.body.records.every(r => r.readOnly === true));
  const { body } = await call('GET', `/api/legacy/records/${encodeURIComponent(list.body.records[0].id)}`, officer);
  assert.equal(body.record.readOnly, true);
  assert.ok(body.record.gisLinks.length > 0);
  assert.equal((await call('GET', '/api/legacy/records?open=1&department=Water')).status, 200);

  const page = await fetch(`${(await serveBase(t, w))}/history`);
  assert.match(await page.text(), /READ-ONLY/);

  const id = encodeURIComponent('permit:CA-0');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const res = await call(method, `/api/legacy/records/${id}`, it, { status: 'OPEN' });
    assert.equal(res.status, 405, method);
    assert.equal(res.body.error.kind, 'read_only');
  }
  assert.throws(() => w.db.prepare("UPDATE legacy_record SET status = 'OPEN' WHERE id = 'permit:CA-0'").run(), /read-only/);
  assert.throws(() => w.db.prepare("DELETE FROM legacy_attachment").run(), /read-only/);
  assert.throws(() => w.db.prepare("INSERT INTO legacy_gis_link VALUES ('x', 'permit:CA-0', 'L', 'F', 'source')").run(), /read-only/);

  const actions = w.audit.list({ entityType: 'legacy', limit: 50 }).map(e => e.action);
  assert.ok(actions.includes('legacy.view'), 'opening a case is logged');
  assert.equal(actions.filter(a => a === 'legacy.write_refused').length, 4);
  assert.equal((await call('GET', '/api/legacy/records', billing)).status, 403);
  assert.equal((await call('GET', '/api/legacy/records', {})).status, 401);
});

async function serveBase(t, w) {
  const server = http.createServer(createApp({ db: w.db, audit: w.audit, assets: createAssetStore(w.db, w.audit), tyler: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('criterion 4: the report is trusted only when counts match and no GIS relationship is orphaned or unresolved', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 8, attachments: 8, faults: { missingFeature: 2, ambiguous: 1, unknownRecord: 1 } });
  const report = await w.migrate();
  assert.equal(report.verdict, 'not_trusted');
  assert.equal(report.gis.unresolved, 4);
  assert.deepEqual(report.gis.unresolvedByProblem, { missing: 2, ambiguous: 1, unknown_record: 1 });
  assert.equal(report.gis.accountedFor, true, 'every source relationship is linked, folded, accepted or listed');
  assert.ok(report.failures.some(f => /need resolving/.test(f)));
  assert.equal(w.count('legacy_record'), 32, 'the records themselves still import');
  assert.match(reportMarkdown(report), /NOT TRUSTED/);

  // A person resolves each one; the next run is trusted.
  const resolutions = Object.fromEntries(report.gisIssues.map(i => [i.link_key, i.problem === 'ambiguous'
    ? { layer: 'WATER_MAIN', feature_id: '20000-SHARED' }
    : { no_feature: true, reason: 'Checked by GIS: no current feature' }]));
  const file = path.join(w.dir, 'resolutions.json');
  fs.writeFileSync(file, JSON.stringify(resolutions));
  const fixed = await w.migrate({ resolutionsFile: file });
  assert.equal(fixed.verdict, 'trusted', fixed.failures.join('; '));
  assert.equal(fixed.gis.fromResolutions, 1);
  assert.equal(fixed.gis.acceptedWithoutFeature, 3);
  assert.equal(fixed.gis.unresolved, 0);
  assert.match(reportMarkdown(fixed), /\*\*Verdict: TRUSTED\*\*/);
  assert.ok(w.audit.list({ entityType: 'migration' }).every(e => e.actor === 'it-1'));
});

test('criterion 4: orphaned links are found by reading the database itself', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 4, attachments: 0 });
  await w.migrate();
  const inventory = new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(w.exportDir, 'gis-features.json'))).layers).map(([l, ids]) => [l, new Set(ids)]));
  assert.equal(checkGisLinks(w.db, inventory).orphaned.length, 0);
  w.db.exec("UPDATE sync_state SET value = '1' WHERE key = 'legacy_writable'");
  w.db.exec("INSERT INTO legacy_gis_link VALUES ('a', 'permit:CA-0', 'WATER_MAIN', 'NOT-IN-GIS', 'source')");
  // A link to a record that does not exist cannot even be stored.
  assert.throws(() => w.db.exec("INSERT INTO legacy_gis_link VALUES ('b', 'permit:GONE', 'WATER_MAIN', '20001', 'source')"), /FOREIGN KEY/);
  w.db.exec("UPDATE sync_state SET value = '0' WHERE key = 'legacy_writable'");
  assert.deepEqual(checkGisLinks(w.db, inventory).orphaned.map(l => l.id), ['a']);
});

test('criterion 4: records of an unknown kind or missing files make the report untrusted', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 4, attachments: 6, faults: { unknownCategory: 1, missingFile: 2 } });
  const report = await w.migrate();
  assert.equal(report.verdict, 'not_trusted');
  assert.equal(report.unmapped.length, 1);
  assert.equal(report.attachments.notMigrated, 2);
  assert.deepEqual(report.attachments.byProblem, { missing_file: 2 });
});

test('an incomplete export is refused before anything is written', async t => {
  for (const faults of [{ dropTable: 'REQUEST' }, { manifestOff: 'WORKORDER' }]) {
    const w = workspace(t);
    makeExport(w.exportDir, { records: 4, attachments: 4, faults });
    await assert.rejects(w.migrate(), err => err instanceof MigrationRefused && err.kind === 'export_incomplete');
    assert.equal(w.count('legacy_record'), 0);
    assert.equal(fs.existsSync(w.attachmentsDir) ? fs.readdirSync(w.attachmentsDir).length : 0, 0, 'no files copied');
    assert.equal(w.audit.list({ entityType: 'migration' })[0].action, 'migration.refused');
  }
  const w = workspace(t);
  fs.mkdirSync(w.exportDir);
  await assert.rejects(w.migrate(), err => err.kind === 'export_incomplete');
});

test('schema drift: a known renamed column is followed, an unknown one is refused', async t => {
  const known = workspace(t);
  makeExport(known.exportDir, { records: 4, attachments: 0, faults: { renameColumn: ['REQUEST', 'STATUS', 'REQSTATUS'] } });
  const report = await known.migrate();
  assert.equal(report.verdict, 'trusted');
  assert.equal(known.db.prepare("SELECT status FROM legacy_record WHERE id = 'service_request:SR-1'").get().status, 'CLOSED');

  const unknown = workspace(t);
  makeExport(unknown.exportDir, { records: 4, attachments: 0, faults: { renameColumn: ['REQUEST', 'STATUS', 'STAT_CD'] } });
  await assert.rejects(unknown.migrate(), err => err.kind === 'schema_drift' && /REQUEST has no column for status/.test(err.message));
  assert.equal(unknown.count('legacy_record'), 0);
});

test('attachment volume: over the quota, the disk, or the per-file limit is refused before copying', async t => {
  for (const [label, options] of [
    ['quota', { limits: { ...MIGRATION_LIMITS, maxTotalBytes: 100 } }],
    ['disk', { freeBytes: () => 50 }],
    ['file size', { limits: { ...MIGRATION_LIMITS, maxFileBytes: 10 } }],
  ]) {
    const w = workspace(t);
    makeExport(w.exportDir, { records: 4, attachments: 10 });
    await assert.rejects(w.migrate(options), err => err.kind === 'attachment_volume', label);
    assert.equal(w.count('legacy_record'), 0, label);
    assert.equal(fs.readdirSync(w.attachmentsDir).length, 0, `${label}: nothing copied`);
  }
});

test('a resolutions file that is not valid is refused', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 2, attachments: 0 });
  const file = path.join(w.dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ key: { no_feature: true } }));
  await assert.rejects(w.migrate({ resolutionsFile: file }), err => err.kind === 'bad_resolutions');
});

test('the migrate command writes the report and exits by verdict', async t => {
  const w = workspace(t);
  makeExport(w.exportDir, { records: 4, attachments: 4 });
  w.db.close();
  const env = { ...process.env, DB_PATH: path.join(w.dir, 'app.db'), ATTACHMENTS_DIR: w.attachmentsDir };
  const cmd = args => run(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/migrate-main.js', ...args], { env, timeout: 60000 })
    .then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

  const ok = await cmd([w.exportDir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /VERDICT: TRUSTED/);
  const reports = fs.readdirSync(path.join(w.dir, 'migration-reports'));
  assert.deepEqual(reports.map(f => path.extname(f)).sort(), ['.json', '.md']);

  makeExport(w.exportDir, { records: 4, attachments: 4, faults: { missingFeature: 1 } });
  assert.equal((await cmd([w.exportDir])).code, 3);
  makeExport(w.exportDir, { records: 4, attachments: 4, faults: { dropTable: 'ATTACHMENT' } });
  const refused = await cmd([w.exportDir]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /MIGRATION REFUSED \(export_incomplete\)/);
});
