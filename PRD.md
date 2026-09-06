# five-stack-bot v2 — Product Requirements Document

## 1. Summary

A Telegram bot that coordinates tonight's League of Legends party for a private friend group. One group message shows the session, saved responses and current party. A personal Mini App opens from that message for each player to select availability and watch everyone else's saved choices live.

Time selections in the Mini App take effect only after **Save**. Choosing one time while building a draft cannot decline other times or form a party from unfinished input. A separate **Can't play tonight** button in the group submits a complete decline immediately, without opening the Mini App.

## 2. Goals

- Start a session with `/lfp` or a shortcut such as `/lfp 12-22`.
- Put setting availability or dropping out first, using two taps for an initial range and individual time edits afterward.
- Make everyone's saved times, live overlap and the current party the main view after answering; keep them available below the form while editing.
- Start the earliest playable party, defaulting to enabled sizes 5/3/2, and list other playable windows independently.
- Preserve existing announcements, reminders, roster tools and historical session data.

## 3. Non-goals

- Scheduling across multiple days; sessions are for the current date in the chat's timezone.
- Riot integration, matchmaking, game-mode voting, recurring sessions or voice coordination.
- Public stranger access or guest voting through the Mini App.
- Multi-language UI; the interface is English.

## 4. Core concepts

| Concept | Definition |
|---|---|
| Chat | A Telegram group with its own roster, timezone, stack configuration and sessions |
| Roster | Players eligible to read the session's private Mini App and submit availability |
| Session | A proposed start-time window for tonight, with at most one active session per chat |
| Candidate start | A start time on the 30-minute grid; session start is included and session end is excluded |
| Draft | One player's unfinished answer, kept in their open panel and invisible to other players |
| Saved answer | A complete response for the session's remaining future starts; selected starts are Yes/Maybe and all others are explicit No |
| Unanswered | No saved availability; opening the panel or session does not count as a reply |
| Opener | Organizer who ran `/lfp`; automatically added to the roster, with no automatic votes |
| Lock | The current chosen start, enabled party size, core players and alternates |
| Alternate | Available player outside the current core, eligible for promotion |
| Filler | Per-session “Only if needed” preference; the player's selected Yes/Maybe starts count after normal Yes and Maybe players when filling seats |

## 5. Functional requirements

### 5.1 Session lifecycle and organizer flow

The organizer opens tonight's session in either of two ways:

- `/lfp` shows a start-hour picker, an end-hour picker offering later hours, and a confirmation with roster size and current enabled stacks.
- `/lfp 18-23` opens immediately. Bounds accept `19`, `19:30` or `1930`; minutes must be :00 or :30. End `24`, `24:00` or `2400` means midnight. Optional `[5,3,2]` persists stack choices and `@mentions` add roster players in the same command.

For `/lfp 12-22`, selectable candidate starts run from **12:00 through 21:30**. The end is a boundary, not another candidate start. The group message tags the roster and offers **Set my availability** plus **Can't play tonight**. The organizer submits their own response using the same flow as everyone else.

Only one session is active per chat. Repeating `/lfp`, `/lfp_bump` or `/lfp_show` re-posts the live message at the bottom, updates the current message ID, and tombstones the previous message. Mini App links refer to the session and continue working after a bump.

The session archives at the final candidate start (`end - 30 minutes`) or the next local 03:00 cutoff, whichever occurs first. `/lfp_cancel` requests one confirmation before ending the session. There is no cancellation button in the shared availability keyboard. Archived sessions reject saves; their saved data remains available for history. A later `/lfp` opens a new session.

### 5.2 Roster

The roster persists across sessions. An empty chat receives instructions for adding players through `/lfp_add`, a reply to a player's message, or mentions in the `/lfp` shortcut. The opener is added automatically.

- `/lfp_roster` shows players with removal confirmation, Add player and Done controls.
- `/lfp_add` accepts one or several mentions, or a reply carrying a real Telegram user ID.
- `/lfp_remove` accepts a username or opens the removal picker. Active sessions re-evaluate after roster changes.
- Mention-only entries initially use synthetic IDs. A matching **verified** Telegram username can bind a synthetic entry to the real user ID when that player opens the Mini App. An existing positive user-ID entry cannot be claimed by username alone.
- `/lfp_skip` marks a roster member unavailable for this session only. Their next complete Save clears the skip. Permanent removal uses `/lfp_remove`.

