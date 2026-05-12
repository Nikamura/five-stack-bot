import Database from "better-sqlite3";
import { config } from "../config.js";
import { SCHEMA } from "./schema.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA);
migrate();

export { db };

export function nowMs(): number {
  return Date.now();
}

function migrate(): void {
  // Sessions originally stored hour-only start/end. We now store minutes
  // (30-min grid) to allow half-hour starts. Migrate in-place if the old
  // columns still exist.
  const cols = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (names.has("start_hour") && !names.has("start_minutes")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN start_minutes INTEGER;
      ALTER TABLE sessions ADD COLUMN end_minutes INTEGER;
      UPDATE sessions SET start_minutes = start_hour * 60, end_minutes = end_hour * 60;
      ALTER TABLE sessions DROP COLUMN start_hour;
      ALTER TABLE sessions DROP COLUMN end_hour;
    `);
  }
}
