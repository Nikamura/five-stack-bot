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
      if (!v) continue;
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
      noUserIds: [...noVotes.map((v) => v.telegram_user_id), ...skippedNo],
      fillerAvailableUserIds: fillerVotes.map((v) => v.telegram_user_id),
    };
  });
}

/**
 * Evaluate the lock per §5.4.
 *
 * Walks the valid stacks largest-first:
 *  1. If any slot has yes >= currentStack, lock the EARLIEST such slot at
 *     currentStack with non-filler ✅ voters as core.
 *  2. Else if non-filler ✅ + fillerAvailable >= currentStack on any slot,
 *     lock the EARLIEST such slot using fillers to complete the lineup.
 *     Real ✅ voters always come first; fillers fill the remaining seats
 *     by vote-time. A later real ✅ vote will bump the filler back to
 *     alternate.
 *  3. Else if the stack is still mathematically possible
 *     (yes + maybe + fillerAvailable + notVoted >= stack), wait.
 *  4. Else fall through to the next-smallest stack and repeat.
 */
export function evaluateLock(args: {
  tallies: SlotTally[];
  validStacks: number[]; // sorted largest-first
}): LockResult {
  const { tallies, validStacks } = args;
  const stacks = [...validStacks].sort((a, b) => b - a);

  for (const stack of stacks) {
    // 1. Strict ✅ lock — earliest slot with non-filler yes >= stack.
    const yesOnly = tallies.find((t) => t.yes >= stack);
    if (yesOnly) {
      const core = yesOnly.yesUserIds.slice(0, stack);
      // Anyone else who said ✅, plus any fillers, are alternates.
      const alternates = [
        ...yesOnly.yesUserIds.slice(stack),
        ...yesOnly.fillerAvailableUserIds,
      ];
      return { slot: yesOnly.slot, size: stack, core, alternates };
    }
    // 2. Filler-assisted lock — non-filler ✅ + filler availability >= stack.
    const withFiller = tallies.find((t) => t.yes + t.fillerAvailable >= stack);
    if (withFiller) {
      const ranked = [
        ...withFiller.yesUserIds,
        ...withFiller.fillerAvailableUserIds,
      ];
      return {
        slot: withFiller.slot,
        size: stack,
        core: ranked.slice(0, stack),
        alternates: ranked.slice(stack),
      };
    }
    // 3. Still in play? (anyone undecided or maybe could still push it over.)
    const stillInPlay = tallies.some(
      (t) => t.yes + t.maybe + t.fillerAvailable + t.notVoted >= stack,
    );
    if (stillInPlay) {
      return { slot: null, size: null, core: [], alternates: [] };
    }
    // Else: stack dead. Try the next-smallest.
  }

  return { slot: null, size: null, core: [], alternates: [] };
}

/** Minimum committed players needed at the locked slot for party mode (6v6 custom). */
export const PARTY_MODE_SIZE = 6;

/**
 * Count of strict-commit (non-filler ✅ + filler ✅/🤷) players at the locked
 * slot. This is the same pool that seats `lock_party` rows, so it's the right
 * number to gate "can we play a 6v6 custom" on — it excludes plain 🤷 from
 * non-fillers since those haven't committed.
 */
export function partyModeEligibleAtSlot(tally: SlotTally): number {
  return tally.yesUserIds.length + tally.fillerAvailableUserIds.length;
}

/**
 * If party mode is on and the locked slot has at least 6 committed players,
 * expand the lock to a 6-stack so the T-15 reminder tags everyone playing.
 * No-op when party mode is off, when no slot is locked, or when fewer than 6
 * are eligible — in those cases we return the input lock unchanged.
 */
export function applyPartyModeOverride(args: {
  lock: LockResult;
  tallies: SlotTally[];
  partyMode: boolean;
}): LockResult {
  const { lock, tallies, partyMode } = args;
  if (!partyMode || lock.slot === null) return lock;
  const tally = tallies.find((t) => t.slot === lock.slot);
  if (!tally) return lock;
  const eligible = partyModeEligibleAtSlot(tally);
  if (eligible < PARTY_MODE_SIZE) return lock;
  const ranked = [...tally.yesUserIds, ...tally.fillerAvailableUserIds];
  return {
    slot: lock.slot,
    size: PARTY_MODE_SIZE,
    core: ranked.slice(0, PARTY_MODE_SIZE),
    alternates: ranked.slice(PARTY_MODE_SIZE),
  };
}

/**
 * The largest stack that's currently *reachable* at any slot, ignoring the
 * "wait for the largest possible" rule. Use this to surface a "we could play
 * X-stack at HH:MM right now if nobody more shows up" hint when the actual
 * lock evaluator is still waiting on a bigger stack. Includes filler help.
 *
 * Returns null if no slot has enough ✅ votes (even with filler help) to clear
 * the smallest valid stack.
 */
export function tentativeLock(args: {
  tallies: SlotTally[];
  validStacks: number[];
}): { slot: number; size: number } | null {
  const stacks = [...args.validStacks].sort((a, b) => b - a);
  for (const stack of stacks) {
    const earliest = args.tallies.find(
      (t) => t.yes + t.fillerAvailable >= stack,
    );
    if (earliest) return { slot: earliest.slot, size: stack };
  }
  return null;
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
