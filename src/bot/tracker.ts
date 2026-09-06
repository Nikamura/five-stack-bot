import { HOUR, type SharedGame } from "../core/encouragement.js";
export const TRACKER_ORIGIN = "https://lol-tracker.cn.lt";
export interface AccountLink { origin: string; puuid: string; gameName: string; tagLine: string; platform: string }
export interface Player extends AccountLink { lastPolledAt: number | null }
interface Profile { player: Player; headline: { games: number }; recentMatches: { matchId: string }[] }
interface Detail { matchId: string; gameStart: number; gameDuration: number; queueId: number; participants: { puuid: string; teamId: number; win: boolean }[] }
export async function trackerGet(path: string, signal: AbortSignal, fetcher = fetch): Promise<unknown> {
  const response = await fetcher(`${TRACKER_ORIGIN}/api/v1${path}`, { signal });
  if (!response.ok) throw new Error(`Tracker HTTP ${response.status}`);
  return (await response.json() as { data: unknown }).data;
}
export async function resolveAccount(gameName: string, tagLine: string, platform: string): Promise<AccountLink> {
  const query = new URLSearchParams({ gameName, tagLine, platform });
  const p = await trackerGet(`/players/resolve?${query}`, AbortSignal.timeout(2000)) as Player;
  if (!p || typeof p.puuid !== "string" || !p.puuid || typeof p.gameName !== "string" || typeof p.tagLine !== "string" || p.platform !== platform) throw new Error("Invalid account");
  return { origin: TRACKER_ORIGIN, puuid: p.puuid, gameName: p.gameName, tagLine: p.tagLine, platform: p.platform };
}
/** Entire operation has one deadline; no retries or automatic identity reassignment. */
export async function sharedGames(links: AccountLink[], now: number, fetcher = fetch): Promise<SharedGame[]> {
  const ids = [...new Set(links.filter(l => l.origin === TRACKER_ORIGIN).map(l => l.puuid))];
  if (ids.length < 2 || ids.length > 10) return [];
  const signal = AbortSignal.timeout(2500);
  try {
    const profiles = await Promise.all(ids.map(async id => {
      const p = await trackerGet(`/players/${encodeURIComponent(id)}?since=7d&queue=flex&recentLimit=50`, signal, fetcher) as Profile;
      if (p.player.puuid !== id || !p.player.lastPolledAt || p.player.lastPolledAt > now || now - p.player.lastPolledAt > 6 * HOUR || p.headline.games !== p.recentMatches.length) throw new Error("Stale or capped history");
      return p;
    }));
    const counts = new Map<string, number>();
    for (const p of profiles) for (const id of new Set(p.recentMatches.map(m => m.matchId))) counts.set(id, (counts.get(id) ?? 0) + 1);
    const matches = [...counts].filter(([, n]) => n >= 2).map(([id]) => id);
    if (matches.length > 30) return [];
    const result: SharedGame[] = [];
    // Batches cap detail concurrency at five.
    for (let i = 0; i < matches.length; i += 5) {
      const batch = await Promise.all(matches.slice(i, i + 5).map(async id => {
        const m = await trackerGet(`/matches/${encodeURIComponent(id)}`, signal, fetcher) as Detail;
        if (m.matchId !== id || m.queueId !== 440 || !Number.isFinite(m.gameDuration) || m.gameDuration < 300 || !Number.isFinite(m.gameStart) || m.gameStart > now || m.gameStart < now - 7 * 24 * HOUR) throw new Error("Invalid match");
        const friends = m.participants.filter(p => ids.includes(p.puuid));
        if (new Set(friends.map(p => p.puuid)).size !== friends.length) throw new Error("Duplicate participant");
        // Opposing linked friends make group-level results ambiguous: omit that match.
        if (friends.length < 2 || new Set(friends.map(p => p.teamId)).size !== 1) return null;
        if (![100, 200].includes(friends[0]!.teamId) || friends.some(p => typeof p.win !== "boolean" || p.win !== friends[0]!.win)) throw new Error("Invalid team result");
        return { id, at: m.gameStart, win: friends[0]!.win };
      }));
      result.push(...batch.filter((g): g is SharedGame => g !== null));
    }
    return result.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  } catch { return []; }
}
