import * as q from "../db/queries.js";
import { log } from "../log.js";
import {
  archiveSessionFromScheduler,
  fireT15,
} from "../bot/session.js";

const ARCHIVE = "archive";
const T15 = "t15";

const timers = new Map<number, NodeJS.Timeout>(); // job_id -> Timeout

export async function scheduleArchive(sessionId: number, fireAt: number): Promise<void> {
  // Replace any prior archive job for this session.
  q.deleteJobsForSession(sessionId, ARCHIVE);
  const id = q.scheduleJob(ARCHIVE, { sessionId }, fireAt);
  arm(id, fireAt, async () => {
    await archiveSessionFromScheduler(sessionId);
  });
}

export async function scheduleT15(sessionId: number, fireAt: number): Promise<void> {
  q.deleteJobsForSession(sessionId, T15);
  const id = q.scheduleJob(T15, { sessionId }, fireAt);
  arm(id, fireAt, async () => {
    await fireT15(sessionId);
  });
}

export function cancelT15(sessionId: number): void {
  // In-process: clear any timer that maps to a T15 job for this session.
  // The DB rows are deleted by the caller (deleteJobsForSession).
  for (const job of q.listJobs()) {
    if (job.kind !== T15) continue;
    try {
      const payload = JSON.parse(job.payload) as { sessionId?: number };
      if (payload.sessionId === sessionId) clearTimer(job.id);
    } catch {
      // ignore
    }
  }
}

function arm(jobId: number, fireAt: number, fn: () => Promise<void>): void {
  clearTimer(jobId);
  const ms = Math.max(0, fireAt - Date.now());
  // setTimeout has a 32-bit signed-int max (~24.8 days). We never schedule
  // past tonight, so this is fine.
  const t = setTimeout(() => {
    timers.delete(jobId);
    fn()
      .catch((err) => log.error(`scheduled job ${jobId} failed`, err))
      .finally(() => {
        // Clean up the persisted job row regardless of success.
        q.deleteJob(jobId);
      });
  }, ms);
  timers.set(jobId, t);
}

function clearTimer(jobId: number): void {
  const t = timers.get(jobId);
  if (t) {
    clearTimeout(t);
    timers.delete(jobId);
  }
}

/**
 * On boot, re-arm in-process timers for every persisted job.
 * Past-due jobs run immediately if they're within the recent-grace window;
 * older ones are dropped.
 */
export async function rehydrateJobs(graceMs: number = 5 * 60 * 1000): Promise<void> {
  const now = Date.now();
  for (const job of q.listJobs()) {
    const overdue = now - job.fire_at;
    if (overdue > graceMs) {
      log.warn(`Dropping overdue job ${job.id} (${job.kind}): ${Math.round(overdue / 1000)}s late`);
      q.deleteJob(job.id);
      continue;
    }
    let payload: { sessionId?: number };
    try {
      payload = JSON.parse(job.payload);
    } catch {
      log.warn(`Job ${job.id} has unparseable payload, dropping.`);
      q.deleteJob(job.id);
      continue;
    }
    const sid = payload.sessionId;
    if (typeof sid !== "number") {
      q.deleteJob(job.id);
      continue;
    }
    if (job.kind === ARCHIVE) {
      arm(job.id, job.fire_at, () => archiveSessionFromScheduler(sid));
    } else if (job.kind === T15) {
      arm(job.id, job.fire_at, () => fireT15(sid));
    } else {
      log.warn(`Unknown job kind '${job.kind}', dropping.`);
      q.deleteJob(job.id);
    }
  }
  log.info(`Rehydrated ${timers.size} scheduled job(s).`);
}
