import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSessionBody, renderSessionKeyboard, wizardStep2Text, wizardStep3Text } from "./render.js";
import { tallySlots } from "./lock.js";
import type { RosterMember, SessionRow, VoteRow } from "../db/types.js";

const session: SessionRow = {
  id: 1, chat_id: 1, opener_user_id: 1, opener_display_name: "One & friends",
  start_minutes: 720, end_minutes: 840, opened_at: 0, archive_at: 1000,
  archived_at: null, poll_message_id: 1, game_on_message_id: null,
};
const roster: RosterMember[] = ["One", "Two", "Three", "Four", "Five"].map((name, index) => ({
  chat_id: 1, telegram_user_id: index + 1, username: name.toLowerCase(), display_name: name, added_at: 0,
}));
const vote = (id: number, slot: number, value: VoteRow["value"]): VoteRow => ({
  session_id: 1, telegram_user_id: id, slot_minutes: slot, value, voted_at: id,
});

function body(votes: VoteRow[], skipIds = new Set<number>(), fillerIds = new Set<number>()) {
  return renderSessionBody({
    session, roster,
    tallies: tallySlots({ slots: [720, 750, 780, 810], votes,
      rosterIds: new Set(roster.map((member) => member.telegram_user_id)), skipIds, fillerIds }),
    lock: null, validStacks: [5, 3, 2], skipIds, fillerIds, totalSlots: 4, spectatorCount: 0,
  });
}

describe("v2 availability summary", () => {
  it("shows unknown people as unanswered without inventing declines", () => {
    const output = body([vote(1, 780, "yes"), vote(99, 780, "yes")]);
    assert.match(output, /Saved replies: <b>1\/5<\/b>/);
    assert.match(output, /✅ One \(13:00\)/);
    assert.doesNotMatch(output, /13:00-13:30|❌|Tap a slot|cycle/);
    assert.match(output, /Not answered: @two @three @four @five/);
    assert.match(output, /Picker changes count only after <b>Save<\/b>/);
    assert.match(output, /Can’t play tonight<\/b> here to decline all remaining start times immediately/);
    assert.match(output, /Start times: <b>12:00–13:30<\/b>/);
    assert.match(output, /One &amp; friends/);
  });

  it("renders inclusive candidate starts, mixed answers, filler and skipped state", () => {
    const output = body([
      vote(1, 720, "yes"), vote(1, 750, "yes"), vote(1, 810, "maybe"), vote(1, 780, "no"),
      vote(2, 780, "yes"), vote(2, 810, "maybe"),
    ], new Set([3]), new Set([2]));
    assert.match(output, /✅ One \(12:00-12:30\)/);
    assert.match(output, /🤷 One \(13:30\)/);
    assert.match(output, /🛟 Two \(13:00-13:30\)/);
    assert.match(output, /❌ One \(13:00\), Three \(skipped\)/);
    assert.match(output, /Saved replies: <b>3\/5<\/b>/);
    assert.match(output, /Not answered: @four @five/);
  });

  it("keeps the direct No button available with or without a configured picker", () => {
    const keyboard = renderSessionKeyboard({ sessionId: 1, miniAppUrl: "https://t.me/TestBot?startapp=s1_signed" });
    assert.deepEqual(keyboard.inline_keyboard, [[{
      text: "📅 Set my availability", url: "https://t.me/TestBot?startapp=s1_signed",
    }], [{ text: "🚫 Can’t play tonight", callback_data: "vbn:1" }], [{ text: "🔔 Remind non-voters", callback_data: "vr:1" }]]);
    assert.doesNotMatch(JSON.stringify(keyboard), /web_app|vbay|vfill|"v:|"v2:/);
    assert.deepEqual(renderSessionKeyboard({ sessionId: 1 }).inline_keyboard, [[{
      text: "📅 Set my availability", callback_data: "app:setup:1",
    }], [{ text: "🚫 Can’t play tonight", callback_data: "vbn:1" }], [{ text: "🔔 Remind non-voters", callback_data: "vr:1" }]]);
  });

  it("explains the excluded setup endpoint and confirms the actual possible starts", () => {
    assert.match(wizardStep2Text(720), /selected end is excluded/);
    assert.match(wizardStep3Text({ startMinutes: 720, endMinutes: 1320, validStacks: [5, 3, 2], rosterSize: 5 }), /12:00–21:30/);
    assert.match(wizardStep3Text({ startMinutes: 780, endMinutes: 810, validStacks: [2], rosterSize: 2 }), /start times 13:00 tonight/);
  });
});
