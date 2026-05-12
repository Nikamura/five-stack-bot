import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateLock, nextVote, tallySlots, tentativeLock, diffLock } from "./lock.js";
import type { VoteRow, VoteValue } from "../db/types.js";

function vote(uid: number, slot: number, value: VoteValue, voted_at: number): VoteRow {
  return { session_id: 1, telegram_user_id: uid, slot_minutes: slot, value, voted_at };
}

describe("tallySlots", () => {
  it("counts roster votes only", () => {
    const slots = [1080, 1110]; // 18:00, 18:30
    const roster = new Set([1, 2, 3]);
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(99, 1080, "yes", 3), // non-roster
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    assert.equal(t[0]!.yes, 2);
    assert.equal(t[0]!.notVoted, 1);
  });

  it("treats skipped roster members as no", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3]);
    const t = tallySlots({
      slots,
      votes: [vote(1, 1080, "yes", 1)],
      rosterIds: roster,
      skipIds: new Set([2]),
      fillerIds: new Set(),
    });
    assert.equal(t[0]!.yes, 1);
    assert.equal(t[0]!.no, 1); // user 2 (skipped) counts as no
    assert.equal(t[0]!.notVoted, 1); // user 3 has not voted and not skipped
  });

  it("pools a filler's ✅/🤷 into fillerAvailable, not yes/maybe", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3]);
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),    // filler ✅ → fillerAvailable
      vote(3, 1080, "maybe", 3),  // filler 🤷 → fillerAvailable
    ];
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([2, 3]),
    });
    assert.equal(t[0]!.yes, 1);
    assert.equal(t[0]!.maybe, 0);
    assert.equal(t[0]!.fillerAvailable, 2);
    assert.deepEqual(t[0]!.fillerAvailableUserIds, [2, 3]);
  });

  it("a filler's ❌ is still a no", () => {
    const slots = [1080];
    const roster = new Set([1, 2]);
    const t = tallySlots({
      slots,
      votes: [vote(2, 1080, "no", 1)],
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([2]),
    });
    assert.equal(t[0]!.no, 1);
    assert.equal(t[0]!.fillerAvailable, 0);
  });
});

describe("evaluateLock", () => {
  const stacks = [5, 3, 2];

  it("locks 5-stack at earliest slot when achievable", () => {
    const slots = [1080, 1110, 1140];
    const roster = new Set([1, 2, 3, 4, 5]);
    const votes: VoteRow[] = [
      // 5 yes on first slot
      ...[1, 2, 3, 4, 5].map((u, i) => vote(u, 1080, "yes", i + 1)),
      // and on second too
      ...[1, 2, 3, 4, 5].map((u, i) => vote(u, 1110, "yes", 100 + i)),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.slot, 1080);
    assert.equal(r.size, 5);
    assert.deepEqual(r.core, [1, 2, 3, 4, 5]);
  });

  it("waits for 5-stack while it's still possible (a player hasn't voted)", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 3 yes votes; 2 players haven't voted — 5-stack still mathematically possible.
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.slot, null);
    assert.equal(r.size, null);
  });

  it("falls back to 3-stack when 5-stack is mathematically dead", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 3 yes, 2 no (so 5-stack is impossible). Should lock 3-stack.
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "no", 4),
      vote(5, 1080, "no", 5),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.slot, 1080);
    assert.equal(r.size, 3);
    assert.deepEqual(r.core, [1, 2, 3]);
  });

  it("4-stack is skipped (default validStacks excludes 4)", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 4 yes, 1 no — 5-stack dead, but 4 is excluded so falls to 3-stack.
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "yes", 4),
      vote(5, 1080, "no", 5),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 3);
    assert.deepEqual(r.core, [1, 2, 3]); // first 3 yes voters by vote_at
  });

  it("alternates ranked by vote time after the core", () => {
    const slots = [1080];
    // 6 yes votes — first 5 in chronological order are core, 6th is alternate.
    const votes: VoteRow[] = [
      vote(10, 1080, "yes", 1),
      vote(20, 1080, "yes", 2),
      vote(30, 1080, "yes", 3),
      vote(40, 1080, "yes", 4),
      vote(50, 1080, "yes", 5),
      vote(60, 1080, "yes", 6),
    ];
    const r = evaluateLock({
      tallies: tallySlots({
        slots,
        votes,
        rosterIds: new Set([10, 20, 30, 40, 50, 60]),
        skipIds: new Set(),
        fillerIds: new Set(),
      }),
      validStacks: stacks,
    });
    assert.equal(r.size, 5);
    assert.deepEqual(r.core, [10, 20, 30, 40, 50]);
    assert.deepEqual(r.alternates, [60]);
  });

  it("/lfp-skip releases the wait so a 3-stack can lock", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 3 yes votes, 1 no — without skip, 5-stack still possible (1 unvoted).
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "no", 4),
    ];
    // user 5 hasn't voted. Skip them.
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set([5]),
      fillerIds: new Set(),
    });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 3);
  });

  it("a filler completes a 5-stack when only 4 real ✅ are in", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "yes", 4),
      vote(5, 1080, "yes", 5), // filler ✅ → fills the 5th seat
    ];
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([5]),
    });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 5);
    // Real ✅ voters rank ahead of the filler.
    assert.deepEqual(r.core, [1, 2, 3, 4, 5]);
    assert.deepEqual(r.alternates, []);
  });

  it("a 6th real ✅ bumps the filler out of the locked party", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5, 6]);
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "yes", 4),
      vote(5, 1080, "yes", 5), // filler ✅
      vote(6, 1080, "yes", 6), // real ✅ arrived after filler
    ];
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([5]),
    });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 5);
    // 5 real ✅ form the core regardless of vote order, filler is alternate.
    assert.deepEqual(r.core, [1, 2, 3, 4, 6]);
    assert.deepEqual(r.alternates, [5]);
  });

  it("a filler 🤷 also counts toward filler help (treated as 'play if pushed')", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "yes", 4),
      vote(5, 1080, "maybe", 5), // filler 🤷 → treated as fillable
    ];
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([5]),
    });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 5);
    assert.deepEqual(r.core, [1, 2, 3, 4, 5]);
  });

  it("does not lock if even filler help isn't enough and stack still in play", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 3 real ✅ + 1 filler 🤷 + 1 not voted. yes+filler = 4 < 5. Still in play.
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "yes", 3),
      vote(4, 1080, "maybe", 4),
    ];
    const t = tallySlots({
      slots,
      votes,
      rosterIds: roster,
      skipIds: new Set(),
      fillerIds: new Set([4]),
    });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.slot, null);
  });

  it("locks 2-stack only when nothing larger is possible", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    // 2 yes, 3 no — 5 and 3 dead, 2 lockable.
    const votes: VoteRow[] = [
      vote(1, 1080, "yes", 1),
      vote(2, 1080, "yes", 2),
      vote(3, 1080, "no", 3),
      vote(4, 1080, "no", 4),
      vote(5, 1080, "no", 5),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.size, 2);
  });

  it("returns no-lock when nothing is possible at all", () => {
    const slots = [1080];
    const roster = new Set([1, 2, 3, 4, 5]);
    const votes: VoteRow[] = [
      ...[1, 2, 3, 4, 5].map((u, i) => vote(u, 1080, "no", i + 1)),
    ];
    const t = tallySlots({ slots, votes, rosterIds: roster, skipIds: new Set(), fillerIds: new Set() });
    const r = evaluateLock({ tallies: t, validStacks: stacks });
    assert.equal(r.slot, null);
  });
});

