// Migrates a Cityworks export into read-only historical records (STORY-013, REQ-012).
//
// The export is a directory: cityworks.db (the SQL export loaded into SQLite),
// manifest.json (what the export says it contains), attachments/, and
// gis-features.json (a snapshot of ArcGIS feature ids by layer). The table and
// column names follow Cityworks' conventions but have NOT been checked against
// the City's own export; SOURCE below is the one place to adjust them.
//
// It runs in four phases, and is safe to run again: a rerun updates what changed
// and creates no duplicates.
//
//   1. preflight   refuse, writing nothing, if the export is incomplete (missing
//                  tables, a manifest that disagrees with the data), if the schema
//                  has drifted (a required column has none of its known names), or
//                  if the attachments would exceed the storage limits
//   2. files       copy attachments into content-addressed storage, each verified
//                  by hash; a rerun skips those already stored
//   3. records     one transaction: records, GIS links, attachments, the run, its
//                  audit event. Historical tables are opened for writing inside it
//                  and closed again before it commits
//   4. reconcile   count source against target independently, check every GIS link
//                  against the snapshot, re-hash every stored file
//
// A GIS relationship that cannot be linked (no feature id, a feature GIS does not
// have, an id two layers share, a record not in the export) is not imported as a
// link. It is listed for a person to resolve, through a resolutions file on the
// next run. The migration is trusted only when every count matches, no link is
// orphaned and nothing is left unresolved.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { transaction } from './db.js';

export class MigrationRefused extends Error {
  // kind: export_incomplete | schema_drift | attachment_volume | bad_resolutions
  constructor(kind, message, problems = []) {
    super(message);
    this.name = 'MigrationRefused';
    this.kind = kind;
    this.problems = problems;
  }
}

// Each logical field lists the column names it has had across Cityworks versions.
const RECORD_SOURCES = [
  { table: 'WORKORDER', types: { _: 'work_order' }, fields: {
    id: ['WORKORDERID'], summary: ['DESCRIPTION'], status: ['STATUS', 'WOSTATUS'], department: ['DOMAIN', 'DEPARTMENT'],
    opened: ['INITIATEDATE', 'DATEINIT'], closed: ['ACTUALFINISHDATE', 'DATECLOSED'], address: ['WOADDRESS', 'LOCATION'] } },
  { table: 'REQUEST', types: { _: 'service_request' }, fields: {
    id: ['REQUESTID'], summary: ['DESCRIPTION'], status: ['STATUS', 'REQSTATUS'], department: ['DOMAIN', 'DEPARTMENT'],
    opened: ['DATETIMEINIT'], closed: ['DATETIMECLOSED'], address: ['PROBADDRESS', 'LOCATION'] } },
  { table: 'INSPECTION', types: { _: 'inspection' }, fields: {
    id: ['INSPECTIONID'], summary: ['INSPTEMPLATENAME', 'DESCRIPTION'], status: ['STATUS'], department: ['DOMAIN', 'DEPARTMENT'],
    opened: ['INSPDATE', 'DATETIMEINIT'], closed: ['DATETIMECLOSED'], address: ['INSPADDRESS', 'LOCATION'] } },
  { table: 'CA_OBJECT', types: { PERMIT: 'permit', LICENSE: 'license' }, fields: {
    id: ['CA_OBJECT_ID'], number: ['CASE_NUMBER'], category: ['CASE_CATEGORY', 'CASE_TYPE'], summary: ['CASE_NAME', 'DESCRIPTION'],
    status: ['CASE_STATUS', 'STATUS'], department: ['DEPARTMENT'], opened: ['DATE_ENTERED'], closed: ['CLOSED_DATE'], address: ['LOCATION'] } },
];
const OPTIONAL_FIELDS = new Set(['summary', 'closed', 'address', 'number']);
const LINK_SOURCES = [
  { table: 'WORKORDERENTITY', parent: 'WORKORDER', fields: { parent: ['WORKORDERID'], layer: ['ENTITYTYPE'], feature: ['ENTITYUID', 'OBJECTID'] } },
  { table: 'REQUESTENTITY', parent: 'REQUEST', fields: { parent: ['REQUESTID'], layer: ['ENTITYTYPE'], feature: ['ENTITYUID', 'OBJECTID'] } },
  { table: 'INSPECTIONENTITY', parent: 'INSPECTION', fields: { parent: ['INSPECTIONID'], layer: ['ENTITYTYPE'], feature: ['ENTITYUID', 'OBJECTID'] } },
  { table: 'CA_OBJECT_ENTITY', parent: 'CA_OBJECT', fields: { parent: ['CA_OBJECT_ID'], layer: ['ENTITYTYPE'], feature: ['ENTITYUID', 'OBJECTID'] } },
];
const ATTACHMENT_SOURCE = { table: 'ATTACHMENT', fields: {
  id: ['ATTACHMENTID'], parentType: ['PARENTTYPE'], parent: ['PARENTID'], name: ['FILENAME'], path: ['FILEPATH'], size: ['FILESIZE'] } };
