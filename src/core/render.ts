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
    totalSlots,
    spectatorCount,
  } = args;
  const opener = escapeHtml(session.opener_display_name);
  const range = `${formatHour(session.start_hour)}–${formatHour(session.end_hour)}`;
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
    lines.push(
      `  ${formatSlot(t.slot)}  ✅ ${t.yes}   🤷 ${t.maybe}   ❌ ${t.no}${tag}`,
    );
  }
  lines.push("</pre>");

  // Per-voter summary: lists each roster member with their compressed slot
  // ranges. Much more compact than per-row names when most slots agree.
  const voterLines = voterSummary({ roster, tallies, skipIds, totalSlots });
  if (voterLines.length > 0) {
    lines.push(...voterLines);
  }

  lines.push("<i>Tap a slot to cycle ✅ → 🤷 → ❌. 🚫 below sets every slot to ❌.</i>");

  if (!lock || lock.slot === null) {
    const tentative = tentativeLock({ tallies, validStacks });
    if (tentative) {
      const slotTally = tallies.find((t) => t.slot === tentative.slot);
      const coreNames = (slotTally?.yesUserIds ?? [])
        .slice(0, tentative.size)
        .map((id) => rosterById.get(id)?.display_name)
        .filter((n): n is string => !!n)
        .map(escapeHtml)
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
  totalSlots: number;
}): string[] {
  const { roster, tallies, skipIds, totalSlots } = args;

  const yesByUser = new Map<number, number[]>();
  const maybeByUser = new Map<number, number[]>();
  const noByUser = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, uid: number, slot: number) => {
    const arr = m.get(uid);
    if (arr) arr.push(slot);
    else m.set(uid, [slot]);
  };
  for (const t of tallies) {
    for (const uid of t.yesUserIds) push(yesByUser, uid, t.slot);
    for (const uid of t.maybeUserIds) push(maybeByUser, uid, t.slot);
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

  for (const m of roster) {
    if (skipIds.has(m.telegram_user_id)) {
      noEntries.push(`${escapeHtml(m.display_name)} (skipped)`);
      continue;
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
  if (noEntries.length > 0) out.push(`❌ ${noEntries.join(", ")}`);
  return out;
}

function hint(t: SlotTally, lock: LockResult | null, largestStack: number | undefined): string {
  if (lock && lock.slot !== null) return "";
  if (typeof largestStack !== "number") return "";
  if (t.yes >= largestStack) return "";
  if (t.yes + t.maybe + t.notVoted >= largestStack && t.notVoted > 0) {
    return `   (${largestStack}-stack still possible: ${t.notVoted} not voted)`;
  }
  return "";
}

function formatHour(h: number): string {
  // endHour can be 24 (midnight); display as 24:00 to match the PRD UX.
  return `${String(h).padStart(2, "0")}:00`;
}

export function renderSessionKeyboard(args: {
  sessionId: number;
  slots: number[];
  perRow?: number;
}): InlineKeyboard {
  const { sessionId, slots, perRow = 3 } = args;
  const kb = new InlineKeyboard();
  let i = 0;
  for (const s of slots) {
    kb.text(formatSlot(s), `v:${sessionId}:${s}`);
    i += 1;
    if (i % perRow === 0) kb.row();
  }
  if (i % perRow !== 0) kb.row();
  kb.text("🚫 I can't play tonight", `vbn:${sessionId}`);
  return kb;
}

// ============================================================================
// GAME ON / T-15 / changes
// ============================================================================

export function renderGameOn(args: {
  slot: number;
  size: number;
  coreIds: number[];
  alternateIds: number[];
  roster: RosterMember[];
  lateByUserId?: Map<number, number>;
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
  return lines.join("\n");
}

export function renderGameOnKeyboard(sessionId: number): InlineKeyboard {
  return new InlineKeyboard().text("⏰ I'll be 15 min late", `late:${sessionId}`);
}

export function renderT15(coreMentions: string): string {
  return `⏰ 15 min — boot up.\n${coreMentions}`;
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
    kb.text(`${h}:00`, `lfp:start:${h}`);
    i += 1;
    if (i % 3 === 0) kb.row();
  }
  if (i % 3 !== 0) kb.row();
  kb.text("Cancel", "lfp:wcancel");
  return kb;
}

export function wizardStep2Text(startHour: number): string {
  return `🎮 Start: ${formatHour(startHour)}. Latest end?`;
}

export function wizardStep2Keyboard(startHour: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  // End hour options: any hour > startHour, up to 24 (midnight).
  const ends: number[] = [];
  for (let h = startHour + 1; h <= 24; h += 1) ends.push(h);
  let i = 0;
  for (const h of ends) {
    kb.text(formatHour(h), `lfp:end:${startHour}:${h}`);
    i += 1;
    if (i % 3 === 0) kb.row();
  }
  if (i % 3 !== 0) kb.row();
  kb.text("◀ Back", "lfp:back:start").text("Cancel", "lfp:wcancel");
  return kb;
}

export function wizardStep3Text(args: {
  startHour: number;
  endHour: number;
  validStacks: number[];
  rosterSize: number;
}): string {
  const stackLine = args.validStacks.join(" → ");
  const skipped = [5, 4, 3, 2].filter((s) => !args.validStacks.includes(s));
  const skipStr = skipped.length ? ` (skip ${skipped.join(",")})` : "";
  return [
    `🎮 Open session ${formatHour(args.startHour)}–${formatHour(args.endHour)} tonight?`,
    `   Stack priority: ${stackLine}${skipStr}`,
    `   Roster: ${args.rosterSize} player${args.rosterSize === 1 ? "" : "s"}`,
  ].join("\n");
}

export function wizardStep3Keyboard(startHour: number, endHour: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Open session", `lfp:open:${startHour}:${endHour}`)
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
