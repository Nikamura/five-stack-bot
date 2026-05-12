# five-stack-bot — Product Requirements Document

## 1. Summary

A Telegram bot that lives in a friend-group chat and coordinates "are we playing tonight?" decisions for **League of Legends**. Replaces the current manual ritual — one person tags everyone individually and asks "20:00 or 21:00?" — with an interactive poll that aggregates each player's availability, picks the best time, and locks in a 5-stack (or trio, or duo) automatically.

The target users are adults with shifting evening schedules. The bot's job is to make "we're locked in for 21:00, five of us" appear as soon as the schedule allows it, without anyone manually counting votes.

## 2. Goals

- One command starts a session: `/lfp 18-23` opens voting for tonight, 18:00–23:00.
- Players cast yes / maybe / no per 30-minute slot from inline buttons.
- Bot auto-locks the **earliest slot at the highest valid stack size**, with priority **5 > 3 > 2** (4-stack skipped — LoL flex queue doesn't allow it).
- Bot tags players when a party locks in and again 15 minutes before the start time.
- Bot re-evaluates if anyone drops out after lock-in — including auto-promoting an alternate.

## 3. Non-Goals (v1)

- Multi-day scheduling. Sessions are always for *tonight*.
- Riot/LoL API integration (champ select detection, MMR, account linking).
- Recurring/auto-scheduled sessions (no "every weekday at 18:00" cron).
- Game-mode polling (Ranked Flex / Normals / ARAM picker).
- Voice coordination, party-finder for strangers, matchmaking, smurf detection.
- Multi-language UI. English only.

## 4. Core Concepts

| Concept | Definition |
|---|---|
| **Chat** | A Telegram group the bot has been added to. All state is scoped per-chat. |
| **Roster** | The list of players the bot considers part of this chat. Tagged on `/lfp`, eligible to vote. Defined and edited by chat members. |
| **Session** | One `/lfp` invocation. Has a slot range, a set of votes, and at most one locked party. |
| **Slot** | A 30-minute candidate start time within the session's range (e.g., 19:30, 20:00, 20:30…). |
| **Vote** | A roster member's stance on a slot: ✅ yes / 🤷 maybe / ❌ no. Defaults to "no vote" until cast. Tapping a slot button cycles ✅ → 🤷 → ❌ → ✅ (no "cleared" stop). |
| **Opener** | The user who ran `/lfp`. Auto-added to the roster (if not already in it) and auto-✅'d on every slot. Tap-to-change works exactly like any other voter. |
| **Lock** | The bot's declaration that a party is forming at a specific slot, with a specific 5/3/2 size and a specific player list. |
| **Alternate** | A player who voted yes on the locked slot but wasn't in the first 5. Auto-promoted if a locked player drops. |
| **Filler** | A roster member who toggled "I can fill if needed, but don't feel like playing" for this session. Their ✅ and 🤷 votes are pooled into a `fillerAvailable` bucket — they only complete a stack when real ✅ alone falls short, and they get bumped back to alternate the moment a real ✅ would replace them. ❌ from a filler is still ❌. Filler state is per-session and clears when the session archives. |

## 5. Functional Requirements

### 5.1 Session lifecycle

A session can be opened two ways:

- **Wizard mode (default for tap users):** `/lfp` with no args replies with an inline keyboard. Step 1 picks the **start hour**; step 2 picks the **end hour** (only hours after the chosen start are offered); step 3 is a confirm screen showing the range and the chat's current stack-priority. Scrim setup intentionally stays hour-only — the flexibility for individual half-hour availability lives in the voting keyboard. This is the primary path on mobile.
- **Shortcut (power users):** `/lfp 18-23` opens a session immediately for that range, no keyboard. Endpoints accept hour-only (`19`), colon (`19:30`), or compact 24h (`1930`) forms; minutes must be `:00` or `:30` to match the 30-minute slot grid. End `24` / `24:00` / `2400` means midnight. The shortcut also accepts an optional bracketed stacks list and any number of `@mentions` in any order, so `/lfp 18-23 [5,3,2] @karolis @tomas` opens the session, persists the stacks for the chat, and folds the tagged users into the roster — all in one message. This makes "fresh chat → first session" a single command.

Only **one active session per chat**. A second `/lfp` (or `/lfp_bump`) on an active session **bumps the poll**: re-posts the live state as a fresh message at the bottom of the chat, tombstones the old message (`↓ Session moved to a fresh message — vote below.`), and points all future body edits at the new message. Old buttons keep working — the callback handler routes by session id, not message id.

The session **auto-archives** when:
  - the last slot's start time has passed, OR
  - 03:00 local time hits, whichever comes first.

**`/lfp_cancel`** is the only way to end a session manually — there is no cancel button on the session keyboard, so misclicks during voting can't tear down the party. Cancellation asks for one confirmation tap before destroying state.

After archive, a fresh `/lfp` starts a brand-new session.

### 5.2 Roster

The first `/lfp` in a chat with no roster shows a short instructions message explaining the three ways to seed the roster: `/lfp_add @user`, replying to a player's message with `/lfp_add`, or running `/lfp 18-23 @user1 @user2 …` to add and open in a single command. Roster persists indefinitely and is reused for every future session.

The session **opener** is auto-added to the roster on `/lfp`. Telegram exposes the opener's user id directly, so they're a real roster entry from the first tap.

For users added by `@mention` (where the bot only sees the handle, not the user id), the roster stores them under a synthetic id keyed off the handle. The first time that user interacts with the bot — usually a vote tap — the synthetic entry is rebound to their real Telegram id.

Roster management is keyboard-driven, with typed shortcuts available:

- **`/lfp_roster`** — prints the current roster as an inline keyboard, one button per player. Tapping a name opens a `[Remove]` confirm. Footer buttons: `[➕ Add player]`, `[Done]`.
- **`/lfp_add`** — with no args, explains the two add methods (mention or reply to a message). With `@username` or as a reply, adds directly. Multiple `@mentions` in a single message all get added at once.
- **`/lfp_remove`** — with no args, opens the same roster keyboard pre-armed for removal. With `@username`, removes directly.
- Removing a player who's currently locked into an active session also removes their lock and triggers re-evaluation (see §5.5).
- Any roster mutation while a session is active triggers a session re-render so the slot tallies and voter summary stay correct.

### 5.3 Voting

- The session message displays each slot as a row with three tally counters: ✅ count, 🤷 count, ❌ count.
- Below the slot table, a per-voter summary lists each roster member with their compressed slot ranges per stance: `✅ Karolis (all), Tomas (18:00-19:30, 21:00-22:00)`. Contiguous slots collapse into ranges; if a voter chose the same stance on every slot, the range reads `(all)`. Skipped users (see §5.4) appear under ❌ as `Name (skipped)`.
- Inline buttons let any chat member toggle their vote per slot. Tapping cycles ✅ → 🤷 → ❌ → ✅. There is **no "cleared" stop** in the cycle — once you've voted on a slot you can't return to "no vote yet" via tapping. (Initial state is still "no vote" until the first tap.)
- The opener is auto-✅'d on every slot when the session is created, on the assumption that the person opening is one of the players. They can flip individual slots to 🤷 or ❌ as needed.
- Players can change their vote at any time while the session is active.
- A bulk **"✅ All times work"** button toggles every slot to ✅ in one tap (tap again to clear back to no vote). A bulk **"🚫 I can't play tonight"** button sets all of a player's slots to ❌ in one tap.
- A bulk **"🛟 I can fill if needed"** button toggles **filler mode** for the tapping user on this session. Filler users' ✅ and 🤷 votes are treated as "play if pushed" (see §5.4) rather than as a strict ✅. The button is a per-user toggle; the toast confirms ON/OFF. Their existing votes stay intact — only the *interpretation* changes.
- Each hour in the voting keyboard has a compact **`HH-(HH+1)`** combo button next to its two 30-min slots that toggles both halves of the hour at once, following the same ✅ → 🤷 → ❌ cycle as a single slot. Lets a player who's available for a whole hour express it with one tap instead of two.
- Votes from non-roster chat members are accepted but **don't count toward lock decisions**; they're shown separately as "+N spectators interested" for visibility.
- Slot-tap callbacks answer immediately (with an optimistic toast like `21:00: ✅`); the message body re-render is debounced ~1s so vote bursts coalesce into a single edit and don't trip Telegram's per-message rate limit.
- Slot buttons for times whose start has already passed are hidden from the keyboard — once 19:30 is in the past, the `[19:30]` button (and the `19-20` combo that toggles it) disappears so nobody accidentally votes on a slot no one can start. Tallies and per-voter history for past slots stay in the message body for context.

### 5.4 Lock logic

The chat has a **valid-stack set**, configurable via `/lfp-stacks` (see §5.7), defaulting to `{5, 3, 2}`. The bot continuously evaluates after every vote change, walking the valid stacks largest-first:

1. **Try the largest enabled stack** (default 5). If any slot has ≥ 5 real ✅ votes (i.e. from non-filler roster members), lock the **earliest** such slot at 5-stack. Fillers who also said ✅/🤷 on that slot become alternates.
2. **Otherwise, can a filler complete the stack?** If `(real ✅ + fillerAvailable)` reaches the stack size on any slot, lock the earliest such slot with fillers seated in vote-time order behind the real ✅ voters. A later real ✅ vote bumps the filler back to alternate (see "if 6th comes, 6th plays" §4).
3. **Otherwise, is the stack still mathematically possible?** A slot is "still in play" if `(✅ + 🤷 + fillerAvailable + not-yet-voted)` on that slot is ≥ stack size. If any slot is still in play, **wait** — do not lock anything smaller.
4. **Otherwise, try the next-largest enabled stack** (default 3), applying steps 1–3 again.
5. **Otherwise, try 2-stack** by the same rule.
6. **Otherwise, no lock** — the bot waits or eventually archives the session unanswered.

While no actual lock is in effect, the body shows a **tentative-lock footer** when *any* slot has reached the smallest valid stack: `⏳ Could play 3-stack at 19:00 with Karolis, Tomas, Justas — waiting on more votes for a bigger party.` This makes "we could play right now if nobody else shows up" visible without parsing the table.

The "skip 4-stack" rule from your group's preference is implemented by 4 being absent from the default valid-stack set, not by hardcoded logic. A different chat can enable 4 if they want.

When the bot locks, the **first 5 (or 3, or 2) ✅ voters in chronological vote order** form the party. Anyone else who voted ✅ on that slot becomes an **alternate**, ranked by vote time.

Because step 2 only releases the lock once every roster member has voted (or voted ❌), an inactive player who never responds will block fall-back to a smaller stack. That's intentional: the bot can't tell the difference between "still might join" and "phone is in a drawer." A human can `/lfp-skip @user` to mark a roster member as a no-show, treating them as ❌ for lock evaluation only (their roster membership is unchanged).

### 5.5 Lock-in actions

When the bot locks a party, it:

1. **Posts a separate "GAME ON" message** in the chat that `@`-mentions every locked player and names the size and time. Example: `🔒 GAME ON 21:00 — 5-stack: @karolis @tomas @mantas @justas @aurimas`. The session poll continues to live next to it. The GAME ON message carries one inline button: **`[⏰ I'll be 15 min late]`**. A locked player tapping it flags themselves as 15 min late and the message edits in place to annotate them (e.g. `@karolis (15 min late)`); tapping again clears the flag. The button is informational only — it does **not** shift the locked slot or the T-15 reminder. Only locked-party players can flag; non-party taps get a toast. Lateness resets automatically when the lineup changes or the party dissolves. The button only exists while a party is locked.
2. **Schedules a T-15 reminder** that `@`-mentions the locked players 15 minutes before the slot start time. Example: `⏰ 15 min — boot up. @karolis @tomas @mantas @justas @aurimas`. When the lock shifts to a slot that's already inside the 15-min window (e.g. a re-evaluation at 19:28 jumps the party to 19:30), the reminder fires immediately but switches to a shorter `🚀 Load up — game's starting.` headline so the "15 min" wording isn't misleading 2 min before tip-off.
3. **Keeps watching for changes.** If anything below happens, it re-runs §5.4:
   - A locked player flips to ❌ or is removed from the roster.
   - A new ✅ vote arrives that would upgrade a 3-stack to a 5-stack.
   - An alternate's ✅ stays standing while a locked player drops — the alternate is promoted, and the bot edits the GAME ON message to reflect the new lineup.

The GAME ON message includes a **3v3 hint** when at least 6 roster members are willing to play the locked slot (counting ✅, 🤷, and 🛟 filler availability): `💡 6 players available — consider 3v3 Summoner's Rift or ARAM custom so everyone plays.` 5-stack flex queue only seats 5; a custom 3v3 (SR or ARAM) lets all 6 friends play together. The hint counts maybes and fillers because the spec is "we could play 3v3 if this person shows up" — strict-✅ commitment isn't required to surface the option. Post-lock, the hint is refreshed in place whenever the alternates list changes (a new ✅/🛟 vote slots a 6th onto the bench, a filler toggles on, or a locked player drops with someone behind them). A standalone 🤷 against the locked slot doesn't re-trigger GAME ON since maybes aren't alternates, but the poll body still reflects it.

If a re-evaluation **changes** the locked party (different size, different time, or different lineup), the bot edits the GAME ON message in place and posts a follow-up `🔄 Party changed: <new state>` so it's visible in the chat scroll. An alternates-only change (e.g. a 6th ✅ slots onto the bench without bumping anyone out of the core) edits GAME ON silently — no follow-up — since the playing lineup hasn't actually moved.

If a re-evaluation **dissolves** the lock entirely (e.g., a 5-stack drop with no alternates and no fall-back trio possible), the bot edits GAME ON to `❌ Party dissolved` and reactivates voting — including releasing the T-15 reminder.

### 5.6 Stats / history

- **`/lfp-stats`** — prints aggregate metrics for the chat:
  - Sessions in the last 30 / 90 days.
  - Per-player join rate (% of sessions they ✅'d on the locked slot).
  - Most common locked time of day.
  - Most common locked stack size (5 / 3 / 2 / no-lock).
- All stats come from the local audit log; no external service.

### 5.7 Configuration

All configuration is reachable two ways: typed command (power users) or inline keyboard (tap users).

- **`/lfp_tz`** — with no args, shows quick-pick buttons for common zones (`Europe/Vilnius`, `Europe/Berlin`, `Europe/London`, `Europe/Helsinki`, `UTC`) plus an `[Other…]` button that prompts for a typed IANA zone. With an arg (e.g., `/lfp_tz Europe/Vilnius`), sets directly. Default for new chats: `Europe/Vilnius`. Affects slot display, "today," T-15 reminder firing, and the 03:00 archive cutoff. DST is handled by the underlying TZ database.
- **`/lfp_stacks`** — opens a toggle keyboard for which party sizes are valid. Each button is one number with its current state: `[5 ✅] [4 ❌] [3 ✅] [2 ✅]`. Tapping flips it; `[Save]` persists. Default: `{5, 3, 2}` (LoL flex queue–compatible). Order is fixed at largest-first; only inclusion is configurable.
- **`/help`** (alias `/lfp_help`) — prints the full command list with one-line descriptions and notes which support inline keyboards.

> **Naming note.** The Telegram Bot API's command grammar doesn't allow `-`, so command names use `_` (`/lfp_cancel`, `/lfp_add`, …). The hyphenated forms in this document are documentation-only labels matching the original PRD prose; the actual user-facing commands use underscores.

### 5.8 Permissions

The bot is **trust-based**: any member of the chat can run any command, including `/lfp_cancel`, `/lfp_remove`, and `/lfp_tz`. This fits a small private friend group with high trust. Every state-changing command writes an audit-log entry recording (chat, user, command, timestamp, args) so abuse is visible after the fact.

The bot itself does not require Telegram admin privileges. Two admin rights are **optional** and improve UX when granted:

- **Pin messages** — the bot pins the active session poll to the top of the chat (with notifications disabled), and unpins on cancel/archive.
- **Delete messages** — the bot best-effort deletes user command messages (`/lfp_add @x`, `/lfp_tz Europe/Vilnius`, etc.) so the chat stays focused on the session poll.

Both are silent no-ops if the bot doesn't have the right; nothing breaks. Bot replies that are redundant with the session message (e.g., "Removed @karolis.") are ephemeral — they auto-delete after ~8s using the bot's always-available right to delete its own messages.

## 6. Commands (reference)

Most commands work with **no args** (open an inline-keyboard wizard) **or with a typed arg** (immediate action). The "Wizard?" column says whether tapping the bare command opens a keyboard.

| Command | What it does | Wizard? |
|---|---|---|
| `/lfp` | Open a session via start/end-hour picker. On an active session, **bumps the poll** to the bottom. | ✅ |
| `/lfp <start>-<end>` | Shortcut: open immediately for that range. Bounds are on the 30-min grid (`HH` or `HH:MM`). | — |
| `/lfp <start>-<end> [stacks] @tags…` | Shortcut + override stack priority + add `@tags` to roster, all in one message. Tokens may appear in any order. | — |
| `/lfp_bump` | Re-post the active poll at the bottom of the chat (alias: `/lfp_show`). | — |
| `/lfp_cancel` | Cancel the active session (with one-tap confirm). | ✅ |
| `/lfp_roster` | Show roster with per-row management buttons. | ✅ |
| `/lfp_add [@user]` | Add to roster — by mention, reply, or interactive flow. | ✅ |
| `/lfp_remove [@user]` | Remove from roster — by mention or pick from list. | ✅ |
| `/lfp_skip [@user]` | Mark a roster member as ❌ for this session only. | ✅ |
| `/lfp_tz [zone]` | Set timezone — quick-pick buttons or typed IANA zone. | ✅ |
| `/lfp_stacks` | Toggle which party sizes are valid (default `{5,3,2}`). | ✅ |
| `/lfp_stats` | Show chat stats (read-only). | — |
| `/help` | Help text (alias: `/lfp_help`). | — |

## 7. UX Sketches

### `/lfp` wizard

Step 1 — start hour:

```
🎮 Open a session for tonight. When can the earliest player start?

  [16:00]  [17:00]  [18:00]
  [19:00]  [20:00]  [21:00]
  [22:00]  [23:00]

  [Cancel]
```

Step 2 — end hour (only later than chosen start):

```
🎮 Start: 18:00. Latest end?

           [20:00]  [21:00]
  [22:00]  [23:00]  [24:00]

  [◀ Back]  [Cancel]
```

Step 3 — confirm:

```
🎮 Open session 18:00–23:00 tonight?
   Stack priority: 5 → 3 → 2 (skip 4)
   Roster: 6 players

  [✅ Open session]  [Cancel]
```

### `/lfp-roster` keyboard

```
👥 Roster (6)

  [@karolis]
  [@tomas]
  [@mantas]
  [@justas]
  [@aurimas]
  [@ignas]

  [➕ Add player]   [Done]
```

Tapping a name:

```
Remove @ignas from the roster?

  [🗑 Remove]  [Cancel]
```

### `/lfp-stacks` keyboard

```
⚙️ Which party sizes are valid for this chat?

  [5  ✅]   [4  ❌]
  [3  ✅]   [2  ✅]

  [Save]   [Cancel]
```

### `/lfp-tz` keyboard

```
🌍 Pick the chat's timezone:

  [Europe/Vilnius]   [Europe/Berlin]
  [Europe/London]    [Europe/Helsinki]
  [UTC]              [Other…]

  [Cancel]
```

### `/help` output

```
five-stack-bot — coordinate tonight's LoL party.

Sessions
  /lfp                       Open a session (wizard).
  /lfp 18-23                 Open immediately for 18:00–23:00.
  /lfp 18-23 [5,3,2] @a @b   Inline stacks + tags (adds tags to roster).
  /lfp_bump                  Re-post the poll at the bottom of chat.
  /lfp_cancel                Cancel the active session.

Roster
  /lfp_roster         Show & manage roster.
  /lfp_add @user      Add a player (or reply to their message).
  /lfp_remove @user   Remove a player.
  /lfp_skip @user     Mark as no-show for this session only.

Settings
  /lfp_tz             Set timezone.
  /lfp_stacks         Toggle valid party sizes.

Stats
  /lfp_stats          Aggregate session metrics.

  /help               This message.

Most commands open an inline keyboard when run with no arguments.
```

### Session message (live)

The message body shows aggregate tallies and a per-voter slot summary; the inline keyboard below it lets each chat member cast/change their own vote. Tapping a slot button cycles **the tapping user's** vote (✅ → 🤷 → ❌ → ✅) and pops up a confirmation toast with their new state. The message body re-edits ~1s later with the new aggregate counts (debounced to coalesce vote bursts).

Body:

```
🎮 Karolis is looking for a party tonight! (18:00–23:00)
Roster: @karolis @tomas @mantas @justas @aurimas @ignas

  18:00  ✅ 1   🤷 0   ❌ 2
  18:30  ✅ 2   🤷 0   ❌ 2
  19:00  ✅ 3   🤷 1   ❌ 0
  19:30  ✅ 3   🤷 1   ❌ 0
  20:00  ✅ 4   🤷 0   ❌ 0   (5-stack still possible: 1 not voted)
  20:30  ✅ 4   🤷 1   ❌ 0
  21:00  ✅ 5   🤷 0   ❌ 0   ← 🔒 5-stack locked
  21:30  ✅ 3   🤷 1   ❌ 0
  22:00  ✅ 1   🤷 0   ❌ 2

✅ Karolis (all), Tomas (18:30-21:30), Mantas (19:00-21:30), Justas (19:00-22:00), Aurimas (21:00-21:30)
🤷 Ignas (19:00-19:30, 20:30-21:30)
❌ Aurimas (18:00-18:30, 22:00-22:30)
Tap a slot to cycle ✅ → 🤷 → ❌. 🚫 below sets every slot to ❌.
```

(Before any actual lock, a `⏳ Could play …` line replaces the per-slot lock indicator — see §5.4.)

Inline keyboard:

```
  [18:00]  [18:30]  [18-19]
  [19:00]  [19:30]  [19-20]
  [20:00]  [20:30]  [20-21]
  [21:00]  [21:30]  [21-22]
  [22:00]  [22:30]  [22-23]

  [✅ All times work]  [🚫 I can't play tonight]
  [🛟 I can fill if needed]
```

Each row is one hour: two 30-min slot buttons followed by a `HH-(HH+1)` combo that toggles both halves at once. If the session range covers only one half of a given hour (e.g. a 21:30 start clips the first half of 21:00), only the in-range half is shown for that hour and the combo button is omitted.

(No cancel button — only `/lfp_cancel` ends a session, to make tear-down a deliberate command rather than a misclickable button.)

### GAME ON announcement

```
🔒 GAME ON 21:00 — 5-stack
@karolis @tomas (15 min late) @mantas @justas @aurimas

Alternates: @ignas

💡 6 players available — consider 3v3 Summoner's Rift or ARAM custom so everyone plays.

  [⏰ I'll be 15 min late]
```

The `💡` hint only appears when at least 6 roster members are willing to play the locked slot (✅, 🤷, or 🛟 — see §5.5). With exactly 5 ✅ on the locked slot it's omitted.

### T-15 reminder

```
⏰ 15 min — boot up.
@karolis @tomas @mantas @justas @aurimas
```

If the lock shifts close to start time (less than 10 min before slot tip-off) the reminder fires immediately with a shorter headline so "15 min" isn't misleading:

```
🚀 Load up — game's starting.
@karolis @tomas @mantas @justas @aurimas
```

### Re-evaluation after a drop

```
🔄 Party changed
@aurimas dropped — @ignas promoted from alternate.
🔒 Still GAME ON 21:00 — 5-stack: @karolis @tomas @mantas @justas @ignas
```

## 8. Architecture

### 8.1 Stack

- **Runtime**: Node.js (LTS), TypeScript.
- **Telegram framework**: [grammY](https://grammy.dev/).
- **Storage**: SQLite via `better-sqlite3` (single file, transactional, zero external infra).
- **Scheduler**: in-process timers, with scheduled jobs persisted in SQLite so they survive restart (rehydrated on boot).
- **Transport**: long-polling. No inbound port required; the bot only makes outbound calls to `api.telegram.org`.
- **Containerisation**: Docker image with the SQLite file mounted on a host volume for persistence + easy backup.

### 8.2 Deployment

Target environment: a small VPS (Hetzner CX11 or DigitalOcean equivalent, ~€4–6/mo). Single Docker container, restart-always policy. Backups are a periodic copy of the `.db` file (cron + `rsync` or `restic`).

### 8.3 Data model (sketch)

- `chats(chat_id, tz, valid_stacks, created_at)` — `valid_stacks` is a sorted CSV like `"5,3,2"`, edited via `/lfp_stacks`.
- `roster_members(chat_id, telegram_user_id, username, display_name, added_at)` — `username` enables `@`-form mentions when available; `telegram_user_id` may be a synthetic negative id derived from the lowercase handle until the user's first interaction binds the real id.
- `sessions(id, chat_id, opener_user_id, opener_display_name, start_minutes, end_minutes, poll_message_id, game_on_message_id, opened_at, archive_at, archived_at)` — `start_minutes` and `end_minutes` are minutes-from-midnight on the 30-minute grid; `end_minutes = 1440` means midnight.
- `votes(session_id, telegram_user_id, slot_minutes, value, voted_at)` — `value` ∈ `yes|maybe|no`. `slot_minutes` is minutes-from-midnight in chat-local time.
- `session_skips(session_id, telegram_user_id)` — session-only no-shows from `/lfp_skip`. Counted as ❌ for lock evaluation only; roster membership is unchanged.
- `session_fillers(session_id, telegram_user_id, set_at)` — session-only filler flag from the **🛟 I can fill if needed** button. The user's ✅/🤷 on this session goes into the `fillerAvailable` pool instead of the strict-✅ pool; ❌ is unaffected. Cleared on session archive (via cascade) or by tapping the button again.
- `locks(session_id, slot_minutes, size, locked_at)` — at most one row per session at a time.
- `lock_party(session_id, telegram_user_id, role, vote_order)` — `role` ∈ `core|alternate`, `core` ordered by vote-time via `vote_order`.
- `lock_late(session_id, telegram_user_id, late_minutes, set_at)` — per-locked-player "I'll be late" flag. Cleared when the lineup changes or the party dissolves.
- `scheduled_jobs(id, fire_at, kind, payload, created_at)` — `kind` ∈ `archive|t15`. Rehydrated into in-process timers on boot.
- `audit_log(id, chat_id, telegram_user_id, command, args, at)`

### 8.4 Concurrency & rate limits

All vote handlers and roster mutations are serialised per session via an in-process per-session mutex. After every state change, the lock-evaluation routine runs end-to-end and produces a new lock state. Differences between old and new produce the user-visible side effects (post GAME ON, post party-changed follow-up, schedule/cancel T-15, etc.) — all idempotent.

The poll-message edit is **debounced** ~1s per session: each state change reschedules a single pending edit, so a burst of votes coalesces into one `editMessageText` call and stays under Telegram's per-message edit rate limit (~1/s for messages with inline keyboards). `safeEditMessage` also catches HTTP 429 explicitly: it sleeps `retry_after + 1s` and retries once before giving up.

Callback-query handlers always answer the query *first* (with an optimistic toast computed from the persisted state before the work runs) and do the DB / message-edit work after. This clears the button spinner immediately so rapid taps register cleanly. Toast text is best-effort under fast retaps; the message body remains the source of truth.

### 8.5 Resilience

- On boot, the bot rehydrates `scheduled_jobs` whose `fire_at` is in the future and skips ones that have already passed.
- For jobs whose `fire_at` is in the *recent* past (within 5 minutes of boot), the bot fires them anyway — better a slightly late T-15 than nothing.
- Telegram's `getUpdates` long-polling resumes from the last acknowledged offset, so messages received during downtime are processed on next boot.

## 9. Open Questions

These are intentionally deferred from v1; capturing them here so they aren't rediscovered later.

- **First-run onboarding** when the bot is added to a new chat — does it auto-greet? (For now: silent until first `/lfp`.)
- **Privacy/data retention** beyond the audit log. v1 keeps everything indefinitely; future revision may add a `/lfp_forget` command.
- **Bot identity** — final username + display name + profile picture. Not blocking implementation.
- **Telemetry / error reporting** — none in v1; logs go to stdout, scraped by the host.

## 10. Appendix: glossary

- **5-stack** — five players queueing as a premade party. The objective.
- **Trio / 3-stack** — three premade. Allowed in LoL ranked flex.
- **Duo / 2-stack** — two premade. Allowed in LoL solo/duo and flex.
- **4-stack** — four premade. **Not a valid LoL ranked queue option** and explicitly skipped by the bot's lock priority.
- **Locked / lock-in** — the bot has declared a definite party at a definite slot.
- **Alternate** — a yes-voter on the locked slot who didn't make the first cut. Promoted automatically if a core player drops.
