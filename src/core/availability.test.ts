import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityRevision,
  completeAvailabilityVotes,
  parseAvailabilitySubmission,
  sameAvailabilityAnswer,
} from "./availability.js";

const expectedRevision = availabilityRevision({ votes: [], filler: false, skipped: false });
const submission = { expectedRevision, votes: [{ slot: 780, value: "yes" }], filler: false, unavailable: false };

describe("availability submission", () => {
  it("makes a complete answer only when explicitly submitted", () => {
    const parsed = parseAvailabilitySubmission(submission, [720, 750, 780, 810]);
    assert.deepEqual(completeAvailabilityVotes(parsed, [720, 750, 780, 810]), [
      { slot: 720, value: "no" }, { slot: 750, value: "no" },
      { slot: 780, value: "yes" }, { slot: 810, value: "no" },
    ]);
  });

  it("accepts mixed definite/maybe selections and explicit unavailable", () => {
    const mixed = parseAvailabilitySubmission({ ...submission, votes: [
      { slot: 810, value: "maybe" }, { slot: 780, value: "yes" },
    ], filler: true }, [780, 810]);
    assert.deepEqual(mixed.votes.map((vote) => vote.value), ["yes", "maybe"]);
    assert.deepEqual(parseAvailabilitySubmission({ ...submission, votes: [], unavailable: true }, [780]).votes, []);
  });

  it("rejects ambiguous empty answers, contradictory flags and duplicate times", () => {
    for (const invalid of [
      { ...submission, votes: [] },
      { ...submission, unavailable: true },
      { ...submission, votes: [], unavailable: true, filler: true },
      { ...submission, votes: [{ slot: 780, value: "yes" }, { slot: 780, value: "maybe" }] },
    ]) assert.throws(() => parseAvailabilitySubmission(invalid, [780, 810]));
  });

  it("strictly validates request keys, values, grid and editable times", () => {
    for (const invalid of [
      null, [], "yes", { ...submission, userId: 7 },
      { ...submission, expectedRevision: "" }, { ...submission, filler: "false" },
      { ...submission, unavailable: 0 },
      ...[
        { slot: "780", value: "yes" }, { slot: 781, value: "yes" },
        { slot: 720, value: "yes" }, { slot: 780, value: "no" },
        { slot: 780, value: "yes", userId: 7 }, { slot: NaN, value: "yes" },
      ].map((vote) => ({ ...submission, votes: [vote] })),
    ]) assert.throws(() => parseAvailabilitySubmission(invalid, [780, 810]));
  });
});

describe("availability concurrency", () => {
  it("fingerprints committed state with stable ordering and includes filler, skip, and vote priority", () => {
    const votes = [
      { slot: 780, value: "yes" as const, votedAt: 1 },
      { slot: 810, value: "maybe" as const, votedAt: 2 },
    ];
    const state = { votes, filler: false, skipped: false };
    const original = availabilityRevision(state);
    assert.equal(availabilityRevision({ ...state, votes: [...votes].reverse() }), original);
    assert.notEqual(availabilityRevision({ ...state, filler: true }), original);
    assert.notEqual(availabilityRevision({ ...state, skipped: true }), original);
    assert.notEqual(availabilityRevision({ ...state, votes: [{ ...votes[0]!, votedAt: 3 }, votes[1]!] }), original);
  });

  it("recognizes an identical retry but never treats unknown as an explicit no", () => {
    const state = {
      currentVotes: [{ slot: 780, value: "yes" as const }, { slot: 810, value: "no" as const }],
      completeVotes: [{ slot: 780, value: "yes" as const }, { slot: 810, value: "no" as const }],
      currentFiller: false, filler: false, skipped: false,
    };
    assert.equal(sameAvailabilityAnswer(state), true);
    assert.equal(sameAvailabilityAnswer({ ...state, currentVotes: [state.currentVotes[0]!] }), false);
    assert.equal(sameAvailabilityAnswer({ ...state, skipped: true }), false);
    assert.equal(sameAvailabilityAnswer({ ...state, filler: true }), false);
  });
});
