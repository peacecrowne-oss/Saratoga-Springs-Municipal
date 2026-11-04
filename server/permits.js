// Permits (STORY-006): a code enforcement application is submitted, reviewed, and
// approved or rejected. Only code enforcement exists today; the other types in
// REQ-007 would be added to PERMIT_TYPES.
//
// A decision and its audit event land in one transaction, so a permit never
// changes without the record of who changed it. A decision is final. Sending the
// same decision again writes nothing, and a different one is refused.
//
// Submitting is idempotent on submission_key: the form sends one key per
// application, so a retry returns the first permit instead of creating a second.
// The same key with different details is a conflict.
//
// Compliance rules, enforced here and refused on the record:
//   - nobody decides an application they submitted themselves
//   - every decision states its reason
//   - an approval needs each check in APPROVAL_CHECKS confirmed
//
// Applicants are residents, and the audit trail can never be erased. So names,
// contact details, addresses and descriptions stay in the permit table and out of
// audit events (see docs/SECURITY.md).

import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { text } from './assets.js';

export const PERMIT_TYPES = ['code_enforcement'];
export const PERMIT_STATUSES = ['submitted', 'approved', 'rejected'];
export const DECISIONS = ['approved', 'rejected'];
export const APPROVAL_CHECKS = ['code_section_verified', 'site_inspected'];
const NUMBER_PREFIX = { code_enforcement: 'CE' };
const MAX_PAGE = 200;

export class PermitValidationError extends Error {
  constructor(problems) {
    super(`The request is not valid: ${problems.map(p => `${p.field} ${p.problem}`).join('; ')}.`);
    this.name = 'PermitValidationError';
    this.kind = 'invalid';
    this.problems = problems;
  }
}

