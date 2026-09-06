# five-stack-bot v2 — Product Requirements Document

## 1. Summary

A Telegram bot that coordinates tonight's League of Legends party for a private friend group. One group message shows the session, saved responses and current party. A personal Mini App opens from that message for each player to select availability and watch everyone else's saved choices live.

Time selections in the Mini App take effect only after **Save**. Choosing one time while building a draft cannot decline other times or form a party from unfinished input. A separate **Can't play tonight** button in the group submits a complete decline immediately, without opening the Mini App.

## 2. Goals

- Start a session with `/lfp` or a shortcut such as `/lfp 12-22`.
- Put setting availability or dropping out first, using two taps for an initial range and individual time edits afterward.
- Make everyone's saved times, live overlap and the current party the main view after answering; keep them available below the form while editing.
- Lock the largest enabled party achievable now, defaulting to 5/3/2, and revise it after saved changes.
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

The bot evaluates **future** starts after complete saves and relevant roster/configuration changes. Enabled sizes are configurable via `/lfp_stacks`, default `{5, 3, 2}`. For each size, largest-first:

1. If any start has enough normal **Yes** players, choose the earliest such start.
2. Otherwise, if **Yes + Maybe + filler availability** reaches that size, choose the earliest such start.
3. Otherwise, try the next enabled smaller size. If none is achievable, there is no lock.

This prefers a later all-Yes start over an earlier soft start **at the same size**, and a larger soft party over a smaller all-Yes party. It does not wait for unanswered players before locking a smaller available party. For example, three Yes replies can form a trio immediately; two later replies can upgrade it to five.

Seats rank **Yes, then Maybe, then filler**, with earlier vote time first within each category. Everyone else available at the chosen start becomes an alternate in the same order. A new Yes may replace a Maybe or filler; a Maybe may replace a filler. Fillers can help achieve a larger enabled party but occupy seats after normal responses.

Saved-answer writes preserve unchanged vote timestamps. Editing unrelated starts or retrying a Save must not reorder an existing Yes at the locked start. Missing votes are unanswered; the lock evaluator never infers No merely because a player voted at a different start. Explicit No is written by a complete Save or the group's direct Can't play submission, never by draft interaction.

### 5.5 Shared live status and party notifications

The group message shows the proposed start window, enabled party sizes, roster, current lock or waiting state, saved reply count, compressed per-player availability and unanswered players. Inside the Mini App, live availability counts appear on the selectable time buttons. While answering or editing, group details remain secondary below the personal form and can be expanded. Once an answer is saved, the group becomes the main view: show players' saved choices and per-start details openly, distinguishing available, Maybe, Only if needed, unavailable and unanswered players. A compact personal summary keeps editing accessible. Reopening with a saved answer returns to the group view, and live updates stay visible without closing the panel.

Open panels receive current snapshots over authenticated SSE. The server checks about once per second and sends changes plus periodic keepalives. Player saves, roster changes, lateness flags, session closure and evaluated lock changes appear without reopening. Reconnect catches up from a complete snapshot. The UI shows Live, reconnecting/offline or ended state and does not replace a dirty draft when shared results change.

“Strongest start” is a live suggestion ranked by total saved availability (Yes + Maybe + filler), then normal Yes count, then earliest time. The persisted lock is shown separately and follows §5.4, including enabled sizes and its strict-Yes priority.

Saves return persisted availability before Telegram edits finish. Lock evaluation coalesces bursts over about 1.5 seconds; poll edits are debounced about 1.1 seconds. The party and group message can therefore follow the saved answer shortly afterward.

When a party locks, the bot:

- Posts a separate **GAME ON** message tagging core players and listing alternates.
- Nudges newly seated Maybe players to open availability, change the locked start to Yes and Save.
- Tags unanswered players when their answer could upgrade to the next enabled size.
- Suggests a 3v3 custom when at least six roster members are available at the locked start, counting Yes, Maybe and fillers.
- Schedules the T-15 reminder tagging core players. If a new lock is already inside that window, it reminds immediately; less than ten minutes before start uses “Load up” wording.

GAME ON retains **I'll be 15 min late**. Only core players can toggle their own flag. It annotates GAME ON and reminders without moving the start or timer. Lateness clears when the party's time or core changes or the lock dissolves; alternates-only changes preserve it. At reminder time, if late players leave too few on-time players for any enabled party, a second message explains the delay.

Time, size or core-lineup changes edit GAME ON and post a visible change follow-up. Alternates-only changes edit it silently. If no enabled party remains, GAME ON becomes **Party dissolved**, its T-15 reminder is cancelled, and the active session continues accepting availability.

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
| `locks`, `lock_party`, `lock_late` | Current chosen party, alternates and lateness flags |
| `scheduled_jobs` | Archive and T-15 timer metadata |
| `audit_log`, `schema_migrations` | Command audit records and applied migration markers |

Availability snapshots/mutations and lock processing use a per-session mutex. Multi-row answer saves and migrations use SQLite transactions. Telegram message edits tolerate unchanged/deleted messages and retry rate limits once using the indicated delay. The deployment runs one bot process against its database.

Startup restores future scheduled jobs, fires jobs up to five minutes overdue, and drops older overdue jobs. Pending Telegram updates are not deliberately discarded. Take a consistent SQLite backup through its backup API or `.backup`; copying the live main database file alone can omit data in the WAL.

The bot stays silent when first added until a group member invokes a command. Session history and audit data are retained without automatic deletion; there is no forget command. Logs go to stdout, with no external analytics service.
