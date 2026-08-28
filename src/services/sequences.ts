import { AutomationExecutor } from "../automation/executor";
import { id, unixNow } from "../core/id";
import { queueEmail } from "../email/queue";
import { enqueueJob } from "../queue/jobs";
import type { Env } from "../types";

interface SubscriptionRow {
  id: string;
  sequence_id: string;
  contact_id: string;
  next_step_position: number;
}

export async function processDueSequences(env: Env, limit = 20): Promise<number> {
  const subscriptions = await env.DB.prepare(
    `SELECT id, sequence_id, contact_id, next_step_position FROM sequence_subscriptions
     WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
  ).bind(unixNow(), limit).all<SubscriptionRow>();
  let processed = 0;
  for (const subscription of subscriptions.results ?? []) {
    const step = await env.DB.prepare(
      "SELECT position, delay_minutes, action_json FROM sequence_steps WHERE sequence_id = ? AND position = ?",
    ).bind(subscription.sequence_id, subscription.next_step_position).first<{ position: number; delay_minutes: number; action_json: string }>();
    if (!step) {
      await env.DB.prepare("UPDATE sequence_subscriptions SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?")
        .bind(unixNow(), subscription.id).run();
      continue;
    }
    const action = JSON.parse(step.action_json) as Record<string, unknown>;
    if (action.type === "email") {
      const contact = await env.DB.prepare("SELECT email FROM contacts WHERE id = ?").bind(subscription.contact_id).first<{ email: string | null }>();
      if (!contact?.email) {
        await env.DB.prepare("UPDATE sequence_subscriptions SET status = 'paused', updated_at = ? WHERE id = ?")
          .bind(unixNow(), subscription.id).run();
        continue;
      }
      const queueId = await queueEmail(env.DB, {
        recipient: contact.email,
        templateId: requiredString(action.templateId, "templateId"),
        senderId: typeof action.senderId === "string" ? action.senderId : undefined,
        variables: { contact_id: subscription.contact_id },
      });
      await enqueueJob(env, "email_send", { queueId }, { priority: 70 });
    } else if (action.type === "automation") {
      await new AutomationExecutor(env).handleTrigger({
        type: "sequence",
        eventId: `sequence:${subscription.id}:${step.position}`,
        contactId: subscription.contact_id,
        automationId: requiredString(action.automationId, "automationId"),
        variables: { sequenceId: subscription.sequence_id, position: step.position },
      });
    } else {
      await env.DB.prepare("UPDATE sequence_subscriptions SET status = 'paused', updated_at = ? WHERE id = ?")
        .bind(unixNow(), subscription.id).run();
      continue;
    }
    const nextPosition = step.position + 1;
    const nextStep = await env.DB.prepare("SELECT delay_minutes FROM sequence_steps WHERE sequence_id = ? AND position = ?")
      .bind(subscription.sequence_id, nextPosition).first<{ delay_minutes: number }>();
    await env.DB.prepare(
      `UPDATE sequence_subscriptions SET next_step_position = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      nextPosition,
      nextStep ? unixNow() + Math.max(0, nextStep.delay_minutes) * 60 : null,
      nextStep ? "active" : "completed",
      unixNow(), subscription.id,
    ).run();
    processed++;
  }
  return processed;
}

export async function createSequence(
  db: D1Database,
  input: { name: string; steps: Array<{ delayMinutes: number; action: Record<string, unknown> }> },
): Promise<string> {
  const sequenceId = id("seq");
  const timestamp = unixNow();
  await db.prepare("INSERT INTO sequences (id, name, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)")
    .bind(sequenceId, input.name, timestamp, timestamp).run();
  if (input.steps.length) await db.batch(input.steps.map((step, position) => db.prepare(
    "INSERT INTO sequence_steps (id, sequence_id, position, delay_minutes, action_json) VALUES (?, ?, ?, ?, ?)",
  ).bind(id("sstep"), sequenceId, position, step.delayMinutes, JSON.stringify(step.action))));
  return sequenceId;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Sequence action is missing ${name}`);
  return value;
}
