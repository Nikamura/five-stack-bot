import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "./migrate.js";
import { SCHEMA } from "./schema.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

function sessionCols(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}

describe("migrate", () => {
  it("is a no-op on a fresh schema (new columns only)", () => {
    const db = makeDb();
    db.exec(SCHEMA);
    assert.equal(sessionCols(db).has("start_minutes"), true);
    assert.equal(sessionCols(db).has("start_hour"), false);
    migrate(db);
    migrate(db); // double-call is idempotent
    assert.equal(sessionCols(db).has("start_minutes"), true);
    assert.equal(sessionCols(db).has("start_hour"), false);
  });

  it("migrates a legacy DB with start_hour/end_hour", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE chats (chat_id INTEGER PRIMARY KEY, tz TEXT NOT NULL,
        valid_stacks TEXT NOT NULL DEFAULT '5,3,2', created_at INTEGER NOT NULL);
      INSERT INTO chats VALUES (1, 'Europe/Vilnius', '5,3,2', 0);
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        opener_user_id INTEGER NOT NULL,
        opener_display_name TEXT NOT NULL,
        start_hour INTEGER NOT NULL,
        end_hour INTEGER NOT NULL,
        poll_message_id INTEGER,
        game_on_message_id INTEGER,
        opened_at INTEGER NOT NULL,
        archive_at INTEGER NOT NULL,
        archived_at INTEGER,
        FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
      );
      INSERT INTO sessions (chat_id, opener_user_id, opener_display_name, start_hour, end_hour, opened_at, archive_at)
        VALUES (1, 42, 'Karolis', 18, 23, 0, 0),
               (1, 42, 'Karolis', 22, 24, 0, 0);
    `);
    migrate(db);
    const cols = sessionCols(db);
    assert.equal(cols.has("start_hour"), false);
    assert.equal(cols.has("end_hour"), false);
    assert.equal(cols.has("start_minutes"), true);
    assert.equal(cols.has("end_minutes"), true);
    const rows = db
      .prepare("SELECT id, start_minutes, end_minutes FROM sessions ORDER BY id")
      .all() as { id: number; start_minutes: number; end_minutes: number }[];
    assert.deepEqual(rows.map((r) => [r.start_minutes, r.end_minutes]), [
      [18 * 60, 23 * 60],
      [22 * 60, 24 * 60],
    ]);
  });

  it("resumes a half-migrated DB (both old and new columns present)", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE chats (chat_id INTEGER PRIMARY KEY, tz TEXT NOT NULL,
        valid_stacks TEXT NOT NULL DEFAULT '5,3,2', created_at INTEGER NOT NULL);
      INSERT INTO chats VALUES (1, 'Europe/Vilnius', '5,3,2', 0);
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        opener_user_id INTEGER NOT NULL,
        opener_display_name TEXT NOT NULL,
        start_hour INTEGER NOT NULL,
        end_hour INTEGER NOT NULL,
        start_minutes INTEGER,
        end_minutes INTEGER,
        opened_at INTEGER NOT NULL,
        archive_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      INSERT INTO sessions (chat_id, opener_user_id, opener_display_name, start_hour, end_hour, start_minutes, end_minutes, opened_at, archive_at)
        VALUES (1, 42, 'A', 18, 23, 1080, 1380, 0, 0),
               (1, 42, 'B', 19, 22, NULL, NULL, 0, 0);
    `);
    migrate(db);
    const cols = sessionCols(db);
    assert.equal(cols.has("start_hour"), false);
    assert.equal(cols.has("start_minutes"), true);
    const rows = db
      .prepare("SELECT id, start_minutes, end_minutes FROM sessions ORDER BY id")
      .all() as { id: number; start_minutes: number; end_minutes: number }[];
    assert.deepEqual(rows.map((r) => [r.start_minutes, r.end_minutes]), [
      [18 * 60, 23 * 60], // already-backfilled row preserved as-is
      [19 * 60, 22 * 60], // unbackfilled row populated from start_hour*60
    ]);
  });

  it("rolls back if backfill would leave NULL rows", () => {
    // Simulates a malformed source row where start_hour is NULL — UPDATE
    // can't fill start_minutes, the assertion fires inside the txn, and the
    // table is left in its prior (non-destructive) state.
    const db = makeDb();
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_hour INTEGER,
        end_hour INTEGER,
        opened_at INTEGER NOT NULL DEFAULT 0,
        archive_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions (start_hour, end_hour) VALUES (NULL, 23);
    `);
    assert.throws(() => migrate(db), /NULL minutes after backfill/);
    // Old columns must still exist after the failed transaction.
    const cols = sessionCols(db);
    assert.equal(cols.has("start_hour"), true);
    assert.equal(cols.has("end_hour"), true);
  });
});
