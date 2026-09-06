# Mini App deployment on the homelab

V2 was deployed on **2026-09-06 at 10:57:48 UTC**. The HTTPS application and
`@five_stack_bot` polling are running. At the deployment check, Telegram
`getMe` still reported `has_main_web_app: false`; Karolis is completing
BotFather setup. Native Mini App launch and real availability submissions
have not yet been verified.

## Deployed release

| Item | Verified value |
|---|---|
| Application commit | `1232967` |
| Production source branch | `codex/mini-app-v2`, pushed to origin and tracked by the production checkout |
| Release image | `five-stack-bot:v2-1232967`, also tagged `five-stack-bot:latest` |
| Image ID | `sha256:f67f5aaa6f4c5d5adb448931dd2ebf9e0b207202d62a027051237be7f036f5d5` |
| Rollback image | `five-stack-bot:pre-v2-20260906t105549z` |
| Backup directory | `/opt/stacks/bots/backups/five-stack-v2-20260906T105549Z` |

The permanent Compose file now includes `MINI_APP_URL=https://five-stack-bot.cn.lt`,
empty `MINI_APP_SHORT_NAME`, `WEB_HOST=0.0.0.0`, and `WEB_PORT=3000`. The bot joins
`bots_default` and external `caddy_default`, with no published host port. The
source, Compose and data locations below were retained. The existing Git-pull
updater follows the checkout's tracked `codex/mini-app-v2` branch; account for
that branch explicitly before changing the deployment source.

The standalone [Caddy site](Caddyfile.miniapp) was appended to the existing
Caddyfile, validated with the complete configuration, and reloaded. The
bind-mounted file was written in place so the running Caddy container retained
its mount. Only the bot was recreated; all 40 unrelated containers, including
Caddy, stayed unchanged. Existing routes and authorization policies were kept.

## Verification and remaining activation

- The bot was running with zero restarts and Telegram polling online.
- Verified HTTPS `/healthz` returned HTTP 200 with `{"ok":true}`. Unauthenticated
  session reads, live-stream requests and availability submissions returned
  HTTP 401 with `Cache-Control: no-store`. TLS verification remained enabled.
- Public HTML, `app.js`, `model.js` and `styles.css` matched the release bytes.
- SQLite `quick_check` passed. Every original vote row retained its values and
  timestamps; the one-time migration added explicit No rows for former implied
  declines. No private roster or session data is recorded here.
- Before deployment, all 161 tests, typecheck, build and structured review passed.

Complete BotFather Main Mini App setup and perform the Telegram checks under
**Activate and verify** below. These public endpoint checks do not establish that
a native Telegram launch, authenticated live stream or real vote has succeeded.

The backup directory is mode 0700. Its `database.before.db` is a consistent
SQLite backup with mode 0600; another copy remains in the data volume at
`/app/data/pre-v2-20260906T105549Z.db`. The directory also contains configuration
backups, a source Git bundle, a release manifest and build/validation logs.
Keep backup contents on the host; configuration backups can contain credentials.

## Production installation

| Component | Location |
|---|---|
| Docker host | `192.168.2.200` (`docker-ubuntu`) |
| Compose project / service | `bots` / `five-stack-bot` |
| Compose file | `/opt/stacks/bots/compose.yaml` |
| Source/build context | `/opt/stacks/bots/five-stack-bot` |
| Persistent data | `/opt/stacks/bots/five-stack-bot-data` mounted at `/app/data` |
| Caddy configuration | `/opt/stacks/caddy/Caddyfile` |
| Existing Caddy network | `caddy_default` |
| Public origin | `https://five-stack-bot.cn.lt` |

Use the existing bot token and data volume. Run exactly one polling bot process.
The Mini App HTTP server runs in that same process on port 3000.

## Prepare a future cutover

1. Put the reviewed v2 source in the existing build context. Build the new
   image without restarting the service. Record the old image ID and tag it
   `five-stack-bot:pre-v2` for rollback before rebuilding `latest`.
