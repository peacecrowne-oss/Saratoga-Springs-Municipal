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
`;

// Pass ':memory:' for a throwaway database (tests use this).
export function openDb(file = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
