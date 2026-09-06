/** Optional explicit Telegram ID; Riot ID may contain spaces in either part. */
export function parseAccountLink(text: string, senderId: number): {
  userId: number; gameName: string; tagLine: string; platform: string;
} | null {
  const input = text.trim();
  const target = input.match(/^(\d+)\s+/);
  const account = target ? input.slice(target[0].length) : input;
  const match = account.match(/^([^#]+)#([^#]+)\s+([a-z0-9]+)$/i);
  if (!match) return null;
  const userId = target ? Number(target[1]) : senderId;
  const gameName = match[1]!.trim();
  const tagLine = match[2]!.trim();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !gameName || !tagLine || gameName.length > 100 || tagLine.length > 100) return null;
  return { userId, gameName, tagLine, platform: match[3]!.toLowerCase() };
}

export function parseAccountLinkBulk(text: string): NonNullable<ReturnType<typeof parseAccountLink>>[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 10) throw new Error("Provide 1–10 mappings, one per line: TelegramID Game Name#TAG euw1.");
  const ids = new Set<number>();
  return lines.map((line, i) => {
    const parsed = /^\d+\s+/.test(line) ? parseAccountLink(line, 0) : null;
    if (!parsed) throw new Error(`Line ${i + 1}: use TelegramID Game Name#TAG euw1.`);
    if (ids.has(parsed.userId)) throw new Error(`Line ${i + 1}: Telegram ID ${parsed.userId} appears twice.`);
    ids.add(parsed.userId);
    return parsed;
  });
}
