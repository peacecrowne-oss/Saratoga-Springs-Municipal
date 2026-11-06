// The public portal (STORY-007): a resident submits a code enforcement permit
// application, receives a confirmation, and schedules the site inspection.
//
// Residents have no account. Submitting returns a private link, also sent in the
// confirmation, whose token is the only way back to the application. Only the
// token's hash is stored. The token is derived from the permit id with the server
// key, so a retried submission returns the same link instead of losing it.
//
// Every public interaction is audited with its IP address and browser, including
// refusals and links that match nothing. Personal details stay out of the audit
// trail (see docs/SECURITY.md).
//
// Failure paths:
//   portal access      a link that matches nothing is refused and logged; repeated
//                      misses, or a flood of submissions, from one address are refused
//   submission errors  every wrong field is named; a retry creates no second permit
//   notification       a confirmation that cannot be sent is kept and retried, the
//                      resident is told, and the application stands

import { createHash, createHmac } from 'node:crypto';
import { transaction } from './db.js';
import { PermitConflict, PermitValidationError } from './permits.js';

export const PORTAL_LIMITS = {
  submissionsPerIpPerHour: 10,
  missedLinksPerIp: 20, // in 15 minutes
  inspectionsPerDay: 8,
  inspectionMaxDaysAhead: 60,
};
const PUBLIC = 'public';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PortalError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
    this.kind = kind;
  }
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const localDate = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function isRealDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !isNaN(parsed) && parsed.toISOString().slice(0, 10) === text;
}

