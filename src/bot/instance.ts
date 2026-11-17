import { Bot } from "grammy";
import { config } from "../config.js";
import { dropStaleCommands } from "./staleCommands.js";

export const bot = new Bot(config.botToken);
export type AppBot = typeof bot;

// Registered before any handler module imports `bot`.
bot.use(dropStaleCommands);
