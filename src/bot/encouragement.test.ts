import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "five-stack-encouragement-"));
process.env.BOT_TOKEN = "123:test-only";
process.env.DB_PATH = join(dir, "test.db");
const q = await import("../db/queries.js");
const { db } = await import("../db/index.js");
const { bot } = await import("./instance.js");
const { postSearchEncouragement } = await import("./encouragement.js");
const { openSession, bumpSessionPoll, refreshAllActiveSessions } = await import("./session.js");
test("opening, duplicate events, edits, bump and restart preserve at-most-once history", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      messages.push((payload as { text: string }).text);
      return { ok: true, result: { message_id: messages.length, chat: { id: 1 }, date: 0, text: "fixture" } } as never;
    }
    return { ok: true, result: true } as never;
  });
  try {
    const opened = await openSession({ chatId: 1, openerUserId: 10, openerUsername: null, openerDisplayName: "Friend", startMinutes: 1200, endMinutes: 1380 });
    assert.equal(typeof opened, "number");
    const id = opened as number;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messages.length, 2);
    assert.match(messages[0]!, /looking for a party/);
    assert.equal(q.listJobs().length > 0, true);
    await postSearchEncouragement(id);
    await refreshAllActiveSessions();
    await bumpSessionPoll(1);
    await postSearchEncouragement(id);
    assert.equal(messages.length, 3); // only the bump adds a poll
    const h = q.encouragementHistory(1);
    assert.equal(h.length, 1);
    const restarted = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const q = await import('./src/db/queries.ts');
      const { db } = await import('./src/db/index.ts');
      console.log(JSON.stringify({ history: q.encouragementHistory(1), claimed: q.claimEncouragement(${id}, 1, Date.now() + 86400000) }));
      db.close();
    `], { encoding: "utf8" });
    const saved = JSON.parse(restarted);
    assert.deepEqual(saved.history, h);
    assert.equal(saved.claimed, false);
    assert.equal(q.claimEncouragement(id, 1, Date.now() + 86400000), false);
    q.archiveSession(id);
    const second = q.createSession({ chatId: 1, openerUserId: 10, openerDisplayName: "Friend", startMinutes: 1200, endMinutes: 1380, archiveAt: Date.now() + 10000 });
    assert.equal(q.claimEncouragement(second, 1, Date.now()), false);
    const link = { origin: "https://lol-tracker.cn.lt", puuid: "a", gameName: "A", tagLine: "EUW", platform: "euw1" };
    q.setRiotLink(1, 10, link);
    assert.equal(q.getRiotLinks(1).length, 1);
    assert.equal(q.getRiotLinks(2).length, 0);
    q.removeRosterMember(1, 10);
    assert.equal(q.getRiotLinks(1).length, 0);
    // Party creation and scheduler must finish while tracker requests are still pending.
    q.getOrCreateChat(2);
    q.addRosterMember(2, 20, null, "One");
    q.addRosterMember(2, 21, null, "Two");
    q.setRiotLink(2, 20, link);
    assert.throws(() => q.setRiotLink(2, 21, link));
    q.setRiotLink(2, 21, { ...link, puuid: "b" });
    const originalFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    globalThis.fetch = async () => pending;
    try {
      const next = await openSession({ chatId: 2, openerUserId: 20, openerUsername: null, openerDisplayName: "One", startMinutes: 1200, endMinutes: 1380 });
      assert.equal(typeof next, "number");
      assert.ok(q.listJobs().some(j => JSON.parse(j.payload).sessionId === next));
      assert.equal(q.encouragementHistory(2).length, 0);
      release(new Response("", { status: 500 }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(q.encouragementHistory(2)[0]?.category, "invite");
      const count = messages.length;
      await postSearchEncouragement(next as number);
      assert.equal(messages.length, count);
    } finally { globalThis.fetch = originalFetch; }

    // A bump holds the mutex while its Telegram send is pending. The final
    // encouragement check must wait until the replacement poll ID is stored.
    const { withMutex } = await import("./mutex.js");
    q.getOrCreateChat(3);
    const racing = q.createSession({ chatId: 3, openerUserId: 30, openerDisplayName: "Three", startMinutes: 1200, endMinutes: 1380, archiveAt: Date.now() + 10000 });
    q.setSessionPollMessage(racing, 100);
    let finishBump!: () => void;
    const bumpPending = new Promise<void>(resolve => { finishBump = resolve; });
    const bump = withMutex(`session:${racing}`, async () => {
      await bumpPending;
      q.setSessionPollMessage(racing, 200);
    });
    const messageCount = messages.length;
    const encouragement = postSearchEncouragement(racing);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(q.encouragementHistory(3).length, 0);
    finishBump();
    await Promise.all([bump, encouragement]);
    assert.equal(messages.length, messageCount);
    assert.equal(q.encouragementHistory(3).length, 0);

  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
