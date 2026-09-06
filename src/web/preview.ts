import { createMiniAppServer } from "./server.js";
import { ApiError } from "./contracts.js";

// Isolated UI preview: no bot process, database, real identity, or writable API.
const port = Number(process.env.PREVIEW_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PREVIEW_PORT");
const unavailable = async (): Promise<never> => { throw new ApiError(403, "DEMO_ONLY", "This preview uses simulated votes only."); };
const server = createMiniAppServer({
  botToken: "local-preview-does-not-have-a-bot-token",
  publicUrl: `http://127.0.0.1:${port}`,
  loadSession: unavailable,
  saveAvailability: unavailable,
});
server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}/?demo=1`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
