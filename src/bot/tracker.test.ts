import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedGames, TRACKER_ORIGIN, type AccountLink } from "./tracker.js";
const now = Date.now();
const links: AccountLink[] = ["a", "b"].map(puuid => ({ origin: TRACKER_ORIGIN, puuid, gameName: puuid, tagLine: "EUW", platform: "euw1" }));
function fixture(options: { stale?: boolean; capped?: boolean; opposing?: boolean; fail?: boolean; remake?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    assert.ok(init?.signal);
    if (options.fail) return new Response("", { status: 500 });
    const id = url.pathname.split("/").at(-1);
    if (url.pathname.includes("/players/")) {
      assert.equal(url.searchParams.get("queue"), "flex");
      assert.equal(url.searchParams.get("recentLimit"), "50");
      return Response.json({ data: { player: { puuid: id, lastPolledAt: options.stale ? now - 86400000 : now }, headline: { games: options.capped ? 51 : 1 }, recentMatches: [{ matchId: "m" }] } });
    }
    return Response.json({ data: { matchId: "m", gameStart: now - 1000000, gameDuration: options.remake ? 100 : 1800, queueId: 440, participants: links.map((l, i) => ({ puuid: l.puuid, teamId: options.opposing && i ? 200 : 100, win: true })) } });
  };
  return { fetcher, requests };
}
test("shared match counted once with team verification and fixed queue", async () => {
  const f = fixture();
  assert.equal((await sharedGames(links, now, f.fetcher)).length, 1);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(await sharedGames(links, now, fixture({ opposing: true }).fetcher), []);
});
test("missing links, stale/capped data, remakes and API failures fail closed", async () => {
  const f = fixture();
  assert.deepEqual(await sharedGames(links.slice(0, 1), now, f.fetcher), []);
  assert.equal(f.requests.length, 0);
  for (const options of [{ stale: true }, { capped: true }, { fail: true }, { remake: true }]) {
    assert.deepEqual(await sharedGames(links, now, fixture(options).fetcher), []);
  }
  assert.deepEqual(await sharedGames(links, now, async () => { throw new Error("network"); }), []);
  assert.deepEqual(await sharedGames(links, now, async () => Response.json({ data: {} })), []);
});
test("one overall timeout terminates an unresponsive tracker", async () => {
  const started = Date.now();
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    const hold = setTimeout(() => reject(new Error("test watchdog")), 4000);
    init!.signal!.addEventListener("abort", () => { clearTimeout(hold); reject(new Error("aborted")); });
  });
  assert.deepEqual(await sharedGames(links, now, fetcher), []);
  assert.ok(Date.now() - started < 3500);
});
