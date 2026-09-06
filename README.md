# five-stack-bot v2

A Telegram bot for a friend group's “are we playing tonight?” decisions. The group message shows the party and saved replies; a personal Telegram Mini App lets each player choose start times and watch everyone else's availability live. See [PRD.md](./PRD.md) for the current product rules.

## How people use it

1. The organizer runs `/lfp` for the start/end-hour wizard, or `/lfp 12-22` to open immediately. The bot posts and optionally pins one group message, tags the roster, and adds **Set my availability** and **Can't play tonight**. Opening a session adds the organizer to the roster but does not submit their availability.
2. Responders can tap **Can't play tonight** directly in the group to decline every remaining start immediately, without opening the Mini App. Otherwise, **Set my availability** opens **When can you play?** for a new answer, with **Choose times** selected. Players who already answered see the live group results and can edit their availability.
3. For a new selection, tap the first start and then the last start: every time between them is included. Then tap individual times to add or remove them. **Add a range** adds another block; **All times** selects everything remaining and **Clear** starts again. **Edit availability** loads an existing answer preselected for individual edits. **Maybe** and **Only if needed** stay under **More options**.
4. The preview states exactly which starts are selected and that other remaining starts will be declined. **Save** submits the whole answer atomically. Editing or cancelling a draft never changes the saved answer.
5. After saving, everyone's availability becomes the main view: see saved times by player and who can play at each start without expanding a disclosure. Your answer stays in a compact summary with **Edit availability**. Reopening after answering returns to this live group view. While editing, group details remain secondary and other people's saves never reset your unfinished draft.

Session bounds are start-inclusive and end-exclusive: `/lfp 12-22` offers 12:00 through 21:30. Within the grid, tapping **13:00 then 17:30** selects ten possible starts in two taps, including both endpoints. Tap the same time twice to select just that start. The first tap is only a pending endpoint; Save stays disabled until the range is complete. These are possible game starts, not a promise to finish playing at the second time.

## Quick start

Use **Node.js 22 or newer**.