// A request that conflicts with what is recorded, or that the rules do not allow.
export class PermitConflict extends Error {
  constructor(kind, message, problems = []) {
    super(message);
    this.name = 'PermitConflict';
    this.kind = kind;
    this.problems = problems;
  }
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

function validateApplication(input) {
  if (!isObject(input)) throw new PermitValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
  const problems = [];
  if (!PERMIT_TYPES.includes(input.permit_type)) problems.push({ field: 'permit_type', problem: `must be one of ${PERMIT_TYPES.join(', ')}` });
  const application = {
    permitType: input.permit_type,
    submissionKey: text(input, 'submission_key', 100, problems),
    applicantName: text(input, 'applicant_name', 200, problems),
    applicantContact: text(input, 'applicant_contact', 200, problems),
    propertyAddress: text(input, 'property_address', 200, problems),
    codeSection: text(input, 'code_section', 64, problems),
    description: text(input, 'description', 2000, problems),
  };
  if (problems.length) throw new PermitValidationError(problems);
  return application;
}

const sameApplication = (a, b) => ['permitType', 'applicantName', 'applicantContact', 'propertyAddress', 'codeSection', 'description'].every(f => a[f] === b[f]);

const fromRow = row => row && ({
  id: row.id,
  permitNumber: row.permit_number,
  permitType: row.permit_type,
  status: row.status,
  applicantName: row.applicant_name,
  applicantContact: row.applicant_contact,
  propertyAddress: row.property_address,
  codeSection: row.code_section,
  description: row.description,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  checks: row.checks === null ? null : JSON.parse(row.checks),
});

// What the audit trail keeps of a permit: nothing that identifies the resident.
const forAudit = p => ({
  permitNumber: p.permitNumber,
  permitType: p.permitType,
  status: p.status,
  codeSection: p.codeSection,
  submittedBy: p.submittedBy,
  submittedAt: p.submittedAt,
  decidedBy: p.decidedBy,
  decidedAt: p.decidedAt,
  decisionReason: p.decisionReason,
  checks: p.checks,
});

// The queue's view. Personal details are only in a single permit, whose reads are logged.
const forQueue = p => ({
  id: p.id,
  permitNumber: p.permitNumber,
  permitType: p.permitType,
  status: p.status,
  codeSection: p.codeSection,
  submittedBy: p.submittedBy,
  submittedAt: p.submittedAt,
  decidedBy: p.decidedBy,
  decidedAt: p.decidedAt,
});

export function createPermits(db, audit, { now = () => new Date() } = {}) {
  const byId = db.prepare('SELECT * FROM permit WHERE id = ?');
  const byKey = db.prepare('SELECT * FROM permit WHERE submission_key = ?');
  const countFor = db.prepare('SELECT COUNT(*) AS n FROM permit WHERE permit_number LIKE ?');
  const insert = db.prepare(`
    INSERT INTO permit (id, permit_number, permit_type, status, submission_key, applicant_name, applicant_contact,
      property_address, code_section, description, submitted_by, submitted_at)
    VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveDecision = db.prepare('UPDATE permit SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, checks = ? WHERE id = ?');

  const refuseSubmission = (actor, err) => audit.record({ actor, action: 'permit.submit_rejected', entityType: 'permit',
    after: { kind: err.kind, message: err.message, problems: err.problems } });

  return {
    submit({ actor, input }) {
      try {
        const application = validateApplication(input);
        return transaction(db, () => {
          const existing = fromRow(byKey.get(application.submissionKey));
          if (existing) {
            if (sameApplication(existing, application)) return { created: false, permit: existing };
            throw new PermitConflict('submission_conflict', `This submission was already recorded as ${existing.permitNumber} with different details.`);
          }
          const at = now();
          const prefix = `${NUMBER_PREFIX[application.permitType]}-${at.getFullYear()}-`;
          const permitNumber = `${prefix}${String(countFor.get(`${prefix}%`).n + 1).padStart(4, '0')}`;
          const id = randomUUID();
          insert.run(id, permitNumber, application.permitType, application.submissionKey, application.applicantName, application.applicantContact,
            application.propertyAddress, application.codeSection, application.description, actor, at.toISOString());
          const permit = fromRow(byId.get(id));
          audit.record({ actor, action: 'permit.submit', entityType: 'permit', entityId: id, after: forAudit(permit) });
          return { created: true, permit };
        });
      } catch (err) {
        if (err instanceof PermitValidationError || err instanceof PermitConflict) refuseSubmission(actor, err);
        throw err;
      }
    },

    // Approves or rejects. Returns null if there is no such permit.
    decide({ actor, id, input }) {
      if (!byId.get(String(id))) return null;
      try {
        if (!isObject(input)) throw new PermitValidationError([{ field: 'body', problem: 'must be a JSON object' }]);
        const problems = [];
        if (!DECISIONS.includes(input.decision)) problems.push({ field: 'decision', problem: `must be one of ${DECISIONS.join(', ')}` });
        const reason = text(input, 'reason', 1000, problems);
        if (problems.length) throw new PermitValidationError(problems);

        return transaction(db, () => {
          const before = fromRow(byId.get(String(id)));
          if (before.status === input.decision) return { decided: false, permit: before };
          if (before.status !== 'submitted') {
            throw new PermitConflict('already_decided', `${before.permitNumber} was already ${before.status} by ${before.decidedBy}, and a decision is final.`);
          }
          if (before.submittedBy === actor) {
            throw new PermitConflict('compliance_block', `${actor} submitted ${before.permitNumber}, so another officer must decide it.`);
          }
          let checks = null;
          if (input.decision === 'approved') {
            const missing = APPROVAL_CHECKS.filter(c => input.checks?.[c] !== true);
            if (missing.length) {
              throw new PermitConflict('compliance_block', `${before.permitNumber} cannot be approved until every compliance check is confirmed.`,
                missing.map(field => ({ field, problem: 'must be confirmed before approval' })));
            }
            checks = Object.fromEntries(APPROVAL_CHECKS.map(c => [c, true]));
          }
          saveDecision.run(input.decision, actor, now().toISOString(), reason, checks && JSON.stringify(checks), before.id);
          const permit = fromRow(byId.get(before.id));
          audit.record({ actor, action: input.decision === 'approved' ? 'permit.approve' : 'permit.reject', entityType: 'permit', entityId: before.id,
            before: forAudit(before), after: forAudit(permit) });
          return { decided: true, permit };
        });
      } catch (err) {
        if (err instanceof PermitValidationError || err instanceof PermitConflict) {
          // Written after any rollback, so it survives it.
          audit.record({ actor, action: 'permit.decision_refused', entityType: 'permit', entityId: String(id),
            after: { kind: err.kind, message: err.message, problems: err.problems } });
        }
        throw err;
      }
    },

    // One permit with its personal details. The read is logged before it is
    // returned: if it cannot be, the details are withheld.
    view({ actor, id }) {
      const permit = fromRow(byId.get(String(id)));
      if (!permit) return null;
      audit.record({ actor, action: 'permit.view', entityType: 'permit', entityId: permit.id, after: { permitNumber: permit.permitNumber } });
      return permit;
    },

    // The review queue, oldest first so nothing waits at the bottom.
    search({ status, q, limit = 100, offset = 0 } = {}) {
      const problems = [];
      if (status && !PERMIT_STATUSES.includes(status)) problems.push({ field: 'status', problem: `must be one of ${PERMIT_STATUSES.join(', ')}` });
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) problems.push({ field: 'limit', problem: `must be a whole number from 1 to ${MAX_PAGE}` });
      if (!Number.isInteger(offset) || offset < 0) problems.push({ field: 'offset', problem: 'must be a whole number, 0 or more' });
      if (problems.length) throw new PermitValidationError(problems);

      const where = [];
      const params = [];
      if (status) { where.push('status = ?'); params.push(status); }
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push("(permit_number LIKE ? ESCAPE '\\' OR code_section LIKE ? ESCAPE '\\')");
        params.push(like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM permit ${clause}`).get(...params).n;
      const rows = db.prepare(`SELECT * FROM permit ${clause} ORDER BY submitted_at, permit_number LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return { permits: rows.map(r => forQueue(fromRow(r))), total, limit, offset };
    },

    exists: id => Boolean(byId.get(String(id))),
  };
}
