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
| **Vote** | A roster member's stance on a slot: ✅ yes / 🤷 maybe / ❌ no. Defaults to "no vote" until cast. |
| **Lock** | The bot's declaration that a party is forming at a specific slot, with a specific 5/3/2 size and a specific player list. |
| **Alternate** | A player who voted yes on the locked slot but wasn't in the first 5. Auto-promoted if a locked player drops. |

## 5. Functional Requirements

### 5.1 Session lifecycle

A session can be opened two ways:

- **Wizard mode (default for tap users):** `/lfp` with no args replies with an inline keyboard. Step 1 picks the **start hour**; step 2 picks the **end hour** (only hours after the chosen start are offered); step 3 is a confirm screen showing the range and the chat's current stack-priority. This is the primary path on mobile.
- **Shortcut (power users):** `/lfp 18-23` opens a session immediately for that range, no keyboard. Args are integer hours; end hour `24` means midnight.

Only **one active session per chat**. A second `/lfp` while one is active replies with a link to the running session and a `[Cancel current]` button.

The session **auto-archives** when:
  - the last slot's start time has passed, OR
  - 03:00 local time hits, whichever comes first.

**`/lfp-cancel`** — or the inline `[Cancel session]` button on the session message — ends the session manually. Cancellation always asks for one confirmation tap before destroying state.

After archive, a fresh `/lfp` starts a brand-new session.

### 5.2 Roster

The first `/lfp` in a chat with no roster routes the initiator into a roster-setup flow before opening the session: paste `@`-mentions, or reply to a player's chat message and tap `[Add this user]`. Roster persists indefinitely and is reused for every future session.

Roster management is keyboard-driven, with typed shortcuts available:

- **`/lfp-roster`** — prints the current roster as an inline keyboard, one button per player. Tapping a name opens a `[Remove]` confirm. Footer buttons: `[➕ Add player]`, `[Done]`.
- **`/lfp-add`** — with no args, explains the two add methods (mention or reply to a message). With `@username` or as a reply, adds directly.
- **`/lfp-remove`** — with no args, opens the same roster keyboard pre-armed for removal. With `@username`, removes directly.
- Removing a player who's currently locked into an active session also removes their lock and triggers re-evaluation (see §5.5).

### 5.3 Voting

- The session message displays each slot as a row with three tally counters: ✅ count, 🤷 count, ❌ count.
- Inline buttons let any chat member toggle their vote per slot.
- Players can change their vote at any time while the session is active.
- A bulk **"I can't play tonight"** button sets all of a player's slots to ❌ in one tap.
- Votes from non-roster chat members are accepted but **don't count toward lock decisions**; they're shown separately as "+N spectators interested" for visibility.

### 5.4 Lock logic

The chat has a **valid-stack set**, configurable via `/lfp-stacks` (see §5.7), defaulting to `{5, 3, 2}`. The bot continuously evaluates after every vote change, walking the valid stacks largest-first:

1. **Try the largest enabled stack** (default 5). If any slot has ≥ 5 ✅ votes from roster members, lock the **earliest** such slot at 5-stack.
2. **Otherwise, is a 5-stack still mathematically possible?** A slot is "still in play for 5-stack" if `(✅ + 🤷 + not-yet-voted)` on that slot is ≥ 5. If any slot is still in play, **wait** — do not lock anything smaller.
3. **Otherwise, try the next-largest enabled stack** (default 3). Lock the slot with the most ✅ votes (≥ 3) at 3-stack, choosing earliest on tie.
4. **Otherwise, try 2-stack** by the same rule (≥ 2 ✅).
5. **Otherwise, no lock** — the bot waits or eventually archives the session unanswered.

The "skip 4-stack" rule from your group's preference is implemented by 4 being absent from the default valid-stack set, not by hardcoded logic. A different chat can enable 4 if they want.

When the bot locks, the **first 5 (or 3, or 2) ✅ voters in chronological vote order** form the party. Anyone else who voted ✅ on that slot becomes an **alternate**, ranked by vote time.

