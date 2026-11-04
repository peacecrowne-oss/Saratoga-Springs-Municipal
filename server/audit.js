// The audit trail: who did what to which record, and when (REQ-010).
//
// record() either writes the event or throws AuditWriteError. It never fails
// quietly, so a caller cannot carry on with an action that went unlogged.

import { randomUUID } from 'node:crypto';

export class AuditWriteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}

const toJson = v => (v === null || v === undefined ? null : JSON.stringify(v));
const fromJson = v => (v === null ? null : JSON.parse(v));

export function createAuditLog(db, { now = () => new Date() } = {}) {
  const insert = db.prepare(`
    INSERT INTO audit_event (id, actor_id, action, entity_type, entity_id, before, after, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const select = db.prepare(`
    SELECT * FROM audit_event
    WHERE (:entity_type IS NULL OR entity_type = :entity_type)
      AND (:entity_id IS NULL OR entity_id = :entity_id)
    ORDER BY occurred_at DESC, rowid DESC
    LIMIT :limit
  `);

  const fromRow = row => ({
    id: row.id,
    actor: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: fromJson(row.before),
    after: fromJson(row.after),
    occurredAt: row.occurred_at,
  });

  return {
    // Events by action, across entity types, newest first: every action
    // starting with prefix, or only the actions named in only.
    listActions({ prefix = null, only = null, limit = 100 } = {}) {
      const where = only
        ? `action IN (${only.map(() => '?').join(', ')})`
        : "action LIKE ? ESCAPE '\\'";
      const params = only ?? [`${String(prefix).replace(/[\\%_]/g, '\\$&')}%`];
      return db.prepare(`SELECT * FROM audit_event WHERE ${where} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`)
        .all(...params, limit).map(fromRow);
    },

    record({ actor, action, entityType, entityId = null, before = null, after = null }) {
      if (!actor || !action || !entityType) {
        throw new AuditWriteError('An audit event needs an actor, an action and an entity type.');
      }
      const event = {
        id: randomUUID(),
        actor,
        action,
        entityType,
        entityId: entityId === null ? null : String(entityId),
        before,
        after,
        occurredAt: now().toISOString(),
      };
      try {
        insert.run(event.id, event.actor, event.action, event.entityType, event.entityId,
          toJson(before), toJson(after), event.occurredAt);
      } catch (err) {
        throw new AuditWriteError(`Could not write the audit event: ${err.message}`, { cause: err });
      }
      return event;
    },

    list({ entityType = null, entityId = null, limit = 100 } = {}) {
      return select.all({ entity_type: entityType, entity_id: entityId, limit }).map(fromRow);
    },
  };
}
