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

export const config = {
  botToken: required("BOT_TOKEN"),
  dbPath,
  defaultTz: process.env.DEFAULT_TZ ?? "Europe/Vilnius",
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
} as const;
