import { db, nowMs } from "./index.js";
import type {
  ChatRow,
  LockPartyRow,
  LockRow,
  RosterMember,
  ScheduledJob,
  SessionRow,
  VoteRow,
  VoteValue,
} from "./types.js";
import { config } from "../config.js";

// -- Chats --------------------------------------------------------------------

export function getOrCreateChat(chatId: number): ChatRow {
  const existing = db
    .prepare("SELECT * FROM chats WHERE chat_id = ?")
    .get(chatId) as ChatRow | undefined;
  if (existing) return existing;
  db.prepare(
    "INSERT INTO chats (chat_id, tz, valid_stacks, created_at) VALUES (?, ?, ?, ?)",
  ).run(chatId, config.defaultTz, "5,3,2", nowMs());
  return db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as ChatRow;
}

export function setChatTz(chatId: number, tz: string): void {
  db.prepare("UPDATE chats SET tz = ? WHERE chat_id = ?").run(tz, chatId);
}

export function setChatStacks(chatId: number, stacks: number[]): void {
  const csv = [...new Set(stacks)].sort((a, b) => b - a).join(",");
  db.prepare("UPDATE chats SET valid_stacks = ? WHERE chat_id = ?").run(csv, chatId);
}

export function parseStacks(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);
}

// -- Roster -------------------------------------------------------------------

export function getRoster(chatId: number): RosterMember[] {
  return db
    .prepare("SELECT * FROM roster_members WHERE chat_id = ? ORDER BY added_at ASC")
    .all(chatId) as RosterMember[];
}

export function getRosterIds(chatId: number): Set<number> {
  return new Set(
    (
      db
        .prepare("SELECT telegram_user_id FROM roster_members WHERE chat_id = ?")
        .all(chatId) as { telegram_user_id: number }[]
    ).map((r) => r.telegram_user_id),
  );
}

export function addRosterMember(
  chatId: number,
  userId: number,
  username: string | null,
  displayName: string,
): boolean {
  try {
    db.prepare(
      `INSERT INTO roster_members (chat_id, telegram_user_id, username, display_name, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(chatId, userId, username, displayName, nowMs());
    return true;
  } catch {
    // Already in roster — update name.
    db.prepare(
      `UPDATE roster_members SET username = ?, display_name = ?
       WHERE chat_id = ? AND telegram_user_id = ?`,
    ).run(username, displayName, chatId, userId);
    return false;
  }
}

export function removeRosterMember(chatId: number, userId: number): boolean {
  const r = db
    .prepare("DELETE FROM roster_members WHERE chat_id = ? AND telegram_user_id = ?")
    .run(chatId, userId);
  return r.changes > 0;
}

export function findRosterByUsername(chatId: number, username: string): RosterMember | null {
  const u = username.replace(/^@/, "").toLowerCase();
  const row = db
    .prepare(
      "SELECT * FROM roster_members WHERE chat_id = ? AND lower(username) = ? LIMIT 1",
    )
    .get(chatId, u) as RosterMember | undefined;
  return row ?? null;
}

export function getRosterMember(chatId: number, userId: number): RosterMember | null {
  return (
    (db
      .prepare(
        "SELECT * FROM roster_members WHERE chat_id = ? AND telegram_user_id = ?",
      )
      .get(chatId, userId) as RosterMember | undefined) ?? null
  );
}

// -- Sessions -----------------------------------------------------------------

export function getActiveSession(chatId: number): SessionRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM sessions WHERE chat_id = ? AND archived_at IS NULL ORDER BY opened_at DESC LIMIT 1",
      )
      .get(chatId) as SessionRow | undefined) ?? null
  );
}

export function listActiveSessions(): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY opened_at ASC")
    .all() as SessionRow[];
}

export function getSession(id: number): SessionRow | null {
  return (
    (db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined) ??
    null
  );
}

export function createSession(args: {
  chatId: number;
  openerUserId: number;
  openerDisplayName: string;
  startMinutes: number;
  endMinutes: number;
  archiveAt: number;
}): number {
  const r = db
    .prepare(
      `INSERT INTO sessions
       (chat_id, opener_user_id, opener_display_name, start_minutes, end_minutes, opened_at, archive_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.chatId,
      args.openerUserId,
      args.openerDisplayName,
      args.startMinutes,
      args.endMinutes,
      nowMs(),
      args.archiveAt,
    );
  return Number(r.lastInsertRowid);
}

export function setSessionPollMessage(sessionId: number, messageId: number): void {
  db.prepare("UPDATE sessions SET poll_message_id = ? WHERE id = ?").run(messageId, sessionId);
}

export function setSessionGameOnMessage(
  sessionId: number,
  messageId: number | null,
): void {
  db.prepare("UPDATE sessions SET game_on_message_id = ? WHERE id = ?").run(
    messageId,
    sessionId,
  );
}

export function archiveSession(sessionId: number): void {
  db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL").run(
    nowMs(),
    sessionId,
  );
}

// -- Votes --------------------------------------------------------------------

export function setVote(
  sessionId: number,
  userId: number,
  slot: number,
  value: VoteValue,
): void {
  db.prepare(
    `INSERT INTO votes (session_id, telegram_user_id, slot_minutes, value, voted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, telegram_user_id, slot_minutes)
     DO UPDATE SET value = excluded.value, voted_at = excluded.voted_at`,
  ).run(sessionId, userId, slot, value, nowMs());
}

export function clearVote(sessionId: number, userId: number, slot: number): void {
  db.prepare(
    "DELETE FROM votes WHERE session_id = ? AND telegram_user_id = ? AND slot_minutes = ?",
  ).run(sessionId, userId, slot);
}

export function getVote(
  sessionId: number,
  userId: number,
  slot: number,
): VoteRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM votes WHERE session_id = ? AND telegram_user_id = ? AND slot_minutes = ?",
      )
      .get(sessionId, userId, slot) as VoteRow | undefined) ?? null
  );
}