Mini App reads, saves and streams require roster membership. Removing a player revokes an open stream's access on its next check. Historical spectator votes may remain in stored data, but v2 accepts no new spectator submissions.

### 5.3 Responder flow and explicit Save

**Can't play tonight** on the group message is a one-tap submission: it immediately saves No for every remaining future start and clears filler/skip state. It requires the tapping player's Telegram identity and roster membership, rejects closed sessions, and updates the group and open panels. No popup or further confirmation is required. This declines only that player's availability; it does not cancel the group session.

For selecting or editing possible starts:

1. Tap **Set my availability** on the group message. A signed direct link opens the Main Mini App as a compact panel inside Telegram.
2. If unanswered, land directly on **When can you play?**, with session date/timezone and **Choose times** selected. Group results do not push the answer form below the first screen. If already answered or skipped, open the live group view with a compact saved-answer summary; **Edit availability** opens the preselected form.
3. On a new empty answer, tap the first candidate start, then the last. The grid selects all candidates between them, including both endpoints, then switches to individual add/remove taps. Editing an existing selection starts in individual-edit mode. **Add a range** starts another two-tap block, **All times** selects remaining starts, and **Clear** empties the draft and returns to initial range selection. Choose **Can't play** to drop out. Normal selection means Yes; **More options** exposes Maybe and Only if needed without requiring those decisions in the basic flow.
4. Review the preview and its explicit warning that all other remaining starts will be declined.
5. Tap **Save availability**. Keep the panel open and switch to the live group view: show everyone's saved times and the per-start breakdown directly, with no disclosure to open. Keep your saved answer compact with **Edit availability** for changes.

Each selected button represents one possible game start, not a duration or a play-until time. For example, tapping **13:00 then 17:30** selects ten starts in two taps. Tapping the same time twice completes a single-start range; tapping endpoints in reverse order selects the same interval. The first endpoint is visibly pending and cannot be saved; the UI prompts for the second endpoint. **Cancel range** abandons that pending selection while preserving existing choices. All times and Clear also cancel a pending endpoint. After a completed range, ordinary taps change only the tapped start. Add a range can add a separate block while keeping the existing selection; overlapping existing starts retain their response values.

An existing mixed Yes/Maybe answer retains each start's saved value when loaded, when other starts are toggled and when ranges or All times add starts. More options shows Mixed saved replies for that state; deliberately choosing I'm in, Maybe or Only if needed applies the chosen response to all selected starts. Filler is a preference for the entire answer and never overrides an unavailable time.

Inside the Mini App, shared state and the previous saved answer stay unchanged until Save, including when choosing Can't play. Cancelling an edit restores the saved answer. A fresh unanswered player stays unanswered while drafting even though Choose times is the default. Choosing Can't play explicitly is required to submit no available starts; Clear or an empty selection cannot silently decline the session. The separate group button submits immediately as described above.

Save is one database transaction covering the user's future-slot votes, filler preference and session skip. Unselected future starts become explicit No. Past-slot records remain unchanged; a start that passes while editing is omitted from the submitted selection and indicated in the preview. If no future starts remain, saving is disabled and the server rejects the request.

Each answer has a per-user revision. Other people's saves do not invalidate it. If the same player's saved answer changes elsewhere, an unfinished draft remains intact and the UI requires an explicit choice to load the saved version or keep the draft before another Save. A lost-response retry with the same answer is idempotent and preserves seat priority. Failed requests keep the draft available for retry. Closing and reopening loads saved state; unsaved drafts are not persistent server data.

Telegram's MainButton mirrors Save. Back/close behavior preserves saved data, with native closing confirmation while a draft has changes.

### 5.4 Lock logic

The bot evaluates each **future** start after complete saves and relevant roster/configuration changes. Enabled sizes are configurable via `/lfp_stacks`, default `{5, 3, 2}`. Choose the earliest start where Yes + Maybe + filler can form an enabled party, selecting the largest enabled size at that start. Later larger or all-Yes parties never delay that earlier playable start.

One search contains multiple independent party windows. At every candidate start, seat the largest enabled party. Merge adjacent starts only if their playing lineup and Maybe/filler conditions match. A gap, changed lineup or changed size creates another window, even if both windows are 3-stacks. Thus 3 at 15:30, 4 at 16:30 and 5 at 17:30 are separate parties, not a series of postponements. Include fillers in a larger later party as authorized by their saved availability. Never assume an earlier participant remains available later; count only that later start’s saved answers.

