import { InlineKeyboard } from "grammy";
import type { LockResult, SlotTally } from "./lock.js";
import { tentativeLock } from "./lock.js";
import { compressSlotRanges, formatSlot } from "./slots.js";
import type { RosterMember, SessionRow } from "../db/types.js";
import { escapeHtml, mention, mentionList } from "./mention.js";
import { COMMON_TZS } from "./time.js";

// ============================================================================
// Session message
// ============================================================================

export function renderSessionBody(args: {
  session: SessionRow;
  roster: RosterMember[];
  tallies: SlotTally[];
  lock: LockResult | null;
  validStacks: number[];
  skipIds: Set<number>;
  fillerIds: Set<number>;
  totalSlots: number;
  spectatorCount: number;
}): string {
  const {
    session,
    roster,
    tallies,
    lock,
    validStacks,
    skipIds,
    fillerIds,
    totalSlots,
    spectatorCount,
  } = args;
  const opener = escapeHtml(session.opener_display_name);
  const range = `${formatSlot(session.start_minutes)}–${formatSlot(session.end_minutes)}`;
  const rosterStr = roster.length === 0 ? "<i>(empty)</i>" : mentionList(roster);
  const largestStack = validStacks[0];
  const rosterById = new Map(roster.map((m) => [m.telegram_user_id, m]));

  const lines: string[] = [];
  lines.push(`🎮 <b>${opener}</b> is looking for a party tonight! (${range})`);
  lines.push(`Roster: ${rosterStr}`);
  lines.push("");
  lines.push("<pre>");
  for (const t of tallies) {
    const isLocked = lock && lock.slot === t.slot;
    const tag = isLocked ? `   ← 🔒 ${lock!.size}-stack locked` : hint(t, lock, largestStack);
    const fillerTag = t.fillerAvailable > 0 ? `   🛟 ${t.fillerAvailable}` : "";
    lines.push(
      `  ${formatSlot(t.slot)}  ✅ ${t.yes}   🤷 ${t.maybe}   ❌ ${t.no}${fillerTag}${tag}`,
    );
  }
  lines.push("</pre>");

  // Per-voter summary: lists each roster member with their compressed slot
  // ranges. Much more compact than per-row names when most slots agree.
  const voterLines = voterSummary({ roster, tallies, skipIds, fillerIds, totalSlots });
  if (voterLines.length > 0) {
    lines.push(...voterLines);
  }

  lines.push("<i>Tap a slot to cycle ✅ → 🤷 → ❌. The HH-HH+1 button toggles the whole hour at once. ✅ All sets every slot to yes; 🚫 sets every slot to no. 🛟 Filler means \"I'll play only if the team is short.\"</i>");

  if (!lock || lock.slot === null) {
    const tentative = tentativeLock({ tallies, validStacks });
    if (tentative) {
      const slotTally = tallies.find((t) => t.slot === tentative.slot);
      const ranked = [
        ...(slotTally?.yesUserIds ?? []),
        ...(slotTally?.maybeUserIds ?? []),
        ...(slotTally?.fillerAvailableUserIds ?? []),
      ];
      const maybeSet = new Set(slotTally?.maybeUserIds ?? []);
      const fillerSet = new Set(slotTally?.fillerAvailableUserIds ?? []);
      const coreNames = ranked
        .slice(0, tentative.size)
        .map((id) => {
          const name = rosterById.get(id)?.display_name;
          if (!name) return null;
          const escaped = escapeHtml(name);
          if (fillerSet.has(id)) return `${escaped} 🛟`;
          if (maybeSet.has(id)) return `${escaped} 🤷`;
          return escaped;
        })
        .filter((n): n is string => !!n)
        .join(", ");
      const withClause = coreNames ? ` with ${coreNames}` : "";
      lines.push(
        `⏳ Could play <b>${tentative.size}-stack at ${formatSlot(tentative.slot)}</b>${withClause} — ` +
          `waiting on more votes for a bigger party.`,
      );
    }
  }

  if (spectatorCount > 0) {
    lines.push(`+${spectatorCount} spectator${spectatorCount === 1 ? "" : "s"} interested`);
  }
  return lines.join("\n");
}

