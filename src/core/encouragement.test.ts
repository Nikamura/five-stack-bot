import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseEncouragement, day, HOUR, type SharedGame, type UsedEncouragement } from "./encouragement.js";
const now = Date.parse("2026-09-06T18:00:00Z");
const games = (n: number, at = now - HOUR, win = true): SharedGame[] => Array.from({ length: n }, (_, i) => ({ id: `${at}-${i}`, at: at - i * HOUR, win }));
test("Vilnius rollover and unchanged facts cannot be recycled as another category", () => {
  assert.equal(day(Date.parse("2026-09-06T21:01:00Z")), "2026-09-07");
  const gs = games(3);
  const a = chooseEncouragement(gs, [], now)!;
  assert.equal(a.category, "today");
  assert.equal(chooseEncouragement(gs, [{ ...a, at: now }], now + HOUR), null);
  assert.equal(chooseEncouragement(gs, [{ ...a, at: now }], now + 24 * HOUR)?.category, "invite");
});
test("daily sequence rotates categories and phrases on fresh events; losses stay light", () => {
  const history: UsedEncouragement[] = [];
  let gs: SharedGame[] = [];
  for (let d = 0; d < 5; d++) {
    const time = now + d * 24 * HOUR;
    if (d !== 3) gs = [...games(3, time - HOUR, d !== 4), ...gs];
    const value = chooseEncouragement(gs, history, time)!;
    history.unshift({ ...value, at: time });
  }
  assert.deepEqual(history.toReversed().map(h => h.category), ["today", "wins", "today", "invite", "today"]);
  assert.match(history[0]!.text, /0–3.*Who’s up/);
  assert.notEqual(history[2]!.phrase, history[4]!.phrase);
  assert.match(history[3]!.text, /last 6 recorded/);
});
test("stale/empty history produces varied invitations; tiny samples never imply a streak", () => {
  assert.equal(chooseEncouragement(games(1), [], now)?.category, "today");
  const a = chooseEncouragement(games(3, now - 49 * HOUR), [], now)!;
  assert.equal(a.category, "invite");
  const b = chooseEncouragement([], [{ ...a, at: now }], now + 24 * HOUR)!;
  assert.notEqual(a.text, b.text);
});

test("fresh last play day includes its earlier games outside the 48-hour cutoff", () => {
  const time = Date.parse("2026-09-06T18:00:00Z");
  const gs = [
    { id: "late", at: Date.parse("2026-09-04T19:00:00Z"), win: true },
    { id: "early", at: Date.parse("2026-09-04T10:00:00Z"), win: false },
  ];
  const value = chooseEncouragement(gs, [], time)!;
  assert.equal(value.category, "last-day");
  assert.match(value.text, /2026-09-04: 1–1 recorded/);
});