Window ranges show candidate starts with the actual last start included, consistent with the picker; they are not a promise that a game ends at that time. Persist the plan in the same transaction as an accepted availability save, before the Telegram debounce. Retain already-started slots as historical commitments while future slots recompute; a last-second accepted decline must update the plan before that start becomes history. Keep a separate last-notified plan so the debounced change announcement is not lost. Identity rebinding updates both stored plans. The earliest party stays in the existing lock record for backward-compatible first-party lateness and session stats. Before a party starts, loss of availability may still move or dissolve that party.
Seats rank **Yes, then Maybe, then filler**, with earlier vote time first within each category. Everyone else available at the chosen start becomes an alternate in the same order. A new Yes may replace a Maybe or filler; a Maybe may replace a filler. Fillers can help achieve a larger enabled party but occupy seats after normal responses.

Saved-answer writes preserve unchanged vote timestamps. Editing unrelated starts or retrying a Save must not reorder an existing Yes at the locked start. Missing votes are unanswered; the lock evaluator never infers No merely because a player voted at a different start. Explicit No is written by a complete Save or the group's direct Can't play submission, never by draft interaction.

### 5.5 Shared live status and party notifications

The group message shows the proposed start window, enabled party sizes, roster, current lock or waiting state, saved reply count, compressed per-player availability and unanswered players. Inside the Mini App, live availability counts appear on the selectable time buttons. While answering or editing, group details remain secondary below the personal form and can be expanded. Once an answer is saved, the group becomes the main view: show players' saved choices and per-start details openly, distinguishing available, Maybe, Only if needed, unavailable and unanswered players. A compact personal summary keeps editing accessible. Reopening with a saved answer returns to the group view, and live updates stay visible without closing the panel.

Open panels receive current snapshots over authenticated SSE. The server checks about once per second and sends changes plus periodic keepalives. Player saves, roster changes, lateness flags, session closure and evaluated lock changes appear without reopening. Reconnect catches up from a complete snapshot. The UI shows Live, reconnecting/offline or ended state and does not replace a dirty draft when shared results change.

“Strongest start” is a live suggestion ranked by total saved availability (Yes + Maybe + filler), then normal Yes count, then earliest time. The persisted lock is shown separately and follows §5.4, including enabled sizes and earliest-playable priority. The full independent-party plan is shown alongside it.

Saves return persisted availability before Telegram edits finish. Lock evaluation coalesces bursts over about 1.5 seconds; poll edits are debounced about 1.1 seconds. The party and group message can therefore follow the saved answer shortly afterward.

When a party locks, the bot:

- Posts a separate **GAME ON** message tagging core players and listing alternates.
- Nudges newly seated Maybe players to open availability, change the locked start to Yes and Save.
- Tags unanswered players when their answer could upgrade to the next enabled size.
- Suggests a 3v3 custom when at least six roster members are available at the locked start, counting Yes, Maybe and fillers.
- Schedules a T-15 reminder for each party window, naming its own players and conditions. A newly formed future party already inside that window is reminded immediately. Persist one attempt per session/start before sending, so retries and restarts cannot duplicate the reminder; an uncertain send may be omitted. Reconcile the current plan under the mutex before delivery and cancel removed-window timers. Retain unchanged timer IDs. Persist all future timers before sending any immediate reminders, and isolate a failed send to its own window. Never remind historical windows newly discovered after their start.

GAME ON retains **I'll be 15 min late** for the first party. Only its core players can toggle their own flag. It annotates GAME ON and reminders without moving the start or timer. Lateness clears when the party's time or core changes or the lock dissolves; alternates-only changes preserve it. At reminder time, if late players leave too few on-time players for any enabled party, a second message explains the delay.

Before the first start, time, size or core-lineup changes edit GAME ON and post a visible change follow-up. Later-window changes update the full plan and post one compact plan update; they never describe earlier players as postponed or promoted to a later start. Alternates-only changes edit it silently. If no enabled party remains, GAME ON becomes **Party dissolved**, its T-15 reminder is cancelled, and the active session continues accepting availability.

### 5.6 Statistics and configuration

`/lfp_stats` shows session counts over 30/90 days and 90-day player join rates, common locked start and common stack size. Data comes from local session, vote and lock records.

`/lfp_tz` accepts a typed IANA timezone or a quick picker for Europe/Vilnius, Europe/Berlin, Europe/London, Europe/Helsinki and UTC, with an Other option. Default: Europe/Vilnius. The timezone determines tonight's date, candidate starts, archive cutoff and reminders.

