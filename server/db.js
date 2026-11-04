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
  addMissingColumns(db);
  return db;
}
