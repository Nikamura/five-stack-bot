import Database from "better-sqlite3";
import { config } from "../config.js";
import { SCHEMA } from "./schema.js";

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA);

export { db };

export function nowMs(): number {
  return Date.now();
}
