import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartyPlan, evaluateLock, tallySlots, type SlotTally } from "./lock.js";
import type { VoteRow } from "../db/types.js";
function tallies(entries: [number, number[]][], fillers = new Set<number>()): SlotTally[] {
  const votes: VoteRow[] = entries.flatMap(([slot, ids]) => ids.map(id => ({ session_id: 1, telegram_user_id: id, slot_minutes: slot, value: "yes", voted_at: id })));
  return tallySlots({ slots: entries.map(([slot]) => slot), votes, rosterIds: new Set([1,2,3,4,5,6]), skipIds: new Set(), fillerIds: fillers });
}
test("three separate 3/4/5 parties never move the initial trio to the later five", () => {
  const t = tallies([[930,[1,2,3]],[960,[1,2,3]],[990,[1,2,3,4]],[1020,[1,2,3,4]],[1050,[1,2,3,4,5]]], new Set([4]));
  const plan = buildPartyPlan({ tallies: t, validStacks: [5,4,3] });
  assert.deepEqual(plan.map(p => [p.slot,p.endSlot,p.size]), [[930,990,3],[990,1050,4],[1050,1080,5]]);
  assert.deepEqual(plan[1]!.fillerIds, [4]);
  assert.equal(evaluateLock({ tallies: t.toReversed(), validStacks: [5,4,3] }).slot, 930);
});
test("separated trios and a different lineup become separate windows", () => {
  const t = tallies([[780,[1,2,3]],[810,[1,2,3]],[840,[]],[1020,[1,2,3]],[1050,[1,2,4]]]);
  const plan = buildPartyPlan({ tallies: t, validStacks: [5,4,3] });
  assert.deepEqual(plan.map(p => [p.slot,p.endSlot,p.size]), [[780,840,3],[1020,1050,3],[1050,1080,3]]);
});
test("later counts don't carry departed people forward; disabled sizes stay disabled", () => {
  const t = tallies([[930,[1,2,3]],[990,[1,2,4,5]]]);
  assert.deepEqual(buildPartyPlan({ tallies:t, validStacks:[5,3] }).map(p => p.size), [3,3]);
  assert.deepEqual(buildPartyPlan({ tallies:t, validStacks:[5,4,3] }).map(p => p.size), [3,4]);
});
test("started parties remain history while future windows recompute", () => {
  const previous = buildPartyPlan({ tallies:tallies([[780,[1,2,3]],[810,[1,2,3]],[1020,[1,2,3]]]), validStacks:[3,4] });
  const next = buildPartyPlan({ previous, firstFutureSlot:810, tallies:tallies([[780,[]],[810,[1,2,3,4]],[1020,[]]]), validStacks:[4,3] });
  assert.deepEqual(next.map(p => [p.slot,p.endSlot,p.size]), [[780,810,3],[810,840,4]]);
  assert.deepEqual(next[0]!.core, [1,2,3]);
});
test("earlier soft start wins over a later confirmed party", () => {
  const t = tallies([[930,[1,2,3]],[990,[1,2,3,5]]], new Set([3]));
  assert.equal(evaluateLock({ tallies:t, validStacks:[4,3] }).slot,930);
});
