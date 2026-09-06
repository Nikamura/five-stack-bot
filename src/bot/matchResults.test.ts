import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const dir = mkdtempSync(join(tmpdir(), "match-results-"));
process.env.BOT_TOKEN = "123:test-only";
process.env.DB_PATH = join(dir, "test.db");
const { resultMessage, pollMatchResults } = await import("./matchResults.js");
const q = await import("../db/queries.js");
const { db } = await import("../db/index.js");
const { bot } = await import("./instance.js");
const { TRACKER_ORIGIN } = await import("./tracker.js");
const now = Date.now();
const links = ["a", "b", "c", "d", "e"].map(puuid => ({ origin: TRACKER_ORIGIN, puuid, gameName: `<${puuid}>`, tagLine: "EUW", platform: "euw1" }));
const match = (id = "EUW1_1", n = 3) => ({ matchId: id, gameStart: now - 1800000, gameDuration: 1800, queueId: 450,
  participants: links.slice(0, n).map(l => ({ puuid: l.puuid, teamId: 100, win: true, championName: "Ahri", kills: 4, deaths: 2, assists: 8 })) });
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("three and up on the same team; validated results and escaped names", () => {
  for (const n of [3, 4, 5]) assert.match(resultMessage(match("EUW1_1", n), "EUW1_1", links, now, now)!, new RegExp(`${n}-stack`));
  assert.equal(resultMessage(match("EUW1_1", 2), "EUW1_1", links, now, now), null);
  const m = match();
  assert.match(resultMessage(m, m.matchId, links, now, now)!, /&lt;a&gt; · Ahri · 4\/2\/8/);
  m.participants[2]!.teamId = 200;
  assert.equal(resultMessage(m, m.matchId, links, now, now), null);
  for (const patch of [{ gameDuration: 299 }, { gameStart: now }, { participants: [m.participants[0], m.participants[0], m.participants[0]] }]) {
    assert.equal(resultMessage({ ...match(), ...patch }, "EUW1_1", links, now, now), null);
  }
  assert.equal(resultMessage(match(), "wrong", links, now, now), null);
  assert.equal(resultMessage(match(), "EUW1_1", links, now + 1, now), null);
  assert.equal(resultMessage({ ...match(), participants: match().participants.map(p => ({ ...p, win: "true" })) }, "EUW1_1", links, now, now), null);
});

test("baseline, independent groups, retries, restart persistence and failed sends", async () => {
  for (const chat of [-1, -2]) {
    q.getOrCreateChat(chat);
    for (const [i, l] of links.slice(0, 3).entries()) { q.addRosterMember(chat, i + 1, null, l.gameName); q.setRiotLink(chat, i + 1, l); }
  }
  const sent: { chat_id: number; text: string; reply_markup: unknown }[] = [];
  let failSend = false;
  bot.api.config.use(async (_prev, method, payload) => {
    assert.equal(method, "sendMessage");
    if (failSend) throw new Error("ambiguous network failure");
    sent.push(payload as never);
    return { ok: true, result: { message_id: sent.length } } as never;
  });
  let current = match();
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.includes("/players/")) return Response.json({ data: { player: { puuid: url.pathname.split("/").at(-1) }, recentMatches: [current] } });
    return Response.json({ data: current });
  };
  await pollMatchResults(now + 1, fetcher); // existing history is suppressed
  assert.equal(sent.length, 0);
  current = { ...match("EUW1_2"), gameStart: now - 1799000 };
  await Promise.all([pollMatchResults(now + 2000, fetcher), pollMatchResults(now + 2000, fetcher)]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(s => s.chat_id), [-2, -1]);
  assert.match(JSON.stringify(sent[0]!.reply_markup), /https:\/\/lol-tracker.cn.lt\/matches\/EUW1_2/);
  const restart = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const q = await import('./src/db/queries.ts');
    console.log(q.claimMatchResult(-1, 'EUW1_2', Date.now()));
  `], { encoding: "utf8" });
  assert.equal(restart.trim(), "false");
  await pollMatchResults(now + 2000, async () => { throw new Error("offline"); });
  assert.equal(sent.length, 2);
  current = { ...match("EUW1_3"), gameStart: now - 1798000 };
  failSend = true;
  await pollMatchResults(now + 3000, fetcher);
  failSend = false;
  await pollMatchResults(now + 3000, fetcher);
  assert.equal(sent.length, 2); // ambiguity never causes a duplicate
  q.deleteRiotLink(-1, 3);
  await pollMatchResults(now + 4000, fetcher);
  assert.equal(sent.length, 2);
});
