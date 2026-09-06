# Mini App activation on the homelab

These files are a prepared rollout, not a record of a completed deployment.
Read-only inspection on 2026-09-06 confirmed the running bot is
`@five_stack_bot`, and its Main Mini App is not configured yet.

## Existing installation

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

## Prepare the cutover

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

After the hostname, Caddy route and BotFather setting are ready, recreate only
the bot service with the built v2 image:

```sh
docker compose up -d --no-deps five-stack-bot
curl --fail https://five-stack-bot.cn.lt/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://five-stack-bot.cn.lt/api/session
```

Expect `{"ok":true}` and HTTP **401** for the unauthenticated session request.
The first v2 boot applies the transactional migration and refreshes still-active
posted messages with the picker button. Existing choices, including previous
opener votes and inferred declines, retain their meaning. Expired sessions close.

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

Restore the old image tag in the service and the backed-up Compose/Caddy
configuration, then recreate only this bot. The v2 migration only adds a
migration marker and materializes old implicit declines into existing vote
rows, so the v1 code can read the migrated database. Prefer keeping current
data to avoid losing answers saved after the cutover. If restoring the backup
is necessary, stop the bot first and move the database, WAL and SHM files aside
together before installing the backup; this discards answers after the backup.

Disable or reset the Main Mini App in BotFather if rolling back. Confirm the
old bot refreshed its session buttons and resumes polling. Do not run both
image versions against the same token or database.
