import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createAuditLog, AuditWriteError } from './audit.js';

const fixedNow = () => new Date('2026-11-02T12:00:00.000Z');

test('records an event with its actor, action and timestamp', () => {
  const audit = createAuditLog(openDb(':memory:'), { now: fixedNow });

  const event = audit.record({
    actor: 'user-1', action: 'budget.view', entityType: 'budget_line', entityId: 'GF-2026', after: { amount: 100 },
  });

  assert.equal(event.occurredAt, '2026-11-02T12:00:00.000Z');
  const [stored] = audit.list();
  assert.deepEqual(stored, event);
});

test('lists only the events for the entity asked about', () => {
  const audit = createAuditLog(openDb(':memory:'));
  audit.record({ actor: 'u', action: 'budget.view', entityType: 'budget_line', entityId: 'A' });
  audit.record({ actor: 'u', action: 'budget.view', entityType: 'budget_line', entityId: 'B' });

  const events = audit.list({ entityType: 'budget_line', entityId: 'A' });
  assert.equal(events.length, 1);
  assert.equal(events[0].entityId, 'A');
});

test('refuses to edit an audit event', () => {
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  const { id } = audit.record({ actor: 'u', action: 'budget.view', entityType: 'budget_line' });

  assert.throws(() => db.prepare('UPDATE audit_event SET actor_id = ? WHERE id = ?').run('someone-else', id), /append-only/);
  assert.equal(audit.list()[0].actor, 'u');
});

test('refuses to delete an audit event', () => {
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  audit.record({ actor: 'u', action: 'budget.view', entityType: 'budget_line' });

  assert.throws(() => db.prepare('DELETE FROM audit_event').run(), /append-only/);
  assert.equal(audit.list().length, 1);
});

test('throws when the event cannot be written, rather than failing quietly', () => {
  const db = openDb(':memory:');
  const audit = createAuditLog(db);
  db.close();

  assert.throws(
    () => audit.record({ actor: 'u', action: 'budget.view', entityType: 'budget_line' }),
    AuditWriteError,
  );
});

test('rejects an event with no actor', () => {
  const audit = createAuditLog(openDb(':memory:'));
  assert.throws(() => audit.record({ action: 'budget.view', entityType: 'budget_line' }), AuditWriteError);
});
