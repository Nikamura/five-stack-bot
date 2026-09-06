import type Database from "better-sqlite3";
import { log } from "../log.js";

/**
 * Apply in-place schema migrations. Idempotent — safe to call on a fresh
 * DB, a fully-migrated DB, or one stuck in the middle of a prior migration
 * that crashed before completing.
 */
export function migrate(db: Database.Database): void {
  migrateSessionsHourToMinutes(db);
  materializeLegacyImplicitNo(db);
}

/**
 * Before explicit Save, one vote meant no on every other slot. Materialize that
 * meaning once, so removing the inference does not change existing answers.
 * New sessions and votes added after this migration keep untouched slots unknown.
 */
function materializeLegacyImplicitNo(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((table) => table.name));
  if (!tables.has("votes") || !tables.has("roster_members")) return;
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)");
    const name = "2026-09-explicit-availability";
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) return;
    db.exec(`
      WITH RECURSIVE session_slots(session_id, slot, end_minutes) AS (
        SELECT id, start_minutes, end_minutes FROM sessions
        UNION ALL
        SELECT session_id, slot + 30, end_minutes FROM session_slots WHERE slot + 30 < end_minutes
      ), engaged AS (
        SELECT v.session_id, v.telegram_user_id, MAX(v.voted_at) AS voted_at
        FROM votes v JOIN sessions s ON s.id = v.session_id
        JOIN roster_members r ON r.chat_id = s.chat_id AND r.telegram_user_id = v.telegram_user_id
        GROUP BY v.session_id, v.telegram_user_id
      )
      INSERT OR IGNORE INTO votes (session_id, telegram_user_id, slot_minutes, value, voted_at)
      SELECT e.session_id, e.telegram_user_id, ss.slot, 'no', e.voted_at
      FROM engaged e JOIN session_slots ss ON ss.session_id = e.session_id
    `);
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
  })();
}

/**
 * 2026-05: sessions.start_hour/end_hour → start_minutes/end_minutes
 * (multiplied by 60 to preserve the existing hour-on-the-grid values).
 * Allows half-hour starts via the shortcut parser.
 *
 * Wrapped in a transaction so the table can't be left half-renamed if the
 * process dies mid-migration. Also handles the "process died with both old
 * and new columns present" recovery path.
 */
function migrateSessionsHourToMinutes(db: Database.Database): void {
  const cols = sessionColumns(db);
  const hasOld = cols.has("start_hour") || cols.has("end_hour");
  const hasNew = cols.has("start_minutes") && cols.has("end_minutes");

  if (!hasOld) return; // already migrated or fresh install

  if (!hasNew) {
    log.info("migrating sessions: start_hour/end_hour → start_minutes/end_minutes");
    db.transaction(() => {
      db.exec("ALTER TABLE sessions ADD COLUMN start_minutes INTEGER");
      db.exec("ALTER TABLE sessions ADD COLUMN end_minutes INTEGER");
      db.exec(
        "UPDATE sessions SET start_minutes = start_hour * 60, end_minutes = end_hour * 60",
      );
      assertNoUnmigratedRows(db);
      db.exec("ALTER TABLE sessions DROP COLUMN start_hour");
      db.exec("ALTER TABLE sessions DROP COLUMN end_hour");
    })();
    log.info("migration complete");
    return;
  }

  // Both old and new columns exist — a previous run was interrupted between
  // adding the new columns and dropping the old. Finish the job: backfill
  // any NULL new columns, then drop the old.
  log.info("resuming partial sessions migration");
  db.transaction(() => {
    db.exec(
      `UPDATE sessions SET start_minutes = start_hour * 60
       WHERE start_minutes IS NULL`,
    );
    db.exec(
      `UPDATE sessions SET end_minutes = end_hour * 60
       WHERE end_minutes IS NULL`,
    );
    assertNoUnmigratedRows(db);
    db.exec("ALTER TABLE sessions DROP COLUMN start_hour");
    db.exec("ALTER TABLE sessions DROP COLUMN end_hour");
  })();
  log.info("migration resume complete");
}

function assertNoUnmigratedRows(db: Database.Database): void {
  const bad = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE start_minutes IS NULL OR end_minutes IS NULL",
    )
    .get() as { n: number };
  if (bad.n > 0) {
    // Throws inside the transaction — better-sqlite3 rolls it back, so the
    // old columns and original data are preserved for a second attempt.
    throw new Error(
      `sessions migration aborted: ${bad.n} row(s) have NULL minutes after backfill`,
    );
  }
}

function sessionColumns(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}
