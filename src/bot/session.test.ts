import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "five-stack-session-"));
process.env.DB_PATH = join(directory, "test.sqlite");
process.env.BOT_TOKEN = "123:test-token";
process.env.MINI_APP_URL = "https://availability.example.test";
const { db } = await import("../db/index.js");
const q = await import("../db/queries.js");
const sessions = await import("./session.js");
const { bot } = await import("./instance.js");
const { withMutex } = await import("./mutex.js");
const { getAvailabilitySnapshot, saveAvailability } = await import("./availability.js");
await import("./callbacks.js");

const now = Date.parse("2026-09-06T12:15:00Z");
let sessionId = 0;
let nextMessage = 100;
const calls: Array<{ method: string; text?: string; options?: unknown }> = [];

before(() => {
  mock.method(Date, "now", () => now);
  mock.timers.enable({ apis: ["setTimeout"] });
  bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "TestBot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: true, can_manage_bots: false,
    has_topics_enabled: false, allows_users_to_create_topics: false };
  // Contexts clone the API client; a transformer also intercepts callback calls.
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, options: payload });
    return { ok: true, result: true } as any;
  });
  mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in session test"); });
  mock.method(bot.api, "sendMessage", async (_chatId: unknown, text: string, options: unknown) => {
    calls.push({ method: "sendMessage", text, options });
    return { message_id: nextMessage++ };
  });
  mock.method(bot.api, "editMessageText", async (_chatId: unknown, _messageId: unknown, text: string, options: unknown) => {
    calls.push({ method: "editMessageText", text, options });
    return true;
  });
  mock.method(bot.api, "editMessageReplyMarkup", async (_chatId: unknown, _messageId: unknown, options: unknown) => {
    calls.push({ method: "editMessageReplyMarkup", options });
    return true;
  });
  mock.method(bot.api, "answerCallbackQuery", async (_queryId: unknown, options: unknown) => {
    calls.push({ method: "answerCallbackQuery", options });
    return true;
  });
  mock.method(bot.api, "pinChatMessage", async () => true);
  mock.method(bot.api, "unpinChatMessage", async () => true);
});

beforeEach(() => {
  db.exec("DELETE FROM chats; DELETE FROM scheduled_jobs");
  calls.length = 0;
  q.getOrCreateChat(1);
  q.setChatTz(1, "UTC");
  q.addRosterMember(1, 1, "one", "One");
  q.addRosterMember(1, 2, "two", "Two");
  sessionId = q.createSession({ chatId: 1, openerUserId: 1, openerDisplayName: "One", startMinutes: 720,
    endMinutes: 870, archiveAt: Date.parse("2026-09-06T14:00:00Z") });
});