`/lfp_stacks` toggles sizes 5/4/3/2 with Save/Cancel. Default 5/3/2 leaves 4 disabled; this is configuration, not a hardcoded exclusion. `/help` and `/lfp_help` list commands.

### 5.7 Permissions and authentication

Group command management is trust-based: any group member may manage sessions, roster and settings. Commands are audited locally. Bot admin privileges are optional: Pin messages supports silent pinning/unpinning, and Delete messages supports command cleanup. Redundant bot confirmations disappear after about eight seconds.

The Mini App backend validates Telegram's raw `initData` HMAC with constant-time comparison, rejects duplicate fields, validates the user ID and checks launch age (24 hours, with 30 seconds of future clock tolerance). Both Telegram's signature and a bot-signed session token bind the launch to its session. Client-supplied user IDs, URL session IDs and `initDataUnsafe` are never authorization sources.

All API reads, streams and saves require authentication and roster membership. Credentials are sent in the Authorization header, never API query strings or logs. Saves require the configured same origin, JSON and a bounded body. Connection/request limits, a static-file allowlist and restrictive browser headers apply. Expired authorization requires reopening from the group.

### 5.8 Upgrade and deployment

Existing votes are retained. A transactional, one-time migration materializes the former implicit declines for existing engaged roster members, preserving the meaning of saved historical choices. New missing votes remain unanswered until a complete Save.

Startup refreshes active group and GAME ON messages. Old slot, all-Yes and filler callback buttons only upgrade their keyboard to the new controls; tapping them cannot cast a partial vote. The old Can't play callback remains a complete decline action, with the same checks as the new group button. Bumped messages keep referring to the original session.

The production HTTPS origin is `https://five-stack-bot.cn.lt` for `@five_stack_bot`. **Set my availability** uses a signed `t.me` direct URL with `startapp` and `mode=compact`; BotFather must map the bot's Main Mini App to that HTTPS URL. The group's direct Can't play action does not depend on Mini App setup. Deployment status, verification and remaining native launch checks live in [deploy/HOMELAB.md](./deploy/HOMELAB.md).

The local demo is isolated: it requires no token or database, uses sample players, and cannot write live availability. The live backend never accepts demo mode as authentication.

## 6. Command reference

| Command | Behavior |
|---|---|
| `/lfp` | Session wizard, or bump when a session is active |
| `/lfp <start>-<end> [stacks] @tags…` | Immediate session with optional stack settings and roster additions |
| `/lfp_bump`, `/lfp_show` | Re-post the active group message |
| `/lfp_cancel` | Cancel after confirmation |
| `/lfp_roster` | Manage roster |
| `/lfp_add [@user]` | Add through mentions, reply or instructions |
| `/lfp_remove [@user]` | Remove by username or picker |
| `/lfp_skip [@user]` | Session-only unavailability |
| `/lfp_tz [zone]` | Timezone picker or direct setting |
| `/lfp_stacks` | Toggle enabled party sizes |
| `/lfp_stats` | Local chat statistics |
| `/help`, `/lfp_help` | Help |

Telegram command names use underscores.

## 7. Example responder journey

```text
Group: Start window 12:00–22:00 · 5 / 3 / 2-player parties
       Saved replies: 2/6
       [Set my availability] [Can't play tonight]

Personal panel: When can you play?                            Live
                Today · Europe/Vilnius
                [Choose times] [Can't play]
                Tap the first start, then the last.
                [All times] [Clear]

                Tap 13:00 → tap 17:30
                All ten half-hour starts are now selected.
                Tap individual times to add/remove them.
                [Add a range]
                ...live availability counts on each button...
                [More options]

                In for starts at 13:00–17:30.
                All other remaining start times will be declined.
                [Save availability]

After Save:     Your availability is saved.
                [Edit my availability] [Back to chat]

Below answer:   [See everyone's answers ▸]
                Live group results are available when expanded.
```

## 8. Architecture and operations

One Node.js 22+ process runs the grammY bot, the HTTP/SSE server and persisted-job timers. Telegram updates still use long-polling; the Mini App additionally requires an inbound HTTPS route to the HTTP listener. TypeScript builds to `dist/`, and the unbundled browser assets live in `web/`. SQLite uses `better-sqlite3` on a persistent volume. Deployment targets the existing homelab bots stack described in [deploy/HOMELAB.md](./deploy/HOMELAB.md).