// Kept with each permit and license when the export has them.
const DETAIL_SOURCES = [
  { table: 'CA_FEE', key: 'fees', fields: { parent: ['CA_OBJECT_ID'] } },
  { table: 'CA_PEOPLE', key: 'people', fields: { parent: ['CA_OBJECT_ID'] } },
];
export const RECORD_TYPES = ['permit', 'license', 'service_request', 'inspection', 'work_order'];
const CLOSED = new Set(['CLOSED', 'COMPLETE', 'COMPLETED', 'CANCELED', 'CANCELLED', 'VOID', 'FINALED', 'EXPIRED', 'DENIED', 'WITHDRAWN']);

export const MIGRATION_LIMITS = {
  maxFileBytes: 2 * 1024 ** 3,
  maxTotalBytes: Infinity, // a storage quota for attachments, if the City sets one
  freeSpaceMargin: 0.9,    // never fill the disk past 90% of what is free
  copyConcurrency: 16,
};

const sha256 = text => createHash('sha256').update(text).digest('hex');

async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function inPool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const isClosed = status => CLOSED.has(String(status ?? '').trim().toUpperCase());

// ── Phase 1: read and check the export ─────────────────────────────────────

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MigrationRefused('export_incomplete', `The export has no readable ${what} (${path.basename(file)}): ${err.message}`);
  }
}

// Maps each logical field to the column this export uses, or names what is missing.
function resolveColumns(source, columnsOf, problems) {
  const present = columnsOf(source.table);
  if (!present) return null;
  const map = {};
  for (const [field, names] of Object.entries(source.fields)) {
    const found = names.find(n => present.has(n));
    if (found) map[field] = found;
    else if (!OPTIONAL_FIELDS.has(field)) problems.push(`${source.table} has no column for ${field} (looked for ${names.join(' or ')})`);
  }
  return map;
}