describe("nextVote 3-state cycle", () => {
  it("null → yes → maybe → no → yes", () => {
    assert.equal(nextVote(null), "yes");
    assert.equal(nextVote("yes"), "maybe");
    assert.equal(nextVote("maybe"), "no");
    assert.equal(nextVote("no"), "yes");
  });
});

describe("tentativeLock", () => {
  const stacks = [5, 3, 2];
  it("returns the largest reachable stack at the earliest slot", () => {
    const slots = [1080, 1110];
    // 2 yes at 18:00; 3 yes at 18:30 — 3-stack reachable at 18:30, 2 at 18:00.
    const t = tallySlots({
      slots,
      votes: [
        { session_id: 1, telegram_user_id: 1, slot_minutes: 1080, value: "yes", voted_at: 1 },
        { session_id: 1, telegram_user_id: 2, slot_minutes: 1080, value: "yes", voted_at: 2 },
        { session_id: 1, telegram_user_id: 1, slot_minutes: 1110, value: "yes", voted_at: 3 },
        { session_id: 1, telegram_user_id: 2, slot_minutes: 1110, value: "yes", voted_at: 4 },
        { session_id: 1, telegram_user_id: 3, slot_minutes: 1110, value: "yes", voted_at: 5 },
      ],
      rosterIds: new Set([1, 2, 3, 4, 5]),
      skipIds: new Set(),
      fillerIds: new Set(),
    });
    const tent = tentativeLock({ tallies: t, validStacks: stacks });
    assert.equal(tent?.size, 3);
    assert.equal(tent?.slot, 1110);
  });
  it("returns null when no slot reaches even the smallest stack", () => {
    const t = tallySlots({
      slots: [1080],
      votes: [
        { session_id: 1, telegram_user_id: 1, slot_minutes: 1080, value: "yes", voted_at: 1 },
      ],
      rosterIds: new Set([1, 2, 3, 4, 5]),
      skipIds: new Set(),
      fillerIds: new Set(),
    });
    assert.equal(tentativeLock({ tallies: t, validStacks: stacks }), null);
  });
});

describe("diffLock", () => {
  it("detects a new lock", () => {
    const d = diffLock(
      { slot: null, size: null, core: [], alternates: [] },
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 5], alternates: [] },
    );
    assert.equal(d.kind, "new");
  });

  it("detects a lineup change at same slot/size", () => {
    const d = diffLock(
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 5], alternates: [] },
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 6], alternates: [] },
    );
    assert.equal(d.kind, "changed");
    if (d.kind === "changed") assert.equal(d.lineupChanged, true);
  });

  it("detects dissolution", () => {
    const d = diffLock(
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 5], alternates: [] },
      { slot: null, size: null, core: [], alternates: [] },
    );
    assert.equal(d.kind, "dissolved");
  });

  it("unchanged when same lock", () => {
    const d = diffLock(
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 5], alternates: [] },
      { slot: 1080, size: 5, core: [1, 2, 3, 4, 5], alternates: [] },
    );
    assert.equal(d.kind, "unchanged");
  });
});
