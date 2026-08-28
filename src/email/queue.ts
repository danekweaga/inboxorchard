import { id, unixNow } from "../core/id";
import { activeGoogleAccessToken } from "../auth/google";
import { incrementUsage } from "../data/platform";
import { openSecret } from "../security/crypto";
import { BrevoProvider, GmailProvider, MockEmailProvider, type EmailProvider } from "../providers/email";
import type { Env } from "../types";

interface EmailQueueRow {
  id: string;
  sender_id: string | null;
  provider: string;
  recipient: string;
  template_id: string | null;
  payload_json: string;
  status: string;
  scheduled_at: number;
  attempt_count: number;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  last_error: string | null;
  provider_message_id: string | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SenderRow {
  id: string;
  provider: "gmail" | "brevo" | "mock";
  email: string;
  display_name: string | null;
  status: string;
  credentials_ciphertext: string | null;
  safety_limit: number;
  sent_window_start: number | null;
  sent_in_window: number;
}

interface TemplateRow {
  subject: string;
  html_body: string;
  text_body: string | null;
}

export async function queueEmail(
  db: D1Database,
  input: { senderId?: string; provider?: string; recipient: string; templateId: string; variables?: Record<string, unknown>; scheduledAt?: number },
): Promise<string> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient)) throw new Error("A valid recipient email is required");
  const queueId = id("email");
  const timestamp = unixNow();
  await db.prepare(
    `INSERT INTO email_queue
      (id, sender_id, provider, recipient, template_id, payload_json, status, scheduled_at,
       attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
  ).bind(
    queueId,
    input.senderId ?? null,
    input.provider ?? "auto",
    input.recipient,
    input.templateId,
    JSON.stringify(input.variables ?? {}),
    input.scheduledAt ?? timestamp,
    input.scheduledAt ?? timestamp,
    timestamp,
    timestamp,
  ).run();
  return queueId;
}

export async function processEmailQueueItem(env: Env, queueId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM email_queue WHERE id = ?").bind(queueId).first<EmailQueueRow>();
  if (!row || row.status === "delivered" || row.status === "failed" || row.status === "paused") return;
  const timestamp = unixNow();
  if (row.scheduled_at > timestamp || (row.next_attempt_at ?? 0) > timestamp) return;
  let sender: SenderRow | null = row.sender_id
    ? await env.DB.prepare("SELECT * FROM email_senders WHERE id = ? AND status = 'connected'").bind(row.sender_id).first<SenderRow>()
    : await env.DB.prepare("SELECT * FROM email_senders WHERE status = 'connected' ORDER BY created_at LIMIT 1").first<SenderRow>();
  if (!sender && env.MOCK_MODE === "true") {
    sender = await ensureMockSender(env.DB);
  }
  if (!sender) {
    await env.DB.prepare("UPDATE email_queue SET status = 'paused', last_error = 'No connected email sender', updated_at = ? WHERE id = ?")
      .bind(timestamp, queueId).run();
    return;
  }
  const windowStart = sender.sent_window_start ?? timestamp;
  const windowExpired = timestamp - windowStart >= 24 * 60 * 60;
  const sentInWindow = windowExpired ? 0 : sender.sent_in_window;
  if (sentInWindow >= sender.safety_limit) {
    const next = windowExpired ? timestamp + 60 : windowStart + 24 * 60 * 60;
    await env.DB.prepare(
      `UPDATE email_queue SET status = 'retrying', next_attempt_at = ?, last_error = 'Sender safety limit reached', updated_at = ? WHERE id = ?`,
    ).bind(next, timestamp, queueId).run();
    return;
  }
  const template = row.template_id
    ? await env.DB.prepare("SELECT subject, html_body, text_body FROM email_templates WHERE id = ?").bind(row.template_id).first<TemplateRow>()
    : null;
  if (!template) {
    await env.DB.prepare("UPDATE email_queue SET status = 'failed', last_error = 'Email template not found', updated_at = ? WHERE id = ?")
      .bind(timestamp, queueId).run();
    return;
  }
  const variables = JSON.parse(row.payload_json) as Record<string, unknown>;
  const subject = renderTemplate(template.subject, variables);
  const html = renderTemplate(template.html_body, variables);
  const text = template.text_body ? renderTemplate(template.text_body, variables) : undefined;
  if (subject.missing.length || html.missing.length || text?.missing.length) {
    const missing = [...new Set([...subject.missing, ...html.missing, ...(text?.missing ?? [])])];
    await env.DB.prepare("UPDATE email_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .bind(`Missing template variables: ${missing.join(", ")}`, timestamp, queueId).run();
    return;
  }

  await env.DB.prepare("UPDATE email_queue SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?")
    .bind(timestamp, timestamp, queueId).run();
  try {
    const provider = await providerFor(env, sender);
    const result = await provider.send({
      from: { email: sender.email, name: sender.display_name ?? undefined },
      to: row.recipient,
      subject: subject.value,
      html: html.value,
      text: text?.value,
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_queue SET status = 'delivered', provider_message_id = ?, delivered_at = ?,
         last_error = NULL, updated_at = ? WHERE id = ?`,
      ).bind(result.messageId, timestamp, timestamp, queueId),
      env.DB.prepare(
        `UPDATE email_senders SET sent_window_start = ?, sent_in_window = ?, updated_at = ? WHERE id = ?`,
      ).bind(windowExpired ? timestamp : windowStart, sentInWindow + 1, timestamp, sender.id),
      env.DB.prepare(
        "INSERT INTO email_events (id, queue_id, type, safe_payload_json, created_at) VALUES (?, ?, 'delivered', ?, ?)",
      ).bind(id("eevt"), queueId, JSON.stringify({ provider: sender.provider, messageId: result.messageId }), timestamp),
    ]);
    await incrementUsage(env.DB, "emails_sent", 1);
  } catch (error) {
    const attempts = row.attempt_count + 1;
    const terminal = attempts >= 6;
    const backoff = Math.min(6 * 60 * 60, 60 * 2 ** Math.max(0, attempts - 1));
    await env.DB.prepare(
      `UPDATE email_queue SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      terminal ? "failed" : "retrying",
      terminal ? null : timestamp + backoff,
      error instanceof Error ? error.message : String(error),
      timestamp,
      queueId,
    ).run();
    if (!terminal) throw error;
  }
}

export async function dueEmailIds(db: D1Database, limit = 20): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT id FROM email_queue WHERE status IN ('pending','scheduled','retrying')
     AND scheduled_at <= ? AND COALESCE(next_attempt_at, scheduled_at) <= ? ORDER BY scheduled_at LIMIT ?`,
  ).bind(unixNow(), unixNow(), Math.max(1, Math.min(100, limit))).all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

function renderTemplate(template: string, variables: Record<string, unknown>): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const replacement = variables[key];
    if (replacement === undefined || replacement === null) {
      missing.push(key);
      return "";
    }
    return String(replacement);
  });
  return { value, missing };
}