function voterSummary(args: {
  roster: RosterMember[];
  tallies: SlotTally[];
  skipIds: Set<number>;
  fillerIds: Set<number>;
  totalSlots: number;
}): string[] {
  const { roster, tallies, skipIds, fillerIds, totalSlots } = args;

  const yesByUser = new Map<number, number[]>();
  const maybeByUser = new Map<number, number[]>();
  const noByUser = new Map<number, number[]>();
  const fillerByUser = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, uid: number, slot: number) => {
    const arr = m.get(uid);
    if (arr) arr.push(slot);
    else m.set(uid, [slot]);
  };
  for (const t of tallies) {
    for (const uid of t.yesUserIds) push(yesByUser, uid, t.slot);
    for (const uid of t.maybeUserIds) push(maybeByUser, uid, t.slot);
    for (const uid of t.fillerAvailableUserIds) push(fillerByUser, uid, t.slot);
    for (const uid of t.noUserIds) {
      // Skipped users get a single "(skipped)" entry below; don't repeat
      // them per-slot in the no list.
      if (skipIds.has(uid)) continue;
      push(noByUser, uid, t.slot);
    }
  }

  const fmtEntry = (m: RosterMember, slots: number[]): string => {
    const range = slots.length === totalSlots ? "all" : compressSlotRanges(slots);
    return `${escapeHtml(m.display_name)} (${range})`;
  };

  const yesEntries: string[] = [];
  const maybeEntries: string[] = [];
  const noEntries: string[] = [];
  const fillerEntries: string[] = [];

  for (const m of roster) {
    if (skipIds.has(m.telegram_user_id)) {
      noEntries.push(`${escapeHtml(m.display_name)} (skipped)`);
      continue;
    }
    const isFiller = fillerIds.has(m.telegram_user_id);
    const filler = fillerByUser.get(m.telegram_user_id);
    if (isFiller && filler && filler.length > 0) {
      fillerEntries.push(fmtEntry(m, filler));
    }
    const yes = yesByUser.get(m.telegram_user_id);
    if (yes && yes.length > 0) yesEntries.push(fmtEntry(m, yes));
    const maybe = maybeByUser.get(m.telegram_user_id);
    if (maybe && maybe.length > 0) maybeEntries.push(fmtEntry(m, maybe));
    const no = noByUser.get(m.telegram_user_id);
    if (no && no.length > 0) noEntries.push(fmtEntry(m, no));
  }

  const out: string[] = [];
  if (yesEntries.length > 0) out.push(`✅ ${yesEntries.join(", ")}`);
  if (maybeEntries.length > 0) out.push(`🤷 ${maybeEntries.join(", ")}`);
  if (fillerEntries.length > 0) out.push(`🛟 ${fillerEntries.join(", ")}`);
  if (noEntries.length > 0) out.push(`❌ ${noEntries.join(", ")}`);
  return out;
}

function hint(t: SlotTally, lock: LockResult | null, largestStack: number | undefined): string {
  if (lock && lock.slot !== null) return "";
  if (typeof largestStack !== "number") return "";
  if (t.yes >= largestStack) return "";
  if (
    t.yes + t.maybe + t.fillerAvailable + t.notVoted >= largestStack &&
    t.notVoted > 0
  ) {
    return `   (${largestStack}-stack still possible: ${t.notVoted} not voted)`;
  }
  return "";
}

/**
 * Lay out one row per hour. For each hour H covered by the session, show:
 *   `[H:00]  [H:30]  [H-(H+1)]`
 * The first two cast a vote on a single 30-min slot. The third is a combo
 * that toggles both 30-min slots in the hour at once, so a player who's
 * available for the full hour can express that with one tap.
 *
 * If the session range only includes one of the two half-slots in a given
 * hour (e.g. a 21:30–22:30 session covers [21:30] and [22:00], but only the
 * second half of 21:00 and only the first half of 22:00), the combo button
 * is omitted for that hour — there's no second slot to toggle.
 */