| Stored state | Purpose |
|---|---|
| `chats`, `roster_members` | Chat settings and persistent roster identities |
| `sessions` | Session bounds, date anchors, message IDs and archive times |
| `votes` | Explicit Yes/Maybe/No by player and candidate start, including vote priority timestamps |
| `session_skips`, `session_fillers` | Session-only no-show and filler preferences |
| `locks`, `lock_party`, `lock_late` | First chosen party, alternates and first-party lateness flags |
| `session_party_plans` | Persisted independent windows, including started history |
| `party_reminder_attempts` | Durable per-window reminder send claims |
| `scheduled_jobs` | Archive and T-15 timer metadata |
| `audit_log`, `schema_migrations` | Command audit records and applied migration markers |

Availability snapshots/mutations and lock processing use a per-session mutex. Multi-row answer saves and migrations use SQLite transactions. Telegram message edits tolerate unchanged/deleted messages and retry rate limits once using the indicated delay. The deployment runs one bot process against its database.

Startup restores future scheduled jobs, fires jobs up to five minutes overdue, and drops older overdue jobs. Pending Telegram updates are not deliberately discarded. Take a consistent SQLite backup through its backup API or `.backup`; copying the live main database file alone can omit data in the WAL.

The bot stays silent when first added until a group member invokes a command. Session history and audit data are retained without automatic deletion; there is no forget command. Logs go to stdout, with no external analytics service.

## Voting reminders

- The poll and Mini App group summary include **🔔 Remind non-voters**. Any group member can use the poll button; Mini App requests require authenticated roster membership. Both entry points share the same CTA and a **15-minute cooldown per session**.
- Voting reminders are **manual only**, sent when someone presses the button. Opening a session, bumping the poll, waiting or restarting never sends a voting reminder. The Mini App shows sending feedback and the shared remaining cooldown; its demo simulates the action without contacting Telegram. Previously scheduled voting reminders are discarded on boot.
- A reminder tags only current roster members with **no votes anywhere** in the session, excluding session skips. Anyone who has responded ✅, 🤷 or ❌ is excluded. It offers **🗳 Choose times** and **🚫 Can't play tonight**; the latter saves a complete decline for all remaining starts through the existing availability service. Choose times opens the same signed Mini App session link as the main poll.
- Keep **one active reminder per session**: remove the previous CTA before sending a fresh message, so eligible players can be notified again. If Telegram rejects deletion, replace its text with a closed notice and remove its buttons. If both cleanup operations fail, do not post another CTA.
- Vote/roster changes silently refresh the remaining mentions. Remove the CTA when everyone has responded (or been skipped), the largest enabled party is filled, or the session is cancelled/archived/expired; do not send a reminder in those states or after the locked game has started. The signed Choose times link survives poll bumps. Notification delivery follows each player's Telegram settings.
- Persist the current CTA message ID and last successful send time in SQLite. Cleanup preserves the cooldown; restart refreshes existing CTAs without sending a new notification.

## Search encouragement and recorded match facts

A newly created party search gets at most one short, silent reply alongside its initial poll. The existing English tone is retained. This runs after poll creation and archive scheduling, without awaiting tracker work; tracker trouble cannot block voting, locking, reminders, or party creation. Poll edits, bumps, repeat `/lfp` on an active search, restart refreshes and dissolved/reopened voting never trigger another encouragement.

Prerequisite: a roster member explicitly maps an account with `/lfp_link TelegramID Game Name#TAG euw1`; omit TelegramID to link the sender. `/lfp_unlink [TelegramID]` removes that link for this chat. Both actor and target must be in this chat’s roster with real positive Telegram IDs. This follows the private group’s trust model: roster members can manage each other’s links, with actor and target recorded in the audit log. The supplied Telegram ID identifies the target; names are never used for automatic account matching. A placeholder roster entry must first be bound by voting (or a friend can add the actual sender via a reply). The public tracker resolver validates the full Riot ID/platform. This is a manually declared association, not proof of Riot account ownership. No name guessing, token, or Riot key is involved. Store origin, PUUID, full Riot ID and platform per chat/user; reject duplicate accounts within a chat. Roster removal cascades to its link. Changed/missing accounts require explicit `/lfp_link` again; do not silently reassign identities.

