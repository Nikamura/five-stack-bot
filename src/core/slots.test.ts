import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlots,
  compressSlotRanges,
  formatSlot,
  parseLfpArgs,
  parseRangeArg,
  parseStacksArg,
} from "./slots.js";

describe("buildSlots", () => {
  it("18-23 → 10 slots ending at 22:30", () => {
    const s = buildSlots(18, 23);
    assert.equal(s.length, 10);
    assert.equal(s[0], 18 * 60);
    assert.equal(s[s.length - 1], 22 * 60 + 30);
  });
  it("end=24 means midnight", () => {
    const s = buildSlots(22, 24);
    assert.equal(s.length, 4); // 22:00, 22:30, 23:00, 23:30
    assert.equal(s[s.length - 1], 23 * 60 + 30);
  });
  it("rejects empty/invalid ranges", () => {
    assert.throws(() => buildSlots(20, 20));
    assert.throws(() => buildSlots(22, 18));
    assert.throws(() => buildSlots(-1, 5));
    assert.throws(() => buildSlots(0, 25));
  });
});

describe("formatSlot", () => {
  it("zero-pads", () => {
    assert.equal(formatSlot(0), "00:00");
    assert.equal(formatSlot(60 * 9 + 30), "09:30");
    assert.equal(formatSlot(23 * 60 + 30), "23:30");
  });
});

describe("parseRangeArg", () => {
  it("accepts canonical form", () => {
    assert.deepEqual(parseRangeArg("18-23"), { startHour: 18, endHour: 23 });
  });
  it("tolerates whitespace", () => {
    assert.deepEqual(parseRangeArg(" 18 - 23 "), { startHour: 18, endHour: 23 });
  });
  it("rejects bad inputs", () => {
    assert.equal(parseRangeArg("18-18"), null);
    assert.equal(parseRangeArg("18-25"), null);
    assert.equal(parseRangeArg("nope"), null);
    assert.equal(parseRangeArg(""), null);
  });
});

describe("parseStacksArg", () => {
  it("accepts canonical form", () => {
    assert.deepEqual(parseStacksArg("[5,3,2]"), [5, 3, 2]);
  });
  it("sorts descending and dedupes", () => {
    assert.deepEqual(parseStacksArg("[2,3,5,3]"), [5, 3, 2]);
  });
  it("tolerates inner whitespace", () => {
    assert.deepEqual(parseStacksArg("[5, 3, 2]"), [5, 3, 2]);
  });
  it("rejects malformed inputs", () => {
    assert.equal(parseStacksArg("5,3,2"), null);
    assert.equal(parseStacksArg("[]"), null);
    assert.equal(parseStacksArg("[a]"), null);
    assert.equal(parseStacksArg("18-23"), null);
  });
});

describe("compressSlotRanges", () => {
  it("handles a single contiguous run", () => {
    // 18:00, 18:30, 19:00, 19:30 → 18:00-20:00
    assert.equal(compressSlotRanges([1080, 1110, 1140, 1170]), "18:00-20:00");
  });
  it("splits non-contiguous runs", () => {
    // 18:00, 19:00 (gap), 19:30 → 18:00-18:30, 19:00-20:00
    assert.equal(compressSlotRanges([1080, 1140, 1170]), "18:00-18:30, 19:00-20:00");
  });
  it("renders end=24:00 for the last slot of a midnight session", () => {
    // 23:00, 23:30 (last slot of 22-24 session) → 23:00-24:00
    assert.equal(compressSlotRanges([1380, 1410]), "23:00-24:00");
  });
  it("returns empty string for empty input", () => {
    assert.equal(compressSlotRanges([]), "");
  });
  it("dedupes input", () => {
    assert.equal(compressSlotRanges([1080, 1080, 1110]), "18:00-19:00");
  });
});

describe("parseLfpArgs", () => {
  it("parses range only", () => {
    const r = parseLfpArgs("18-23");
    assert.deepEqual(r.range, { startHour: 18, endHour: 23 });
    assert.equal(r.stacks, null);
    assert.equal(r.rest, "");
  });
  it("parses range + stacks + tags in any order", () => {
    const r = parseLfpArgs("18-23 [5,3,2] @karolis @tomas");
    assert.deepEqual(r.range, { startHour: 18, endHour: 23 });
    assert.deepEqual(r.stacks, [5, 3, 2]);
    assert.equal(r.rest, "@karolis @tomas");
  });
  it("token order doesn't matter", () => {
    const r = parseLfpArgs("@a [3,2] 19-22 @b");
    assert.deepEqual(r.range, { startHour: 19, endHour: 22 });
    assert.deepEqual(r.stacks, [3, 2]);
    assert.equal(r.rest, "@a @b");
  });
  it("returns null range when missing", () => {
    const r = parseLfpArgs("[5,3,2] @a");
    assert.equal(r.range, null);
    assert.deepEqual(r.stacks, [5, 3, 2]);
  });
});