export function renderSessionKeyboard(args: {
  sessionId: number;
  slots: number[];
}): InlineKeyboard {
  const { sessionId, slots } = args;
  const kb = new InlineKeyboard();
  const slotSet = new Set(slots);
  const hours = new Set<number>();
  for (const s of slots) hours.add(Math.floor(s / 60));
  const sortedHours = [...hours].sort((a, b) => a - b);
  for (const h of sortedHours) {
    const a = h * 60;
    const b = h * 60 + 30;
    const hasA = slotSet.has(a);
    const hasB = slotSet.has(b);
    if (hasA) kb.text(formatSlot(a), `v:${sessionId}:${a}`);
    if (hasB) kb.text(formatSlot(b), `v:${sessionId}:${b}`);
    if (hasA && hasB) kb.text(`${h}-${h + 1}`, `v2:${sessionId}:${a}`);
    kb.row();
  }
  kb.text("✅ All times work", `vbay:${sessionId}`);
  kb.text("🚫 I can't play tonight", `vbn:${sessionId}`).row();
  kb.text("🛟 I can fill if needed", `vfill:${sessionId}`);
  return kb;
}

// ============================================================================
// GAME ON / T-15 / changes
// ============================================================================

/** Threshold at which we suggest 3v3 — six players is one full custom-game lineup. */
export const THREE_V_THREE_THRESHOLD = 6;

export function renderGameOn(args: {
  slot: number;
  size: number;
  coreIds: number[];
  alternateIds: number[];
  roster: RosterMember[];
  lateByUserId?: Map<number, number>;
  /**
   * Count of roster members willing to play this slot (✅ + 🤷 + 🛟). When
   * this hits {@link THREE_V_THREE_THRESHOLD} we add an "everyone plays"
   * 3v3-custom hint so the alternates aren't quietly left out.
   */
  availableAtSlot?: number;
}): string {
  const map = new Map(args.roster.map((m) => [m.telegram_user_id, m]));
  const renderCore = (id: number): string => {
    const m = map.get(id);
    if (!m) return "";
    const base = mention(m);
    const late = args.lateByUserId?.get(id);
    return late && late > 0 ? `${base} <i>(${late} min late)</i>` : base;
  };
  const coreStr = args.coreIds.map(renderCore).filter(Boolean).join(" ");
  const altStr = args.alternateIds
    .map((id) => {
      const m = map.get(id);
      return m ? mention(m) : "";
    })
    .filter(Boolean)
    .join(" ");
  const lines = [
    `🔒 <b>GAME ON ${formatSlot(args.slot)}</b> — ${args.size}-stack`,
    coreStr,
  ];
  if (altStr.length > 0) {
    lines.push("", `Alternates: ${altStr}`);
  }
  if (
    typeof args.availableAtSlot === "number" &&
    args.availableAtSlot >= THREE_V_THREE_THRESHOLD
  ) {
    lines.push(
      "",
      `💡 <b>${args.availableAtSlot} players available</b> — consider 3v3 Summoner's Rift or ARAM custom so everyone plays.`,
    );
  }
  return lines.join("\n");
}

export function renderGameOnKeyboard(sessionId: number): InlineKeyboard {
  return new InlineKeyboard().text("⏰ I'll be 15 min late", `late:${sessionId}`);
}

/**
 * Nudge for 🤷 voters who got pulled into the locked party. They're seated
 * because the bot treats maybe as soft-yes for stack completion, but we want
 * them to upgrade to ✅ so the lineup is firm. Posted alongside GAME ON when
 * any core seat is held by a maybe voter.
 */
export function renderMaybeNudge(maybeMentions: string): string {
  return `🤷 ${maybeMentions} — you're in the party as a maybe. Tap ✅ on the locked slot to confirm you're playing.`;
}

export function renderT15(coreMentions: string): string {
  return `⏰ 15 min — boot up.\n${coreMentions}`;
}

/**
 * Used when the T-15 fires very close to (or after) the slot start — e.g.
 * the lock shifted to an earlier slot and the reminder is now <10 min from
 * tip-off. "15 min — boot up" would be misleading at 2 min out, so we
 * collapse to a generic "load up" instead.
 */
export function renderLoadUp(coreMentions: string): string {
  return `🚀 Load up — game's starting.\n${coreMentions}`;
}