1. Create a bot with [@BotFather](https://t.me/BotFather), or use the existing bot's token.
2. Disable Group Privacy if the bot must discover usernames from normal group messages. Add it to the group. Optional **Pin messages** and **Delete messages** admin rights enable pinning and command cleanup; other features do not require admin rights.
3. Configure and install:

```bash
cp .env.example .env
# Set BOT_TOKEN and the public HTTPS MINI_APP_URL in .env.
npm ci
npm run dev
```

4. Serve the HTTP listener behind HTTPS. In BotFather, select the bot and configure its **Main Mini App** URL as `https://five-stack-bot.cn.lt`. Leave `MINI_APP_SHORT_NAME` empty for this setup.
5. Seed the roster with `/lfp_add @karolis @tomas`, by replying to a player's message with `/lfp_add`, or inline with `/lfp 18-23 @karolis @tomas`.
6. Open a session and submit availability from its group button.

The **Set my availability** button uses a signed Telegram direct link such as `https://t.me/five_stack_bot?startapp=<signed-session-token>&mode=compact`. Telegram opens the configured HTTPS Main Mini App in a compact panel and signs the session parameter into its launch data. It is a normal URL button, which works in groups; the private-chat-only `web_app` inline button is not used. [Telegram Mini App launch documentation](https://core.telegram.org/bots/webapps#launching-the-main-mini-app)

V2 was deployed to the homelab on **2026-09-06** at [five-stack-bot.cn.lt](https://five-stack-bot.cn.lt), with HTTPS and bot polling verified. At the deployment check, Telegram still reported `@five_stack_bot`'s Main Mini App disabled; BotFather activation and a real in-Telegram availability test remain pending. See [deploy/HOMELAB.md](./deploy/HOMELAB.md) for the deployed release, verification, backups and update/rollback runbook.

## Local preview and checks

The preview runs without a bot token, database or Telegram connection:

```bash
npm ci
npm run preview
```

Open [the simulated picker](http://127.0.0.1:3000/?demo=1). Its sample votes and live-update controls are local demo data. Set `PREVIEW_PORT` to use another port. Loading the real application outside Telegram cannot authenticate or change votes.

```bash
npm run typecheck
npm test
npm run build
npm start
```

`npm start` starts the real bot and HTTP server and requires `.env` configuration. Tests cover slot parsing, lock rules, atomic availability and conflicts, migration, Telegram authentication, real local HTTP/SSE, and frontend draft/stream behavior.

## Commands

| Command | What it does |
|---|---|
| `/lfp` | Open tonight's session through a wizard; re-post the poll if a session is active |
| `/lfp 18-23` | Open immediately for starts from 18:00 through 22:30 |
| `/lfp 18-23 [5,3,2] @a @b @c` | Open, persist stack choices and add tagged players |
| `/lfp_bump` | Re-post the active poll at the bottom; alias `/lfp_show` |
| `/lfp_cancel` | Cancel the active session after confirmation |
| `/lfp_roster` | Show and manage the roster |
| `/lfp_add [@user]` | Add players by mention or reply |
| `/lfp_remove [@user]` | Remove a player |
| `/lfp_skip [@user]` | Mark a roster member unavailable for this session |
| `/lfp_tz [zone]` | Set the chat's timezone |
| `/lfp_stacks` | Toggle valid party sizes; default 5/3/2 |
| `/lfp_stats` | Show chat statistics |
| `/help` | Help; alias `/lfp_help` |

Telegram command names use underscores. Session and roster management remains trust-based: any group member can use these commands. Availability reads and saves require verified Telegram identity and membership in that session's roster.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `BOT_TOKEN` | Required | Telegram bot token |
| `DB_PATH` | `./data/five-stack.db` | Persistent SQLite database |
| `DEFAULT_TZ` | `Europe/Vilnius` | IANA timezone for new chats |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `MINI_APP_URL` | Unset | Public HTTPS origin; `.env.example` uses `https://five-stack-bot.cn.lt` |
| `MINI_APP_SHORT_NAME` | Empty | Leave empty for Main Mini App; set only for a named Mini App |
| `WEB_HOST` | `127.0.0.1` | HTTP bind address; Docker uses `0.0.0.0` |
| `WEB_PORT` | `3000` | HTTP port behind the proxy |
| `PREVIEW_PORT` | `3000` | Isolated demo server port only |

When `MINI_APP_URL` is unset, **Set my availability** displays a setup notice. Setting it enables signed launch buttons, but BotFather registration and reachable HTTPS are also necessary. The group's direct **Can't play tonight** action works without Mini App setup.

## Party selection

After each saved answer, the bot evaluates enabled party sizes largest-first. For each size it first chooses the earliest future start with enough **Yes** responses. If none exists, it chooses the earliest start where **Yes + Maybe + Only if needed** completes that size. It then tries the next smaller enabled size.

It locks the largest party achievable now without waiting for unanswered players. A later answer can upgrade, move or dissolve the party. Seats go to **Yes**, then **Maybe**, then **Only if needed**, using vote time within each group. A larger party using maybes/fillers takes priority over a smaller confirmed party; at the same size, an all-Yes start takes priority over an earlier soft start.

Default sizes are 5/3/2. GAME ON announcements, alternates, maybe-confirmation nudges, T-15 reminders, 15-minute lateness flags and the six-player 3v3 suggestion remain available.

## Operations and upgrades

- Run one bot process against one persistent SQLite database. Use SQLite's backup API or `sqlite3 five-stack.db ".backup /backup/five-stack.db"` for a consistent live backup.
- Startup applies migrations and refreshes active group messages in place. The v2 migration fills previously implicit declines with explicit No rows while preserving existing votes. It runs once transactionally.
- Old slot, all-Yes and filler buttons upgrade to the new keyboard without casting a partial vote. The old Can't play button remains a complete decline action. Session links survive poll bumps because they identify the session, not the message.
- Scheduled archive and T-15 jobs survive restarts. Recently overdue jobs fire on startup; older overdue reminders are dropped. Sessions close at the last candidate start or the next local 03:00 cutoff, whichever is earlier.
- Live updates use authenticated SSE with reconnect/catch-up. The server checks roster access repeatedly, limits connections and saves, and closes streams when the session ends or authentication expires. Launch credentials never go into API URLs.
- `/healthz` reports HTTP liveness. Logs go to stdout. Homelab proxy/network setup and launch verification are in [deploy/HOMELAB.md](./deploy/HOMELAB.md).

## Layout

```text
src/bot/       Telegram commands, session orchestration, availability service and mutex
src/core/      Slot/time helpers, availability validation/revisions, lock rules and rendering
src/db/        SQLite schema, migrations and queries
src/web/       Shared API contracts, Telegram authentication, HTTP/SSE server and demo server
src/scheduler/ Persisted archive and reminder jobs
web/           Mini App HTML/CSS/JS, draft model, SSE decoder and isolated demo
```

## Voting reminders

The **🔔 Remind non-voters** button in the poll and Mini App group summary posts a fresh reminder tagging only
players who haven't responded. It includes **🗳 Choose times** and
**🚫 Can't play tonight**, which declines all remaining starts in one tap.

Voting reminders are sent only when someone presses the button, with a shared
15-minute cooldown between reminders. There are no automatic voting reminders.
Each fresh reminder removes the previous CTA. It disappears when everyone
has responded, the largest enabled party fills, or the session ends.
The message ID and cooldown survive restarts.
