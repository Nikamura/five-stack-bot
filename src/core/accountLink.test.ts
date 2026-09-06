import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccountLink } from "./accountLink.js";
test("explicit target supports Telegram IDs larger than 32 bits", () => {
  assert.deepEqual(parseAccountLink("5340273861 Wazalsky#EUW euw1", 1388135549), {
    userId: 5340273861, gameName: "Wazalsky", tagLine: "EUW", platform: "euw1",
  });
});
test("self linking and spaces in Riot names and tags", () => {
  assert.deepEqual(parseAccountLink("dont argue#to me EUW1", 42), {
    userId: 42, gameName: "dont argue", tagLine: "to me", platform: "euw1",
  });
  assert.equal(parseAccountLink("42 dont argue#to me euw1", 1)?.userId, 42);
});
test("invalid IDs and malformed accounts rejected", () => {
  for (const input of ["0 A#B euw1", "99999999999999999999 A#B euw1", "42 A#B", "42 #B euw1", "42 A# #B euw1"]) {
    assert.equal(parseAccountLink(input, 1), null, input);
  }
});

test("bulk requires explicit unique IDs, tolerates blank lines and limits requests", async () => {
  const { parseAccountLinkBulk } = await import("./accountLink.js");
  assert.equal(parseAccountLinkBulk("\n 42 dont argue#to me EUW1\r\n\n43 A#B euw1\n").length, 2);
  for (const input of ["", "A#B euw1", "42 A#B euw1\n42 C#D euw1", "42 A#B euw1\nbad", Array.from({ length: 11 }, (_, i) => `${i + 1} A#B euw1`).join("\n")]) {
    assert.throws(() => parseAccountLinkBulk(input));
  }
});