Because step 2 only releases the lock once every roster member has voted (or voted ❌), an inactive player who never responds will block fall-back to a smaller stack. That's intentional: the bot can't tell the difference between "still might join" and "phone is in a drawer." A human can `/lfp-skip @user` to mark a roster member as a no-show, treating them as ❌ for lock evaluation only (their roster membership is unchanged).

### 5.5 Lock-in actions

When the bot locks a party, it:

1. **Posts a separate "GAME ON" message** in the chat that `@`-mentions every locked player and names the size and time. Example: `🔒 GAME ON 21:00 — 5-stack: @karolis @tomas @mantas @justas @aurimas`. The session poll continues to live next to it.
2. **Schedules a T-15 reminder** that `@`-mentions the locked players 15 minutes before the slot start time. Example: `⏰ 15 min — boot up. @karolis @tomas @mantas @justas @aurimas`.
3. **Keeps watching for changes.** If anything below happens, it re-runs §5.4:
   - A locked player flips to ❌ or is removed from the roster.
   - A new ✅ vote arrives that would upgrade a 3-stack to a 5-stack.
   - An alternate's ✅ stays standing while a locked player drops — the alternate is promoted, and the bot edits the GAME ON message to reflect the new lineup.

If a re-evaluation **changes** the locked party (different size, different time, or different lineup), the bot edits the GAME ON message in place and posts a follow-up `🔄 Party changed: <new state>` so it's visible in the chat scroll.

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

- **`/lfp-tz`** — with no args, shows quick-pick buttons for common zones (`Europe/Vilnius`, `Europe/Berlin`, `Europe/London`, `Europe/Helsinki`, `UTC`) plus an `[Other…]` button that prompts for a typed IANA zone. With an arg (e.g., `/lfp-tz Europe/Vilnius`), sets directly. Default for new chats: `Europe/Vilnius`. Affects slot display, "today," T-15 reminder firing, and the 03:00 archive cutoff. DST is handled by the underlying TZ database.
- **`/lfp-stacks`** — opens a toggle keyboard for which party sizes are valid. Each button is one number with its current state: `[5 ✅] [4 ❌] [3 ✅] [2 ✅]`. Tapping flips it; `[Save]` persists. Default: `{5, 3, 2}` (LoL flex queue–compatible). Order is fixed at largest-first; only inclusion is configurable.
- **`/help`** (alias `/lfp-help`) — prints the full command list with one-line descriptions and notes which support inline keyboards.

### 5.8 Permissions

The bot is **trust-based**: any member of the chat can run any command, including `/lfp-cancel`, `/lfp-remove`, and `/lfp-tz`. This fits a small private friend group with high trust. Every state-changing command writes an audit-log entry recording (chat, user, command, timestamp, args) so abuse is visible after the fact.

The bot itself does not need Telegram admin privileges in the chat.

## 6. Commands (reference)

Most commands work with **no args** (open an inline-keyboard wizard) **or with a typed arg** (immediate action). The "Wizard?" column says whether tapping the bare command opens a keyboard.

| Command | What it does | Wizard? |
|---|---|---|
| `/lfp` | Open a session via start/end-hour picker. | ✅ |
| `/lfp <start>-<end>` | Shortcut: open immediately for that range. | — |
| `/lfp-cancel` | Cancel the active session (with one-tap confirm). | ✅ |
| `/lfp-roster` | Show roster with per-row management buttons. | ✅ |
| `/lfp-add [@user]` | Add to roster — by mention, reply, or interactive flow. | ✅ |
| `/lfp-remove [@user]` | Remove from roster — by mention or pick from list. | ✅ |
| `/lfp-skip [@user]` | Mark a roster member as ❌ for this session only. | ✅ |
| `/lfp-tz [zone]` | Set timezone — quick-pick buttons or typed IANA zone. | ✅ |
| `/lfp-stacks` | Toggle which party sizes are valid (default `{5,3,2}`). | ✅ |
| `/lfp-stats` | Show chat stats (read-only). | — |
| `/help` | Help text (alias: `/lfp-help`). | — |

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
  /lfp                Open a session (wizard).
  /lfp 18-23          Open immediately for 18:00–23:00.
  /lfp-cancel         Cancel the active session.

