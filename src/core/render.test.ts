import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderGameOn, THREE_V_THREE_THRESHOLD } from "./render.js";
import type { RosterMember } from "../db/types.js";

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
