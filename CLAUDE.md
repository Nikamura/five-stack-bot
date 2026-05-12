# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project instructions

Keep `PRD.md` up to date when product behaviour or features change. Replace prior decisions in place — the file holds the current spec only, not the decision history.

## Commands

```bash
npm run dev         # tsx --watch, loads .env if present
npm run build       # tsc → dist/
npm start           # node dist/index.js (post-build)
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx 'src/**/*.test.ts'
```

Run a single test file: `node --test --import tsx src/core/lock.test.ts`.
Filter by name: `node --test --test-name-pattern '<regex>' --import tsx src/core/lock.test.ts`.

`BOT_TOKEN` is required (see `.env.example`). `tsx` watches and reloads `src/`; the SQLite file is created on first boot under `DB_PATH` (default `./data/five-stack.db`).

## Architecture

Three layers, strict direction `bot/ → core/ → db/`. `core/` has no Telegram or DB imports — it operates on plain values so it can be unit-tested without a live bot or DB.

- `src/bot/` — grammY handlers and per-session orchestration. `instance.ts` is the singleton bot. `commands.ts` and `callbacks.ts` register handlers as import side effects (see `index.ts`). `session.ts` owns the open / vote / lock / archive flow.
- `src/core/` — pure logic. `lock.ts` implements the largest-stack-first lock rule from PRD §5.4 (`evaluateLock`, `tallySlots`, `diffLock`). `slots.ts` parses range shortcuts and builds the 30-minute slot grid. `render.ts` builds message bodies and inline keyboards. `time.ts` (luxon) handles per-chat timezones.
- `src/db/` — `better-sqlite3` singleton. `schema.ts` holds the DDL as a string and is applied unconditionally on boot (every statement is `CREATE TABLE IF NOT EXISTS`). `migrate.ts` handles in-place column migrations that `CREATE IF NOT EXISTS` can't express; it's idempotent and resumes after a mid-migration crash. `queries.ts` is the only module that talks to `db`.
- `src/scheduler/jobs.ts` — DB-persisted timers (`scheduled_jobs` table) for session auto-archive and the T-15 reminder. `rehydrateJobs()` runs on boot from `src/index.ts`; jobs less than 5 minutes overdue fire immediately, older ones are dropped.

### Per-session mutex

Every mutation that reads-then-writes a session (vote, lock evaluation, archive, bump) is wrapped in `withMutex(\`session:${id}\`, ...)` from `src/bot/mutex.ts`. This is single-process serialization — there's exactly one bot process, one SQLite file. Don't read session state outside the mutex and then write back; you'll race the debounced edit flush and other vote handlers.

### Debounced poll edits

`session.ts` coalesces poll re-renders into one edit per ~1.1s per session (`schedulePollEdit` / `flushPollEdit`). Telegram enforces 1 edit/sec on messages with inline keyboards; vote bursts would otherwise hit `429`. `safeEditMessage` swallows `"message is not modified"` and `"message to edit not found"`, and does one retry on `429` honoring `retry_after`.

### Message identity vs. session identity

Callback handlers route by `sessionId` embedded in `callback_data`, not by `message_id`. `/lfp_bump` (and re-running `/lfp` on an active session) sends a fresh poll message and updates `sessions.poll_message_id`; the old message gets a tombstone edit but its buttons keep working.

### Lock evaluation

`evaluateLock` walks `validStacks` largest-first. For each size: if a slot has `yes >= stack`, lock the earliest such slot. Else if any slot is "still in play" for that stack (`yes + maybe + notVoted >= stack`), return `null` — wait, don't fall back. Else continue to the next-smallest stack. Default `validStacks` is `{5, 3, 2}` (4 skipped — LoL flex queue doesn't allow it). Session-only skips (`/lfp_skip @user`) count as ❌ for lock purposes; permanent removal uses `/lfp_remove`.

### Schema notes

The `migrate.ts` flow is the template for new migrations: detect old/new column presence, run inside `db.transaction(() => ...)`, assert the post-state, then drop the old columns. better-sqlite3 rolls back the transaction on throw, so a failed migration preserves the original schema for a retry.

## Conventions

- ESM throughout (`"type": "module"` in `package.json`, `module: "NodeNext"`). Relative imports include the `.js` extension even in `.ts` source — required by NodeNext.
- TypeScript is `strict` with `noUncheckedIndexedAccess` and `noUnusedLocals/Parameters`. Array/Map accesses return `T | undefined` — narrow before use.
- Tests are colocated `*.test.ts` next to the source they cover, using `node:test` and `node:assert`.
- Telegram command names can't contain `-`, so `/lfp_cancel` is the on-the-wire form; the hyphenated names in `PRD.md` are spec-only aliases.