Roster
  /lfp-roster         Show & manage roster.
  /lfp-add @user      Add a player (or reply to their message).
  /lfp-remove @user   Remove a player.
  /lfp-skip @user     Mark as no-show for this session only.

Settings
  /lfp-tz             Set timezone.
  /lfp-stacks         Toggle valid party sizes.

Stats
  /lfp-stats          Aggregate session metrics.

  /help               This message.

Most commands open an inline keyboard when run with no arguments.
```

### Session message (live)

The message body shows aggregate tallies; the inline keyboard below it lets each user cast/change their own vote. Tapping a slot button cycles **the tapping user's** vote (yes → maybe → no → cleared) and pops up a confirmation toast with their new state. The message body is then re-edited with updated aggregate counts.

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
```

Inline keyboard:

```
  [18:00]  [18:30]  [19:00]
  [19:30]  [20:00]  [20:30]
  [21:00]  [21:30]  [22:00]
  [22:30]  [23:00]

  [🚫 I can't play tonight]
  [❌ Cancel session]
```

### GAME ON announcement

```
🔒 GAME ON 21:00 — 5-stack
@karolis @tomas @mantas @justas @aurimas

Alternates: @ignas
```

### T-15 reminder

```
⏰ 15 min — boot up.
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

- `chats(chat_id, tz, valid_stacks, created_at)` — `valid_stacks` is a sorted CSV like `"5,3,2"`, edited via `/lfp-stacks`.
- `roster_members(chat_id, telegram_user_id, display_name, added_at)`
- `sessions(id, chat_id, start_hour, end_hour, opened_at, archived_at, lock_state)`
- `votes(session_id, telegram_user_id, slot_minutes, value, voted_at)` — `value` ∈ `yes|maybe|no`. `slot_minutes` is minutes-from-midnight in chat-local time.
- `locks(session_id, slot_minutes, size, locked_at)` — at most one row per session at a time.
- `lock_party(session_id, telegram_user_id, role)` — `role` ∈ `core|alternate`, `core` ordered by vote-time.
- `scheduled_jobs(id, fire_at, kind, payload)` — `kind` ∈ `archive_session|t_minus_15`. Rehydrated into in-process timers on boot.
- `audit_log(id, chat_id, telegram_user_id, command, args, at)`

### 8.4 Concurrency

All vote callbacks are serialised per session via a mutex (in-process is enough at this scale). After every state change, the lock-evaluation routine runs end-to-end and produces a new `lock_state`. Differences between old and new `lock_state` produce the user-visible side effects (edit poll message, post GAME ON, schedule/cancel T-15, etc.) — all idempotent.

### 8.5 Resilience

- On boot, the bot rehydrates `scheduled_jobs` whose `fire_at` is in the future and skips ones that have already passed.
- For jobs whose `fire_at` is in the *recent* past (within 5 minutes of boot), the bot fires them anyway — better a slightly late T-15 than nothing.
- Telegram's `getUpdates` long-polling resumes from the last acknowledged offset, so messages received during downtime are processed on next boot.

## 9. Open Questions

These are intentionally deferred from v1; capturing them here so they aren't rediscovered later.

- **First-run onboarding** when the bot is added to a new chat — does it auto-greet? (For now: silent until first `/lfp`.)
- **Privacy/data retention** beyond the audit log. v1 keeps everything indefinitely; future revision may add a `/lfp-forget` command.
- **Bot identity** — final username + display name + profile picture. Not blocking implementation.
- **Telemetry / error reporting** — none in v1; logs go to stdout, scraped by the host.

## 10. Appendix: glossary

- **5-stack** — five players queueing as a premade party. The objective.
- **Trio / 3-stack** — three premade. Allowed in LoL ranked flex.
- **Duo / 2-stack** — two premade. Allowed in LoL solo/duo and flex.
- **4-stack** — four premade. **Not a valid LoL ranked queue option** and explicitly skipped by the bot's lock priority.
- **Locked / lock-in** — the bot has declared a definite party at a definite slot.
- **Alternate** — a yes-voter on the locked slot who didn't make the first cut. Promoted automatically if a core player drops.