async function providerFor(env: Env, sender: SenderRow): Promise<EmailProvider> {
  if (sender.provider === "mock") return new MockEmailProvider();
  if (!sender.credentials_ciphertext) throw new Error("Sender credentials are missing");
  if (sender.provider === "gmail") {
    const token = await activeGoogleAccessToken(env, sender.credentials_ciphertext, async (ciphertext) => {
      await env.DB.prepare("UPDATE email_senders SET credentials_ciphertext = ?, updated_at = ? WHERE id = ?")
        .bind(ciphertext, unixNow(), sender.id).run();
    });
    return new GmailProvider(token);
  }
  const credentials = JSON.parse(await openSecret(sender.credentials_ciphertext, env.ENCRYPTION_KEY ?? "")) as Record<string, unknown>;
  const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey : env.BREVO_API_KEY ?? "";
  if (!apiKey) throw new Error("Brevo API key is missing");
  return new BrevoProvider(apiKey);
}

async function ensureMockSender(db: D1Database): Promise<SenderRow> {
  const existing = await db.prepare("SELECT * FROM email_senders WHERE provider = 'mock' LIMIT 1").first<SenderRow>();
  if (existing) return existing;
  const senderId = id("sender");
  const timestamp = unixNow();
  await db.prepare(
    `INSERT INTO email_senders
      (id, provider, email, display_name, purpose, status, safety_limit, sent_window_start, sent_in_window, created_at, updated_at)
     VALUES (?, 'mock', 'mock@inbox-orchard.local', 'Inbox Orchard Mock', 'Local development', 'connected', 450, ?, 0, ?, ?)`,
  ).bind(senderId, timestamp, timestamp, timestamp).run();
  const row = await db.prepare("SELECT * FROM email_senders WHERE id = ?").bind(senderId).first<SenderRow>();
  if (!row) throw new Error("Mock sender creation failed");
  return row;
}