export function renderPartyChanged(line: string): string {
  return `🔄 <b>Party changed</b>\n${line}`;
}

export function renderPartyDissolved(): string {
  return "❌ <b>Party dissolved</b> — voting reopened.";
}

// ============================================================================
// /lfp wizard
// ============================================================================

const WIZARD_HOURS = [16, 17, 18, 19, 20, 21, 22, 23];

export function wizardStep1Text(): string {
  return "🎮 Open a session for tonight. When can the earliest player start?";
}

export function wizardStep1Keyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  let i = 0;
  for (const h of WIZARD_HOURS) {
    kb.text(`${h}:00`, `lfp:start:${h * 60}`);
    i += 1;
    if (i % 3 === 0) kb.row();
  }
  if (i % 3 !== 0) kb.row();
  kb.text("Cancel", "lfp:wcancel");
  return kb;
}

export function wizardStep2Text(startMinutes: number): string {
  return `🎮 Start: ${formatSlot(startMinutes)}. Latest end?`;
}

export function wizardStep2Keyboard(startMinutes: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  // End hour options: any whole hour > startHour, up to 24 (midnight).
  const startHour = Math.floor(startMinutes / 60);
  let i = 0;
  for (let h = startHour + 1; h <= 24; h += 1) {
    kb.text(formatSlot(h * 60), `lfp:end:${startMinutes}:${h * 60}`);
    i += 1;
    if (i % 3 === 0) kb.row();
  }
  if (i % 3 !== 0) kb.row();
  kb.text("◀ Back", "lfp:back:start").text("Cancel", "lfp:wcancel");
  return kb;
}

export function wizardStep3Text(args: {
  startMinutes: number;
  endMinutes: number;
  validStacks: number[];
  rosterSize: number;
}): string {
  const stackLine = args.validStacks.join(" → ");
  const skipped = [5, 4, 3, 2].filter((s) => !args.validStacks.includes(s));
  const skipStr = skipped.length ? ` (skip ${skipped.join(",")})` : "";
  return [
    `🎮 Open session ${formatSlot(args.startMinutes)}–${formatSlot(args.endMinutes)} tonight?`,
    `   Stack priority: ${stackLine}${skipStr}`,
    `   Roster: ${args.rosterSize} player${args.rosterSize === 1 ? "" : "s"}`,
  ].join("\n");
}

export function wizardStep3Keyboard(startMinutes: number, endMinutes: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Open session", `lfp:open:${startMinutes}:${endMinutes}`)
    .text("Cancel", "lfp:wcancel");
}

export function wizardCancelledText(): string {
  return "Cancelled.";
}

export function wizardOpenedText(): string {
  return "🎮 Session opened — see below ↓";
}

// ============================================================================
// /lfp-cancel
// ============================================================================

export function cancelConfirmText(): string {
  return "Cancel the active session?";
}

export function cancelConfirmKeyboard(sessionId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗑 Cancel session", `xs!:${sessionId}`)
    .text("Keep it", "xs:keep");
}

export function cancelDoneText(): string {
  return "Session cancelled.";
}

// ============================================================================
// /lfp-roster
// ============================================================================

export function rosterHeaderText(roster: RosterMember[]): string {
  if (roster.length === 0) {
    return "👥 Roster (0)\n\n<i>No players yet.</i> Tap ➕ to add the first one.";
  }
  return `👥 Roster (${roster.length})`;
}

export function rosterKeyboard(roster: RosterMember[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of roster) {
    const label = m.username ? `@${m.username}` : m.display_name;
    kb.text(label, `r:rm:${m.telegram_user_id}`).row();
  }
  kb.text("➕ Add player", "r:add").text("Done", "r:done");
  return kb;
}

export function rosterRemoveConfirmText(m: { username: string | null; display_name: string }): string {
  const name = m.username ? `@${m.username}` : escapeHtml(m.display_name);
  return `Remove ${name} from the roster?`;
}

export function rosterRemoveConfirmKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🗑 Remove", `r:rm!:${userId}`)
    .text("Cancel", "r:cancel");
}

