import { withMutex } from "./mutex.js";
import * as q from "../db/queries.js";
import { chooseEncouragement } from "../core/encouragement.js";
import { sharedGames } from "./tracker.js";
import { bot } from "./instance.js";

export async function postSearchEncouragement(sessionId: number): Promise<void> {
  const session = q.getSession(sessionId);
  if (!session || session.archived_at !== null || !session.poll_message_id) return;
  const pollMessageId = session.poll_message_id;
  const now = Date.now();
  if (!q.claimEncouragement(sessionId, session.chat_id, now)) return;
  const links = q.getRiotLinks(session.chat_id);
  const games = await sharedGames(links, now);
  await withMutex(`session:${sessionId}`, async () => {
    const fresh = q.getSession(sessionId);
    // Ignore a search cancelled/bumped while loading, or an account mapping changed mid-read.
    if (!fresh || fresh.archived_at !== null || fresh.poll_message_id !== pollMessageId ||
        JSON.stringify(q.getRiotLinks(session.chat_id)) !== JSON.stringify(links)) return;
    const value = chooseEncouragement(games, q.encouragementHistory(session.chat_id), now);
    if (!value) return;
    // Persist before sending. Telegram cannot provide exactly-once delivery after a crash.
    q.saveEncouragement(sessionId, value);
    await bot.api.sendMessage(session.chat_id, value.text, {
      reply_parameters: { message_id: pollMessageId },
      disable_notification: true,
    });
  });
}
