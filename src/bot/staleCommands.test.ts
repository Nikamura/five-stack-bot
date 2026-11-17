import test from "node:test";
import assert from "node:assert/strict";
import { isStaleCommand, STALE_COMMAND_SECONDS } from "./staleCommands.js";

const cmd = (date: number, text = "/lfp") => ({ date, text, entities: [{ type: "bot_command", offset: 0 }] });

test("fresh commands are answered", () => {
  assert.equal(isStaleCommand(cmd(1000), 1000 + STALE_COMMAND_SECONDS), false);
});

test("a command delivered hours late is stale", () => {
  assert.equal(isStaleCommand(cmd(1000), 1000 + 10 * 3600), true);
});

test("old non-command messages are untouched", () => {
  assert.equal(isStaleCommand({ date: 1000, text: "hello /lfp", entities: [{ type: "bot_command", offset: 6 }] }, 99999), false);
  assert.equal(isStaleCommand({ date: 1000, text: "hi" }, 99999), false);
  assert.equal(isStaleCommand(undefined, 99999), false);
});