export function getSessionVotes(sessionId: number): VoteRow[] {
  return db
    .prepare("SELECT * FROM votes WHERE session_id = ? ORDER BY voted_at ASC")
    .all(sessionId) as VoteRow[];
}

export function bulkNoForUser(
  sessionId: number,
  userId: number,
  slots: number[],
): void {
  const stmt = db.prepare(
    `INSERT INTO votes (session_id, telegram_user_id, slot_minutes, value, voted_at)
     VALUES (?, ?, ?, 'no', ?)
     ON CONFLICT(session_id, telegram_user_id, slot_minutes)
     DO UPDATE SET value = 'no', voted_at = excluded.voted_at`,
  );
  const now = nowMs();
  const tx = db.transaction(() => {
    for (const s of slots) stmt.run(sessionId, userId, s, now);
  });
  tx();
}

export function bulkYesForUser(
  sessionId: number,
  userId: number,
  slots: number[],
): void {
  const stmt = db.prepare(
    `INSERT INTO votes (session_id, telegram_user_id, slot_minutes, value, voted_at)
     VALUES (?, ?, ?, 'yes', ?)
     ON CONFLICT(session_id, telegram_user_id, slot_minutes)
     DO UPDATE SET value = 'yes', voted_at = excluded.voted_at`,
  );
  const now = nowMs();
  const tx = db.transaction(() => {
    for (const s of slots) stmt.run(sessionId, userId, s, now);
  });
  tx();
}

export function clearVotesForUser(sessionId: number, userId: number): void {
  db.prepare(
    "DELETE FROM votes WHERE session_id = ? AND telegram_user_id = ?",
  ).run(sessionId, userId);
}

export function getUserVotes(sessionId: number, userId: number): VoteRow[] {
  return db
    .prepare(
      "SELECT * FROM votes WHERE session_id = ? AND telegram_user_id = ?",
    )
    .all(sessionId, userId) as VoteRow[];
}

// -- Skips --------------------------------------------------------------------

export function addSkip(sessionId: number, userId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO session_skips (session_id, telegram_user_id) VALUES (?, ?)",
  ).run(sessionId, userId);
}

export function getSkips(sessionId: number): Set<number> {
  return new Set(
    (
      db
        .prepare("SELECT telegram_user_id FROM session_skips WHERE session_id = ?")
        .all(sessionId) as { telegram_user_id: number }[]
    ).map((r) => r.telegram_user_id),
  );
}

// -- Fillers ------------------------------------------------------------------

export function addFiller(sessionId: number, userId: number): void {
  db.prepare(
    `INSERT INTO session_fillers (session_id, telegram_user_id, set_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, telegram_user_id) DO NOTHING`,
  ).run(sessionId, userId, nowMs());
}

