import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "five-stack-bulk-"));
process.env.BOT_TOKEN = "123:test-only";
process.env.DB_PATH = join(dir, "test.db");
const q = await import("../db/queries.js");
const { db } = await import("../db/index.js");
const { linkAccountsBulk } = await import("./accountLinkBulk.js");
const link = (name: string) => ({ origin: "https://lol-tracker.cn.lt", puuid: name.toLowerCase(), gameName: name, tagLine: "EUW", platform: "euw1" });
const resolve = async (name: string) => link(name);
test("bulk resolves then saves atomically; repeats/swaps work and failures preserve old links", async () => {
  try {
    q.getOrCreateChat(1);
    for (const id of [10, 11, 12]) q.addRosterMember(1, id, null, `Friend ${id}`);
    q.setRiotLink(1, 10, link("Old"));
    const batch = "10 A#EUW euw1\n11 B#EUW euw1";
    const result = await linkAccountsBulk(1, 10, batch, resolve);
    assert.match(result, /Linked 2 accounts/);
    assert.match(result, /Friend 11 \(11\) → B#EUW/);
    assert.deepEqual(q.getRiotLinks(1).map(l => l.puuid), ["a", "b"]);
    await linkAccountsBulk(1, 10, batch, resolve);
    assert.equal(q.getRiotLinks(1).length, 2);
    await linkAccountsBulk(1, 10, "10 B#EUW euw1\n11 A#EUW euw1", resolve);
    assert.deepEqual(q.getRiotLinks(1).map(l => l.puuid), ["b", "a"]);
    q.setRiotLink(1, 12, link("Outside"));
    const before = q.getRiotLinks(1);
    const auditCount = () => (db.prepare("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n;
    const audits = auditCount();
    // First row would change successfully; second conflicts with an untouched member.
    await assert.rejects(linkAccountsBulk(1, 10, "10 New#EUW euw1\n11 Outside#EUW euw1", resolve), /Couldn’t save/);
    assert.deepEqual(q.getRiotLinks(1), before);
    assert.equal(auditCount(), audits);
    await assert.rejects(linkAccountsBulk(1, 10, batch, async name => {
      if (name === "B") throw new Error("tracker timeout");
      return link("New");
    }), /Couldn’t resolve B/);
    assert.deepEqual(q.getRiotLinks(1), before);
    await assert.rejects(linkAccountsBulk(1, 10, "10 A#EUW euw1\n11 a#EUW euw1", resolve), /same Riot account/);
    let calls = 0;
    const counted = async (name: string) => { calls++; return link(name); };
    await assert.rejects(linkAccountsBulk(1, 10, "99 A#EUW euw1", counted), /isn’t in this chat/);
    await assert.rejects(linkAccountsBulk(2, 10, batch, counted), /Join this chat/);
    await assert.rejects(linkAccountsBulk(1, 99, batch, counted), /Join this chat/);
    await assert.rejects(linkAccountsBulk(1, 10, "10 A#EUW euw1\nbad", counted), /Line 2/);
    assert.equal(calls, 0);
    assert.deepEqual(q.getRiotLinks(1), before);
    assert.equal(auditCount(), audits);
    // A roster change during resolution is checked again inside the transaction.
    await assert.rejects(linkAccountsBulk(1, 10, batch, async name => {
      if (name === "B") q.removeRosterMember(1, 11);
      return link("New" + name);
    }), /Couldn’t save/);
    assert.equal(q.getRiotLinks(1)[0]?.puuid, "b");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
