import { describe, expect, it } from "vitest";
import { starterDefinition } from "../src/automation/schema";
import { saveAutomationDraft } from "../src/automation/repository";
import { reconcilePendingWebhookJobs, requeueStaleJobs } from "../src/queue/jobs";
import { processDurableJob } from "../src/services/jobs";
import type { Env } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";

describe("webhook and journey recovery", () => {
  it("recreates one durable job for an orphaned pending webhook", async () => {
    const db = makeTestDb();
    await db.prepare(
      `INSERT INTO webhook_events
        (id, provider, idempotency_key, event_type, payload_json, received_at, status, attempt_count)
       VALUES ('wh_orphan', 'instagram', 'unique-event', 'comments', '{}', 1, 'pending', 0)`,
    ).run();
    const env = { DB: db } as Env;

    expect(await reconcilePendingWebhookJobs(env)).toBe(1);
    expect(await reconcilePendingWebhookJobs(env)).toBe(0);
    const rows = await db.prepare(
      `SELECT id FROM durable_jobs
       WHERE type = 'webhook_event' AND json_extract(payload_json, '$.eventId') = 'wh_orphan'`,
    ).all();
    expect(rows.results).toHaveLength(1);
  });

  it("allows completed and active waits in the same automation run", async () => {
    const db = makeTestDb();
    const saved = await saveAutomationDraft(db, { definition: starterDefinition("Sequential waits") });
    await db.prepare(
      `INSERT INTO automation_runs
        (id, automation_id, version_id, trigger_type, trigger_event_id, status, context_json, started_at, updated_at)
       VALUES ('run_waits', ?, ?, 'instagram_comment', 'comment_waits', 'waiting', '{}', 1, 2)`,
    ).bind(saved.automationId, saved.versionId).run();
    await db.prepare(
      `INSERT INTO automation_wait_states
        (id, run_id, node_id, wait_type, created_at, resumed_at)
       VALUES ('wait_done', 'run_waits', 'opening', 'response', 1, 2)`,
    ).run();
    await db.prepare(
      `INSERT INTO automation_wait_states
        (id, run_id, node_id, wait_type, created_at)
       VALUES ('wait_active', 'run_waits', 'follow', 'response', 3)`,
    ).run();

    const rows = await db.prepare("SELECT id FROM automation_wait_states WHERE run_id = 'run_waits'").all();
    expect(rows.results).toHaveLength(2);
  });

  it("returns an abandoned processing job to the retry queue", async () => {
    const db = makeTestDb();
    await db.prepare(
      `INSERT INTO durable_jobs
        (id, type, payload_json, status, priority, attempt_count, available_at, claimed_at, created_at, updated_at)
       VALUES ('job_stale', 'automation_resume', '{}', 'processing', 10, 1, 1, 1, 1, 1)`,
    ).run();

    expect(await requeueStaleJobs(db, 60)).toBe(1);
    expect(await db.prepare("SELECT status, claimed_at FROM durable_jobs WHERE id = 'job_stale'").first())
      .toMatchObject({ status: "retrying", claimed_at: null });
  });

  it("records malformed job payloads as retryable failures", async () => {
    const db = makeTestDb();
    await db.prepare(
      `INSERT INTO durable_jobs
        (id, type, payload_json, status, priority, attempt_count, available_at, created_at, updated_at)
       VALUES ('job_bad_json', 'automation_resume', '{bad json', 'pending', 10, 0, 1, 1, 1)`,
    ).run();

    expect(await processDurableJob({ DB: db } as Env, "job_bad_json")).toBe(false);
    expect(await db.prepare("SELECT status, attempt_count, last_error FROM durable_jobs WHERE id = 'job_bad_json'").first())
      .toMatchObject({ status: "retrying", attempt_count: 1 });
  });
});