`/lfp_link_bulk` accepts 1–10 nonblank lines of `TelegramID Game Name#TAG platform`. Every line requires an explicit positive Telegram ID in this chat’s roster; duplicate target IDs and duplicate resolved accounts are rejected. Resolve all accounts with the existing two-second per-request timeout before saving. The entire batch, including its actor/target audit record, is one SQLite transaction; failure leaves every mapping unchanged. Existing target mappings may be replaced or swapped; links outside the batch remain untouched. Return one confirmation naming all saved mappings, or one error. Repeating a successful batch preserves the same mappings.

Facts use the current linked roster, before a lineup exists: at least two linked friends on the same team in a flex game (queue 440), counted once by match ID. Matches with linked friends on opposing teams are omitted. Wording always identifies linked friends, shared flex games and recorded results. No individual blame or claims about current availability. `/lfp_stats` remains local scheduling metrics.

Small initial fact set:

- Today's recorded shared wins/losses, using Europe/Vilnius calendar days regardless of the scheduling timezone.
- The latest recorded shared play day's results within 48 hours, labelled by date; this is not called a session because a day can contain multiple sessions.
- At least three wins in the latest recorded shared flex games, only with a shared game within 48 hours. This describes the linked group history, never a specific lineup.
- Otherwise a brief rotating invitation. No weekday comparisons, reunion claims, or lineup-specific achievements in this version.

Defaults: six hours between new search attempts per chat (including suppressed attempts); seven-day rolling history; at most 10 unique linked accounts, 50 recent matches per account, 30 candidate shared match details, five detail requests concurrently. One overall 2.5-second tracker deadline, no retries; explicit account resolution has a two-second deadline. All accounts must have a match-poll timestamp within six hours. Every profile's filtered game count must equal its recent sample length; any cap, failed request, stale profile, invalid detail or excessive request budget falls back to an invitation. This describes only recorded cache history, not complete Riot history. Remakes under 300 seconds are excluded and detail queue/team/result values are verified.

SQLite retains one attempt row per session, plus selected category, phrasing, text and a sorted match-ID/result fingerprint for sent attempts. Claim before fetching; persist the chosen text before the single Telegram send attempt. Identical fact evidence is not reused under another category, another date label or another phrase. A candidate also needs a newest match/result event not already present in a used fact, so shrinking windows or unshown overlapping categories cannot manufacture freshness. Fresh candidates prefer the least recently used category, then rotate its wording; generic invitations rotate separately. History survives restarts and is retained with sessions. Account changes during fetching discard the pending encouragement. Cancelled or bumped searches discard it too.

Delivery deliberately favors at-most-once attempts: a crash or uncertain Telegram response can omit a line. It cannot be safely retried because Telegram offers no idempotency key for `sendMessage`. The normal poll remains authoritative.

The current [live consumer API](https://lol-tracker.cn.lt/API.md) is sufficient for this conservative scope; no tracker changes are needed. Richer complete weekday/session statistics are deferred. If added separately, the smallest missing contract is cursor pagination of filtered player match IDs with a stable snapshot boundary, `nextCursor`, explicit coverage/truncation metadata, and the same queue/remake/time semantics; the bot can deduplicate these IDs and verify teams via existing details. Player aggregates cannot substitute for group statistics.

## Completed crew match results

The bot checks lol-tracker's cached API every minute for each group chat with at least three explicitly linked roster members. When at least three linked players finish a match on the same team, it posts the team's victory/defeat, party size, each member's Riot name, champion and K/D/A, queue and duration, plus a **View match details** button at `https://lol-tracker.cn.lt/matches/<matchId>`. No active party search or saved availability is required. All recorded queues qualify; matches under 300 seconds do not. Two friends on one team and one opponent do not qualify. If both teams have three linked members, one message shows both results.

Watching starts at the first bot check, and resets when this chat's account mappings change. Only matches ending at or after that point qualify, including an in-progress game finishing afterwards. Startup does not replay old results. Restarts preserve the start boundary and claimed match IDs. Reads cover the last 24 hours, with up to 50 recent matches per account and 50 candidate details per check; outages beyond that coverage are not backfilled. At most one result is posted per chat per minute. Tracker polling/import time determines the actual delay; bot API reads never trigger Riot polling.

The result poller runs independently from scheduling, with a 15-second tracker deadline per chat and no overlapping poll runs. Links are rechecked before sending. A durable per-chat/match claim is saved before the Telegram request to prevent duplicate posts after restarts and ambiguous send failures. Delivery is at-most-once: a failed request or crash after the claim may lose that notification rather than resend it. Deploy the tracker's standalone match route before enabling this bot version.
