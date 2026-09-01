import { id, unixNow } from "../core/id";
import { incrementUsage } from "../data/platform";
import type { Env } from "../types";

export type JobType = "webhook_event" | "custom_webhook" | "automation_resume" | "email_send" | "outbound_message" | "http_action";

export interface QueueJob {
  id: string;
  type: JobType;
}

export interface DurableJobRow extends QueueJob {
  payload_json: string;
  status: string;
  priority: number;
  attempt_count: number;
  available_at: number;
  claimed_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export async function enqueueJob(
  env: Env,
  type: JobType,
  payload: unknown,
  options: { delaySeconds?: number; priority?: number } = {},
): Promise<string> {
  const jobId = id("job");
  const timestamp = unixNow();
  const delaySeconds = Math.max(0, Math.min(86400, options.delaySeconds ?? 0));
  await env.DB.prepare(
    `INSERT INTO durable_jobs
      (id, type, payload_json, status, priority, attempt_count, available_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
  ).bind(jobId, type, JSON.stringify(payload), options.priority ?? 100, timestamp + delaySeconds, timestamp, timestamp).run();

  if (env.TASK_QUEUE) {
    try {
      await env.TASK_QUEUE.send({ id: jobId, type }, delaySeconds > 0 ? { delaySeconds } : undefined);
      await env.DB.prepare("UPDATE durable_jobs SET status = 'queued', updated_at = ? WHERE id = ?")
        .bind(unixNow(), jobId).run();
      await incrementUsage(env.DB, "queue_operations", 1);
    } catch (error) {
      await env.DB.prepare("UPDATE durable_jobs SET last_error = ?, updated_at = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message : String(error), unixNow(), jobId).run();
      // D1 row remains pending; cron is the no-loss fallback.
    }
  }
  return jobId;
}

export async function ensureWebhookEventJob(env: Env, eventId: string): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM durable_jobs
     WHERE type = 'webhook_event'
       AND json_extract(payload_json, '$.eventId') = ?
       AND status IN ('pending','queued','retrying','processing')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  return existing?.id ?? enqueueJob(env, "webhook_event", { eventId }, { priority: 10 });
}

/** Rebuild jobs for webhook rows that were persisted before a queue insert failed. */
export async function reconcilePendingWebhookJobs(env: Env, limit = 25): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT w.id FROM webhook_events w
     WHERE (w.status = 'pending' OR (w.status = 'failed' AND COALESCE(w.next_attempt_at, 0) <= ?))
       AND NOT EXISTS (
         SELECT 1 FROM durable_jobs j
         WHERE j.type = 'webhook_event'
           AND json_extract(j.payload_json, '$.eventId') = w.id
           AND j.status IN ('pending','queued','retrying','processing')
       )
     ORDER BY w.received_at ASC LIMIT ?`,
  ).bind(unixNow(), Math.max(1, Math.min(100, limit))).all<{ id: string }>();
  for (const row of rows.results ?? []) await ensureWebhookEventJob(env, row.id);
  return rows.results?.length ?? 0;
}

/** Return jobs abandoned by a terminated Worker invocation to the retry queue. */
export async function requeueStaleJobs(db: D1Database, staleAfterSeconds = 300): Promise<number> {
  const timestamp = unixNow();
  const result = await db.prepare(
    `UPDATE durable_jobs
     SET status = 'retrying', available_at = ?, claimed_at = NULL,
         last_error = COALESCE(last_error, 'Recovered after interrupted processing'), updated_at = ?
     WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
  ).bind(timestamp, timestamp, timestamp - Math.max(60, staleAfterSeconds)).run();
  return result.meta.changes ?? 0;
}

export async function claimJob(db: D1Database, jobId: string): Promise<DurableJobRow | null> {
  const timestamp = unixNow();
  const result = await db.prepare(
    `UPDATE durable_jobs SET status = 'processing', claimed_at = ?, attempt_count = attempt_count + 1,
     updated_at = ? WHERE id = ? AND status IN ('pending','queued','retrying') AND available_at <= ?`,
  ).bind(timestamp, timestamp, jobId, timestamp).run();
  if ((result.meta.changes ?? 0) === 0) return null;
  return db.prepare("SELECT * FROM durable_jobs WHERE id = ?").bind(jobId).first<DurableJobRow>();
}

export async function completeJob(db: D1Database, jobId: string): Promise<void> {
  await db.prepare("UPDATE durable_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE id = ?")
    .bind(unixNow(), jobId).run();
}

export async function failJob(db: D1Database, row: DurableJobRow, error: unknown): Promise<void> {
  const attempts = row.attempt_count;
  const terminal = attempts >= 6;
  const backoff = Math.min(6 * 60 * 60, 30 * 2 ** Math.max(0, attempts - 1));
  await db.prepare(
    `UPDATE durable_jobs SET status = ?, available_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    terminal ? "dead" : "retrying",
    unixNow() + (terminal ? 0 : backoff),
    error instanceof Error ? error.message : String(error),
    unixNow(),
    row.id,
  ).run();
}

export async function dueJobIds(db: D1Database, limit = 20): Promise<Array<{ id: string; type: JobType }>> {
  const rows = await db.prepare(
    `SELECT id, type FROM durable_jobs WHERE status IN ('pending','retrying') AND available_at <= ?
     ORDER BY priority ASC, created_at ASC LIMIT ?`,
  ).bind(unixNow(), Math.max(1, Math.min(100, limit))).all<{ id: string; type: JobType }>();
  return rows.results ?? [];
}
