import { parseAccountLinkBulk } from "../core/accountLink.js";
import * as q from "../db/queries.js";
import { resolveAccount } from "./tracker.js";

export async function linkAccountsBulk(chatId: number, actorId: number, text: string, resolve = resolveAccount): Promise<string> {
  if (!q.getRosterMember(chatId, actorId)) throw new Error("Join this chat’s roster before managing account links.");
  const rows = parseAccountLinkBulk(text);
  const members = rows.map(row => {
    const member = q.getRosterMember(chatId, row.userId);
    if (!member) throw new Error(`Telegram ID ${row.userId} isn’t in this chat’s roster.`);
    return member;
  });
  // At most ten resolver calls, each with the existing two-second deadline.
  const links = await Promise.all(rows.map(async row => {
    try {
      return { userId: row.userId, link: await resolve(row.gameName, row.tagLine, row.platform) };
    } catch { throw new Error(`Couldn’t resolve ${row.gameName}#${row.tagLine} (${row.platform}). Check the account and try again.`); }
  }));
  const accounts = new Set(links.map(row => `${row.link.origin}\n${row.link.puuid}`));
  if (accounts.size !== links.length) throw new Error("The same Riot account was assigned to more than one person.");
  try { q.setRiotLinksBulk(chatId, actorId, links); }
  catch { throw new Error("Couldn’t save the batch. Check roster membership and whether an account is already linked to someone outside this batch."); }
  return `Linked ${links.length} account${links.length === 1 ? "" : "s"}:\n` + links.map((row, i) =>
    `${members[i]!.display_name} (${row.userId}) → ${row.link.gameName}#${row.link.tagLine} (${row.link.platform})`,
  ).join("\n");
}