export function rosterAddPromptText(): string {
  return [
    "Add a player. Two ways:",
    " 1. Send <code>@username</code>.",
    " 2. Reply to a message from the player and tap below.",
    "",
    "Tip: <code>/lfp_add @username</code> works directly.",
  ].join("\n");
}

export function rosterDoneText(roster: RosterMember[]): string {
  return `👥 Roster (${roster.length}) — done.`;
}

// ============================================================================
// /lfp-stacks
// ============================================================================

export function stacksText(): string {
  return "⚙️ Which party sizes are valid for this chat?";
}

export function stacksKeyboard(current: number[]): InlineKeyboard {
  const set = new Set(current);
  const kb = new InlineKeyboard();
  // Fixed display order: 5, 4, 3, 2
  const opts = [5, 4, 3, 2];
  let i = 0;
  for (const n of opts) {
    const mark = set.has(n) ? "✅" : "❌";
    kb.text(`${n}  ${mark}`, `s:t:${n}`);
    i += 1;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 !== 0) kb.row();
  kb.text("Save", "s:save").text("Cancel", "s:x");
  return kb;
}

export function stacksSavedText(stacks: number[]): string {
  if (stacks.length === 0) return "⚠️ No stacks enabled — the bot can't lock anything until you re-enable some.";
  return `⚙️ Stack priority saved: ${stacks.join(" → ")}`;
}

// ============================================================================
// /lfp-tz
// ============================================================================

export function tzText(currentTz: string): string {
  return `🌍 Current timezone: <code>${escapeHtml(currentTz)}</code>\nPick one:`;
}

export function tzKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  let i = 0;
  for (const z of COMMON_TZS) {
    kb.text(z, `tz:set:${i}`);
    i += 1;
    if (i % 2 === 0) kb.row();
  }
  if (i % 2 !== 0) kb.row();
  kb.text("Other…", "tz:other").text("Cancel", "tz:x");
  return kb;
}

export function tzSavedText(tz: string): string {
  return `🌍 Timezone set to <code>${escapeHtml(tz)}</code>.`;
}

export function tzOtherPromptText(): string {
  return "Send the IANA timezone name as a single message (e.g., <code>Europe/Vilnius</code>, <code>America/New_York</code>).";
}

// ============================================================================
// /help
// ============================================================================

export const HELP_TEXT = [
  "<b>five-stack-bot</b> — coordinate tonight's LoL party.",
  "",
  "<b>Sessions</b>",
  "  /lfp                       Open a session (wizard).",
  "  /lfp 18-23                 Open immediately for 18:00–23:00.",
  "  /lfp 18-23 [5,3,2] @a @b   Inline stacks + tags (adds tags to roster).",
  "  /lfp_bump                  Re-post the poll at the bottom of chat.",
  "  /lfp_cancel                Cancel the active session.",
  "",
  "<b>Roster</b>",
  "  /lfp_roster         Show &amp; manage roster.",
  "  /lfp_add @user      Add a player (or reply to their message).",
  "  /lfp_remove @user   Remove a player.",
  "  /lfp_skip @user     Mark as no-show for this session only.",
  "",
  "<b>Settings</b>",
  "  /lfp_tz             Set timezone.",
  "  /lfp_stacks         Toggle valid party sizes.",
  "",
  "<b>Stats</b>",
  "  /lfp_stats          Aggregate session metrics.",
  "",
  "  /help               This message.",
  "",
  "Most commands open an inline keyboard when run with no arguments.",
].join("\n");

// ============================================================================
// Misc
// ============================================================================

export function noActiveSessionText(): string {
  return "No active session. Open one with /lfp.";
}

export function existingSessionText(): string {
  return "A session is already active.";
}

export function notInGroupText(): string {
  return "five-stack-bot only works in group chats — add me to your friend-group chat first.";
}

export function rosterEmptyOnLfpText(): string {
  return [
    "👥 No roster yet.",
    "",
    "Add the players who count for vote tallies. Three ways:",
    " 1. Send <code>/lfp_add @karolis @tomas @mantas</code>.",
    " 2. Reply to a player's message with <code>/lfp_add</code>.",
    " 3. Add and open in one shot: <code>/lfp 18-23 @karolis @tomas …</code>",
  ].join("\n");
}
