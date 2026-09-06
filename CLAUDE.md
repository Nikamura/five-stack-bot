# CLAUDE.md

Guidance for agents working in this repository.

## Project instructions

Keep `PRD.md` up to date when product behavior changes. Replace prior decisions in place; it describes the current product, not a decision history. Deployment-specific steps belong in `deploy/HOMELAB.md`.

## Commands

Use Node.js 22 or newer.

```bash
npm ci
npm run dev         # real bot + HTTP server, watches src/, loads .env
npm run preview     # isolated Mini App demo; no bot token or database
npm run build       # tsc -> dist/
npm start           # real bot + HTTP server from dist/, loads .env
npm run typecheck   # tsc --noEmit
npm test            # Node test runner: src/**/*.test.ts and web/*.test.js
```

Preview: `http://127.0.0.1:3000/?demo=1`; override with `PREVIEW_PORT`. Real startup requires `BOT_TOKEN`; `DB_PATH` defaults to `./data/five-stack.db`. `MINI_APP_URL` is the configured HTTPS origin; without it, group launch buttons show a setup notice. `WEB_HOST`/`WEB_PORT` control the HTTP listener. Main Mini App uses an empty `MINI_APP_SHORT_NAME`.

Single tests: `node --test --import tsx src/core/lock.test.ts`, or add `--test-name-pattern '<regex>'` before the file. Frontend model/stream tests run directly with `node --test web/*.test.js`.

## Architecture

- `src/bot/` owns grammY handlers, roster management, per-session orchestration and the availability application service. `commands.ts` and `callbacks.ts` register handlers as import side effects. `session.ts` handles open/evaluate/lock/archive and Telegram message updates. `availability.ts` authorizes roster access and coordinates atomic saved answers.
- `src/core/` contains slot/time helpers and domain logic. `lock.ts` tallies explicit votes and selects parties; `availability.ts` validates complete submissions and computes per-user revisions. These domain modules perform no database or Telegram calls. `render.ts` is the Telegram rendering adapter, including inline keyboards.
- `src/db/queries.ts` owns runtime SQLite access. `schema.ts` is applied on boot; `migrate.ts` handles transactional, idempotent migrations.
- `src/web/contracts.ts` defines JSON DTOs and `ApiError`. `auth.ts` validates Telegram launch data and signs session links. `server.ts` uses Node HTTP with injected load/save services, serves `web/`, and streams snapshots. It does not import bot/config/database modules. `preview.ts` supplies rejecting services for an isolated static demo.
- `web/` is an unbundled Mini App: HTML/CSS, browser controller, pure draft model, SSE decoder and sample-data module. The production container must copy `web/` alongside `dist/`.
- `src/scheduler/jobs.ts` persists archive and T-15 timers. Startup rehydrates jobs and refreshes active session/GAME ON messages in place.

There is one bot process and one SQLite database. Keep transport authentication, availability business rules and database writes in their respective layers; shared contract imports are allowed.

## V2 availability invariants

- Opening a session adds the organizer to the roster but creates no votes.
- Group keyboards use signed `t.me/<bot>?startapp=<token>&mode=compact` URL buttons. Group `web_app` inline buttons are not supported. A named Mini App adds its short-name path; Main Mini App is the default.
- A second group button, Can't play tonight, immediately submits a complete No answer without opening the Mini App. Check Telegram callback identity, session roster membership and closure; write all future No votes and clear filler/skip atomically. This button press is the submission, with no extra popup or Save step.
- For unanswered players, the personal answer is the first screen: Choose times (default) or Can't play, then a time grid and explicit Save. Keep Maybe/Only if needed under More options and group details secondary while editing. After Save, and when reopening with an existing answer or skip, show the live group results openly as the main view, with a compact personal summary and Edit availability. Editing loads the saved answer preselected and preserves its values.
- A new empty selection uses two grid taps: first endpoint, then second endpoint, selecting the inclusive block and switching to individual add/remove taps. The same endpoint twice selects one start; reversed endpoints select the same interval. A pending first endpoint disables Save. Editing an existing selection starts in individual-edit mode. Add a range adds another two-tap block, preserving values already selected; Cancel range abandons the pending block. All times cancels pending selection and selects remaining starts; Clear cancels pending selection, empties the draft and resets range mode.
- Session bounds are start-inclusive/end-exclusive on the half-hour grid; the two selected range endpoints are inclusive candidate **starts**, not a play-until interval. Keep range selection in the same grid, without dropdown range forms.
- Preserve existing per-slot Yes/Maybe values, including mixed saved answers, when loading or editing selections. Optional response changes must be deliberate.
- Mini App draft changes stay local until explicit Save, including its Can't play choice. A Save writes all future slots atomically: selected Yes/Maybe, explicit No elsewhere, filler state and skip removal. Past votes remain unchanged. The direct group Can't play action is a separate complete submission.
- Require explicit Can't play for an empty submission. Validate exact input keys, future slots, duplicate slots, values and revision server-side.
- A revision describes only the user's saved answer, filler and skip state. Other players' updates must not invalidate a draft. A conflicting own-answer update requires explicit UI resolution; same-answer retries are idempotent and preserve unchanged vote timestamps/seat priority.
- Authenticated roster membership is required for reads, SSE and saves. Verified username matching may bind a synthetic negative roster ID, never replace a different positive identity.
- Old slot/all-Yes/filler callbacks (`v`, `v2`, `vbay`, `vfill`) only replace their keyboard with the new controls; they must not call partial-vote mutations. The legacy `vbn` Can't play callback performs the same complete decline as the new group button.
- The one-time `2026-09-explicit-availability` migration adds explicit No rows for previously implicit declines. Preserve existing choices; do not reintroduce implicit declines into tallying.

