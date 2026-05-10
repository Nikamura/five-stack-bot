type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let current: Level = "info";
export function setLogLevel(l: Level) {
  current = l;
}

function emit(l: Level, msg: string, extra?: unknown) {
  if (order[l] < order[current]) return;
  const line = `[${new Date().toISOString()}] [${l}] ${msg}`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console[l === "error" ? "error" : "log"](line, extra);
  } else {
    // eslint-disable-next-line no-console
    console[l === "error" ? "error" : "log"](line);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
