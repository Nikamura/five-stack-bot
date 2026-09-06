/** Pure availability helpers. Each selected time is one possible game start. */
export const formatTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function groupVotes(votes) {
  const sorted = votes.filter((vote) => vote.value !== 'no').slice().sort((a, b) => a.slot - b.slot);
  const ranges = [];
  for (const vote of sorted) {
    const last = ranges.at(-1);
    if (last && last.value === vote.value && last.to + 30 === vote.slot) last.to = vote.slot;
    else ranges.push({ from: vote.slot, to: vote.slot, value: vote.value });
  }
  return ranges;
}

export function formatRanges(votes, value) {
  return groupVotes(votes.filter((vote) => value === undefined || vote.value === value))
    .map((range) => range.from === range.to ? formatTime(range.from) : `${formatTime(range.from)}–${formatTime(range.to)}`)
    .join(', ');
}

export function draftFromSnapshot(snapshot, now) {
  const future = new Set(snapshot.slots.filter((slot) => slot.startsAt > now).map((slot) => slot.minutes));
  const votes = snapshot.me.skipped ? [] : snapshot.me.votes.filter((vote) => future.has(vote.slot) && vote.value !== 'no').map((vote) => ({ ...vote }));
  const mode = (snapshot.me.responded || snapshot.me.skipped) && !votes.length ? 'no' : 'times';
  const filler = snapshot.me.filler && mode !== 'no';
  const response = filler ? 'filler' : !votes.length ? 'yes'
    : votes.every((vote) => vote.value === votes[0].value) ? votes[0].value : 'mixed';
  return {
    mode, response,
    filler,
    votes,
  };
}

export function draftSignature(draft) {
  if (draft.mode === 'no') return 'unavailable';
  return JSON.stringify({ mode: draft.mode, response: draft.response, filler: draft.filler, votes: draft.votes.slice().sort((a, b) => a.slot - b.slot) });
}

export function toggleTime(draft, slot) {
  const selected = draft.votes.findIndex((vote) => vote.slot === slot);
  if (selected !== -1) draft.votes.splice(selected, 1);
  else draft.votes.push({ slot, value: draft.response === 'maybe' ? 'maybe' : 'yes' });
}

/** Saved selections open for individual edits; an empty answer starts with two endpoints. */
export function selectionFromDraft(draft) {
  return { rangeMode: !draft.votes.length, anchor: null };
}

/** Add an inclusive range, preserving existing per-time responses and excluding passed starts. */
export function addTimeRange(draft, slots, now, first, last) {
  const from = Math.min(first, last);
  const to = Math.max(first, last);
  const selected = new Map(draft.votes.map((vote) => [vote.slot, vote.value]));
  for (const slot of slots) {
    if (slot.startsAt <= now || slot.minutes < from || slot.minutes > to || selected.has(slot.minutes)) continue;
    selected.set(slot.minutes, draft.response === 'maybe' ? 'maybe' : 'yes');
  }
  draft.votes = [...selected].map(([slot, value]) => ({ slot, value })).sort((a, b) => a.slot - b.slot);
}

/** The first range tap is transient UI state; only the second tap changes the draft votes. */
export function selectGridTime(draft, selection, slots, now, minutes) {
  if (!slots.some((slot) => slot.minutes === minutes && slot.startsAt > now)) return;
  if (!selection.rangeMode) { toggleTime(draft, minutes); return; }
  if (selection.anchor === null) { selection.anchor = minutes; return; }
  addTimeRange(draft, slots, now, selection.anchor, minutes);
  selection.anchor = null;
  selection.rangeMode = false;
}

/** A deliberate optional response change applies to every selected start. */
export function setResponse(draft, response) {
  if (!['yes', 'maybe', 'filler'].includes(response)) return;
  draft.response = response;
  draft.filler = response === 'filler';
  draft.votes = draft.votes.map((vote) => ({ slot: vote.slot, value: response === 'maybe' ? 'maybe' : 'yes' }));
}

