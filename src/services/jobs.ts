import { AutomationExecutor } from "../automation/executor";
import { processEmailQueueItem } from "../email/queue";
import { claimJob, completeJob, failJob } from "../queue/jobs";
import { processWebhookEvent } from "./ingestion";
import type { Env } from "../types";

export async function processDurableJob(env: Env, jobId: string): Promise<boolean> {
  const row = await claimJob(env.DB, jobId);
  if (!row) return true;
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  try {
    switch (row.type) {
      case "webhook_event":
        await processWebhookEvent(env, requiredString(payload.eventId, "eventId"));
        break;
      case "custom_webhook":
        await processCustomWebhook(env, requiredString(payload.eventId, "eventId"), requiredString(payload.automationId, "automationId"));
        break;
      case "automation_resume":
        await new AutomationExecutor(env).resumeDelayed(requiredString(payload.runId, "runId"));
        break;
      case "email_send":
        await processEmailQueueItem(env, requiredString(payload.queueId, "queueId"));
        break;
      case "outbound_message":
      case "http_action":
        throw new Error(`Job type ${row.type} is not dispatched directly`);
    }
    await completeJob(env.DB, row.id);
    return true;
  } catch (error) {
    await failJob(env.DB, row, error);
    return false;
  }
}

async function processCustomWebhook(env: Env, eventId: string, automationId: string): Promise<void> {
  const event = await env.DB.prepare("SELECT payload_json, status FROM webhook_events WHERE id = ? AND provider = 'custom'")
    .bind(eventId).first<{ payload_json: string; status: string }>();
  if (!event || event.status === "processed") return;
  const variables = JSON.parse(event.payload_json) as Record<string, unknown>;
  await new AutomationExecutor(env).handleTrigger({
    type: "webhook",
    eventId: `custom:${eventId}`,
    automationId,
    variables,
  });
  await env.DB.prepare("UPDATE webhook_events SET status = 'processed', processed_at = ?, attempt_count = attempt_count + 1 WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000), eventId).run();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Job payload is missing ${name}`);
  return value;
}
