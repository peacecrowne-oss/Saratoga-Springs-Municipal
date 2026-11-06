// Historical Cityworks records, for look-up and analysis (STORY-013). Read-only:
// nothing here writes a record, and the database refuses changes anyway (see the
// legacy_* triggers in db.js). Every answer says readOnly: true.

import fs from 'node:fs';
import { RECORD_TYPES } from './migration.js';

const MAX_PAGE = 200;

export class LegacyQueryError extends Error {
  constructor(problems) {
    super(`The request is not valid: ${problems.map(p => `${p.field} ${p.problem}`).join('; ')}.`);
    this.name = 'LegacyQueryError';
    this.problems = problems;
  }
}

const summaryOf = row => ({
  id: row.id,
  recordType: row.record_type,
  caseNumber: row.case_number,
  status: row.status,
  department: row.department,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  address: row.address,
  summary: row.summary,
  migratedAt: row.migrated_at,
  readOnly: true,
});

export function createLegacy(db) {
  const byId = db.prepare('SELECT * FROM legacy_record WHERE id = ?');
  const linksOf = db.prepare('SELECT layer, feature_id, resolved_by FROM legacy_gis_link WHERE record_id = ? ORDER BY layer, feature_id');
  const issuesOf = db.prepare('SELECT layer, feature_ref, problem, detail FROM legacy_gis_issue WHERE record_id = ?');
  const attachmentsOf = db.prepare('SELECT id, file_name, size, sha256 FROM legacy_attachment WHERE record_id = ? ORDER BY file_name');
  const attachment = db.prepare('SELECT * FROM legacy_attachment WHERE id = ? AND record_id = ?');
  const latestRun = db.prepare('SELECT * FROM migration_run ORDER BY finished_at DESC, rowid DESC LIMIT 1');

  return {
    search({ type, q, department, open, limit = 50, offset = 0 } = {}) {
      const problems = [];
      if (type && !RECORD_TYPES.includes(type)) problems.push({ field: 'type', problem: `must be one of ${RECORD_TYPES.join(', ')}` });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) problems.push({ field: 'limit', problem: `must be a whole number from 1 to ${MAX_PAGE}` });
      if (!Number.isInteger(offset) || offset < 0) problems.push({ field: 'offset', problem: 'must be a whole number, 0 or more' });
      if (problems.length) throw new LegacyQueryError(problems);
      const where = [];
      const params = [];
      if (type) { where.push('record_type = ?'); params.push(type); }
      if (department) { where.push('department = ? COLLATE NOCASE'); params.push(department); }
      if (open) where.push("closed_at IS NULL AND UPPER(COALESCE(status, '')) NOT IN ('CLOSED', 'COMPLETE', 'COMPLETED', 'CANCELED', 'CANCELLED', 'VOID', 'FINALED', 'EXPIRED', 'DENIED', 'WITHDRAWN')");
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push("(case_number LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\')");
        params.push(like, like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM legacy_record ${clause}`).get(...params).n;
      const rows = db.prepare(`SELECT * FROM legacy_record ${clause} ORDER BY opened_at DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { records: rows.map(summaryOf), total, limit, offset, readOnly: true };
    },

    get(id) {
      const row = byId.get(String(id));
      if (!row) return null;
      return {
        ...summaryOf(row),
        sourceTable: row.source_table,
        sourceId: row.source_id,
        data: JSON.parse(row.data),
        gisLinks: linksOf.all(row.id).map(l => ({ layer: l.layer, featureId: l.feature_id, resolvedBy: l.resolved_by })),
        gisIssues: issuesOf.all(row.id).map(i => ({ layer: i.layer, featureRef: i.feature_ref, problem: i.problem, detail: i.detail })),
        attachments: attachmentsOf.all(row.id).map(a => ({ id: a.id, fileName: a.file_name, size: a.size, sha256: a.sha256 })),
      };
    },

    // { file, row } when the stored file is there; { missing: row } when the record
    // says it exists but the file does not; null when there is no such attachment.
    attachment(recordId, attachmentId) {
      const row = attachment.get(String(attachmentId), String(recordId));
      if (!row) return null;
      return fs.existsSync(row.stored_path) ? { file: row.stored_path, row } : { missing: row };
    },

    latestRun() {
      const run = latestRun.get();
      return run ? JSON.parse(run.report) : null;
    },
  };
}
