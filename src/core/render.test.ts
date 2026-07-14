import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderGameOn,
  renderLoadUp,
  renderPartyDelayed,
  renderT15,
  THREE_V_THREE_THRESHOLD,
} from "./render.js";
import type { RosterMember } from "../db/types.js";
import { mentionByIdsWithLate } from "./mention.js";

function member(id: number, name: string): RosterMember {
  return {
    chat_id: 1,
    telegram_user_id: id,
    username: name.toLowerCase(),
    display_name: name,
    added_at: 0,
  };
}

describe("renderGameOn 3v3 suggestion", () => {
  const roster = [
    member(1, "Karolis"),
    member(2, "Tomas"),
    member(3, "Mantas"),
    member(4, "Justas"),
    member(5, "Aurimas"),
    member(6, "Ignas"),
  ];

  it("appends the 3v3 hint when 6+ players are available", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 5,
      coreIds: [1, 2, 3, 4, 5],
      alternateIds: [6],
      roster,
      availableAtSlot: 6,
    });
    assert.match(out, /6 players available/);
    assert.match(out, /3v3 Summoner's Rift or ARAM/);
  });

  it("omits the hint when fewer than 6 are available", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 5,
      coreIds: [1, 2, 3, 4, 5],
      alternateIds: [],
      roster,
      availableAtSlot: 5,
    });
    assert.doesNotMatch(out, /players available/);
    assert.doesNotMatch(out, /3v3/);
  });

  it("omits the hint when availableAtSlot is not provided", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 5,
      coreIds: [1, 2, 3, 4, 5],
      alternateIds: [6],
      roster,
    });
    assert.doesNotMatch(out, /3v3/);
  });

  it("shows the actual count when more than 6 are available", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 5,
      coreIds: [1, 2, 3, 4, 5],
      alternateIds: [6],
      roster,
      availableAtSlot: 7,
    });
    assert.match(out, /7 players available/);
  });

  it("exports the threshold constant for callers", () => {
    assert.equal(THREE_V_THREE_THRESHOLD, 6);
  });
});

describe("renderGameOn upgrade nudge", () => {
  const roster = [
    member(1, "Karolis"),
    member(2, "Tomas"),
    member(3, "Mantas"),
    member(4, "Justas"),
    member(5, "Aurimas"),
  ];

  it("tags unvoted players when the lock is below the next enabled stack", () => {
    const out = renderGameOn({
      slot: 1170,
      size: 4,
      coreIds: [1, 2, 3, 4],
      alternateIds: [],
      roster,
      unvotedIds: [5],
      upgradeTarget: 5,
    });
    assert.match(out, /@aurimas/);
    assert.match(out, /upgrade to a 5-stack/);
    assert.match(out, /19:30/);
  });

  it("omits the nudge when the lock is already at the largest enabled stack", () => {
    const out = renderGameOn({
      slot: 1170,
      size: 5,
      coreIds: [1, 2, 3, 4, 5],
      alternateIds: [],
      roster,
      unvotedIds: [],
      upgradeTarget: null,
    });
    assert.doesNotMatch(out, /upgrade/);
  });

  it("omits the nudge when no roster members are still pending", () => {
    const out = renderGameOn({
      slot: 1170,
      size: 4,
      coreIds: [1, 2, 3, 4],
      alternateIds: [],
      roster,
      unvotedIds: [],
      upgradeTarget: 5,
    });
    assert.doesNotMatch(out, /upgrade/);
  });
});

describe("T-15 vs Load up wording", () => {
  it("renderT15 keeps the 15-min headline", () => {
    assert.match(renderT15("@a @b"), /15 min — boot up/);
  });

  it("renderLoadUp drops the 15-min wording", () => {
    const out = renderLoadUp("@a @b");
    assert.doesNotMatch(out, /15 min/);
    assert.match(out, /Load up/);
  });

  it("keeps a late annotation in the T-15 party list", () => {
    const roster = [member(1, "A"), member(2, "B")];
    const mentions = mentionByIdsWithLate(
      roster,
      [1, 2],
      new Map([[2, 15]]),
    );
    const out = renderT15(mentions);
    assert.match(out, /@b <i>\(15 min late\)<\/i>/);
  });

  it("renders a separate delay notice when no enabled stack is ready", () => {
    const out = renderPartyDelayed({
      readyCount: 1,
      lateMentions: "@b @c",
      delayMinutes: 15,
    });
    assert.match(out, /Party delayed 15 min/);
    assert.match(out, /1 on-time player is not enough/);
    assert.match(out, /Waiting for @b @c/);
  });
});
