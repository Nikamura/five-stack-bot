import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../web/contracts.js";

// A standalone test database and inert Telegram timers; never open live data.
const directory = mkdtempSync(join(tmpdir(), "five-stack-availability-"));
process.env.DB_PATH = join(directory, "test.sqlite");
process.env.BOT_TOKEN = "123:test-token";
process.env.MINI_APP_URL = "";
const { db } = await import("../db/index.js");
const q = await import("../db/queries.js");
const { getAvailabilitySnapshot, saveAvailability, declineAvailability } = await import("./availability.js");

const user = { id: 1, username: "one", first_name: "One" };
const openedAt = Date.parse("2026-09-06T12:15:00Z");
let now = openedAt;
let sessionId = 0;

before(() => {
  mock.method(Date, "now", () => now);
  mock.timers.enable({ apis: ["setTimeout"] });
});

beforeEach(() => {
  now = openedAt;
  db.exec("DELETE FROM chats");
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

function isError(status: number, code: string) {
  return (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;
}

async function input(votes: Array<{ slot: number; value: "yes" | "maybe" }>, filler = false) {
  const state = await getAvailabilitySnapshot(sessionId, user);
  return { expectedRevision: state.me.revision, votes, filler, unavailable: votes.length === 0 };
}

describe("availability service", () => {
  it("keeps untouched availability unknown and scopes the live snapshot to the roster", async () => {
    q.setVote(sessionId, 99, 780, "yes");
    const state = await getAvailabilitySnapshot(sessionId, user);
    assert.equal(state.me.responded, false);
    assert.deepEqual(state.players.map((player) => player.id), [1, 2]);
    assert.equal(state.slots.find((slot) => slot.minutes === 780)!.yes, 0);
    assert.equal(state.slots[0]!.notVoted, 2);
    assert.equal(state.slots[0]!.startsAt, Date.parse("2026-09-06T12:00:00Z"));
    assert.equal(state.session.date, "2026-09-06");
  });

  it("saves the complete future answer atomically, preserving past history and unchanged vote priority", async () => {
    q.setVote(sessionId, 1, 720, "maybe");
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, 2, 780, "yes");
    q.addSkip(sessionId, 1);
    const beforePast = q.getVote(sessionId, 1, 720);
    const beforeYes = q.getVote(sessionId, 1, 780);
    const otherVotes = q.getUserVotes(sessionId, 2);
    const request = await input([{ slot: 780, value: "yes" }, { slot: 810, value: "maybe" }], true);
    now += 1000;
    const state = await saveAvailability(sessionId, user, request);
    assert.deepEqual(q.getVote(sessionId, 1, 720), beforePast);
    assert.deepEqual(q.getVote(sessionId, 1, 780), beforeYes);
    assert.deepEqual(q.getUserVotes(sessionId, 2), otherVotes);
    assert.deepEqual(state.me.votes, [
      { slot: 720, value: "maybe" }, { slot: 750, value: "no" }, { slot: 780, value: "yes" },
      { slot: 810, value: "maybe" }, { slot: 840, value: "no" },
    ]);
    assert.equal(state.me.skipped, false);
    assert.equal(state.me.filler, true);
    assert.equal(state.me.responded, true);
  });

  it("supports explicit unavailable and clears filler mode", async () => {
    q.addFiller(sessionId, 1);
    const state = await saveAvailability(sessionId, user, await input([]));
    assert.equal(state.me.filler, false);
    assert.equal(state.me.votes.length, 4);
    assert.ok(state.me.votes.every((vote) => vote.value === "no"));
  });

  it("declines directly without a Mini App, preserves history, and conflicts with an older open picker", async () => {
    q.setVote(sessionId, 1, 720, "yes");
    q.setVote(sessionId, 1, 780, "maybe");
    q.setVote(sessionId, 2, 780, "yes");
    q.addSkip(sessionId, 1);
    q.addFiller(sessionId, 1);
    const oldPicker = await input([{ slot: 780, value: "yes" }]);
    const past = q.getVote(sessionId, 1, 720);
    const others = q.getUserVotes(sessionId, 2);
    const declined = await declineAvailability(sessionId, user);
    assert.equal(declined.me.skipped, false);
    assert.equal(declined.me.filler, false);
    assert.ok(declined.me.votes.filter((vote) => vote.slot > 720).every((vote) => vote.value === "no"));
    assert.deepEqual(q.getVote(sessionId, 1, 720), past);
    assert.deepEqual(q.getUserVotes(sessionId, 2), others);
    await assert.rejects(saveAvailability(sessionId, user, oldPicker), isError(409, "CONFLICT"));
    const savedRows = q.getUserVotes(sessionId, 1);
    now += 5000;
    assert.equal((await declineAvailability(sessionId, user)).me.revision, declined.me.revision);
    assert.deepEqual(q.getUserVotes(sessionId, 1), savedRows);
  });

  it("resolves a trusted synthetic roster member before a direct decline", async () => {
    q.addRosterMember(1, -123, "Future", "Future");
    q.setVote(sessionId, -123, 780, "maybe");
    q.addSkip(sessionId, -123);
    q.addFiller(sessionId, -123);
    const declined = await declineAvailability(sessionId, { id: 3, username: "future", first_name: "Future player" });
    assert.equal(q.getRosterMember(1, -123), null);
    assert.equal(declined.me.id, 3);
    assert.equal(declined.me.skipped, false);
    assert.equal(declined.me.filler, false);
    assert.ok(declined.me.votes.every((vote) => vote.value === "no"));
    assert.equal(declined.me.votes.length, 4);
  });

  it("rejects direct declines from outsiders, closed sessions, or sessions without future starts", async () => {
    await assert.rejects(declineAvailability(sessionId, { id: 99, username: "two", first_name: "Other" }), isError(403, "FORBIDDEN"));
    db.prepare("UPDATE sessions SET end_minutes = 750 WHERE id = ?").run(sessionId);
    await assert.rejects(declineAvailability(sessionId, user), isError(410, "CLOSED"));
    q.archiveSession(sessionId);
    await assert.rejects(declineAvailability(sessionId, user), isError(410, "CLOSED"));
    assert.deepEqual(q.getSessionVotes(sessionId), []);
  });

  it("rejects a competing save but accepts an identical stale retry without rewriting priority", async () => {
    const request = await input([{ slot: 780, value: "yes" }]);
    const different = { ...request, votes: [{ slot: 810, value: "maybe" }] };
    const [first, second] = await Promise.allSettled([
      saveAvailability(sessionId, user, request), saveAvailability(sessionId, user, different),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    if (second.status === "rejected") assert.ok(isError(409, "CONFLICT")(second.reason));
    const savedRows = q.getUserVotes(sessionId, 1);
    now += 5000;
    const retried = await saveAvailability(sessionId, user, request);
    assert.deepEqual(q.getUserVotes(sessionId, 1), savedRows);
    if (first.status === "fulfilled") assert.equal(retried.me.revision, first.value.me.revision);
  });

  it("does not conflict when someone else's committed availability changes", async () => {
    const request = await input([{ slot: 780, value: "yes" }]);
    q.setVote(sessionId, 2, 780, "maybe");
    const saved = await saveAvailability(sessionId, user, request);
    assert.equal(saved.slots.find((slot) => slot.minutes === 780)!.maybe, 1);
  });

  it("rejects malformed and past-time submissions without changing any answer", async () => {
    const request = await input([{ slot: 780, value: "yes" }]);
    for (const bad of [
      { ...request, userId: 2 }, { ...request, votes: [{ slot: 720, value: "yes" }] },
      { ...request, votes: [] }, { ...request, votes: [{ slot: 900, value: "yes" }] },
    ]) await assert.rejects(saveAvailability(sessionId, user, bad), isError(400, "INVALID_INPUT"));
    assert.equal(q.getUserVotes(sessionId, 1).length, 0);
  });

  it("allows only roster users and cannot claim an existing real user's username", async () => {
    await assert.rejects(getAvailabilitySnapshot(sessionId, { id: 99, username: "two", first_name: "Other" }), isError(403, "FORBIDDEN"));
    await assert.rejects(getAvailabilitySnapshot(sessionId, { id: -123, first_name: "Invalid" }), isError(403, "FORBIDDEN"));
    assert.ok(q.getRosterMember(1, 2));
    q.addRosterMember(1, -123, "Future", "Future");
    q.addSkip(sessionId, -123);
    q.setVote(sessionId, -123, 780, "maybe");
    const bound = await getAvailabilitySnapshot(sessionId, { id: 3, username: "future", first_name: "Bound" });
    assert.equal(bound.me.id, 3);
    assert.equal(bound.me.skipped, true);
    assert.deepEqual(bound.me.votes, [{ slot: 780, value: "maybe" }]);
    assert.equal(q.getRosterMember(1, -123), null);
    assert.equal(q.getRosterMember(1, 3)!.display_name, "Bound");
  });

  it("merges every legacy synthetic duplicate into an existing real identity without overriding its saved answer", async () => {
    // Bypass the fixed insertion helper to reproduce data created by v1.
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "ONE", "Old One", 1);
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -102, "one", "Duplicate One", 2);
    q.setVote(sessionId, 1, 720, "yes");
    q.setVote(sessionId, 1, 780, "yes");
    const actualPast = q.getVote(sessionId, 1, 720);
    const actualFuture = q.getVote(sessionId, 1, 780);
    now += 1000;
    q.setVote(sessionId, -101, 780, "no");
    q.setVote(sessionId, -101, 750, "maybe");
    q.setVote(sessionId, -102, 810, "maybe");
    q.addSkip(sessionId, -101);
    q.addFiller(sessionId, -102);
    const state = await getAvailabilitySnapshot(sessionId, user);
    assert.deepEqual(state.players.map((player) => player.id), [1, 2]);
    assert.deepEqual(q.getVote(sessionId, 1, 720), actualPast);
    assert.deepEqual(q.getVote(sessionId, 1, 780), actualFuture);
    assert.equal(q.getVote(sessionId, 1, 750)!.value, "maybe");
    assert.equal(q.getVote(sessionId, 1, 810)!.value, "maybe");
    assert.equal(state.me.skipped, false);
    assert.equal(state.me.filler, false);
    assert.deepEqual(q.getUserVotes(sessionId, -101), []);
    assert.deepEqual(q.getUserVotes(sessionId, -102), []);
    assert.equal(q.removeRosterMember(1, 1), true);
    await assert.rejects(getAvailabilitySnapshot(sessionId, user), isError(403, "FORBIDDEN"));
  });

  it("rejects a reused username owned by another real roster member before touching legacy duplicates", async () => {
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "ONE", "Legacy One", 1);
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, -101, 780, "maybe");
    q.setVote(sessionId, -101, 810, "maybe");
    q.addSkip(sessionId, -101);
    q.addFiller(sessionId, -101);
    const storedState = () => ({
      roster: q.getRoster(1),
      votes: q.getSessionVotes(sessionId),
      skips: [...q.getSkips(sessionId)],
      fillers: [...q.getFillers(sessionId)],
    });
    const before = storedState();
    const newHandleOwner = { id: 99, username: "one", first_name: "Different person" };
    await assert.rejects(getAvailabilitySnapshot(sessionId, newHandleOwner), isError(403, "FORBIDDEN"));
    assert.deepEqual(storedState(), before);
    await assert.rejects(declineAvailability(sessionId, newHandleOwner), isError(403, "FORBIDDEN"));
    assert.deepEqual(storedState(), before);
    assert.equal(q.getRosterMember(1, 99), null);

    // The stored real identity can still resolve its own duplicate safely.
    const owner = await getAvailabilitySnapshot(sessionId, user);
    assert.equal(owner.me.id, 1);
    assert.deepEqual(owner.players.map((player) => player.id), [1, 2]);
    assert.equal(q.getRosterMember(1, -101), null);
    assert.equal(q.getVote(sessionId, 1, 780)!.value, "yes");
    assert.equal(q.getVote(sessionId, 1, 810)!.value, "maybe");
    assert.equal(owner.me.skipped, false);
    assert.equal(owner.me.filler, false);
  });

  for (const newUsername of ["newone", null]) {
    it(`reconciles old placeholders before a verified username is ${newUsername ? "renamed" : "cleared"}`, async () => {
      db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "ONE", "Legacy One", 1);
      q.setVote(sessionId, 1, 780, "yes");
      const savedRealVote = q.getVote(sessionId, 1, 780);
      now += 1000;
      q.setVote(sessionId, -101, 780, "maybe");
      q.setVote(sessionId, -101, 810, "maybe");
      q.addSkip(sessionId, -101);
      q.addFiller(sessionId, -101);

      q.addRosterMember(1, 1, newUsername, "Current One");
      assert.equal(q.getRosterMember(1, 1)!.username, newUsername);
      assert.equal(q.getRosterMember(1, -101), null);
      assert.deepEqual(q.getVote(sessionId, 1, 780), savedRealVote);
      assert.equal(q.getVote(sessionId, 1, 810)!.value, "maybe");
      assert.equal(q.getSkips(sessionId).has(1), false);
      assert.equal(q.isFiller(sessionId, 1), false);
      const attacker = { id: 99, username: "one", first_name: "Old handle's new owner" };
      const storedState = () => ({
        roster: q.getRoster(1), votes: q.getSessionVotes(sessionId),
        skips: [...q.getSkips(sessionId)], fillers: [...q.getFillers(sessionId)],
      });
      const before = storedState();
      await assert.rejects(getAvailabilitySnapshot(sessionId, attacker), isError(403, "FORBIDDEN"));
      await assert.rejects(declineAvailability(sessionId, attacker), isError(403, "FORBIDDEN"));
      assert.deepEqual(storedState(), before);
      q.removeRosterMember(1, 1);
      const removed = storedState();
      await assert.rejects(getAvailabilitySnapshot(sessionId, attacker), isError(403, "FORBIDDEN"));
      await assert.rejects(declineAvailability(sessionId, attacker), isError(403, "FORBIDDEN"));
      assert.deepEqual(storedState(), removed);
      assert.equal(q.getRosterMember(1, 99), null);
    });
  }

  it("cleans both old and current username placeholders when authentication rebinds a renamed real member", async () => {
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "ONE", "Old placeholder", 1);
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -102, "NEWONE", "Current placeholder", 2);
    q.setVote(sessionId, 1, 780, "yes");
    const savedRealVote = q.getVote(sessionId, 1, 780);
    now += 1000;
    q.setVote(sessionId, -101, 780, "no");
    q.setVote(sessionId, -101, 750, "maybe");
    q.setVote(sessionId, -102, 780, "maybe");
    q.setVote(sessionId, -102, 810, "yes");
    q.addSkip(sessionId, -101);
    q.addFiller(sessionId, -102);

    const renamed = await getAvailabilitySnapshot(sessionId, { id: 1, username: "newone", first_name: "Current One" });
    assert.deepEqual(renamed.players.map((player) => player.id), [1, 2]);
    assert.equal(q.getRosterMember(1, 1)!.username, "newone");
    assert.equal(q.getRosterMember(1, -101), null);
    assert.equal(q.getRosterMember(1, -102), null);
    assert.deepEqual(q.getVote(sessionId, 1, 780), savedRealVote);
    assert.equal(q.getVote(sessionId, 1, 750)!.value, "maybe");
    assert.equal(q.getVote(sessionId, 1, 810)!.value, "yes");
    assert.equal(renamed.me.skipped, false);
    assert.equal(renamed.me.filler, false);
    const attacker = { id: 99, username: "one", first_name: "Old handle's new owner" };
    await assert.rejects(getAvailabilitySnapshot(sessionId, attacker), isError(403, "FORBIDDEN"));
    await assert.rejects(declineAvailability(sessionId, attacker), isError(403, "FORBIDDEN"));
    q.removeRosterMember(1, 1);
    await assert.rejects(getAvailabilitySnapshot(sessionId, attacker), isError(403, "FORBIDDEN"));
    await assert.rejects(declineAvailability(sessionId, attacker), isError(403, "FORBIDDEN"));
    assert.equal(q.getRosterMember(1, 99), null);
  });

  it("preserves placeholder state when the existing real roster entry has no saved response", async () => {
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "one", "Old One", 1);
    q.setVote(sessionId, -101, 780, "maybe");
    q.addSkip(sessionId, -101);
    q.addFiller(sessionId, -101);
    const state = await getAvailabilitySnapshot(sessionId, user);
    assert.equal(state.me.skipped, true);
    assert.equal(state.me.filler, true);
    assert.equal(q.getVote(sessionId, 1, 780)!.value, "maybe");
    assert.equal(q.getRosterMember(1, -101), null);
  });

  it("cleans unresolved legacy duplicates on removal so they cannot grant access again", async () => {
    db.prepare("INSERT INTO roster_members VALUES (?, ?, ?, ?, ?)").run(1, -101, "ONE", "Old One", 1);
    q.getOrCreateChat(2);
    q.addRosterMember(2, -101, "one", "Other group's One");
    assert.equal(q.findRosterByUsername(1, "one")!.telegram_user_id, 1);
    assert.equal(q.removeRosterMember(1, 1), true);
    assert.equal(q.getRosterMember(1, -101), null);
    assert.ok(q.getRosterMember(2, -101));
    await assert.rejects(declineAvailability(sessionId, user), isError(403, "FORBIDDEN"));
  });

  it("prevents a new mention-only entry from shadowing a known real member", () => {
    assert.equal(q.addRosterMember(1, -101, "ONE", "One"), false);
    assert.equal(q.getRosterMember(1, -101), null);
    assert.equal(q.getRoster(1).length, 2);
  });

  it("returns the persisted party and identifies skipped, mixed, and filler availability", async () => {
    q.setVote(sessionId, 1, 780, "yes");
    q.setVote(sessionId, 1, 810, "maybe");
    q.addFiller(sessionId, 1);
    q.addSkip(sessionId, 2);
    q.writeLock({ sessionId, slot: 780, size: 2, core: [1], alternates: [] });
    q.setLockLate(sessionId, 1, 15);
    const state = await getAvailabilitySnapshot(sessionId, user);
    assert.deepEqual(state.lock, { slot: 780, size: 2, core: [1], alternates: [] });
    assert.equal(state.players[0]!.lateMinutes, 15);
    assert.equal(state.players[1]!.skipped, true);
    assert.equal(state.players[1]!.responded, true);
    assert.equal(state.slots.find((slot) => slot.minutes === 780)!.filler, 1);
    assert.equal(state.slots.find((slot) => slot.minutes === 780)!.no, 1);
  });

  it("keeps the session date anchored after midnight and rejects closed saves", async () => {
    const request = await input([{ slot: 780, value: "yes" }]);
    now = Date.parse("2026-09-07T00:15:00Z");
    const closed = await getAvailabilitySnapshot(sessionId, user);
    assert.equal(closed.session.closed, true);
    assert.equal(closed.session.date, "2026-09-06");
    assert.equal(closed.slots[0]!.startsAt, Date.parse("2026-09-06T12:00:00Z"));
    await assert.rejects(saveAvailability(sessionId, user, request), isError(410, "CLOSED"));
    now = openedAt;
    q.archiveSession(sessionId);
    await assert.rejects(saveAvailability(sessionId, user, request), isError(410, "CLOSED"));
    await assert.rejects(getAvailabilitySnapshot(999999, user), isError(404, "NOT_FOUND"));
  });

  it("rolls back the whole answer, filler, and skip if a database write fails", () => {
    q.addSkip(sessionId, 1);
    q.setVote(sessionId, 1, 780, "yes");
    const beforeRows = q.getUserVotes(sessionId, 1);
    db.exec(`CREATE TEMP TRIGGER fail_maybe BEFORE INSERT ON votes WHEN NEW.value = 'maybe'
      BEGIN SELECT RAISE(ABORT, 'test save failure'); END;`);
    try {
      assert.throws(() => q.saveUserAvailability({ sessionId, userId: 1, filler: true, votes: [
        { slot: 750, value: "no" }, { slot: 780, value: "maybe" },
      ] }), /test save failure/);
      assert.deepEqual(q.getUserVotes(sessionId, 1), beforeRows);
      assert.equal(q.isFiller(sessionId, 1), false);
      assert.equal(q.getSkips(sessionId).has(1), true);
    } finally {
      db.exec("DROP TRIGGER fail_maybe");
    }
  });
});
