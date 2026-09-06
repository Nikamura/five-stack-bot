import test from 'node:test';
import assert from 'node:assert/strict';
import { addTimeRange, draftFromSnapshot, draftSignature, evaluateDraft, formatRanges, groupStartLineups, groupVotes, saveInput, selectAllTimes, selectGridTime, selectionFromDraft, setResponse, strongestSlot, toggleTime } from './model.js';

const slots = [720, 750, 780, 810, 840].map((minutes, index) => ({ minutes, startsAt: 1000 + index * 1000, yes: 0, maybe: 0 }));
const snapshot = (me = {}) => ({ slots, me: { id: 1, responded: false, skipped: false, filler: false, votes: [], ...me } });

test('new answer opens directly on a blank time grid and cannot submit an implicit decline', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  assert.equal(draft.mode, 'times');
  assert.equal(draft.response, 'yes');
  assert.deepEqual(draft.votes, []);
  assert.equal(evaluateDraft(draft, slots, 0).valid, false);
  assert.throws(() => saveInput(draft, slots, 0, 'v1'));
});

test('individual editing toggles exactly one candidate start and can return to the baseline', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  const baseline = draftSignature(draft);
  toggleTime(draft, 780);
  assert.deepEqual(saveInput(draft, slots, 0, 'v1'), { expectedRevision: 'v1', votes: [{ slot: 780, value: 'yes' }], filler: false, unavailable: false });
  assert.equal(formatRanges(draft.votes), '13:00');
  toggleTime(draft, 780);
  assert.equal(draftSignature(draft), baseline);
  assert.equal(evaluateDraft(draft, slots, 0).valid, false);
});

test('two endpoint taps select ten starts, with no saveable partial answer after the first tap', () => {
  const tenSlots = Array.from({ length: 10 }, (_, index) => ({ minutes: 720 + index * 30, startsAt: 1000 + index * 1000 }));
  const draft = draftFromSnapshot({ ...snapshot(), slots: tenSlots }, 0);
  const selection = selectionFromDraft(draft);
  assert.equal(selection.rangeMode, true);
  selectGridTime(draft, selection, tenSlots, 0, 720);
  assert.equal(selection.anchor, 720);
  assert.deepEqual(draft.votes, []);
  assert.equal(evaluateDraft(draft, tenSlots, 0, selection).valid, false);
  assert.throws(() => saveInput(draft, tenSlots, 0, 'v1', selection), /latest start/);
  selectGridTime(draft, selection, tenSlots, 0, 990);
  assert.equal(draft.votes.length, 10);
  assert.deepEqual(selection, { rangeMode: false, anchor: null });
  assert.equal(saveInput(draft, tenSlots, 0, 'v1', selection).votes.length, 10);
});

test('tapping the same endpoint twice selects one start, then subsequent taps edit individually', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  const selection = selectionFromDraft(draft);
  selectGridTime(draft, selection, slots, 0, 780);
  selectGridTime(draft, selection, slots, 0, 780);
  assert.deepEqual(draft.votes, [{ slot: 780, value: 'yes' }]);
  selectGridTime(draft, selection, slots, 0, 840);
  assert.deepEqual(draft.votes.map((vote) => vote.slot), [780, 840]);
  selectGridTime(draft, selection, slots, 0, 780);
  assert.deepEqual(draft.votes, [{ slot: 840, value: 'yes' }]);
});

test('Add a range preserves the first block, including mixed responses in an overlapping block', () => {
  const draft = draftFromSnapshot(snapshot({ responded: true, votes: [{ slot: 720, value: 'yes' }, { slot: 750, value: 'maybe' }] }), 0);
  assert.deepEqual(selectionFromDraft(draft), { rangeMode: false, anchor: null });
  const selection = { rangeMode: true, anchor: null };
  selectGridTime(draft, selection, slots, 0, 810);
  assert.equal(evaluateDraft(draft, slots, 0, selection).valid, false);
  selectGridTime(draft, selection, slots, 0, 840);
  assert.deepEqual(draft.votes, [{ slot: 720, value: 'yes' }, { slot: 750, value: 'maybe' }, { slot: 810, value: 'yes' }, { slot: 840, value: 'yes' }]);
  addTimeRange(draft, slots, 0, 750, 810);
  assert.equal(draft.votes.find((vote) => vote.slot === 750).value, 'maybe');
  assert.equal(draft.votes.find((vote) => vote.slot === 780).value, 'yes');
});

