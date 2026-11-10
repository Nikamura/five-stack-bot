import { config } from "./config.js";
import { setLogLevel, log } from "./log.js";
import { bot } from "./bot/instance.js";
// Side-effect imports register handlers.
import "./bot/commands.js";
import "./bot/callbacks.js";
import { rehydrateJobs } from "./scheduler/jobs.js";
import { refreshAllActiveSessions } from "./bot/session.js";
import { getAvailabilitySnapshot, saveAvailability, remindNonVoters } from "./bot/availability.js";
import { createMiniAppServer } from "./web/server.js";
import { startMatchResults } from "./bot/matchResults.js";

setLogLevel(config.logLevel);

/**
 * `personal` commands only answer their sender, so in groups the command is
 * hidden too. /lfp qualifies because its wizard is private and the session it
 * opens is posted publicly. Commands that change the shared session or roster
 * stay visible; /lfp_add also depends on replying to another member's message.
 */
const BOT_COMMANDS: { command: string; description: string; personal?: true }[] = [
  { command: "lfp", description: "Open a session for tonight", personal: true },
  { command: "lfp_bump", description: "Re-post the poll at the bottom" },
  { command: "lfp_cancel", description: "Cancel the active session" },
  { command: "lfp_roster", description: "Show & manage the roster", personal: true },
  { command: "lfp_add", description: "Add a player to the roster" },
  { command: "lfp_remove", description: "Remove a player from the roster" },
  { command: "lfp_skip", description: "Mark a roster member as no-show for tonight" },
  { command: "lfp_tz", description: "Set the chat timezone", personal: true },
  { command: "lfp_stacks", description: "Toggle valid party sizes", personal: true },
  { command: "lfp_link", description: "Link a roster member: [Telegram ID] Name#TAG platform", personal: true },
  { command: "lfp_link_bulk", description: "Link multiple roster members, one mapping per line", personal: true },
  { command: "lfp_unlink", description: "Remove a Riot account link: [Telegram ID]", personal: true },
  { command: "lfp_stats", description: "Show chat stats", personal: true },
  { command: "help", description: "Help", personal: true },
];

bot.catch((err) => {
  log.error("bot error", err);
});

async function main() {
  // Initialize identity before rendering signed Mini App links into group polls.
  await bot.init();
  const server = createMiniAppServer({
    botToken: config.botToken,
    publicUrl: config.miniAppUrl || `http://127.0.0.1:${config.webPort}`,
    loadSession: getAvailabilitySnapshot,
    saveAvailability,
    remindNonVoters,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.webPort, config.webHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log.info(`Mini App listening on ${config.webHost}:${config.webPort}`);
  if (!config.miniAppUrl) log.warn("MINI_APP_URL is unset; configure it to enable group launch buttons.");
  // Re-arm scheduled jobs that survived a restart.
  await rehydrateJobs();

  // Re-edit active session messages so deploy-time render changes show up
  // without waiting for the next vote or a manual /lfp_bump.
  await refreshAllActiveSessions();

  // Set the bot command menu so Telegram users see it in the / picker.
  await bot.api.setMyCommands(BOT_COMMANDS.map(({ command, description }) => ({ command, description })));
  // In groups, personal and administrative commands are sent ephemerally:
  // only the sender and the bot see the command and its reply (Bot API 10.2).
  await bot.api.setMyCommands(
    BOT_COMMANDS.map(({ command, description, personal }) => ({
      command, description, ...(personal ? { is_ephemeral: true } : {}),
    })),
    { scope: { type: "all_group_chats" } },
  );

  const stopMatchResults = startMatchResults();

  process.once("SIGINT", () => {
    stopMatchResults();
    log.info("SIGINT — stopping");
    bot.stop();
    server.close();
  });
  process.once("SIGTERM", () => {
    stopMatchResults();
    log.info("SIGTERM — stopping");
    bot.stop();
    server.close();
  });

  log.info(`Starting bot, db=${config.dbPath}, defaultTz=${config.defaultTz}`);
  await bot.start({
    drop_pending_updates: false,
    onStart: (me) => log.info(`@${me.username} online`),
  });
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
