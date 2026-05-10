# five-stack-bot

A Telegram bot that lives in a friend-group chat and coordinates "are we
playing tonight?" decisions for League of Legends. See [PRD.md](./PRD.md)
for the product spec.

## Quick start

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, get a token.
2. **Disable Privacy Mode** with BotFather → `/mybots` → your bot →
   *Bot Settings* → *Group Privacy* → *Turn off*. The bot needs to read
   normal group messages so `/lfp-add` can pick up `@mentions`.
3. Add the bot to your group chat. The bot does **not** need admin to function, but two admin rights make the UX much nicer:
   - **Pin messages** — the bot pins the active session poll to the top, unpins on cancel/archive.
   - **Delete messages** — the bot cleans up command messages (`/lfp_add @x`, `/lfp_tz Europe/Vilnius`, etc.) so the chat stays focused on the session poll.

   Both are silent no-ops if the bot doesn't have the right.
4. Configure and run:

```bash
cp .env.example .env       # fill in BOT_TOKEN
npm install
npm run dev                 # local
# or
docker compose up -d --build
```

5. In the chat: `/lfp-add @karolis @tomas …` to seed the roster.
6. `/lfp` to open the first session.

## Commands

| Command | What it does |
|---|---|
| `/lfp` | Open a session for tonight (wizard). On an active session, **re-posts** the poll at the bottom of the chat. |
| `/lfp 18-23` | Open immediately for 18:00–23:00 |
| `/lfp 18-23 [5,3,2] @a @b @c` | Open + override stacks + add tags to roster, all in one message |
| `/lfp_bump` | Re-post the active poll at the bottom of the chat (alias: `/lfp_show`) |
| `/lfp_cancel` | Cancel the active session |
| `/lfp_roster` | Show & manage roster |
| `/lfp_add [@user]` | Add a player (or reply to their message) |
| `/lfp_remove [@user]` | Remove a player |
| `/lfp_skip [@user]` | Mark as no-show for tonight only |
| `/lfp_tz [zone]` | Set chat timezone |
| `/lfp_stacks` | Toggle valid party sizes (default 5/3/2) |
| `/lfp_stats` | Show chat stats |
| `/help` | Help |

> Telegram doesn't accept `-` in command names, so the underscored
> form (`/lfp_cancel`) is canonical. The hyphenated forms in the PRD
> are aliases for the human-readable spec only.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `BOT_TOKEN` | (required) | From @BotFather |
| `DB_PATH` | `./data/five-stack.db` | SQLite file. Mount a volume in Docker. |
| `DEFAULT_TZ` | `Europe/Vilnius` | IANA zone for new chats |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## How it locks

After every vote change, the bot re-evaluates the lock:

1. **Try the largest enabled stack** (default 5). If any slot has ≥ N ✅ votes
   from roster members, lock the **earliest** such slot.
2. **Else, is N still mathematically possible** at any slot?
   (`yes + maybe + not-voted ≥ N`). If yes, **wait** — don't fall back smaller.
3. **Else**, try the next-largest enabled stack. Repeat.

The default `{5, 3, 2}` skips 4-stack because LoL flex queue doesn't allow it.
A different chat can enable 4 via `/lfp_stacks`.

A roster member who never responds blocks fall-back. Use
`/lfp_skip @user` to count them as ❌ for lock purposes only.

## Operations

* **Backups** — copy `data/five-stack.db` to safe storage on a cron.
  SQLite WAL mode is on, so a hot `cp` is mostly safe; for guaranteed
  consistency use `sqlite3 five-stack.db ".backup /backup/five-stack.db"`.
* **Restart** — scheduled jobs (auto-archive, T-15 reminders) live in the
  DB and are rehydrated on boot. T-15 reminders less than 5 minutes overdue
  fire immediately on boot; older ones are dropped.
* **Logs** — written to stdout. Scrape with your host's logging stack.

## Layout

```
src/
  bot/             grammY handlers + per-session orchestration
    instance.ts      bot singleton
    commands.ts      / command handlers
    callbacks.ts     inline-button handlers
    session.ts       open / vote / lock / archive (mutex-serialised)
    mutex.ts         per-session promise chains
    util.ts          ctx helpers
    wizardState.ts   in-memory short-lived flow state
  core/            pure logic, no Telegram dependencies
    lock.ts          tally + lock evaluation
    slots.ts         slot generation + range parsing
    time.ts          timezone helpers (luxon)
    render.ts        message text + inline keyboards
    mention.ts       @mention HTML helpers
  db/
    index.ts         SQLite singleton
    schema.ts        DDL (auto-applied on boot)
    queries.ts       typed query helpers
    types.ts         row types
  scheduler/
    jobs.ts          DB-persisted timers (archive, T-15)
  config.ts        env loading
  log.ts           logger
  index.ts         entry point
```

## Tests

```
npm test
```

Covers the lock-evaluation rules from PRD §5.4 and slot/range parsing.
