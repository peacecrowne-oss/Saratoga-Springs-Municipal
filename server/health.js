// Health check: is the database answering, and is the audit trail still
// protected? Used by GET /api/health and by the deploy command.

export function checkHealth(db) {
  const checks = {};

  try {
    db.prepare('SELECT 1 AS ok').get();
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: err.message };
  }

  try {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('audit_event_no_update', 'audit_event_no_delete')"
    ).all();
    checks.audit = triggers.length === 2
      ? { ok: true }
      : { ok: false, detail: 'The audit trail is missing its append-only protection.' };
  } catch (err) {
    checks.audit = { ok: false, detail: err.message };
  }

  const ok = Object.values(checks).every(c => c.ok);
  return { status: ok ? 'ok' : 'unhealthy', checks };
}
