import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GrammyError } from "grammy";

const dir = mkdtempSync(join(tmpdir(), "five-stack-reminders-"));
process.env.BOT_TOKEN = "123:test-only";
process.env.DB_PATH = join(dir, "test.db");
process.env.MINI_APP_URL = "https://availability.example.test";
const q = await import("../db/queries.js");
const { db } = await import("../db/index.js");
const { bot } = await import("./instance.js");
const session = await import("./session.js");
const reminders = await import("./voteReminders.js");
const jobs = await import("../scheduler/jobs.js");
const availability = await import("./availability.js");
await import("./callbacks.js");
bot.botInfo = { id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, can_manage_bots: false, has_topics_enabled: false, allows_users_to_create_topics: false };

test("voting reminder lifecycle with SQLite and mocked Telegram", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-09-06T12:00:00Z") });
  type Call = { method: string; payload: Record<string, any> };
  const calls: Call[] = [];
  const failures = new Map<string, string>();
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const fail = failures.get(method);
    if (fail) throw new GrammyError("fixture", { ok: false, error_code: 400, description: fail }, method, payload);
    if (method === "sendMessage") return { ok: true, result: { message_id: ++messageId, chat: { id: 1 }, date: 0, text: "fixture" } } as never;
    return { ok: true, result: true } as never;
  });
  const sent = () => calls.filter(call => call.method === "sendMessage" && call.payload.text.startsWith("🔔"));
  const fixture = (chatId: number) => {
    q.getOrCreateChat(chatId);
    q.setChatTz(chatId, "UTC");
    for (let id = 1; id <= 7; id++) q.addRosterMember(chatId, id, `player${id}`, `Player ${id}`);
    const id = q.createSession({ chatId, openerUserId: 1, openerDisplayName: "Player 1", startMinutes: 1200, endMinutes: 1380, archiveAt: Date.now() + 8 * 3600_000 });
    q.setSessionPollMessage(id, 50);
    q.setVote(id, 1, 1200, "yes");
    return id;
  };
  const advanceCooldown = () => t.mock.timers.setTime(Date.now() + reminders.VOTE_REMINDER_INTERVAL_MS);
  const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const tap = (id: number, chatId: number, userId: number, data: string, username = `player${userId}`) => bot.handleUpdate({
    update_id: messageId++,
    callback_query: { id: `tap-${messageId}`, from: { id: userId, is_bot: false, first_name: "Player", username }, chat_instance: "fixture", data,
      message: { message_id: q.getVoteReminder(id)?.message_id ?? 50, date: 0, chat: { id: chatId, type: "supergroup", title: "Fixture" } } },
  });

  try {
    await t.test("only non-voters are tagged and concurrent sends share cooldown", async () => {
      const chatId = -1001234567890;
      const id = fixture(chatId);
      q.setVote(id, 2, 1230, "maybe");
      q.setVote(id, 3, 1200, "no");
      q.addSkip(id, 4);
      q.removeRosterMember(chatId, 7);
      const results = await Promise.all([reminders.sendVoteReminder(id, chatId), reminders.sendVoteReminder(id, chatId)]);
      assert.match(results[0]!, /Reminded/);
      assert.match(results[1]!, /wait 15 min/);
      assert.equal(sent().length, 1);
      assert.match(sent()[0]!.payload.text, /@player5 @player6/);
      assert.doesNotMatch(sent()[0]!.payload.text, /@player[12347]/);
      const keyboard = sent()[0]!.payload.reply_markup.inline_keyboard.flat();
      assert.equal(keyboard[0].url, session.getSessionMiniAppLink(id));
      assert.equal(keyboard[1].callback_data, `vbn:${id}`);
      assert.equal(sent()[0]!.payload.disable_notification, undefined);
      assert.ok(!q.listJobs().some(job => job.kind === "vote_reminder"));

      const oldMessage = q.getVoteReminder(id)!.message_id;
      await session.bumpSessionPoll(chatId);
      const edit = calls.findLast(call => call.method === "editMessageText" && call.payload.message_id === oldMessage);
      assert.equal(edit!.payload.reply_markup.inline_keyboard[0][0].url, session.getSessionMiniAppLink(id));
      advanceCooldown();
      const before = calls.length;
      await reminders.sendVoteReminder(id, chatId);
      assert.equal(calls[before]!.method, "deleteMessage");
      assert.equal(calls[before]!.payload.message_id, oldMessage);
      assert.equal(calls[before + 1]!.method, "sendMessage");
      assert.notEqual(q.getVoteReminder(id)!.message_id, oldMessage);

      await tap(id, chatId, 5, `vbn:${id}`);
      assert.equal(q.getUserVotes(id, 5).length, 6);
      assert.ok(q.getUserVotes(id, 5).every(vote => vote.value === "no"));
      await session.refreshActiveSession(chatId);
      const refreshed = calls.findLast(call => call.method === "editMessageText" && call.payload.message_id === q.getVoteReminder(id)!.message_id);
      assert.match(refreshed!.payload.text, /@player6/);
      assert.doesNotMatch(refreshed!.payload.text, /@player5/);
      await tap(id, chatId, 6, `vbn:${id}`);
      await session.refreshActiveSession(chatId);
      assert.equal(q.getVoteReminder(id)!.message_id, null);
      q.clearVotesForUser(id, 6);
      assert.match(await reminders.sendVoteReminder(id, chatId), /wait 15 min/);
      await session.cancelSession(id);
      const count = sent().length;
      await tap(id, chatId, 6, `vbn:${id}`);
      assert.equal(q.getUserVotes(id, 6).length, 0);
      await reminders.sendVoteReminder(id, chatId);
      assert.equal(sent().length, count);
    });

    await t.test("full party, expired session and wrong chat cannot trigger reminders", async () => {
      const id = fixture(-1001234567891);
      const count = sent().length;
      for (let player = 2; player <= 5; player++) q.setVote(id, player, 1200, "yes");
      await reminders.sendVoteReminder(id);
      assert.equal(sent().length, count); // lock evaluation has not been flushed
      q.clearVotesForUser(id, 5);
      await reminders.sendVoteReminder(id, -999);
      assert.equal(sent().length, count);
      await reminders.sendVoteReminder(id);
      assert.equal(sent().length, count + 1);
      q.setVote(id, 5, 1200, "yes");
      await session.refreshActiveSession(-1001234567891);
      assert.equal(q.getVoteReminder(id)!.message_id, null);
      await session.cancelSession(id);

      const expired = fixture(-1001234567892);
      db.prepare("UPDATE sessions SET archive_at = ? WHERE id = ?").run(Date.now() - 1, expired);
      await reminders.sendVoteReminder(expired);
      assert.equal(q.getVoteReminder(expired), undefined);

      const started = fixture(-1001234567897);
      q.writeLock({ sessionId: started, slot: 720, size: 2, core: [1, 2], alternates: [] });
      await reminders.sendVoteReminder(started);
      assert.equal(q.getVoteReminder(started), undefined);
    });

    await t.test("failed deletion retires old buttons; failed cleanup prevents duplicate CTA", async () => {
      const id = fixture(-1001234567893);
      await reminders.sendVoteReminder(id);
      advanceCooldown();
      failures.set("deleteMessage", "message can't be deleted");
      const oldMessage = q.getVoteReminder(id)!.message_id;
      await reminders.sendVoteReminder(id);
      const retired = calls.findLast(call => call.method === "editMessageText" && call.payload.message_id === oldMessage);
      assert.deepEqual(retired!.payload.reply_markup.inline_keyboard, []);
      assert.equal(retired!.payload.text, "Voting reminder closed.");
      advanceCooldown();
      failures.set("editMessageText", "not enough rights");
      const count = sent().length;
      const current = q.getVoteReminder(id)!.message_id;
      await assert.rejects(reminders.sendVoteReminder(id));
      assert.equal(sent().length, count);
      assert.equal(q.getVoteReminder(id)!.message_id, current);
      failures.clear();
      failures.set("sendMessage", "fixture send failure");
      const timestamp = q.getVoteReminder(id)!.last_sent_at;
      await assert.rejects(reminders.sendVoteReminder(id));
      assert.equal(q.getVoteReminder(id)!.message_id, null);
      assert.equal(q.getVoteReminder(id)!.last_sent_at, timestamp);
      failures.clear();
      await reminders.sendVoteReminder(id);
      await session.archiveSessionFromScheduler(id);
      assert.equal(q.getVoteReminder(id)!.message_id, null);
    });

    await t.test("CTA and cooldown persist across process restart without another notification", async () => {
      const id = fixture(-1001234567894);
      await reminders.sendVoteReminder(id);
      const saved = q.getVoteReminder(id);
      const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        const q = await import('./src/db/queries.ts');
        const { db } = await import('./src/db/index.ts');
        console.log(JSON.stringify(q.getVoteReminder(${id})));
        db.close();
      `], { encoding: "utf8" });
      assert.deepEqual(JSON.parse(result), saved);
      const count = sent().length;
      await reminders.refreshVoteReminders();
      assert.equal(sent().length, count);
      assert.match(await reminders.sendVoteReminder(id), /wait 15 min/);
      q.archiveSession(id);
      await reminders.refreshVoteReminders();
      assert.equal(q.getVoteReminder(id)!.message_id, null);
    });

    await t.test("basic groups use signed Mini App links; synthetic non-voter can decline", async () => {
      const chatId = -23456;
      const id = fixture(chatId);
      // Bind through the existing callback path, just like /lfp_add @username.
      const name = "newplayer";
      let hash = 0;
      for (const ch of name) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
      q.addRosterMember(chatId, -Math.abs(hash), name, name);
      await tap(id, chatId, 7, `vr:${id}`);
      assert.equal(sent().at(-1)!.payload.reply_markup.inline_keyboard[0][0].url, session.getSessionMiniAppLink(id));
      const count = sent().length;
      await tap(id, chatId, 7, `vr:${id}`);
      assert.equal(sent().length, count);
      assert.match(calls.findLast(call => call.method === "answerCallbackQuery")!.payload.text, /wait 15 min/);
      await tap(id, chatId, 90, `vbn:${id}`, name);
      assert.ok(q.getRosterIds(chatId).has(90));
      assert.ok(q.getUserVotes(id, 90).every(vote => vote.value === "no"));
      await session.cancelSession(id);
    });

    await t.test("Mini App authorization and chat button share one reminder and cooldown", async () => {
      const chatId = -1001234567896;
      const id = fixture(chatId);
      const user = { id: 1, first_name: "Player 1" };
      const count = sent().length;
      await assert.rejects(availability.remindNonVoters(id, { id: 99, first_name: "Outsider" }), /roster/);
      assert.equal(sent().length, count);
      const result = await availability.remindNonVoters(id, user);
      assert.match(result.message, /Reminded/);
      assert.equal(sent().length, count + 1);
      assert.equal(result.nextAllowedAt, Date.now() + reminders.VOTE_REMINDER_INTERVAL_MS);
      assert.equal((await availability.getAvailabilitySnapshot(id, user)).reminderAvailableAt, result.nextAllowedAt);
      await tap(id, chatId, 2, `vr:${id}`);
      assert.equal(sent().length, count + 1);
      assert.match((await availability.remindNonVoters(id, user)).message, /wait 15 min/);
      advanceCooldown();
      await availability.remindNonVoters(id, user);
      assert.equal(sent().length, count + 2);
      q.removeRosterMember(chatId, user.id);
      await assert.rejects(availability.remindNonVoters(id, user), /roster/);
      await session.cancelSession(id);
      await assert.rejects(availability.remindNonVoters(id, { id: 2, first_name: "Two" }), /ended/);
    });

    await t.test("new sessions stay quiet; restart discards legacy automatic jobs", async () => {
      const chatId = -1001234567895;
      q.getOrCreateChat(chatId);
      q.setChatTz(chatId, "UTC");
      q.addRosterMember(chatId, 2, "waiting", "Waiting");
      const id = await session.openSession({ chatId, openerUserId: 1, openerUsername: "opener", openerDisplayName: "Opener", startMinutes: 1200, endMinutes: 1380 }) as number;
      await drain();
      assert.ok(!q.listJobs().some(job => job.kind === "vote_reminder"));
      await session.bumpSessionPoll(chatId);
      q.scheduleJob("vote_reminder", { sessionId: id }, Date.now() - 1000);
      q.scheduleJob("vote_reminder", { sessionId: id }, Date.now() + reminders.VOTE_REMINDER_INTERVAL_MS);
      await jobs.rehydrateJobs();
      assert.ok(!q.listJobs().some(job => job.kind === "vote_reminder"));
      const count = sent().length;
      t.mock.timers.tick(reminders.VOTE_REMINDER_INTERVAL_MS * 2);
      await drain();
      assert.equal(sent().length, count);
      await tap(id, chatId, 1, `vr:${id}`);
      assert.equal(sent().length, count + 1);
      assert.match(sent().at(-1)!.payload.text, /@waiting/);
      assert.ok(!q.listJobs().some(job => job.kind === "vote_reminder"));
      t.mock.timers.tick(reminders.VOTE_REMINDER_INTERVAL_MS);
      await drain();
      assert.equal(sent().length, count + 1);
      await session.cancelSession(id);
      assert.equal(q.getVoteReminder(id)!.message_id, null);
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
