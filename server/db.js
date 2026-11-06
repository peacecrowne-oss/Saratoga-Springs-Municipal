// Opens the system's SQLite database and makes sure its tables exist.
// Uses Node's built-in node:sqlite, so there is nothing to install.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DB_PATH = 'data/app.db';

// audit_event follows model/data-model.json. The two triggers make it
// append-only at the database level: no code path can rewrite history.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_event (
    id          TEXT PRIMARY KEY,
    actor_id    TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    before      TEXT,
    after       TEXT,
    occurred_at TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS audit_event_no_update
  BEFORE UPDATE ON audit_event
  BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS audit_event_no_delete
  BEFORE DELETE ON audit_event
  BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

  -- The first core record (STORY-001). STORY-004 adds the lifecycle on top.
  -- asset_tag is the City's own label, so a repeated create cannot duplicate it.
  CREATE TABLE IF NOT EXISTS asset (
    id         TEXT PRIMARY KEY,
    asset_tag  TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    status     TEXT NOT NULL,
    location   TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- An asset's feature in the ArcGIS layer (STORY-002). Our system owns the
  -- fields in pushed_values; GIS owns attributes and geometry.
  CREATE TABLE IF NOT EXISTS asset_gis (
    asset_id      TEXT PRIMARY KEY REFERENCES asset(id),
    object_id     INTEGER,
    layer         TEXT,
    attributes    TEXT,
    geometry      TEXT,
    gis_edited_at INTEGER,
    gis_edited_by TEXT,
    pushed_values TEXT,
    pushed_at     TEXT,
    synced_at     TEXT,
    status        TEXT NOT NULL,
    mismatch      TEXT,
    last_error    TEXT,
    spatial_problem TEXT,
    verified_at   TEXT
  );

  -- Condition readings (STORY-004). The asset's current condition is its latest
  -- reading by observed_at, and readings are history: they are never rewritten.
  CREATE TABLE IF NOT EXISTS asset_condition (
    id          TEXT PRIMARY KEY,
    asset_id    TEXT NOT NULL REFERENCES asset(id),
    condition   TEXT NOT NULL,
    notes       TEXT,
    observed_at TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (asset_id, observed_at)
  );

  CREATE TRIGGER IF NOT EXISTS asset_condition_no_update
  BEFORE UPDATE ON asset_condition
  BEGIN SELECT RAISE(ABORT, 'asset_condition is append-only'); END;

  CREATE TRIGGER IF NOT EXISTS asset_condition_no_delete
  BEFORE DELETE ON asset_condition
  BEGIN SELECT RAISE(ABORT, 'asset_condition is append-only'); END;

  -- Scheduled maintenance (STORY-004). The unique key makes a repeated
  -- schedule request return the first task rather than create a second.
  CREATE TABLE IF NOT EXISTS maintenance_task (
    id           TEXT PRIMARY KEY,
    asset_id     TEXT NOT NULL REFERENCES asset(id),
    title        TEXT NOT NULL,
    due_on       TEXT NOT NULL,
    notes        TEXT,
    status       TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (asset_id, title, due_on)
  );

  -- Permit applications and their decisions (STORY-006). submission_key makes a
  -- repeated submission return the first permit rather than create a second.
  CREATE TABLE IF NOT EXISTS permit (
    id                TEXT PRIMARY KEY,
    permit_number     TEXT NOT NULL UNIQUE,
    permit_type       TEXT NOT NULL,
    status            TEXT NOT NULL,
    submission_key    TEXT NOT NULL UNIQUE,
    applicant_name    TEXT NOT NULL,
    applicant_contact TEXT NOT NULL,
    property_address  TEXT NOT NULL,
    code_section      TEXT NOT NULL,
    description       TEXT NOT NULL,
    submitted_by      TEXT NOT NULL,
    submitted_at      TEXT NOT NULL,
    decided_by        TEXT,
    decided_at        TEXT,
    decision_reason   TEXT,
    checks            TEXT
  );

  -- The public portal (STORY-007). A resident reaches their application with a
  -- private link; only the hash of its token is stored.
  CREATE TABLE IF NOT EXISTS permit_access (
    token_hash TEXT PRIMARY KEY,
    permit_id  TEXT NOT NULL UNIQUE REFERENCES permit(id),
    created_at TEXT NOT NULL
  );

  -- One inspection per permit; rescheduling moves its date.
  CREATE TABLE IF NOT EXISTS inspection (
    permit_id    TEXT PRIMARY KEY REFERENCES permit(id),
    scheduled_on TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- Messages to residents. dedupe_key makes each one go out once, however many
  -- times the action behind it is retried.
  CREATE TABLE IF NOT EXISTS notification (
    id         TEXT PRIMARY KEY,
    permit_id  TEXT NOT NULL REFERENCES permit(id),
    kind       TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    recipient  TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    transport  TEXT,
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    sent_at    TEXT
  );

  -- Historical Cityworks records (STORY-013). Read-only: the triggers below refuse
  -- every change unless the migration has opened them inside its own transaction.
  CREATE TABLE IF NOT EXISTS legacy_record (
    id           TEXT PRIMARY KEY,
    record_type  TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    case_number  TEXT,
    status       TEXT,
    department   TEXT,
    opened_at    TEXT,
    closed_at    TEXT,
    address      TEXT,
    summary      TEXT,
    data         TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    migrated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS legacy_record_type ON legacy_record (record_type, department);

  CREATE TABLE IF NOT EXISTS legacy_gis_link (
    id          TEXT PRIMARY KEY,
    record_id   TEXT NOT NULL REFERENCES legacy_record(id),
    layer       TEXT NOT NULL,
    feature_id  TEXT NOT NULL,
    resolved_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS legacy_gis_link_record ON legacy_gis_link (record_id);

  -- Source relationships that could not be linked, for a person to resolve.
  CREATE TABLE IF NOT EXISTS legacy_gis_issue (
    link_key    TEXT PRIMARY KEY,
    record_id   TEXT NOT NULL,
    layer       TEXT,
    feature_ref TEXT,
    problem     TEXT NOT NULL,
    detail      TEXT
  );

  CREATE TABLE IF NOT EXISTS legacy_attachment (
    id          TEXT PRIMARY KEY,
    record_id   TEXT NOT NULL REFERENCES legacy_record(id),
    file_name   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    stored_path TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS legacy_attachment_record ON legacy_attachment (record_id);

  CREATE TABLE IF NOT EXISTS migration_run (
    id          TEXT PRIMARY KEY,
    actor       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    report      TEXT NOT NULL
  );

  -- User acceptance results (STORY-011). Never edited: a retest is a new row.
  CREATE TABLE IF NOT EXISTS uat_result (
    id          TEXT PRIMARY KEY,
    result_key  TEXT NOT NULL UNIQUE,
    scenario_id TEXT NOT NULL,
    tester      TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    severity    TEXT NOT NULL,
    notes       TEXT,
    recorded_at TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS uat_result_no_update
  BEFORE UPDATE ON uat_result
  BEGIN SELECT RAISE(ABORT, 'uat_result is append-only'); END;

  CREATE TABLE IF NOT EXISTS test_report (
    id           TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    status       TEXT NOT NULL,
    verdict      TEXT NOT NULL,
    report       TEXT NOT NULL
  );

  -- Sign-in (STORY-012). Only hashes of passwords, challenges and session tokens
  -- are stored. The TOTP secret must be readable to check codes, so it is encrypted.
  CREATE TABLE IF NOT EXISTS auth_user (
    username       TEXT PRIMARY KEY,
    display_name   TEXT,
    role           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    totp_secret    TEXT NOT NULL,
    last_totp_step INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    disabled_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_challenge (
    id_hash    TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    used_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_session (
    id             TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    username       TEXT NOT NULL,
    role           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    ip             TEXT,
    user_agent     TEXT,
    created_at     TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    revoked_at     TEXT,
    revoked_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS audit_event_action_time ON audit_event (action, occurred_at);

  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

// CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added
// after a table first shipped are added here. Safe to run on every open.
const ADDED_COLUMNS = { asset_gis: ['spatial_problem TEXT', 'verified_at TEXT'] };

// Historical records are read-only (STORY-013). Only the migration opens them,
// by setting legacy_writable inside its transaction and clearing it before commit.
export const LEGACY_TABLES = ['legacy_record', 'legacy_gis_link', 'legacy_gis_issue', 'legacy_attachment'];

function readOnlyTriggers() {
  return LEGACY_TABLES.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(op => `
    CREATE TRIGGER IF NOT EXISTS ${table}_read_only_${op.toLowerCase()}
    BEFORE ${op} ON ${table}
    WHEN (SELECT value FROM sync_state WHERE key = 'legacy_writable') IS NOT '1'
    BEGIN SELECT RAISE(ABORT, 'Historical Cityworks records are read-only.'); END;`)).join('\n');
}

function addMissingColumns(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const column of columns) {
      if (!existing.has(column.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
  }
}

// Runs fn inside one transaction: all of its writes land, or none do.
// A failed rollback is attached to the original error, never dropped.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      err.rollbackFailure = rollbackErr;
    }
    throw err;
  }
}

// Pass ':memory:' for a throwaway database (tests use this).
export function openDb(file = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  // The server and the GIS sync job share the file: wait up to 5 s for a lock, never forever.
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(SCHEMA);
  db.exec(readOnlyTriggers());
  addMissingColumns(db);
  return db;
}
