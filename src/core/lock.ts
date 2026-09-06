import type { VoteRow, VoteValue } from "../db/types.js";

export interface SlotTally {
  slot: number;
  /** Non-filler ✅ count (the "actually wants to play" signal). */
  yes: number;
  /** Non-filler 🤷 count. Filler ✅/🤷 votes are counted in `fillerAvailable`. */
  maybe: number;
  no: number;
  notVoted: number;
  /**
   * Filler "I'll play if you need me" availability — any positive response
   * (✅ or 🤷) from a roster member who toggled filler mode for this session.
   * These are used to complete a stack when non-filler ✅ alone falls short.
   */
  fillerAvailable: number;
  /** non-filler ✅ voters, ordered by vote_at ASC */
  yesUserIds: number[];
  /** non-filler 🤷 voters, ordered by vote_at ASC */
  maybeUserIds: number[];
  /** ❌ voters + session-only skips */
  noUserIds: number[];
  /** filler users with ✅ or 🤷 on this slot, ordered by vote_at ASC */
  fillerAvailableUserIds: number[];
}

export interface LockResult {
  /** null = no lock; the bot waits or session eventually archives. */
  slot: number | null;
  size: number | null;
  /** core players, in chronological vote order (first to ✅ that slot first) */
  core: number[];
  /** alternates, in chronological vote order, starting after `core` */
  alternates: number[];
}

interface TallyArgs {
  slots: number[];
  votes: VoteRow[];
  /** roster member ids — non-roster votes are ignored for lock decisions. */
  rosterIds: Set<number>;
  /** session-only no-shows (from /lfp-skip) — count as ❌ */
  skipIds: Set<number>;
  /** session-only fillers — ✅/🤷 votes downgrade to "fillerAvailable". */
  fillerIds: Set<number>;
}

/**
 * Build per-slot tallies. Only roster member votes count; non-roster votes
 * are tracked separately by the caller for the "spectators" line.
 *
 * Filler users (in `fillerIds`) are "I'll play if needed but don't push to
 * have me." Their ✅ and 🤷 are pooled into `fillerAvailable` rather than
 * counted as a strict ✅ — that way they only complete the stack when
 * non-filler ✅ alone falls short. ❌ from a filler is still ❌.
 *
 * An absent vote is unknown. The availability save writes explicit ❌ votes
 * for omitted future slots only after the user submits their complete answer.
 */
export function tallySlots(args: TallyArgs): SlotTally[] {
  const { slots, votes, rosterIds, skipIds, fillerIds } = args;

  // Map: slot -> Map<userId, VoteRow> (latest vote wins, but we only have one per (session,user,slot))
  const bySlotUser = new Map<number, Map<number, VoteRow>>();
  for (const s of slots) bySlotUser.set(s, new Map());
  for (const v of votes) {
    if (!rosterIds.has(v.telegram_user_id)) continue;
    const m = bySlotUser.get(v.slot_minutes);
    if (!m) continue; // out-of-range slot (shouldn't happen)
    m.set(v.telegram_user_id, v);
  }

  return slots.map((slot) => {
    const m = bySlotUser.get(slot)!;
    let yes = 0;
    let maybe = 0;
    let no = 0;
    let fillerAvailable = 0;
    const yesVotes: VoteRow[] = [];
    const maybeVotes: VoteRow[] = [];
    const noVotes: VoteRow[] = [];
    const fillerVotes: VoteRow[] = [];
    const skippedNo: number[] = [];
    for (const userId of rosterIds) {
      const v = m.get(userId);
      if (skipIds.has(userId)) {
        no += 1;
        skippedNo.push(userId);
        continue;
      }
      if (!v) {
        // Never infer a decline from a vote on some other start time.
        continue;
      }
      if (fillerIds.has(userId)) {
        if (v.value === "yes" || v.value === "maybe") {
          fillerAvailable += 1;
          fillerVotes.push(v);
        } else {
          no += 1;
          noVotes.push(v);
        }
        continue;
      }
      if (v.value === "yes") {
        yes += 1;
        yesVotes.push(v);
      } else if (v.value === "maybe") {
        maybe += 1;
        maybeVotes.push(v);
      } else {
        no += 1;
        noVotes.push(v);
      }
    }
    yesVotes.sort((a, b) => a.voted_at - b.voted_at);
    maybeVotes.sort((a, b) => a.voted_at - b.voted_at);
    noVotes.sort((a, b) => a.voted_at - b.voted_at);
    fillerVotes.sort((a, b) => a.voted_at - b.voted_at);
    const cast = yes + maybe + no + fillerAvailable;
    const notVoted = rosterIds.size - cast;
    return {
      slot,
      yes,
      maybe,
      no,
      notVoted,
      fillerAvailable,
      yesUserIds: yesVotes.map((v) => v.telegram_user_id),
      maybeUserIds: maybeVotes.map((v) => v.telegram_user_id),
      noUserIds: [
        ...noVotes.map((v) => v.telegram_user_id),
        ...skippedNo,
      ],
      fillerAvailableUserIds: fillerVotes.map((v) => v.telegram_user_id),
    };
  });
}

/** Choose the earliest playable start, then the largest enabled size there. */
export function evaluateLock(args: { tallies: SlotTally[]; validStacks: number[] }): LockResult {
  const stacks = [...args.validStacks].sort((a, b) => b - a);
  for (const tally of [...args.tallies].sort((a, b) => a.slot - b.slot)) {
    const ranked = [...tally.yesUserIds, ...tally.maybeUserIds, ...tally.fillerAvailableUserIds];
    const size = stacks.find(size => ranked.length >= size);
    if (size !== undefined) return { slot: tally.slot, size, core: ranked.slice(0, size), alternates: ranked.slice(size) };
  }
  return { slot: null, size: null, core: [], alternates: [] };
}