export function createPortal(db, audit, permits, notifier, {
  secretKey,
  publicBaseUrl = 'http://127.0.0.1:3000',
  now = () => new Date(),
  limits = PORTAL_LIMITS,
} = {}) {
  if (!secretKey) throw new Error('The portal needs the server key to issue private links.');

  const accessBy = db.prepare('SELECT permit_id FROM permit_access WHERE token_hash = ?');
  const addAccess = db.prepare('INSERT INTO permit_access (token_hash, permit_id, created_at) VALUES (?, ?, ?)');
  const publicByKey = db.prepare("SELECT id FROM permit WHERE submission_key = ? AND submitted_by = 'public'");
  const inspectionOf = db.prepare('SELECT * FROM inspection WHERE permit_id = ?');
  const bookedOn = db.prepare('SELECT COUNT(*) AS n FROM inspection WHERE scheduled_on = ? AND permit_id <> ?');
  const upsertInspection = db.prepare(`
    INSERT INTO inspection (permit_id, scheduled_on, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (permit_id) DO UPDATE SET scheduled_on = excluded.scheduled_on, updated_at = excluded.updated_at
  `);
  const count = db.prepare(`
    SELECT COUNT(*) AS n FROM audit_event
    WHERE action = ? AND actor_id = ? AND occurred_at >= ? AND json_extract(after, '$.ip') = ?
  `);

  const tokenFor = permitId => createHmac('sha256', secretKey).update(`portal-access:${permitId}`).digest('base64url');
  const linkFor = permitId => `${publicBaseUrl}/portal#t=${tokenFor(permitId)}`;
  const seen = ctx => ({ ip: ctx.ip, userAgent: ctx.userAgent });
  const since = ms => new Date(now().getTime() - ms).toISOString();

  const record = (action, ctx, { actor = PUBLIC, entityType = 'portal', entityId = null, before = null, after = {} } = {}) =>
    audit.record({ actor, action, entityType, entityId, before, after: { ...after, ...seen(ctx) } });
  const residentOf = permit => `resident:${permit.permitNumber}`;

  function refuseFlood(ctx, scope, used, limit) {
    if (used < limit) return;
    record('portal.rate_limited', ctx, { after: { scope, used, limit } });
    throw new PortalError(429, 'rate_limited', 'Too many requests from your connection. Please wait a while and try again.');
  }

  // What the resident sees: their own application and the messages sent to them.
  function view(permitId) {
    const p = permits.get(permitId);
    return {
      permitNumber: p.permitNumber,
      status: p.status,
      propertyAddress: p.propertyAddress,
      codeSection: p.codeSection,
      description: p.description,
      submittedAt: p.submittedAt,
      decidedAt: p.decidedAt,
      decisionReason: p.decisionReason,
      inspectionOn: p.inspectionOn,
      notifications: notifier.forPermit(permitId).map(n => ({
        kind: n.kind, subject: n.subject, body: n.body, status: n.status, sentAt: n.sentAt, transport: n.transport,
      })),
    };
  }

  const delivery = n => ({ status: n.status, transport: n.transport, error: n.status === 'sent' ? null : n.lastError });

  // The permit a private link opens, or a refusal that is logged.
  function open(token, ctx) {
    refuseFlood(ctx, 'missed_links', count.get('portal.access_denied', PUBLIC, since(15 * 60000), ctx.ip).n, limits.missedLinksPerIp);
    const found = typeof token === 'string' && token ? accessBy.get(sha256(token)) : undefined;
    if (!found) {
      record('portal.access_denied', ctx, { after: { reason: token ? 'unknown_link' : 'no_link' } });
      throw new PortalError(404, 'unknown_link', 'We could not find an application for that link. Check that you used the whole link from your confirmation.');
    }
    return permits.get(found.permit_id);
  }

  return {
    async submit({ input, ctx }) {
      const retry = typeof input?.submission_key === 'string' && publicByKey.get(input.submission_key);
      if (!retry) {
        refuseFlood(ctx, 'submissions', count.get('permit.submit', PUBLIC, since(60 * 60000), ctx.ip).n, limits.submissionsPerIpPerHour);
      }

      const fields = ['submission_key', 'applicant_name', 'applicant_contact', 'property_address', 'code_section', 'description'];
      const application = { permit_type: 'code_enforcement' };
      if (input && typeof input === 'object' && !Array.isArray(input)) for (const f of fields) application[f] = input[f];
      const extraProblems = i => (typeof i.applicant_contact === 'string' && i.applicant_contact.trim() && !EMAIL.test(i.applicant_contact.trim())
        ? [{ field: 'applicant_contact', problem: 'must be an email address' }] : []);

      const { created, permit } = permits.submit({
        actor: PUBLIC,
        input: input && typeof input === 'object' && !Array.isArray(input) ? application : input,
        context: { via: 'portal', ...seen(ctx) },
        extraProblems,
        onCreated: p => {
          addAccess.run(sha256(tokenFor(p.id)), p.id, now().toISOString());
          notifier.enqueue({
            permitId: p.id, kind: 'application_received', dedupeKey: `application_received:${p.id}`, recipient: p.applicantContact,
            subject: `We received your application ${p.permitNumber}`,
            body: `Dear ${p.applicantName},\n\nThe City has received your code enforcement permit application ${p.permitNumber} for ${p.propertyAddress}. `
              + `An officer will review it. You can check its progress and schedule the site inspection here:\n\n${linkFor(p.id)}\n\nKeep this link private: anyone who has it can see your application.`,
          });
        },
      });
      if (!created && permit.submittedBy !== PUBLIC) {
        record('portal.submit_refused', ctx, { after: { kind: 'submission_conflict' } });
        throw new PermitConflict('submission_conflict', 'This submission could not be accepted. Please reload the page and try again.');
      }

      const confirmation = notifier.forPermit(permit.id).find(n => n.kind === 'application_received');
      const sent = await notifier.deliver(confirmation.id);
      return { created, token: tokenFor(permit.id), link: linkFor(permit.id), confirmation: delivery(sent), application: view(permit.id) };
    },

    lookup({ token, ctx }) {
      const permit = open(token, ctx);
      record('portal.view', ctx, { actor: residentOf(permit), entityType: 'permit', entityId: permit.id, after: { permitNumber: permit.permitNumber } });
      return { application: view(permit.id) };
    },

    async scheduleInspection({ token, input, ctx }) {
      const permit = open(token, ctx);
      const actor = residentOf(permit);
      const date = input?.date;
      let result;
      try {
        if (!isRealDate(date)) throw new PermitValidationError([{ field: 'date', problem: 'must be a real date, YYYY-MM-DD' }]);
        result = transaction(db, () => {
          const current = permits.get(permit.id);
          const before = inspectionOf.get(permit.id);
          if (before?.scheduled_on === date) return { scheduled: false };
          if (current.status !== 'submitted') {
            throw new PermitConflict('permit_decided', `${current.permitNumber} has already been ${current.status}, so its inspection cannot be changed.`);
          }
          const today = localDate(now());
          if (before && before.scheduled_on <= today) {
            throw new PermitConflict('too_late', 'Your inspection is today or has passed, so it can no longer be moved. Please contact the City.');
          }
          const problems = [];
          if (date <= today) problems.push({ field: 'date', problem: 'must be after today' });
          else if (date > addDays(today, limits.inspectionMaxDaysAhead)) problems.push({ field: 'date', problem: `must be within ${limits.inspectionMaxDaysAhead} days` });
          const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
          if (weekday === 0 || weekday === 6) problems.push({ field: 'date', problem: 'must be a weekday' });
          if (problems.length) throw new PermitValidationError(problems);
          if (bookedOn.get(date, permit.id).n >= limits.inspectionsPerDay) {
            throw new PermitConflict('date_full', `Every inspection on ${date} is taken. Please choose another day.`);
          }

          const at = now().toISOString();
          upsertInspection.run(permit.id, date, at, at);
          const event = record(before ? 'portal.inspection_rescheduled' : 'portal.inspection_scheduled', ctx, {
            actor, entityType: 'permit', entityId: permit.id,
            before: before ? { date: before.scheduled_on } : null, after: { permitNumber: current.permitNumber, date },
          });
          const n = notifier.enqueue({
            permitId: permit.id, kind: 'inspection_scheduled', dedupeKey: `inspection_scheduled:${event.id}`, recipient: current.applicantContact,
            subject: `Inspection for ${current.permitNumber} booked for ${date}`,
            body: `Dear ${current.applicantName},\n\nThe site inspection for ${current.permitNumber} at ${current.propertyAddress} is booked for ${date}`
              + `${before ? `, moved from ${before.scheduled_on}` : ''}. You can change it until the day before:\n\n${linkFor(permit.id)}`,
          });
          return { scheduled: true, notificationId: n.id };
        });
      } catch (err) {
        if (err instanceof PermitValidationError || err instanceof PermitConflict) {
          record('portal.inspection_refused', ctx, { actor, entityType: 'permit', entityId: permit.id,
            after: { kind: err.kind, message: err.message, problems: err.problems, requested: typeof date === 'string' ? date.slice(0, 20) : null } });
        }
        throw err;
      }
      const confirmation = result.notificationId ? delivery(await notifier.deliver(result.notificationId)) : null;
      return { scheduled: result.scheduled, confirmation, application: view(permit.id) };
    },
  };
}
