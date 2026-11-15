/**
 * Apply the database migrations.
 *
 * The server applies migrations when it starts, so this is only needed to
 * prepare a database ahead of time, or to check what the schema looks
 * like.
 *
 *     npm run migrate
 */

import { openDatabase } from "./index.js";

const path = process.env.PAPERLOOM_DB ?? "data/paperloom.db";

console.log(`Applying migrations to ${path}`);
const db = openDatabase({ path });

const applied = db
  .prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id")
  .all() as Array<{ id: string; applied_at: string }>;

for (const migration of applied) {
  console.log(`  ${migration.id}  ${migration.applied_at}`);
}

console.log(`The schema is at version ${applied.length}.`);
db.close();