/** The same earliest playable start used by the actual lock. */
export function tentativeLock(args: { tallies: SlotTally[]; validStacks: number[] }): { slot: number; size: number } | null {
  const lock = evaluateLock(args);
  return lock.slot === null ? null : { slot: lock.slot, size: lock.size! };
}

export interface PartyWindow {
  slot: number;
  /** Exclusive end of the candidate-start window, not a promised play-until time. */
  endSlot: number;
  size: number;
  core: number[];
  alternates: number[];
  maybeIds: number[];
  fillerIds: number[];
}

/** Independent parties: merge adjacent starts only when their playing lineup and conditions match.
 * Past planned starts are history; future plans always use that slot's saved answers.
 */
export function buildPartyPlan(args: {
  tallies: SlotTally[]; validStacks: number[]; firstFutureSlot?: number; previous?: PartyWindow[];
}): PartyWindow[] {
  const cutoff = args.firstFutureSlot ?? -Infinity;
  const starts: PartyWindow[] = [];
  for (const old of args.previous ?? []) {
    for (let slot = old.slot; slot < Math.min(old.endSlot, cutoff); slot += 30) {
      starts.push({ ...old, slot, endSlot: slot + 30 });
    }
  }
  for (const tally of args.tallies.filter(t => t.slot >= cutoff)) {
    const lock = evaluateLock({ tallies: [tally], validStacks: args.validStacks });
    if (lock.slot === null) continue;
    starts.push({ ...lock, slot: lock.slot, endSlot: lock.slot + 30, size: lock.size!,
      maybeIds: lock.core.filter(id => tally.maybeUserIds.includes(id)),
      fillerIds: lock.core.filter(id => tally.fillerAvailableUserIds.includes(id)),
    });
  }
  const plan: PartyWindow[] = [];
  for (const entry of starts.sort((a, b) => a.slot - b.slot)) {
    const last = plan.at(-1);
    if (last && last.endSlot === entry.slot && partyLineupKey(last) === partyLineupKey(entry)) last.endSlot = entry.endSlot;
    else plan.push({ ...entry });
  }
  return plan;
}
function partyLineupKey(party: PartyWindow): string {
  return JSON.stringify([party.size, [...party.core].sort((a,b) => a-b), [...party.maybeIds].sort((a,b) => a-b), [...party.fillerIds].sort((a,b) => a-b)]);
}
export function partyPlanKey(plan: PartyWindow[]): string {
  return JSON.stringify(plan.map(p => [p.slot, p.endSlot, partyLineupKey(p)]));
}

/**
 * Roster members who haven't cast a single vote in the session and aren't
 * session-skipped. Used to nudge them in GAME ON when the locked stack is
 * smaller than the largest enabled stack — their ✅ on the locked slot would
 * upgrade the party.
 */
export function unvotedRosterMembers(args: {
  votes: VoteRow[];
  rosterIds: Set<number>;
  skipIds: Set<number>;
}): number[] {
  const voted = new Set<number>();
  for (const v of args.votes) {
    if (args.rosterIds.has(v.telegram_user_id)) voted.add(v.telegram_user_id);
  }
  const out: number[] = [];
  for (const id of args.rosterIds) {
    if (voted.has(id) || args.skipIds.has(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Diff two lock results — returns the kind of change for caller side effects.
 *
 * `alternates-changed` covers the post-lock case where the core lineup is
 * stable but a new ✅/🛟 vote pushes someone onto (or off) the alternates
 * list. The bot persists the new alternates and re-renders GAME ON so the
 * "X players available" suggestion stays accurate, but suppresses the
 * `🔄 Party changed` follow-up since the playing lineup hasn't moved.
 */
export type LockDiff =
  | { kind: "unchanged" }
  | { kind: "new"; next: LockResult }
  | { kind: "changed"; prev: LockResult; next: LockResult; lineupChanged: boolean }
  | { kind: "alternates-changed"; prev: LockResult; next: LockResult }
  | { kind: "dissolved"; prev: LockResult };

export function diffLock(prev: LockResult | null, next: LockResult): LockDiff {
  const prevLocked = prev && prev.slot !== null;
  const nextLocked = next.slot !== null;
  if (!prevLocked && !nextLocked) return { kind: "unchanged" };
  if (!prevLocked && nextLocked) return { kind: "new", next };
  if (prevLocked && !nextLocked) return { kind: "dissolved", prev: prev! };
  // both locked
  const p = prev!;
  if (p.slot === next.slot && p.size === next.size && sameIds(p.core, next.core)) {
    if (sameIds(p.alternates, next.alternates)) return { kind: "unchanged" };
    return { kind: "alternates-changed", prev: p, next };
  }
  const lineupChanged =
    p.slot === next.slot && p.size === next.size && !sameIds(p.core, next.core);
  return { kind: "changed", prev: p, next, lineupChanged };
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const VOTE_CYCLE: VoteValue[] = ["yes", "maybe", "no"];
export const VOTE_EMOJI: Record<VoteValue, string> = {
  yes: "✅",
  maybe: "🤷",
  no: "❌",
};

export function nextVote(current: VoteValue | null): VoteValue {
  // 3-state cycle: (no vote) → yes → maybe → no → yes → …
  // No "cleared" stop — once you've voted, you cycle through the three
  // states. This avoids the surprise where, after "I can't play tonight",
  // tapping a slot would silently move you back to no-vote-yet.
  if (current === null) return "yes";
  if (current === "yes") return "maybe";
  if (current === "maybe") return "no";
  return "yes";
}
