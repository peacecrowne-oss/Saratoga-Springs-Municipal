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
    last_error    TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

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
  return db;
}