after(() => {
  mock.timers.reset();
  mock.restoreAll();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("v2 session integration", () => {
  it("opens a poll with no assumed availability, including for its organizer", async () => {
    q.archiveSession(sessionId);
    const opened = await sessions.openSession({ chatId: 1, openerUserId: 3, openerUsername: "three",
      openerDisplayName: "Three", startMinutes: 780, endMinutes: 870 });
    assert.equal(typeof opened, "number");
    assert.ok(q.getRosterMember(1, 3));
    if (typeof opened !== "number") throw new Error("Expected a new session");
    assert.deepEqual(q.getSessionVotes(opened), []);
    const sent = calls.find((call) => call.method === "sendMessage")!;
    assert.match(sent.text!, /Saved replies: <b>0\/3<\/b>/);
    assert.match(JSON.stringify(sent.options), /https:\/\/t.me\/TestBot\?startapp=/);
    assert.doesNotMatch(JSON.stringify(sent.options), /"callback_data":"(?:v|v2|vbay|vfill):/);
    assert.match(JSON.stringify(sent.options), /"callback_data":"vbn:/);
  });

  it("merges an organizer's earlier username placeholder before opening a new poll", async () => {
    q.addRosterMember(1, -333, "three", "Three placeholder");
    q.setVote(sessionId, -333, 780, "maybe");
    const oldSession = sessionId;
    q.archiveSession(oldSession);
    const opened = await sessions.openSession({ chatId: 1, openerUserId: 3, openerUsername: "three",
      openerDisplayName: "Three", startMinutes: 780, endMinutes: 870 });
    assert.equal(typeof opened, "number");
    assert.deepEqual(q.getRoster(1).map((member) => member.telegram_user_id), [1, 2, 3]);
    assert.equal(q.getVote(oldSession, 3, 780)!.value, "maybe");
    assert.equal(q.getRosterMember(1, -333), null);
    if (typeof opened !== "number") throw new Error("Expected a new session");
    assert.deepEqual(q.getSessionVotes(opened), []);
    const sent = calls.find((call) => call.method === "sendMessage")!;
    assert.match(sent.text!, /Saved replies: <b>0\/3<\/b>/);
    assert.doesNotMatch(sent.text!, /placeholder/);
  });

  it("upgrades old partial-vote buttons without writing a vote, skip, or filler change", async () => {
    q.setVote(sessionId, 1, 780, "yes");
    q.addSkip(sessionId, 1);
    q.addFiller(sessionId, 1);
    const previous = q.getSessionVotes(sessionId);
    for (const data of [`v:${sessionId}:780`, `v2:${sessionId}:780`, `vbay:${sessionId}`, `vfill:${sessionId}`]) {
      await bot.handleUpdate({ update_id: nextMessage++, callback_query: {
        id: `query-${nextMessage}`, from: { id: 1, is_bot: false, first_name: "One", username: "one" },
        chat_instance: "chat-one", data,
        message: { message_id: 50, date: now / 1000, chat: { id: 1, type: "supergroup", title: "Test" } },
      } });
    }
    assert.deepEqual(q.getSessionVotes(sessionId), previous);
    assert.equal(q.getSkips(sessionId).has(1), true);
    assert.equal(q.isFiller(sessionId, 1), true);
    const upgrades = calls.filter((call) => call.method === "editMessageReplyMarkup");
    assert.equal(upgrades.length, 4);
    assert.ok(upgrades.every((call) => JSON.stringify(call.options).includes("https://t.me/TestBot?startapp=")));
    assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  });

  it("uses both old and current No callbacks to save a direct complete decline", async () => {
    q.setVote(sessionId, 1, 720, "yes");
    q.setVote(sessionId, 1, 780, "yes");
    q.addSkip(sessionId, 1);
    q.addFiller(sessionId, 1);
    const clickNo = (userId: number) => bot.handleUpdate({ update_id: nextMessage++, callback_query: {
      id: `decline-${nextMessage}`, from: { id: userId, is_bot: false, first_name: "One", username: "one" },
      chat_instance: "chat-one", data: `vbn:${sessionId}`,
      message: { message_id: 50, date: now / 1000, chat: { id: 1, type: "supergroup", title: "Test" } },
    } });
    await clickNo(1);
    assert.equal(q.getVote(sessionId, 1, 720)!.value, "yes");
    assert.ok(q.getUserVotes(sessionId, 1).filter((vote) => vote.slot_minutes > 720).every((vote) => vote.value === "no"));
    assert.equal(q.getSkips(sessionId).has(1), false);
    assert.equal(q.isFiller(sessionId, 1), false);
    const answer = calls.find((call) => call.method === "answerCallbackQuery")!;
    assert.match(JSON.stringify(answer.options), /Saved: you can't play/);
    assert.doesNotMatch(JSON.stringify(answer.options), /show_alert/);
    assert.equal(calls.filter((call) => call.method === "editMessageReplyMarkup").length, 0);
    const votes = q.getSessionVotes(sessionId);
    calls.length = 0;
    await clickNo(99);
    assert.deepEqual(q.getSessionVotes(sessionId), votes);
    assert.match(JSON.stringify(calls[0]!.options), /Only this group's roster/);
    assert.match(JSON.stringify(calls[0]!.options), /"show_alert":true/);
    q.archiveSession(sessionId);
    calls.length = 0;
    await clickNo(1);
    assert.match(JSON.stringify(calls[0]!.options), /Voting has ended/);
    assert.match(JSON.stringify(calls[0]!.options), /"show_alert":true/);
  });

  it("ignores past-slot majorities when evaluating the next party", async () => {
    for (let id = 1; id <= 5; id++) {
      q.addRosterMember(1, id, `player${id}`, `Player ${id}`);
      q.setVote(sessionId, id, 720, "yes");
    }
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, 2, 780, "yes");
    await sessions.refreshActiveSession(1);
    assert.equal(q.getLock(sessionId)!.slot_minutes, 780);
    assert.equal(q.getLock(sessionId)!.size, 2);
    assert.match(calls.find((call) => call.method === "sendMessage")!.text!, /13:00/);
  });

  it("cannot resurrect a session cancelled while refresh waits on its mutex", async () => {
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, 2, 780, "yes");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const cancelling = withMutex(`session:${sessionId}`, async () => {
      await barrier;
      q.archiveSession(sessionId);
    });
    const refreshing = sessions.refreshActiveSession(1);
    release();
    await Promise.all([cancelling, refreshing]);
    assert.equal(q.getLock(sessionId), null);
    assert.equal(calls.length, 0);
  });

  it("refreshes a no-longer-pending person's upgrade nudge silently without rescheduling the reminder", async () => {
    q.addRosterMember(1, 3, "three", "Three");
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, 2, 780, "yes");
    await sessions.refreshActiveSession(1);
    assert.match(calls.find((call) => call.method === "sendMessage")!.text!, /@three — save your availability/);
    const reminders = q.listJobs().filter((job) => job.kind === "t15");
    calls.length = 0;
    const third = { id: 3, username: "three", first_name: "Three" };
    const previous = await getAvailabilitySnapshot(sessionId, third);
    await saveAvailability(sessionId, third, { expectedRevision: previous.me.revision, votes: [],
      unavailable: true, filler: false });
    await sessions.refreshActiveSession(1);
    const edit = calls.find((call) => call.method === "editMessageText")!;
    assert.ok(edit);
    assert.doesNotMatch(edit.text!, /@three|upgrade/);
    assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
    assert.deepEqual(q.listJobs().filter((job) => job.kind === "t15"), reminders);
  });

  it("refreshes existing poll keyboards on boot and archives sessions whose deadline passed during downtime", async () => {
    q.setSessionPollMessage(sessionId, 50);
    await sessions.refreshAllActiveSessions();
    const edit = calls.find((call) => call.method === "editMessageText")!;
    assert.match(JSON.stringify(edit.options), /https:\/\/t.me\/TestBot\?startapp=/);
    assert.match(edit.text!, /Picker changes count only after <b>Save<\/b>/);
    calls.length = 0;
    db.prepare("UPDATE sessions SET archive_at = ? WHERE id = ?").run(now - 60_000, sessionId);
    await sessions.refreshAllActiveSessions();
    assert.equal(q.getActiveSession(1), null);
    const archived = calls.find((call) => call.method === "editMessageText")!;
    assert.match(archived.text!, /archived/);
    const clear = calls.find((call) => call.method === "editMessageReplyMarkup")!;
    assert.deepEqual((clear.options as { reply_markup: unknown }).reply_markup, { inline_keyboard: [] });
  });
});
