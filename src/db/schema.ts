// Schema is inlined so the build doesn't need to copy SQL files.
// Keep in sync with the canonical reference at db/schema.sql (if you keep one).

export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS chats (
  chat_id        INTEGER PRIMARY KEY,
  tz             TEXT    NOT NULL,
  valid_stacks   TEXT    NOT NULL DEFAULT '5,3,2',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roster_members (
  chat_id           INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  username          TEXT,
  display_name      TEXT    NOT NULL,
  added_at          INTEGER NOT NULL,
  PRIMARY KEY (chat_id, telegram_user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  opener_user_id      INTEGER NOT NULL,
  opener_display_name TEXT    NOT NULL,
  start_minutes       INTEGER NOT NULL,
  end_minutes         INTEGER NOT NULL,
  poll_message_id     INTEGER,
  game_on_message_id  INTEGER,
  opened_at           INTEGER NOT NULL,
  archive_at          INTEGER NOT NULL,
  archived_at         INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(chat_id, archived_at);

CREATE TABLE IF NOT EXISTS votes (
  session_id        INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  slot_minutes      INTEGER NOT NULL,
  value             TEXT    NOT NULL CHECK (value IN ('yes','maybe','no')),
  voted_at          INTEGER NOT NULL,
  PRIMARY KEY (session_id, telegram_user_id, slot_minutes),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_votes_session_slot ON votes(session_id, slot_minutes);

CREATE TABLE IF NOT EXISTS session_skips (
  session_id        INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  PRIMARY KEY (session_id, telegram_user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS locks (
  session_id    INTEGER PRIMARY KEY,
  slot_minutes  INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  locked_at     INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lock_party (
  session_id        INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('core','alternate')),
  vote_order        INTEGER NOT NULL,
  PRIMARY KEY (session_id, telegram_user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lock_late (
  session_id        INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  late_minutes      INTEGER NOT NULL,
  set_at            INTEGER NOT NULL,
  PRIMARY KEY (session_id, telegram_user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fire_at     INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_fire_at ON scheduled_jobs(fire_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id           INTEGER NOT NULL,
  telegram_user_id  INTEGER NOT NULL,
  command           TEXT    NOT NULL,
  args              TEXT,
  at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit_log(chat_id, at);
`;
