import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderGameOn,
  renderGameOnKeyboard,
  renderLoadUp,
  renderT15,
  THREE_V_THREE_THRESHOLD,
} from "./render.js";
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

describe("renderGameOn party mode", () => {
  const roster: RosterMember[] = [1, 2, 3, 4, 5, 6].map((id) => ({
    chat_id: 1,
    telegram_user_id: id,
    username: `u${id}`,
    display_name: `U${id}`,
    added_at: 0,
  }));

  it("swaps the headline to PARTY MODE when on", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 6,
      coreIds: [1, 2, 3, 4, 5, 6],
      alternateIds: [],
      roster,
      availableAtSlot: 6,
      partyMode: true,
    });
    assert.match(out, /PARTY MODE 21:00/);
    assert.match(out, /6-stack custom/);
  });

  it("suppresses the 3v3 hint while party mode is on", () => {
    const out = renderGameOn({
      slot: 1260,
      size: 6,
      coreIds: [1, 2, 3, 4, 5, 6],
      alternateIds: [],
      roster,
      availableAtSlot: 6,
      partyMode: true,
    });
    assert.doesNotMatch(out, /3v3/);
    assert.doesNotMatch(out, /players available/);
  });
});

describe("renderGameOnKeyboard party-mode button", () => {
  it("omits the party-mode button when ineligible and off", () => {
    const kb = renderGameOnKeyboard({
      sessionId: 7,
      partyMode: false,
      partyModeAvailable: false,
    });
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(labels, ["⏰ I'll be 15 min late"]);
  });

  it("offers party mode when eligible and off", () => {
    const kb = renderGameOnKeyboard({
      sessionId: 7,
      partyMode: false,
      partyModeAvailable: true,
    });
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((l) => l.includes("Play as 6")));
  });

  it("offers a 'switch back' label when party mode is on", () => {
    const kb = renderGameOnKeyboard({
      sessionId: 7,
      partyMode: true,
      partyModeAvailable: true,
    });
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((l) => l.includes("Party mode ON")));
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
});
