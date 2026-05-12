import { config } from "./config.js";
import { setLogLevel, log } from "./log.js";
import { bot } from "./bot/instance.js";
// Side-effect imports register handlers.
import "./bot/commands.js";
import "./bot/callbacks.js";
import { rehydrateJobs } from "./scheduler/jobs.js";
import { refreshAllActiveSessions } from "./bot/session.js";

setLogLevel(config.logLevel);

bot.catch((err) => {
  log.error("bot error", err);
});

async function main() {
  // Re-arm scheduled jobs that survived a restart.
  await rehydrateJobs();

  // Re-edit active session messages so deploy-time render changes show up
  // without waiting for the next vote or a manual /lfp_bump.
  await refreshAllActiveSessions();

  // Set the bot command menu so Telegram users see it in the / picker.
  await bot.api.setMyCommands([
    { command: "lfp", description: "Open a session for tonight" },
    { command: "lfp_bump", description: "Re-post the poll at the bottom" },
    { command: "lfp_cancel", description: "Cancel the active session" },
    { command: "lfp_roster", description: "Show & manage the roster" },
    { command: "lfp_add", description: "Add a player to the roster" },
    { command: "lfp_remove", description: "Remove a player from the roster" },
    { command: "lfp_skip", description: "Mark a roster member as no-show for tonight" },
    { command: "lfp_tz", description: "Set the chat timezone" },
    { command: "lfp_stacks", description: "Toggle valid party sizes" },
    { command: "lfp_stats", description: "Show chat stats" },
    { command: "help", description: "Help" },
  ]);

  process.once("SIGINT", () => {
    log.info("SIGINT — stopping");
    bot.stop();
  });
  process.once("SIGTERM", () => {
    log.info("SIGTERM — stopping");
    bot.stop();
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
