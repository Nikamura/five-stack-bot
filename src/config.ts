import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const dbPath = resolve(process.env.DB_PATH ?? "./data/five-stack.db");
mkdirSync(dirname(dbPath), { recursive: true });

const miniAppUrl = process.env.MINI_APP_URL?.trim() ?? "";
if (miniAppUrl) {
  const url = new URL(miniAppUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MINI_APP_URL must be an HTTPS origin, e.g. https://five-stack-bot.cn.lt");
  }
}
const webPort = Number(process.env.WEB_PORT ?? 3000);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error("Invalid WEB_PORT");
const miniAppShortName = process.env.MINI_APP_SHORT_NAME?.trim() || undefined;
if (miniAppShortName && !/^[A-Za-z0-9_]+$/.test(miniAppShortName)) throw new Error("Invalid MINI_APP_SHORT_NAME");

export const config = {
  botToken: required("BOT_TOKEN"),
  dbPath,
  defaultTz: process.env.DEFAULT_TZ ?? "Europe/Vilnius",
  miniAppUrl,
  miniAppShortName,
  webHost: process.env.WEB_HOST ?? "127.0.0.1",
  webPort,
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
} as const;