function preflight(src, exportDir) {
  const manifest = readJson(path.join(exportDir, 'manifest.json'), 'manifest');
  const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const columnsOf = table => (tables.has(table) ? new Set(src.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)) : null);

  const required = [...RECORD_SOURCES, ...LINK_SOURCES, ATTACHMENT_SOURCE].map(s => s.table);
  const missing = required.filter(t => !tables.has(t));
  if (missing.length) {
    throw new MigrationRefused('export_incomplete', `The export is missing ${missing.length} required table(s): ${missing.join(', ')}. Nothing was migrated.`,
      missing.map(t => `${t} is missing`));
  }
  const short = Object.entries(manifest.tables ?? {})
    .filter(([t]) => tables.has(t))
    .map(([t, expected]) => [t, expected, src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])
    .filter(([, expected, actual]) => expected !== actual);
  const unlisted = required.filter(t => !(t in (manifest.tables ?? {})));
  if (short.length || unlisted.length) {
    const problems = [...short.map(([t, e, a]) => `${t}: the manifest says ${e} rows, the export has ${a}`), ...unlisted.map(t => `${t} is not in the manifest`)];
    throw new MigrationRefused('export_incomplete', `The export does not match its manifest, so it may be incomplete: ${problems.join('; ')}. Nothing was migrated.`, problems);
  }

  const drift = [];
  const columns = {};
  for (const s of [...RECORD_SOURCES, ...LINK_SOURCES, ATTACHMENT_SOURCE, ...DETAIL_SOURCES]) columns[s.table] = resolveColumns(s, columnsOf, drift);
  if (drift.length) {
    throw new MigrationRefused('schema_drift', `The export's schema differs from what this migration knows (Cityworks ${manifest.cityworks_version ?? 'version unknown'}): ${drift.join('; ')}. Nothing was migrated.`, drift);
  }

  const gis = readJson(path.join(exportDir, 'gis-features.json'), 'GIS feature snapshot');
  if (!gis.layers || typeof gis.layers !== 'object') throw new MigrationRefused('export_incomplete', 'gis-features.json has no layers.');
  const inventory = new Map(Object.entries(gis.layers).map(([layer, ids]) => [layer, new Set(ids.map(String))]));
  return { manifest, columns, inventory, tables };
}

function readResolutions(file) {
  if (!file) return {};
  const raw = readJson(file, 'resolutions file');
  const problems = [];
  for (const [key, r] of Object.entries(raw)) {
    const ok = r && typeof r === 'object' && ((typeof r.layer === 'string' && r.feature_id !== undefined) || (r.no_feature === true && typeof r.reason === 'string' && r.reason.trim()));
    if (!ok) problems.push(`${key}: give {"layer", "feature_id"} or {"no_feature": true, "reason"}`);
  }
  if (problems.length) throw new MigrationRefused('bad_resolutions', `The resolutions file is not valid: ${problems.slice(0, 5).join('; ')}.`, problems);
  return raw;
}

// Every stored GIS link, and those that are orphaned: their record is gone, or GIS
// has no such feature. Read straight from the database, independent of the run.
export function checkGisLinks(db, inventory) {
  const links = db.prepare('SELECT l.*, r.id AS rid FROM legacy_gis_link l LEFT JOIN legacy_record r ON r.id = l.record_id').all();
  return { links, orphaned: links.filter(l => !l.rid || !inventory.get(l.layer)?.has(l.feature_id)) };
}

// ── The run ────────────────────────────────────────────────────────────────

