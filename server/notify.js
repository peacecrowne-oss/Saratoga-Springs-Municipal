// Messages to residents (STORY-007): confirmations of an application and of an
// inspection date.
//
// A message is queued inside the transaction of the action it reports, so it
// exists exactly when the action does, and its dedupe_key means a retried action
// queues nothing new. It is then sent outside that transaction, with a timeout on
// each try and a capped number of tries.
//
// Sending is claimed first (pending or failed -> sending), so two senders never
// send the same message. A claim left behind by a crash is taken back after
// STALE_CLAIM_MS. The transport also gets the message id as an idempotency key.
//
// A message that keeps failing is kept with its error, retried by retryDue()
// until MAX_ATTEMPTS, then marked gave_up. The action it reports still stands.
//
// No real email service is connected: simulatedTransport() is the stand-in and
// says so in every result. Recipients and bodies stay in the notification table,
// never in the audit trail.

import { randomUUID } from 'node:crypto';

export const MAX_ATTEMPTS = 9;
const STALE_CLAIM_MS = 10 * 60000;

export class NotificationError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'NotificationError';
    this.kind = kind;
  }
}

// SIMULATED: stands in for the City's mail service. Nothing leaves this machine.
export function simulatedTransport() {
  return {
    name: 'simulated',
    async send() {
      return { simulated: true };
    },
  };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NotificationError('timeout', `The mail service did not answer within ${ms} ms.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const fromRow = row => row && ({
  id: row.id,
  permitId: row.permit_id,
  kind: row.kind,
  recipient: row.recipient,
  subject: row.subject,
  body: row.body,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  transport: row.transport,
  createdAt: row.created_at,
  sentAt: row.sent_at,
});

export function createNotifier(db, audit, {
  transport = simulatedTransport(),
  now = () => new Date(),
  timeoutMs = 5000,
  retries = 2,
  retryDelayMs = 500,
  sleep = defaultSleep,
} = {}) {
  const insert = db.prepare(`
    INSERT INTO notification (id, permit_id, kind, dedupe_key, recipient, subject, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (dedupe_key) DO NOTHING
  `);
  const byKey = db.prepare('SELECT * FROM notification WHERE dedupe_key = ?');
  const byId = db.prepare('SELECT * FROM notification WHERE id = ?');
  const ofPermit = db.prepare('SELECT * FROM notification WHERE permit_id = ? ORDER BY created_at, rowid');
  const claim = db.prepare(`
    UPDATE notification SET status = 'sending', claimed_at = ?
    WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?)) AND attempts < ?
  `);
  const markSent = db.prepare("UPDATE notification SET status = 'sent', attempts = ?, sent_at = ?, transport = ?, last_error = NULL WHERE id = ?");
  const markFailed = db.prepare('UPDATE notification SET status = ?, attempts = ?, last_error = ?, transport = ? WHERE id = ?');
  const due = db.prepare(`
    SELECT id FROM notification
    WHERE (status IN ('pending', 'failed') OR (status = 'sending' AND claimed_at < ?)) AND attempts < ?
    ORDER BY created_at LIMIT 50
  `);

  const event = (action, n, after) => audit.record({
    actor: 'system:notifier', action, entityType: 'permit', entityId: n.permitId,
    after: { notificationId: n.id, kind: n.kind, ...after },
  });

  return {
    // For use inside the caller's transaction. Returns the message, new or not.
    enqueue({ permitId, kind, dedupeKey, recipient, subject, body }) {
      insert.run(randomUUID(), permitId, kind, dedupeKey, recipient, subject, body, now().toISOString());
      return fromRow(byKey.get(dedupeKey));
    },

    // Sends one message unless it is already sent or being sent. Never throws for
    // a delivery failure: the result says what happened.
    async deliver(id) {
      const staleBefore = new Date(now().getTime() - STALE_CLAIM_MS).toISOString();
      if (claim.run(now().toISOString(), id, staleBefore, MAX_ATTEMPTS).changes !== 1) return fromRow(byId.get(id));
      const n = fromRow(byId.get(id));

      let attempts = n.attempts;
      let lastError;
      for (let tryNo = 0; tryNo <= retries && attempts < MAX_ATTEMPTS; tryNo++) {
        attempts++;
        const controller = new AbortController();
        try {
          const result = await withTimeout(
            Promise.resolve(transport.send({ to: n.recipient, subject: n.subject, body: n.body, idempotencyKey: n.id }, { signal: controller.signal })),
            timeoutMs, controller);
          const via = result?.simulated ? `${transport.name} (SIMULATED)` : transport.name;
          markSent.run(attempts, now().toISOString(), via, n.id);
          event('notification.sent', n, { attempts, transport: via });
          return fromRow(byId.get(id));
        } catch (err) {
          lastError = err;
          if (tryNo < retries && attempts < MAX_ATTEMPTS) await sleep(retryDelayMs);
        }
      }

      const status = attempts >= MAX_ATTEMPTS ? 'gave_up' : 'failed';
      const error = `${lastError.kind ?? lastError.name}: ${lastError.message}`;
      markFailed.run(status, attempts, error, transport.name, n.id);
      event(status === 'gave_up' ? 'notification.gave_up' : 'notification.failed', n, { attempts, error });
      console.error(`[notification ${status}] ${n.kind} for permit ${n.permitId}: ${error}`);
      return fromRow(byId.get(id));
    },

    // Retries everything that has not gone out. Run on a timer by deploy.
    async retryDue() {
      const staleBefore = new Date(now().getTime() - STALE_CLAIM_MS).toISOString();
      const results = [];
      for (const { id } of due.all(staleBefore, MAX_ATTEMPTS)) results.push(await this.deliver(id));
      return results;
    },

    forPermit: permitId => ofPermit.all(permitId).map(fromRow),
  };
}