## Per-session mutex and notifications

Every availability read/modify/write, lock evaluation, archive and related session mutation uses ``withMutex(`session:${id}`, ...)``. Do not read outside the mutex and later write that stale state back. The public snapshot getter also owns the mutex; code already inside it must use internal helpers rather than reacquire it.

Save commits the complete database answer, queues evaluation once, and returns the current persisted snapshot. Telegram calls stay off the HTTP save path. Evaluation is debounced about 1.5 seconds, and poll edits about 1.1 seconds. Live clients may see the saved answer before the queued lock update arrives.

`safeEditMessage` tolerates unchanged/missing messages and retries Telegram 429 once using `retry_after`. `/lfp_bump` updates `poll_message_id`; session links and legacy callbacks route by session ID, not message ID.

## Lock evaluation

`evaluateLock` chooses the earliest playable start and the largest enabled party at that start (default sizes 5/3/2). It never delays an early playable party for a later larger or more certain one. Seats rank Yes, Maybe, filler, then vote time within each category.

`buildPartyPlan` evaluates each saved start independently and groups consecutive starts with the same playing lineup and conditional participants. A gap or a lineup/size/condition change creates a separate party, including two separate 3-stacks. Persist `session_party_plans` in the availability transaction before notification debounce; maintain a separate last-notified plan and rebind participant IDs in both JSON fields. Preserve already-started slots as history and recompute future slots. Never carry someone forward without a saved answer at that later start. The earliest party is retained in `locks` for existing session statistics and first-party lateness controls; Telegram and the Mini App also display the full plan.

Each window gets one T-15 reminder. `party_reminder_attempts` claims a session/start before sending, and `syncPartyTimers` retains unchanged jobs and removes obsolete ones. Recheck current plans under the session mutex when a timer fires. Future-plan edits never shift an already-started party or re-ping it. Maybes and fillers retain their conditional labels in each window.

## HTTP and browser safety

Only verified raw Telegram `initData` authorizes a request. Validate HMAC, unique fields, bounded age and safe user ID; require the signed `start_param` session capability. Never trust `initDataUnsafe`, a request-body user ID or query-string session ID. Credentials belong in `Authorization: tma <initData>`, never URLs or logs.

SSE polls authorized snapshots about once per second, ignores server-clock-only differences, and sends 15-second keepalives. Stop on session closure, authentication expiry or roster revocation. Preserve backpressure bounds, reconnect catch-up, connection limits and stream cleanup on `server.close()`.

POST requires the configured same origin and bounded JSON. Static files use an exact allowlist; add any new frontend module there. Retain Telegram-compatible CSP (including the Telegram SDK and web-client frame ancestors). Demo mode stays isolated and cannot bypass API authentication.

## Schema and code conventions

- Use transactions for migrations and multi-row saves. Make migrations safe to rerun and test interrupted/legacy states where relevant.
- ESM/NodeNext throughout: relative TypeScript imports include `.js`.
- TypeScript is strict with `noUncheckedIndexedAccess` and unused checks; narrow optional lookups.
- Tests are colocated and use `node:test`/`node:assert`. Exercise real failure boundaries: partial saves, revisions/retries, access control, migration preservation and open-stream updates.
- Telegram command names use underscores, such as `/lfp_cancel`.

## Voting reminders

Voting CTAs are manual-only. `bot/voteReminders.ts` owns replacement and cleanup; `vote_reminders` retains the message ID and shared 15-minute cooldown across restarts. Its `*Locked` helpers require the session mutex. Legacy automatic voting-reminder jobs are discarded on boot.
