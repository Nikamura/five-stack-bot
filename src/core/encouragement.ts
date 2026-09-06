import { DateTime } from "luxon";

export const HOUR = 3_600_000;
export const day = (ms: number) => DateTime.fromMillis(ms, { zone: "Europe/Vilnius" }).toISODate();
export interface SharedGame { id: string; at: number; win: boolean }
export interface Encouragement { category: string; fact: string; phrase: number; text: string }
export interface UsedEncouragement extends Encouragement { at: number }

/** Input is verified, deduplicated shared flex games, newest first. */
export function chooseEncouragement(games: SharedGame[], history: UsedEncouragement[], now: number): Encouragement | null {
  if (history.some(h => now - h.at < 6 * HOUR)) return null;
  const recent = games.filter(g => g.at <= now && now - g.at < 48 * HOUR);
  const candidates: { category: string; games: SharedGame[]; phrases: string[] }[] = [];
  const today = recent.filter(g => day(g.at) === day(now));
  const lastDay = recent[0] && games.filter(g => g.at <= now && day(g.at) === day(recent[0]!.at));
  const record = (gs: SharedGame[]) => `${gs.filter(g => g.win).length}–${gs.filter(g => !g.win).length}`;
  const prefix = "Linked friends’ shared flex";
  if (today.length) candidates.push({ category: "today", games: today, phrases: [
    `${prefix} today: ${record(today)} recorded. Who’s up for another? 🎮`,
    `${prefix} today: ${record(today)} recorded. Let’s get a party going 👀`,
  ] });
  const wins: SharedGame[] = [];
  for (const g of games) { if (!g.win) break; wins.push(g); }
  if (recent.length && wins.length >= 3) candidates.push({ category: "wins", games: wins, phrases: [
    `Linked friends won the last ${wins.length} recorded shared flex games. Keep it cooking 🔥`,
    `${wins.length} wins in the latest recorded shared flex games for linked friends. Who’s in? 🔥`,
  ] });
  if (!today.length && lastDay?.length) candidates.push({ category: "last-day", games: lastDay, phrases: [
    `${prefix} on ${day(lastDay[0]!.at)}: ${record(lastDay)} recorded. New night, new games 🎮`,
    `${prefix} on ${day(lastDay[0]!.at)}: ${record(lastDay)} recorded. Who’s up for tonight?`,
  ] });
  // Event identity crosses categories and calendar rollover; rewording isn't freshness.
  const available = candidates.filter(c => {
    const newest = c.games[0]!;
    const event = `${newest.id}:${newest.win ? 1 : 0}`;
    return !history.some(h => h.fact === fingerprint(c.games) || h.fact.split(",").includes(event));
  });
  available.sort((a, b) => lastUsed(a.category) - lastUsed(b.category));
  function lastUsed(category: string) { return history.find(h => h.category === category)?.at ?? 0; }
  const c = available[0];
  const category = c?.category ?? "invite";
  const phrases = c?.phrases ?? ["Who’s up for some games tonight? 🎮", "Pick a time — let’s get a party going 👀", "A few games with friends? Count yourself in 🎮"];
  const prev = history.find(h => h.category === category);
  const phrase = ((prev?.phrase ?? -1) + 1) % phrases.length;
  return { category, fact: c ? fingerprint(c.games) : "", phrase, text: phrases[phrase]! };
}
function fingerprint(games: SharedGame[]): string {
  return games.map(g => `${g.id}:${g.win ? 1 : 0}`).sort().join(",");
}
