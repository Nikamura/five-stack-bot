import * as q from "../db/queries.js";
import { bot } from "./instance.js";
import { withMutex } from "./mutex.js";
import { trackerGet, TRACKER_ORIGIN, type AccountLink } from "./tracker.js";
import { escapeHtml } from "../core/mention.js";
import { log } from "../log.js";

const DAY = 86_400_000;
interface Participant {
  puuid: string; teamId: number; win: boolean; championName: string;
  kills: number; deaths: number; assists: number;
}
interface MatchResult {
  matchId: string; gameStart: number; gameDuration: number; queueId: number;
  participants: Participant[];
}
const queues: Record<number, string> = {
  400: "Draft", 420: "Ranked Solo/Duo", 430: "Blind Pick", 440: "Ranked Flex",
  450: "ARAM", 490: "Quickplay", 1700: "Arena", 2400: "ARAM: Mayhem",
};

/** Validate the API boundary before counting unique linked players on each team. */
export function resultMessage(value: unknown, id: string, links: AccountLink[], since: number, now: number): string | null {
  const m = value as MatchResult | null;
  if (!m || m.matchId !== id || !Number.isFinite(m.gameStart) || !Number.isFinite(m.gameDuration) ||
      m.gameDuration < 300 || !Number.isInteger(m.queueId) || !Array.isArray(m.participants)) return null;
  const endedAt = m.gameStart + m.gameDuration * 1000;
  if (endedAt < since || endedAt > now || m.gameStart < now - DAY) return null;
  if (m.participants.some(p => !p || typeof p.puuid !== "string") ||
      new Set(m.participants.map(p => p.puuid)).size !== m.participants.length) return null;
  const names = new Map(links.filter(l => l.origin === TRACKER_ORIGIN).map(l => [l.puuid, l.gameName]));
  const teams = [100, 200].map(team => m.participants.filter(p => p.teamId === team && names.has(p.puuid)))
    .filter(team => team.length >= 3);
  if (!teams.length) return null;
  const lines: string[] = [];
  for (const team of teams) {
    if (team.some(p => typeof p.win !== "boolean" || p.win !== team[0]!.win ||
        typeof p.championName !== "string" || ![p.kills, p.deaths, p.assists].every(n => Number.isSafeInteger(n) && n >= 0))) return null;
    lines.push(`<b>${team[0]!.win ? "🏆 Victory" : "💀 Defeat"} · ${team.length}-stack</b>`,
      ...team.map(p => `${escapeHtml(names.get(p.puuid)!.slice(0, 100))} · ${escapeHtml(p.championName.slice(0, 60))} · ${p.kills}/${p.deaths}/${p.assists}`));
  }
  const duration = `${Math.floor(m.gameDuration / 60)}:${String(Math.floor(m.gameDuration % 60)).padStart(2, "0")}`;
  return `${lines.join("\n")}\n\n${queues[m.queueId] ?? `Queue ${m.queueId}`} · ${duration}`;
}

/** One send per chat per pass. Persistent claims deliberately favor no duplicate posts after an ambiguous send/crash. */
export async function pollMatchResults(now = Date.now(), fetcher = fetch): Promise<void> {
  for (const chatId of q.resultChatIds()) {
    await withMutex(`match-results:${chatId}`, async () => {
      const links = q.getRiotLinks(chatId).filter(l => l.origin === TRACKER_ORIGIN);
      const since = Math.max(q.watchMatchResults(chatId, links, now), now - DAY);
      if (links.length < 3) return;
      const signal = AbortSignal.timeout(15_000);
      try {
        const candidates = new Map<string, number>();
        // Reading one player's profile can expose the whole team before other ingest cursors catch up.
        for (const link of links) {
          try {
            const p = await trackerGet(`/players/${encodeURIComponent(link.puuid)}?since=24h&queue=all&recentLimit=50`, signal, fetcher) as {
              player: { puuid: string }; recentMatches: { matchId: string; gameStart: number; gameDuration: number }[];
            };
            if (p.player.puuid !== link.puuid || !Array.isArray(p.recentMatches)) throw new Error("Invalid tracker profile");
            for (const m of p.recentMatches) {
              if (typeof m.matchId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(m.matchId) ||
                  !Number.isFinite(m.gameStart) || !Number.isFinite(m.gameDuration) ||
                  m.gameStart + m.gameDuration * 1000 < since) continue;
              if (!q.matchResultAttempted(chatId, m.matchId)) {
                candidates.set(m.matchId, m.gameStart);
              }
            }
          } catch { signal.throwIfAborted(); } // A removed tracker account must not block other linked friends.
        }
        for (const [id] of [...candidates].sort((a, b) => b[1] - a[1]).slice(0, 50).reverse()) {
          let detail: unknown;
          try { detail = await trackerGet(`/matches/${encodeURIComponent(id)}`, signal, fetcher); }
          catch { signal.throwIfAborted(); continue; }
          const text = resultMessage(detail, id, links, since, now);
          if (!text) continue;
          if (JSON.stringify(q.getRiotLinks(chatId).filter(l => l.origin === TRACKER_ORIGIN)) !== JSON.stringify(links)) return;
          const claimed = q.claimMatchResult(chatId, id, now);
          if (!claimed) continue;
          await bot.api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [[{ text: "View match details", url: `${TRACKER_ORIGIN}/matches/${encodeURIComponent(id)}` }]] },
          // grammY's older type declarations use a polyfill; its runtime accepts native signals.
          }, AbortSignal.timeout(10_000) as unknown as NonNullable<Parameters<typeof bot.api.sendMessage>[3]>);
          return;
        }
      } catch {
        // Do not log transport errors that might include Telegram credentials.
        log.warn(`Match results unavailable for chat ${chatId}; next check in one minute`);
      }
    });
  }
}

export function startMatchResults(): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await pollMatchResults(); }
    catch { log.warn("Match result poll failed"); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