/** Selecting all adds starts without rewriting saved mixed answers already selected. */
export function selectAllTimes(draft, slots, now) {
  const selected = new Map(draft.votes.map((vote) => [vote.slot, vote.value]));
  draft.votes = slots.filter((slot) => slot.startsAt > now).map((slot) => ({
    slot: slot.minutes, value: selected.get(slot.minutes) ?? (draft.response === 'maybe' ? 'maybe' : 'yes'),
  }));
}

export function evaluateDraft(draft, slots, now, selection) {
  const future = slots.filter((slot) => slot.startsAt > now);
  const empty = { valid: false, votes: [], message: '', expiredCount: 0 };
  if (!future.length) return { ...empty, message: 'All start times have passed.' };
  if (draft.mode === 'no') return { valid: true, votes: [], message: '', expiredCount: 0 };
  if (selection?.anchor !== null && selection?.anchor !== undefined) return { ...empty, message: 'Tap the latest start to finish your range.' };
  if (!draft.votes.length) return { ...empty, message: 'No times selected yet.' };
  const candidates = new Set(slots.map((slot) => slot.minutes));
  const chosen = new Map();
  for (const vote of draft.votes) {
    if (!candidates.has(vote.slot) || !['yes', 'maybe'].includes(vote.value) || chosen.has(vote.slot)) {
      return { ...empty, message: 'Choose one of the listed start times.' };
    }
    chosen.set(vote.slot, vote.value);
  }
  const votes = future.filter((slot) => chosen.has(slot.minutes)).map((slot) => ({ slot: slot.minutes, value: chosen.get(slot.minutes) }));
  if (!votes.length) return { ...empty, message: 'Your selected times have passed. Pick a later start.' };
  return { valid: true, votes, message: '', expiredCount: chosen.size - votes.length };
}

export function saveInput(draft, slots, now, expectedRevision, selection) {
  const evaluated = evaluateDraft(draft, slots, now, selection);
  if (!evaluated.valid) throw new Error(evaluated.message);
  return {
    expectedRevision,
    votes: evaluated.votes,
    filler: draft.mode !== 'no' && draft.filler,
    unavailable: draft.mode === 'no',
  };
}

/** Prefer the largest saved overlap, then confirmed players; earliest start breaks ties. */
export function strongestSlot(slots, now) {
  return slots.filter((slot) => slot.startsAt > now).reduce((best, slot) => {
    const total = slot.yes + slot.maybe + (slot.filler || 0);
    const bestTotal = best ? best.yes + best.maybe + (best.filler || 0) : -1;
    if (!best || total > bestTotal || (total === bestTotal && slot.yes > best.yes)
      || (total === bestTotal && slot.yes === best.yes && slot.minutes < best.minutes)) return slot;
    return best;
  }, null);
}

/** Compact adjacent starts only when the same people have the same saved response. */
export function groupStartLineups(snapshot, now, includePast = false) {
  const groups = [];
  for (const slot of snapshot.slots) {
    if (!includePast && slot.startsAt <= now) continue;
    const yes = [...slot.yesUserIds].sort((a, b) => a - b);
    const maybe = [...slot.maybeUserIds].sort((a, b) => a - b);
    const filler = [...slot.fillerUserIds].sort((a, b) => a - b);
    const waiting = snapshot.players.filter((player) => !player.skipped && !player.votes.some((vote) => vote.slot === slot.minutes))
      .map((player) => player.id).sort((a, b) => a - b);
    const signature = JSON.stringify([yes, maybe, filler, waiting, slot.no]);
    const last = groups.at(-1);
    if (last && last.to + 30 === slot.minutes && last.signature === signature) last.to = slot.minutes;
    else groups.push({ from: slot.minutes, to: slot.minutes, yes, maybe, filler, waiting, no: slot.no, signature });
  }
  return groups;
}