export function removeFiller(sessionId: number, userId: number): void {
  db.prepare(
    "DELETE FROM session_fillers WHERE session_id = ? AND telegram_user_id = ?",
  ).run(sessionId, userId);
}

export function isFiller(sessionId: number, userId: number): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM session_fillers WHERE session_id = ? AND telegram_user_id = ?",
    )
    .get(sessionId, userId);
  return !!row;
}

export function getFillers(sessionId: number): Set<number> {
  return new Set(
    (
      db
        .prepare(
          "SELECT telegram_user_id FROM session_fillers WHERE session_id = ?",
        )
        .all(sessionId) as { telegram_user_id: number }[]
    ).map((r) => r.telegram_user_id),
  );
}

// -- Party mode ---------------------------------------------------------------

export function setPartyMode(sessionId: number, enabled: boolean): void {
  if (enabled) {
    db.prepare(
      `INSERT INTO session_party_mode (session_id, set_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    ).run(sessionId, nowMs());
  } else {
    db.prepare("DELETE FROM session_party_mode WHERE session_id = ?").run(sessionId);
  }
}

export function isPartyMode(sessionId: number): boolean {
  const row = db
    .prepare("SELECT 1 FROM session_party_mode WHERE session_id = ?")
    .get(sessionId);
  return !!row;
}

// -- Locks --------------------------------------------------------------------

export function getLock(sessionId: number): LockRow | null {
  return (
    (db.prepare("SELECT * FROM locks WHERE session_id = ?").get(sessionId) as
      | LockRow
      | undefined) ?? null
  );
}

export function getLockParty(sessionId: number): LockPartyRow[] {
  return db
    .prepare(
      "SELECT * FROM lock_party WHERE session_id = ? ORDER BY role ASC, vote_order ASC",
    )
    .all(sessionId) as LockPartyRow[];
}

export function clearLock(sessionId: number): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lock_party WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM locks WHERE session_id = ?").run(sessionId);
  });
  tx();
}

export function writeLock(args: {
  sessionId: number;
  slot: number;
  size: number;
  core: number[];
  alternates: number[];
}): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM lock_party WHERE session_id = ?").run(args.sessionId);
    db.prepare("DELETE FROM locks WHERE session_id = ?").run(args.sessionId);
    db.prepare(
      "INSERT INTO locks (session_id, slot_minutes, size, locked_at) VALUES (?, ?, ?, ?)",
    ).run(args.sessionId, args.slot, args.size, nowMs());
    const ins = db.prepare(
      "INSERT INTO lock_party (session_id, telegram_user_id, role, vote_order) VALUES (?, ?, ?, ?)",
    );
    args.core.forEach((uid, i) => ins.run(args.sessionId, uid, "core", i));
    args.alternates.forEach((uid, i) => ins.run(args.sessionId, uid, "alternate", i));
  });
  tx();
}

// -- Lateness -----------------------------------------------------------------

export function setLockLate(
  sessionId: number,
  userId: number,
  lateMinutes: number,
): void {
  db.prepare(
    `INSERT INTO lock_late (session_id, telegram_user_id, late_minutes, set_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, telegram_user_id)
     DO UPDATE SET late_minutes = excluded.late_minutes, set_at = excluded.set_at`,
  ).run(sessionId, userId, lateMinutes, nowMs());
}

export function clearLockLateForUser(sessionId: number, userId: number): void {
  db.prepare(
    "DELETE FROM lock_late WHERE session_id = ? AND telegram_user_id = ?",
  ).run(sessionId, userId);
}

export function clearLockLate(sessionId: number): void {
  db.prepare("DELETE FROM lock_late WHERE session_id = ?").run(sessionId);
}

export function getLockLate(sessionId: number): Map<number, number> {
  const rows = db
    .prepare(
      "SELECT telegram_user_id, late_minutes FROM lock_late WHERE session_id = ?",
    )
    .all(sessionId) as { telegram_user_id: number; late_minutes: number }[];
  return new Map(rows.map((r) => [r.telegram_user_id, r.late_minutes]));
}

export function getLockLateForUser(
  sessionId: number,
  userId: number,
): number | null {
  const row = db
    .prepare(
      "SELECT late_minutes FROM lock_late WHERE session_id = ? AND telegram_user_id = ?",
    )
    .get(sessionId, userId) as { late_minutes: number } | undefined;
  return row?.late_minutes ?? null;
}

// -- Scheduled jobs -----------------------------------------------------------

export function scheduleJob(kind: string, payload: unknown, fireAt: number): number {
  const r = db
    .prepare(
      "INSERT INTO scheduled_jobs (fire_at, kind, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(fireAt, kind, JSON.stringify(payload), nowMs());
  return Number(r.lastInsertRowid);
}

export function listJobs(): ScheduledJob[] {
  return db
    .prepare("SELECT * FROM scheduled_jobs ORDER BY fire_at ASC")
    .all() as ScheduledJob[];
}

export function deleteJob(id: number): void {
  db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
}

export function deleteJobsForSession(sessionId: number, kind?: string): void {
  if (kind) {
    db.prepare(
      "DELETE FROM scheduled_jobs WHERE kind = ? AND json_extract(payload, '$.sessionId') = ?",
    ).run(kind, sessionId);
  } else {
    db.prepare(
      "DELETE FROM scheduled_jobs WHERE json_extract(payload, '$.sessionId') = ?",
    ).run(sessionId);
  }
}

// -- Audit --------------------------------------------------------------------

export function audit(
  chatId: number,
  userId: number,
  command: string,
  args?: string,
): void {
  db.prepare(
    "INSERT INTO audit_log (chat_id, telegram_user_id, command, args, at) VALUES (?, ?, ?, ?, ?)",
  ).run(chatId, userId, command, args ?? null, nowMs());
}

// -- Stats --------------------------------------------------------------------

export function statsSessionsSince(chatId: number, sinceMs: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE chat_id = ? AND opened_at >= ?")
    .get(chatId, sinceMs) as { n: number };
  return r.n;
}

export interface PlayerJoinStat {
  telegram_user_id: number;
  display_name: string;
  joined: number;
  total: number;
}

export function statsJoinRate(chatId: number, sinceMs: number): PlayerJoinStat[] {
  // For each roster member, count locked sessions since `sinceMs`
  // and how many of those they appear in lock_party as core.
  const members = getRoster(chatId);
  const totalLocked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s
       JOIN locks l ON l.session_id = s.id
       WHERE s.chat_id = ? AND s.opened_at >= ?`,
    )
    .get(chatId, sinceMs) as { n: number };
  const total = totalLocked.n;
  const joinedStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM lock_party lp
     JOIN sessions s ON s.id = lp.session_id
     WHERE s.chat_id = ? AND s.opened_at >= ? AND lp.telegram_user_id = ? AND lp.role = 'core'`,
  );
  return members.map((m) => {
    const j = joinedStmt.get(chatId, sinceMs, m.telegram_user_id) as { n: number };
    return {
      telegram_user_id: m.telegram_user_id,
      display_name: m.display_name,
      joined: j.n,
      total,
    };
  });
}

export function statsMostCommonHour(chatId: number, sinceMs: number): number | null {
  const r = db
    .prepare(
      `SELECT l.slot_minutes / 60 AS h, COUNT(*) AS n FROM locks l
       JOIN sessions s ON s.id = l.session_id
       WHERE s.chat_id = ? AND s.opened_at >= ?
       GROUP BY h ORDER BY n DESC LIMIT 1`,
    )
    .get(chatId, sinceMs) as { h: number; n: number } | undefined;
  return r?.h ?? null;
}

export function statsMostCommonStack(
  chatId: number,
  sinceMs: number,
): { size: number | "no-lock"; n: number } | null {
  // Count sizes from locks plus sessions with no lock.
  const sizes = db
    .prepare(
      `SELECT l.size AS size, COUNT(*) AS n FROM locks l
       JOIN sessions s ON s.id = l.session_id
       WHERE s.chat_id = ? AND s.opened_at >= ?
       GROUP BY l.size`,
    )
    .all(chatId, sinceMs) as { size: number; n: number }[];
  const noLock = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s
       LEFT JOIN locks l ON l.session_id = s.id
       WHERE s.chat_id = ? AND s.opened_at >= ? AND l.session_id IS NULL`,
    )
    .get(chatId, sinceMs) as { n: number };
  const all: { size: number | "no-lock"; n: number }[] = [
    ...sizes.map((s) => ({ size: s.size as number | "no-lock", n: s.n })),
    { size: "no-lock", n: noLock.n },
  ];
  all.sort((a, b) => b.n - a.n);
  return all[0] && all[0].n > 0 ? all[0] : null;
}