test('reverse endpoint order works and expired starts are filtered when completing a pending range', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  const selection = selectionFromDraft(draft);
  selectGridTime(draft, selection, slots, 0, 840);
  selectGridTime(draft, selection, slots, 0, 780);
  assert.deepEqual(draft.votes.map((vote) => vote.slot), [780, 810, 840]);
  const other = draftFromSnapshot(snapshot(), 0);
  const pending = selectionFromDraft(other);
  selectGridTime(other, pending, slots, 0, 720);
  selectGridTime(other, pending, slots, 2000, 840);
  assert.deepEqual(other.votes.map((vote) => vote.slot), [780, 810, 840]);
});

test('All times adds future starts; clearing is not a valid unavailable response', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  selectAllTimes(draft, slots, 2000);
  assert.deepEqual(draft.votes.map((vote) => vote.slot), [780, 810, 840]);
  assert.equal(formatRanges(draft.votes), '13:00–14:00');
  draft.votes = [];
  assert.equal(evaluateDraft(draft, slots, 2000).valid, false);
});

test('grid taps use updated start instants when a live timezone change makes a time available', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  const selection = selectionFromDraft(draft);
  const beforeChange = [{ minutes: 780, startsAt: 900 }];
  selectGridTime(draft, selection, beforeChange, 1000, 780);
  assert.equal(selection.anchor, null);
  const afterChange = [{ minutes: 780, startsAt: 2000 }];
  selectGridTime(draft, selection, afterChange, 1000, 780);
  assert.equal(selection.anchor, 780);
  selectGridTime(draft, selection, afterChange, 1000, 780);
  assert.deepEqual(draft.votes, [{ slot: 780, value: 'yes' }]);
  selectGridTime(draft, selection, beforeChange, 1000, 780);
  assert.deepEqual(draft.votes, [{ slot: 780, value: 'yes' }]);
});

test('saved mixed replies survive new selections and All times until a deliberate response change', () => {
  const me = { responded: true, votes: [
    { slot: 720, value: 'yes' }, { slot: 750, value: 'no' }, { slot: 780, value: 'maybe' },
  ] };
  const draft = draftFromSnapshot(snapshot(me), 0);
  assert.equal(draft.mode, 'times');
  assert.equal(draft.response, 'mixed');
  toggleTime(draft, 810);
  assert.equal(draft.votes.find((vote) => vote.slot === 780).value, 'maybe');
  assert.equal(draft.votes.find((vote) => vote.slot === 810).value, 'yes');
  selectAllTimes(draft, slots, 0);
  assert.equal(draft.votes.find((vote) => vote.slot === 780).value, 'maybe');
  assert.equal(draft.votes.find((vote) => vote.slot === 750).value, 'yes');
  setResponse(draft, 'yes');
  assert.ok(draft.votes.every((vote) => vote.value === 'yes'));
  assert.deepEqual(me.votes, [{ slot: 720, value: 'yes' }, { slot: 750, value: 'no' }, { slot: 780, value: 'maybe' }]);
});

test('optional Maybe and Only if needed apply to selected and newly added times', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  toggleTime(draft, 780);
  setResponse(draft, 'maybe');
  toggleTime(draft, 810);
  assert.ok(draft.votes.every((vote) => vote.value === 'maybe'));
  setResponse(draft, 'filler');
  assert.ok(draft.votes.every((vote) => vote.value === 'yes'));
  assert.equal(saveInput(draft, slots, 0, 'v1').filler, true);
});

test('a legacy filler-only answer displays its retained preference and can explicitly become confirmed', () => {
  const draft = draftFromSnapshot(snapshot({ filler: true }), 0);
  assert.equal(draft.mode, 'times');
  assert.equal(draft.response, 'filler');
  assert.equal(draft.filler, true);
  const selection = selectionFromDraft(draft);
  selectGridTime(draft, selection, slots, 0, 780);
  selectGridTime(draft, selection, slots, 0, 810);
  assert.equal(saveInput(draft, slots, 0, 'v1', selection).filler, true);
  setResponse(draft, 'yes');
  assert.equal(draft.response, 'yes');
  assert.equal(saveInput(draft, slots, 0, 'v1', selection).filler, false);
});

test('a draft is pruned against server time without submitting starts that have passed', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  selectAllTimes(draft, slots, 0);
  assert.equal(evaluateDraft(draft, slots, 2000).expiredCount, 2);
  assert.deepEqual(saveInput(draft, slots, 2000, 'v1').votes.map((vote) => vote.slot), [780, 810, 840]);
  assert.equal(evaluateDraft(draft, slots, 5000).valid, false);
});

