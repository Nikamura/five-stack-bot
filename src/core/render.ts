import { InlineKeyboard } from "grammy";
import type { LockResult, SlotTally, PartyWindow } from "./lock.js";
import { compressSlotRanges, formatSlot } from "./slots.js";
import type { RosterMember, SessionRow } from "../db/types.js";
import {
  escapeHtml,
  mention,
  mentionByIdsWithLate,
  mentionList,
} from "./mention.js";
import { COMMON_TZS } from "./time.js";

// ============================================================================
// Session message
// ============================================================================

function startTimeRange(startMinutes: number, endMinutes: number): string {
  const lastStart = endMinutes - 30;
  return startMinutes === lastStart ? formatSlot(startMinutes) : `${formatSlot(startMinutes)}–${formatSlot(lastStart)}`;
}

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
  parties?: PartyWindow[];
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
  const range = startTimeRange(session.start_minutes, session.end_minutes);
  const rosterStr = roster.length === 0 ? "<i>(empty)</i>" : mentionList(roster);
  const responded = new Set(tallies.flatMap((t) => [
    ...t.yesUserIds, ...t.maybeUserIds, ...t.noUserIds, ...t.fillerAvailableUserIds,
  ]));
  const lines = [
    `🎮 <b>${opener}</b> is looking for a party!`,
    `Start times: <b>${range}</b> · ${validStacks.join(" / ")}-player parties`,
    `Roster: ${rosterStr}`,
    "",
  ];
  if (lock?.slot !== null && lock?.slot !== undefined) {
    lines.push(`🔒 <b>${lock.size}-stack at ${formatSlot(lock.slot)}</b>`);
  } else {
    lines.push("Waiting for enough overlapping availability.");
  }
  if (args.parties?.length) lines.push(...renderPartyWindows(args.parties, roster));
  lines.push(`Saved replies: <b>${responded.size}/${roster.length}</b>`, "");
  lines.push(...voterSummary({ roster, tallies, skipIds, fillerIds, totalSlots }));
  const pending = roster.filter((m) => !responded.has(m.telegram_user_id));
  if (pending.length) lines.push(`⏳ Not answered: ${mentionList(pending)}`);
  lines.push("", "Open <b>Set my availability</b> to see live replies and choose your start times. Picker changes count only after <b>Save</b>.");
  lines.push("Or tap <b>Can’t play tonight</b> here to decline all remaining start times immediately.");
  if (spectatorCount > 0) lines.push(`+${spectatorCount} spectator${spectatorCount === 1 ? "" : "s"} interested`);
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

/** A group-safe URL button launches the personal Mini App using a signed session link. */
export function renderSessionKeyboard(args: {
  sessionId: number;
  miniAppUrl?: string | null;
}): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (args.miniAppUrl) kb.url("📅 Set my availability", args.miniAppUrl);
  else kb.text("📅 Set my availability", `app:setup:${args.sessionId}`);
  kb.row().text("🚫 Can’t play tonight", `vbn:${args.sessionId}`);
  kb.row().text("🔔 Remind non-voters", `vr:${args.sessionId}`);
  return kb;
}

export function renderVoteReminder(mentions: string): string {
  return `🔔 ${mentions} — up for a game tonight?\nPlease choose your times or tap “Can't play tonight”.`;
}

export function renderVoteReminderKeyboard(sessionId: number, miniAppUrl: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (miniAppUrl) kb.url("🗳 Choose times", miniAppUrl);
  else kb.text("🗳 Choose times", `app:setup:${sessionId}`);
  kb.row().text("🚫 Can't play tonight", `vbn:${sessionId}`);
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
  /**
   * Roster members who haven't voted on any slot in this session. When the
   * locked size is below {@link upgradeTarget}, we tag them in the GAME ON
   * body so they know a ✅ from them would upgrade the party.
   */
  unvotedIds?: number[];
  /** The next-larger enabled stack (e.g. 5 when locked at 4). */
  upgradeTarget?: number | null;
  parties?: PartyWindow[];
}): string {
  const map = new Map(args.roster.map((m) => [m.telegram_user_id, m]));
  const coreStr = mentionByIdsWithLate(
    args.roster,
    args.coreIds,
    args.lateByUserId ?? new Map(),
  );
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
  if (
    args.upgradeTarget &&
    args.upgradeTarget > args.size &&
    args.unvotedIds &&
    args.unvotedIds.length > 0
  ) {
    const mentions = args.unvotedIds
      .map((id) => {
        const m = map.get(id);
        return m ? mention(m) : "";
      })
      .filter(Boolean)
      .join(" ");
    if (mentions) {
      lines.push(
        "",
        `🔔 ${mentions} — save your availability for ${formatSlot(args.slot)} to upgrade to a ${args.upgradeTarget}-stack.`,
      );
    }
  }
  if (args.parties?.length) lines.push("", ...renderPartyWindows(args.parties, args.roster));
  return lines.join("\n");
}

/** Compact independent windows. Exact saved-start ranges avoid implying play duration. */
export function renderPartyWindows(parties: PartyWindow[], roster: RosterMember[]): string[] {
  const names = new Map(roster.map(m => [m.telegram_user_id, escapeHtml(m.display_name)]));
  const lines = ["<b>Playable parties · start options</b>"];
  for (const party of parties.slice(0, 4)) {
    const range = startTimeRange(party.slot, party.endSlot);
    const players = party.core.map(id => `${names.get(id) ?? "Player"}${party.fillerIds.includes(id) ? " (if needed)" : party.maybeIds.includes(id) ? " (maybe)" : ""}`).join(", ");
    lines.push(`${range} · <b>${party.size}-stack</b> — ${players}`);
  }
  if (parties.length > 4) lines.push(`+${parties.length - 4} more parties in the availability app.`);
  return lines;
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
  return `🤷 ${maybeMentions} — you're in the party as a maybe. Open your availability, change the locked start to Yes, and Save to confirm you're playing.`;
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

export function renderPartyDelayed(args: {
  readyCount: number;
  lateMentions: string;
  delayMinutes: number;
}): string {
  const players = args.readyCount === 1 ? "player is" : "players are";
  return (
    `⏳ <b>Party delayed ${args.delayMinutes} min</b> — ` +
    `${args.readyCount} on-time ${players} not enough for an enabled stack.\n` +
    `Waiting for ${args.lateMentions}.`
  );
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
  return `🎮 Earliest start: ${formatSlot(startMinutes)}. When should the start window end? The selected end is excluded.`;
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
    `🎮 Open a session with start times ${startTimeRange(args.startMinutes, args.endMinutes)} tonight?`,
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
  "  /lfp_link [Telegram ID] Name#TAG euw1  Link a roster member.",
  "  /lfp_link_bulk      Link up to 10 members, one mapping per line.",
  "  /lfp_unlink [Telegram ID]  Remove a roster member’s link.",
  "",
  "  /help               This message.",
  "",
  "Tap Set my availability on the group poll to open your personal picker.",
  "Choose possible start times, review your answer, then Save. Live group replies update while you edit.",
  "Or tap Can’t play tonight directly on the group poll to decline all remaining starts immediately.",
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