export async function runMigration({
  db, audit, exportDir, attachmentsDir, actor, resolutionsFile = null,
  limits = MIGRATION_LIMITS, now = () => new Date(), freeBytes = dir => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; },
}) {
  const runId = randomUUID();
  const startedAt = now().toISOString();
  const refused = err => {
    audit.record({ actor, action: 'migration.refused', entityType: 'migration', entityId: runId, after: { kind: err.kind, message: err.message, problems: err.problems, exportDir } });
    return err;
  };

  let src;
  try {
    src = new DatabaseSync(path.join(exportDir, 'cityworks.db'), { readOnly: true });
  } catch (err) {
    throw refused(new MigrationRefused('export_incomplete', `The export has no readable cityworks.db: ${err.message}`));
  }
  try {
    return await migrate();
  } catch (err) {
    // A refusal is already on the record; anything else that stops a run is too.
    if (!(err instanceof MigrationRefused)) {
      audit.record({ actor, action: 'migration.failed', entityType: 'migration', entityId: runId, after: { message: err.message, exportDir } });
    }
    throw err;
  } finally {
    src.close();
  }

  async function migrate() {
    let checked;
    let resolutions;
    try {
      checked = preflight(src, exportDir);
      resolutions = readResolutions(resolutionsFile);
    } catch (err) {
      if (err instanceof MigrationRefused) throw refused(err);
      throw err;
    }
    const { manifest, columns, inventory, tables } = checked;
    const pick = (row, map, field) => (map[field] === undefined ? null : row[map[field]] ?? null);
    const text = v => (v === null || v === undefined ? null : String(v).trim() || null);

    // Records, in memory first so links and attachments can find their parent.
    const records = new Map();
    const parentType = new Map(); // `${table}:${sourceId}` -> record id
    const unmapped = [];
    const sourceCounts = Object.fromEntries(RECORD_TYPES.map(t => [t, 0]));
    for (const s of RECORD_SOURCES) {
      const map = columns[s.table];
      for (const row of src.prepare(`SELECT * FROM ${s.table}`).all()) {
        const sourceId = text(pick(row, map, 'id'));
        const category = map.category ? String(pick(row, map, 'category') ?? '').trim().toUpperCase() : '_';
        const type = s.types[category];
        if (!type || !sourceId) { unmapped.push({ table: s.table, sourceId, category }); continue; }
        sourceCounts[type]++;
        const id = `${type}:${sourceId}`;
        records.set(id, {
          id, type, table: s.table, sourceId,
          number: text(pick(row, map, 'number')) ?? sourceId,
          status: text(pick(row, map, 'status')), department: text(pick(row, map, 'department')),
          opened: text(pick(row, map, 'opened')), closed: text(pick(row, map, 'closed')),
          address: text(pick(row, map, 'address')), summary: text(pick(row, map, 'summary')),
          data: { source: row },
        });
        parentType.set(`${s.table}:${sourceId}`, id);
      }
    }
    const details = {};
    for (const d of DETAIL_SOURCES) {
      details[d.key] = 0;
      if (!tables.has(d.table) || !columns[d.table]) continue;
      for (const row of src.prepare(`SELECT * FROM ${d.table}`).all()) {
        const record = records.get(parentType.get(`CA_OBJECT:${text(pick(row, columns[d.table], 'parent'))}`));
        if (!record) continue;
        (record.data[d.key] ??= []).push(row);
        details[d.key]++;
      }
    }

    // GIS relationships: linked, or listed for a person.
    const links = new Map();
    const issues = [];
    let sourceLinks = 0;
    let duplicates = 0;
    let acceptedNoFeature = 0;
    let fromResolutions = 0;
    const issue = (key, recordId, layer, feature, problem, detail) => issues.push({ key, recordId, layer, feature, problem, detail });
    for (const s of LINK_SOURCES) {
      const map = columns[s.table];
      for (const row of src.prepare(`SELECT * FROM ${s.table}`).all()) {
        sourceLinks++;
        const parentId = text(pick(row, map, 'parent'));
        const recordId = parentType.get(`${s.parent}:${parentId}`);
        let layer = text(pick(row, map, 'layer')) ?? '';
        let feature = text(pick(row, map, 'feature')) ?? '';
        const key = `${recordId ?? `${s.parent}:${parentId}`}|${layer}|${feature}`;
        const fix = resolutions[key];
        // A person may accept that a relationship has nothing to link, whatever its problem.
        if (fix?.no_feature) { acceptedNoFeature++; continue; }
        if (!recordId) { issue(key, `${s.parent}:${parentId}`, layer, feature, 'unknown_record', `${s.table} points at ${s.parent} ${parentId}, which is not in the export.`); continue; }

        let resolvedBy = 'source';
        if (fix) { layer = fix.layer; feature = String(fix.feature_id); resolvedBy = 'resolution'; }

        if (!feature) { issue(key, recordId, layer, feature, 'missing', 'The relationship has no feature id.'); continue; }
        if (!layer) {
          const candidates = [...inventory].filter(([, ids]) => ids.has(feature)).map(([l]) => l);
          if (candidates.length === 1) layer = candidates[0];
          else if (candidates.length > 1) { issue(key, recordId, layer, feature, 'ambiguous', `No layer is given, and feature ${feature} is in ${candidates.join(' and ')}.`); continue; }
          else { issue(key, recordId, layer, feature, 'missing', `No layer is given, and no layer has feature ${feature}.`); continue; }
        }
        if (!inventory.has(layer)) { issue(key, recordId, layer, feature, 'unknown_layer', `GIS has no layer ${layer}.`); continue; }
        if (!inventory.get(layer).has(feature)) { issue(key, recordId, layer, feature, 'missing', `GIS layer ${layer} has no feature ${feature}.`); continue; }
        if (fix) fromResolutions++;
        const linkId = `${recordId}|${layer}|${feature}`;
        if (links.has(linkId)) { duplicates++; continue; }
        links.set(linkId, { id: linkId, recordId, layer, feature, resolvedBy });
      }
    }

    // ── Phase 1, continued: will the attachments fit? ──────────────────────
    const attachRoot = path.resolve(exportDir, 'attachments');
    const amap = columns[ATTACHMENT_SOURCE.table];
    const attachmentRows = src.prepare(`SELECT * FROM ${ATTACHMENT_SOURCE.table}`).all().map(row => ({
      id: text(pick(row, amap, 'id')), parentType: text(pick(row, amap, 'parentType')), parent: text(pick(row, amap, 'parent')),
      name: text(pick(row, amap, 'name')) ?? 'attachment', rel: text(pick(row, amap, 'path')) ?? '', size: Number(pick(row, amap, 'size')),
    }));
    const attachmentIssues = [];
    const candidates = [];
    const already = db.prepare('SELECT size, sha256, stored_path FROM legacy_attachment WHERE id = ?');
    for (const a of attachmentRows) {
      const recordId = parentType.get(`${a.parentType}:${a.parent}`);
      const full = path.resolve(exportDir, a.rel);
      if (!recordId) { attachmentIssues.push({ id: a.id, problem: 'unknown_record', detail: `Its record ${a.parentType} ${a.parent} is not in the export.` }); continue; }
      if (!full.startsWith(attachRoot + path.sep)) { attachmentIssues.push({ id: a.id, problem: 'unsafe_path', detail: `${a.rel} is outside the export's attachments folder.` }); continue; }
      let stat;
      try { stat = fs.statSync(full); } catch { attachmentIssues.push({ id: a.id, problem: 'missing_file', detail: `${a.rel} is not in the export.` }); continue; }
      if (Number.isFinite(a.size) && stat.size !== a.size) { attachmentIssues.push({ id: a.id, problem: 'size_mismatch', detail: `${a.rel} is ${stat.size} bytes; Cityworks recorded ${a.size}.` }); continue; }
      candidates.push({ ...a, recordId, full, size: stat.size });
    }
    const tooBig = candidates.filter(a => a.size > limits.maxFileBytes);
    const toCopy = candidates.filter(a => { const prior = already.get(`att:${a.id}`); return !(prior && prior.size === a.size && fs.existsSync(prior.stored_path)); });
    const needed = toCopy.reduce((sum, a) => sum + a.size, 0);
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const free = freeBytes(attachmentsDir);
    const volume = [];
    if (tooBig.length) volume.push(`${tooBig.length} file(s) are larger than the ${limits.maxFileBytes}-byte limit, e.g. ${tooBig[0].rel}`);
    if (needed > limits.maxTotalBytes) volume.push(`the attachments need ${needed} bytes, more than the ${limits.maxTotalBytes}-byte storage quota`);
    if (needed > free * limits.freeSpaceMargin) volume.push(`the attachments need ${needed} bytes, and only ${Math.floor(free * limits.freeSpaceMargin)} can be used on the target disk`);
    if (volume.length) {
      throw refused(new MigrationRefused('attachment_volume', `The attachments exceed the storage limits: ${volume.join('; ')}. Nothing was migrated; free space or raise the quota, then run again.`, volume));
    }

    // ── Phase 2: files ─────────────────────────────────────────────────────
    const stored = new Map();
    await inPool(candidates, limits.copyConcurrency, async a => {
      const prior = already.get(`att:${a.id}`);
      const hash = await hashFile(a.full);
      if (prior && prior.sha256 === hash && fs.existsSync(prior.stored_path)) { stored.set(a.id, { ...a, sha: hash, storedPath: prior.stored_path }); return; }
      const dest = path.join(attachmentsDir, hash.slice(0, 2), hash);
      if (!fs.existsSync(dest)) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const temp = `${dest}.${randomUUID()}.part`;
        await fsp.copyFile(a.full, temp);
        if (await hashFile(temp) !== hash) { await fsp.rm(temp, { force: true }); throw new Error(`The copy of ${a.rel} did not match the original.`); }
        await fsp.rename(temp, dest).catch(async err => { await fsp.rm(temp, { force: true }); if (!fs.existsSync(dest)) throw err; });
      }
      stored.set(a.id, { ...a, sha: hash, storedPath: dest });
    });

    // ── Phase 3: records, in one transaction ───────────────────────────────
    const at = now().toISOString();
    const setWritable = db.prepare("INSERT INTO sync_state (key, value) VALUES ('legacy_writable', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    const upsertRecord = db.prepare(`
      INSERT INTO legacy_record (id, record_type, source_table, source_id, case_number, status, department, opened_at, closed_at, address, summary, data, run_id, migrated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record_type = excluded.record_type, case_number = excluded.case_number, status = excluded.status,
        department = excluded.department, opened_at = excluded.opened_at, closed_at = excluded.closed_at, address = excluded.address,
        summary = excluded.summary, data = excluded.data, run_id = excluded.run_id, migrated_at = excluded.migrated_at
    `);
    const insertLink = db.prepare('INSERT INTO legacy_gis_link (id, record_id, layer, feature_id, resolved_by) VALUES (?, ?, ?, ?, ?)');
    const insertIssue = db.prepare('INSERT INTO legacy_gis_issue (link_key, record_id, layer, feature_ref, problem, detail) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (link_key) DO NOTHING');
    const upsertAttachment = db.prepare(`
      INSERT INTO legacy_attachment (id, record_id, file_name, size, sha256, stored_path) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record_id = excluded.record_id, file_name = excluded.file_name, size = excluded.size, sha256 = excluded.sha256, stored_path = excluded.stored_path
    `);
    transaction(db, () => {
      setWritable.run('1');
      for (const r of records.values()) {
        upsertRecord.run(r.id, r.type, r.table, r.sourceId, r.number, r.status, r.department, r.opened, r.closed, r.address, r.summary, JSON.stringify(r.data), runId, at);
      }
      db.exec('DELETE FROM legacy_gis_link; DELETE FROM legacy_gis_issue;');
      for (const l of links.values()) insertLink.run(l.id, l.recordId, l.layer, l.feature, l.resolvedBy);
      for (const i of issues) insertIssue.run(i.key, i.recordId, i.layer, i.feature, i.problem, i.detail);
      for (const a of stored.values()) upsertAttachment.run(`att:${a.id}`, a.recordId, a.name, a.size, a.sha, a.storedPath);
      setWritable.run('0');
    });

    // ── Phase 4: reconcile, from what is now in the database ───────────────
    const targetCounts = Object.fromEntries(RECORD_TYPES.map(t => [t, db.prepare('SELECT COUNT(*) AS n FROM legacy_record WHERE record_type = ?').get(t).n]));
    const typeRows = RECORD_TYPES.map(t => ({ type: t, source: sourceCounts[t], target: targetCounts[t], match: sourceCounts[t] === targetCounts[t] }));

    const { links: targetLinks, orphaned } = checkGisLinks(db, inventory);
    const unresolved = db.prepare('SELECT problem, COUNT(*) AS n FROM legacy_gis_issue GROUP BY problem').all();
    const unresolvedTotal = unresolved.reduce((s, r) => s + r.n, 0);
    const gis = {
      sourceRelationships: sourceLinks, linked: targetLinks.length, duplicates, acceptedWithoutFeature: acceptedNoFeature, fromResolutions,
      unresolved: unresolvedTotal, unresolvedByProblem: Object.fromEntries(unresolved.map(r => [r.problem, r.n])),
      orphaned: orphaned.length,
      accountedFor: targetLinks.length + duplicates + acceptedNoFeature + unresolvedTotal === sourceLinks,
    };

    const storedRows = db.prepare('SELECT a.*, r.id AS rid FROM legacy_attachment a LEFT JOIN legacy_record r ON r.id = a.record_id').all();
    const exportIds = new Set(attachmentRows.map(a => `att:${a.id}`));
    let verified = 0;
    const damaged = [];
    await inPool(storedRows.filter(r => exportIds.has(r.id)), limits.copyConcurrency, async r => {
      try {
        if (r.rid && fs.statSync(r.stored_path).size === r.size && await hashFile(r.stored_path) === r.sha256) verified++;
        else damaged.push(r.id);
      } catch { damaged.push(r.id); }
    });
    const attachments = {
      source: attachmentRows.length, manifest: manifest.attachments?.files ?? null,
      stored: storedRows.filter(r => exportIds.has(r.id)).length, verified, damaged: damaged.length,
      notMigrated: attachmentIssues.length, byProblem: attachmentIssues.reduce((m, i) => ({ ...m, [i.problem]: (m[i.problem] ?? 0) + 1 }), {}),
      issues: attachmentIssues.slice(0, 100), bytesCopied: needed,
    };
    attachments.match = attachments.source === attachments.stored && attachments.stored === attachments.verified && attachments.damaged === 0
      && (attachments.manifest === null || attachments.manifest === attachments.source);

    const cutover = {};
    for (const r of db.prepare('SELECT id, record_type, case_number, status, department FROM legacy_record ORDER BY department, record_type, case_number').all()) {
      if (isClosed(r.status)) continue;
      const dept = r.department ?? 'No department';
      cutover[dept] ??= { open: 0, byType: {}, items: [] };
      cutover[dept].open++;
      cutover[dept].byType[r.record_type] = (cutover[dept].byType[r.record_type] ?? 0) + 1;
      if (cutover[dept].items.length < 50) cutover[dept].items.push({ id: r.id, number: r.case_number, status: r.status });
    }

    const failures = [
      ...typeRows.filter(r => !r.match).map(r => `${r.type}: ${r.source} in the export, ${r.target} migrated`),
      ...(unmapped.length ? [`${unmapped.length} record(s) of an unknown kind were not migrated (e.g. ${unmapped[0].table} ${unmapped[0].sourceId}, category ${unmapped[0].category || 'blank'})`] : []),
      ...(attachments.match ? [] : [`attachments: ${attachments.source} in the export, ${attachments.stored} stored, ${attachments.verified} verified${attachments.notMigrated ? `, ${attachments.notMigrated} not migrated` : ''}`]),
      ...(gis.orphaned ? [`${gis.orphaned} orphaned GIS relationship(s)`] : []),
      ...(gis.unresolved ? [`${gis.unresolved} GIS relationship(s) still need resolving`] : []),
      ...(gis.accountedFor ? [] : ['GIS relationships do not add up']),
    ];
    const verdict = failures.length ? 'not_trusted' : 'trusted';
    const report = {
      runId, actor, startedAt, finishedAt: now().toISOString(), exportDir,
      source: { cityworksVersion: manifest.cityworks_version ?? null, exportedAt: manifest.exported_at ?? null, simulated: manifest.simulated === true },
      verdict, failures,
      records: typeRows, unmapped: unmapped.slice(0, 100), details,
      gis, gisIssues: db.prepare('SELECT * FROM legacy_gis_issue ORDER BY problem, link_key LIMIT 200').all(),
      attachments, cutover,
      notMigrated: ['Cityworks workflow definitions and task history (beyond what each record row carries)'],
    };

    transaction(db, () => {
      db.prepare('INSERT INTO migration_run (id, actor, started_at, finished_at, verdict, report) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, actor, startedAt, report.finishedAt, verdict, JSON.stringify(report));
      audit.record({ actor, action: 'migration.completed', entityType: 'migration', entityId: runId, after: {
        verdict, failures, records: Object.fromEntries(typeRows.map(r => [r.type, r.target])), attachments: attachments.stored,
        gisLinked: gis.linked, gisUnresolved: gis.unresolved, gisOrphaned: gis.orphaned, exportDir,
      } });
    });
    return report;
  }
}

// A report a person can read, in Markdown.
export function reportMarkdown(r) {
  const lines = [
    `# Cityworks migration ${r.runId}`,
    '',
    `**Verdict: ${r.verdict === 'trusted' ? 'TRUSTED' : 'NOT TRUSTED'}**${r.source.simulated ? ' (SIMULATED export)' : ''}`,
    '',
    `Run by ${r.actor}, ${r.startedAt} to ${r.finishedAt}. Cityworks ${r.source.cityworksVersion ?? 'version unknown'}, exported ${r.source.exportedAt ?? 'at an unknown time'}.`,
    '',
    ...(r.failures.length ? ['## Why it is not trusted', '', ...r.failures.map(f => `- ${f}`), ''] : []),
    '## Records', '', '| Type | In export | Migrated | Match |', '|---|---:|---:|---|',
    ...r.records.map(x => `| ${x.type} | ${x.source} | ${x.target} | ${x.match ? 'yes' : '**no**'} |`),
    '', `Fees kept: ${r.details.fees ?? 0}. People kept: ${r.details.people ?? 0}.`,
    '', '## GIS relationships', '',
    `- In the export: ${r.gis.sourceRelationships}`,
    `- Linked: ${r.gis.linked} (${r.gis.fromResolutions} by resolution)`,
    `- Duplicates folded together: ${r.gis.duplicates}`,
    `- Accepted as having no feature: ${r.gis.acceptedWithoutFeature}`,
    `- Still to resolve: ${r.gis.unresolved}${r.gis.unresolved ? ` (${Object.entries(r.gis.unresolvedByProblem).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
    `- Orphaned: ${r.gis.orphaned}`,
    ...(r.gisIssues.length ? ['', '| Relationship key | Problem | Detail |', '|---|---|---|', ...r.gisIssues.slice(0, 50).map(i => `| \`${i.link_key}\` | ${i.problem} | ${i.detail} |`)] : []),
    '', '## Attachments', '',
    `- In the export: ${r.attachments.source}${r.attachments.manifest !== null ? ` (manifest: ${r.attachments.manifest})` : ''}`,
    `- Stored: ${r.attachments.stored}, verified by hash: ${r.attachments.verified}, damaged: ${r.attachments.damaged}`,
    `- Not migrated: ${r.attachments.notMigrated}${r.attachments.notMigrated ? ` (${Object.entries(r.attachments.byProblem).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
    `- Bytes copied this run: ${r.attachments.bytesCopied}`,
    '', '## Cutover: open Cityworks items by department', '',
    'Each department closes these out in Cityworks before cutover (see docs/CUTOVER.md).', '',
    '| Department | Open | By type |', '|---|---:|---|',
    ...Object.entries(r.cutover).map(([d, c]) => `| ${d} | ${c.open} | ${Object.entries(c.byType).map(([t, n]) => `${t} ${n}`).join(', ')} |`),
    '', '## Not migrated', '', ...r.notMigrated.map(n => `- ${n}`), '',
  ];
  return lines.join('\n');
}