test('Can’t play is explicit, clears filler on submission, and keeps draft selections when switched back', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  toggleTime(draft, 780);
  setResponse(draft, 'filler');
  draft.mode = 'no';
  assert.deepEqual(saveInput(draft, slots, 0, 'v2'), { expectedRevision: 'v2', votes: [], filler: false, unavailable: true });
  assert.equal(draftSignature(draft), 'unavailable');
  draft.mode = 'times';
  assert.deepEqual(draft.votes, [{ slot: 780, value: 'yes' }]);
  assert.equal(draftFromSnapshot(snapshot({ responded: true, votes: [{ slot: 720, value: 'no' }] }), 0).mode, 'no');
});

test('unknown and duplicate start selections are rejected', () => {
  const draft = draftFromSnapshot(snapshot(), 0);
  draft.votes = [{ slot: 721, value: 'yes' }];
  assert.equal(evaluateDraft(draft, slots, 0).valid, false);
  draft.votes = [{ slot: 720, value: 'yes' }, { slot: 720, value: 'maybe' }];
  assert.equal(evaluateDraft(draft, slots, 0).valid, false);
});

test('summaries keep gaps and actual last starts; overlap includes fillers and excludes past starts', () => {
  assert.deepEqual(groupVotes([{ slot: 840, value: 'yes' }, { slot: 750, value: 'yes' }, { slot: 720, value: 'yes' }]), [
    { from: 720, to: 750, value: 'yes' }, { from: 840, to: 840, value: 'yes' },
  ]);
  assert.equal(formatRanges([{ slot: 780, value: 'yes' }, { slot: 810, value: 'yes' }]), '13:00–13:30');
  const tally = slots.map((slot, index) => ({ ...slot, yes: index < 3 ? 3 : 2, maybe: index === 2 ? 1 : 0 }));
  assert.equal(strongestSlot(tally, 0).minutes, 780);
  assert.equal(strongestSlot(tally, 3000).minutes, 810);
  assert.equal(strongestSlot([{ ...slots[0], filler: 0 }, { ...slots[1], filler: 2 }], 0).minutes, 750);
});

test('results combine adjacent starts only when the same players have the same responses', () => {
  const data = {
    players: [
      { id: 1, skipped: false, votes: [{ slot: 720, value: 'yes' }, { slot: 750, value: 'yes' }, { slot: 780, value: 'maybe' }] },
      { id: 2, skipped: false, votes: [{ slot: 720, value: 'maybe' }, { slot: 750, value: 'maybe' }, { slot: 780, value: 'yes' }] },
      { id: 3, skipped: true, votes: [] },
      { id: 4, skipped: false, votes: [] },
    ],
    slots: [
      { minutes: 720, startsAt: 1000, yesUserIds: [1], maybeUserIds: [2], fillerUserIds: [], no: 1 },
      { minutes: 750, startsAt: 2000, yesUserIds: [1], maybeUserIds: [2], fillerUserIds: [], no: 1 },
      { minutes: 780, startsAt: 3000, yesUserIds: [2], maybeUserIds: [1], fillerUserIds: [], no: 1 },
    ],
  };
  const groups = groupStartLineups(data, 0);
  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0].from, groups[0].to], [720, 750]);
  assert.deepEqual(groups[0].waiting, [4]);
  assert.deepEqual(groups[1].yes, [2]);
  assert.deepEqual(groups[1].maybe, [1]);
  assert.deepEqual([groupStartLineups(data, 1000)[0].from, groupStartLineups(data, 1000)[0].to], [750, 750]);
  assert.equal(groupStartLineups(data, 4000).length, 0);
  assert.equal(groupStartLineups(data, 4000, true).length, 2);
});

test('results keep per-start waiting identities separate even when counts match', () => {
  const data = {
    players: [
      { id: 1, skipped: false, votes: [{ slot: 720, value: 'no' }] },
      { id: 2, skipped: false, votes: [{ slot: 750, value: 'no' }] },
    ],
    slots: [
      { minutes: 720, startsAt: 1000, yesUserIds: [], maybeUserIds: [], fillerUserIds: [], no: 1 },
      { minutes: 750, startsAt: 2000, yesUserIds: [], maybeUserIds: [], fillerUserIds: [], no: 1 },
    ],
  };
  const groups = groupStartLineups(data, 0);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].waiting, [2]);
  assert.deepEqual(groups[1].waiting, [1]);
});
