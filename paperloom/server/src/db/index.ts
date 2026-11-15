/**
 * Database connection and migration runner.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { MIGRATIONS } from "./schema.js";

export type Db = Database.Database;

export interface DbOptions {
  /** Path to the SQLite file, or ":memory:" for an ephemeral database. */
  readonly path: string;
}

/**
 * Open the database and apply any pending migrations.
 *
 * Migrations run inside a transaction each, so a failure leaves the schema at
 * the last good version rather than half-applied.
 */
export function openDatabase(options: DbOptions): Db {
  if (options.path !== ":memory:") {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  migrate(db);
  return db;
}

/**
 * Apply pending migrations. Safe to call repeatedly.
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: string }).id),
  );

  const insert = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id);
    })();
  }
}