2. Back up the existing Compose and Caddy files. Take a consistent SQLite
   backup immediately before the cutover. For example, from `/opt/stacks/bots`:

   ```sh
   docker compose exec -T five-stack-bot node --input-type=module <<'JS'
   import Database from 'better-sqlite3';
   const db = new Database(process.env.DB_PATH || '/app/data/five-stack.db');
   const target = '/app/data/pre-v2-' + new Date().toISOString().replaceAll(':', '-') + '.db';
   await db.backup(target);
   db.close();
   console.log('Backup created:', target);
   JS
   ```

   Keep a separate copy of that backup. Do not copy the live main SQLite file
   alone: committed data can still be in the WAL.
3. Merge [compose.miniapp.yaml](compose.miniapp.yaml) into the existing service
   and top-level networks. Preserve its token, data mount, restart policy and
   other services. This connects only the bot to Caddy's existing network;
   no host port is required. Run `docker compose config --quiet` to validate
   without printing resolved environment secrets. If using an overlay instead,
   include both `-f` files for every future build/up/stop operation.
4. Add [Caddyfile.miniapp](Caddyfile.miniapp) as a site block to the existing
   Caddyfile. Ensure this hostname resolves to the existing Caddy ingress with
   a valid certificate. Validate before reloading:

   ```sh
   docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   Keep existing access policies on other sites. This new site serves public
   assets and authenticates session reads/writes itself using Telegram; an
   interactive OAuth gate in front of it prevents Mini App API requests.
   Caddy forwards SSE without buffering. See its
   [reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
   and Docker's [Compose merge rules](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/).
5. In BotFather, select `@five_stack_bot` → Bot Settings → Configure Mini App
   (Main Mini App) and set its URL to **`https://five-stack-bot.cn.lt/`**.
   Leave `MINI_APP_SHORT_NAME` empty for this Main Mini App. A separately named
   Mini App is optional and must have the matching short name configured.

   Group buttons use Telegram's
   [direct Mini App links](https://core.telegram.org/bots/webapps#direct-link-mini-apps),
   carrying a signed `startapp` session reference. Opening the bot's generic
   profile app button has no session: open from a group's availability message.

## Activate and verify

For a future release, after building its image and checking configuration,
recreate only the bot service from `/opt/stacks/bots` and verify HTTPS:

```sh
docker compose up -d --no-deps five-stack-bot
curl --fail https://five-stack-bot.cn.lt/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://five-stack-bot.cn.lt/api/session
```

Expect `{"ok":true}` and HTTP **401** for the unauthenticated session request.
The first v2 boot already applied the transactional migration. Subsequent boots
retain it and refresh any active posted messages with the current controls.
Existing choices, including previous opener votes and inferred declines, retain
their meaning. Expired sessions close.

In Telegram, verify with a test group or an explicitly approved real session:

- Open the posted availability button as a roster member. Outside roster
  access must fail. Names added by handle bind to the authenticated account.
- Select multiple starts, observe the answer preview, then Save once. The
  selected starts become yes/maybe and other future starts become no together.
- Tap **Can't play tonight** directly on the group message. It saves a complete
  decline without opening the Mini App and updates any open pickers.
- Leave two responders' pickers open. Saving one updates the other's group
  view without resetting their draft. A second device editing the same person
  produces a conflict choice instead of silently replacing changes.
- Reopen/Edit loads the saved answer. Cancel preserves it. Session closure
  disables Save. The bot continues party updates and T-15 reminders.

`/healthz` checks the HTTP process, not Telegram polling or database health;
the Telegram checks above are part of activation. Never include real initData
or tokens in logs, screenshots, URLs, review notes or shell history.

## Rollback

For this cutover, restore `five-stack-bot:pre-v2-20260906t105549z` in the service
and use the configuration backups in the recorded backup directory, then
recreate only this bot. Restore the production source checkout to its previous
`main` branch at `bd4fabbd3bf5f0bdac735827e83abd1eb4a27b6b` before the next
Git-pull/build updater run, so maintenance cannot rebuild v2 after rollback.
Restore the Caddyfile in place and validate/reload it, retaining its mounted
inode. The v2 migration only adds a
migration marker and materializes old implicit declines into existing vote
rows, so the v1 code can read the migrated database. Prefer keeping current
data to avoid losing answers saved after the cutover. If restoring the backup
is necessary, stop the bot first and move the database, WAL and SHM files aside
together before installing the backup; this discards answers after the backup.

Disable or reset the Main Mini App in BotFather if rolling back. Confirm the
old bot refreshed its session buttons and resumes polling. Do not run both
image versions against the same token or database.
