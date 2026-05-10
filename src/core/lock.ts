import type { VoteRow, VoteValue } from "../db/types.js";

export interface SlotTally {
  slot: number;
  yes: number;
  maybe: number;
  no: number;
  notVoted: number;
  /** roster user IDs who voted yes on this slot, ordered by vote_at ASC */
  yesUserIds: number[];
  /** roster user IDs who voted maybe on this slot, ordered by vote_at ASC */
  maybeUserIds: number[];
  /** roster user IDs who voted no on this slot, ordered by vote_at ASC.
   *  Includes session-only skips (treated as no for lock evaluation). */
  noUserIds: number[];
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
}

/**
 * Build per-slot tallies. Only roster member votes count; non-roster votes
 * are tracked separately by the caller for the "spectators" line.
 */
export function tallySlots(args: TallyArgs): SlotTally[] {
  const { slots, votes, rosterIds, skipIds } = args;

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
    const yesVotes: VoteRow[] = [];
    const maybeVotes: VoteRow[] = [];
    const noVotes: VoteRow[] = [];
    const skippedNo: number[] = [];
    for (const userId of rosterIds) {
      const v = m.get(userId);
      if (skipIds.has(userId)) {
        no += 1;
        skippedNo.push(userId);
        continue;
      }
      if (!v) continue;
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
    const cast = yes + maybe + no;
    const notVoted = rosterIds.size - cast;
    return {
      slot,
      yes,
      maybe,
      no,
      notVoted,
      yesUserIds: yesVotes.map((v) => v.telegram_user_id),
      maybeUserIds: maybeVotes.map((v) => v.telegram_user_id),
      noUserIds: [...noVotes.map((v) => v.telegram_user_id), ...skippedNo],
    };
  });
}

/**
 * Evaluate the lock per §5.4.
 *
 * Walks the valid stacks largest-first:
 *  1. If any slot has yes >= currentStack, lock the EARLIEST such slot at currentStack.
 *  2. Else if any slot is still "in play" for the LARGEST stack
 *     (yes + maybe + notVoted >= largestStack), wait — return null.
 *  3. Else fall through to the next-largest stack and repeat.
 *
 * Note: step 2 only blocks fall-back while the LARGEST stack is still possible.
 * Once the largest is impossible, we evaluate the next stack the same way:
 * lock if reachable now, else wait if still in-play, else fall through.
 */
export function evaluateLock(args: {
  tallies: SlotTally[];
  validStacks: number[]; // sorted largest-first
}): LockResult {
  const { tallies, validStacks } = args;
  const stacks = [...validStacks].sort((a, b) => b - a);

  for (const stack of stacks) {
    // Try to lock at this stack: earliest slot with yes >= stack.
    const earliest = tallies.find((t) => t.yes >= stack);
    if (earliest) {
      const core = earliest.yesUserIds.slice(0, stack);
      const alternates = earliest.yesUserIds.slice(stack);
      return { slot: earliest.slot, size: stack, core, alternates };
    }
    // Else: is this stack still mathematically possible at any slot?
    const stillInPlay = tallies.some((t) => t.yes + t.maybe + t.notVoted >= stack);
    if (stillInPlay) {
      // Wait. Don't fall back to a smaller stack.
      return { slot: null, size: null, core: [], alternates: [] };
    }
    // Else: this stack is dead. Try the next-smallest.
  }

  return { slot: null, size: null, core: [], alternates: [] };
}

/**
 * The largest stack that's currently *reachable* at any slot, ignoring the
 * "wait for the largest possible" rule. Use this to surface a "we could play
 * X-stack at HH:MM right now if nobody more shows up" hint when the actual
 * lock evaluator is still waiting on a bigger stack.
 *
 * Returns null if no slot has enough ✅ votes to clear the smallest valid stack.
 */
export function tentativeLock(args: {
  tallies: SlotTally[];
  validStacks: number[];
}): { slot: number; size: number } | null {
  const stacks = [...args.validStacks].sort((a, b) => b - a);
  for (const stack of stacks) {
    const earliest = args.tallies.find((t) => t.yes >= stack);
    if (earliest) return { slot: earliest.slot, size: stack };
  }
  return null;
}

/**
 * Diff two lock results — returns the kind of change for caller side effects.
 */
export type LockDiff =
  | { kind: "unchanged" }
  | { kind: "new"; next: LockResult }
  | { kind: "changed"; prev: LockResult; next: LockResult; lineupChanged: boolean }
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
    return { kind: "unchanged" };
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
