import { id, unixNow } from "../core/id";
import { activeGoogleAccessToken } from "../auth/google";
import { incrementUsage } from "../data/platform";
import { openSecret } from "../security/crypto";
import { BrevoProvider, EmailProviderError, GmailProvider, MockEmailProvider, ResendProvider, type EmailProvider } from "../providers/email";
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
  fallback_enabled: number;
}

interface SenderRow {
  id: string;
  provider: "gmail" | "brevo" | "resend" | "mock";
  email: string;
  display_name: string | null;
  status: string;
  credentials_ciphertext: string | null;
  safety_limit: number;
  sent_window_start: number | null;
  sent_in_window: number;
  monthly_limit: number | null;
  sent_month_start: number | null;
  sent_in_month: number;
}

interface TemplateRow {
  subject: string;
  html_body: string;
  text_body: string | null;
}

export async function queueEmail(
  db: D1Database,
  input: { senderId?: string; provider?: string; recipient: string; templateId: string; variables?: Record<string, unknown>; scheduledAt?: number; allowFallback?: boolean },
): Promise<string> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient)) throw new Error("A valid recipient email is required");
  const queueId = id("email");
  const timestamp = unixNow();
  await db.prepare(
    `INSERT INTO email_queue
      (id, sender_id, provider, recipient, template_id, payload_json, status, scheduled_at,
      attempt_count, next_attempt_at, created_at, updated_at, fallback_enabled)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
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
    input.allowFallback === false ? 0 : 1,
  ).run();
  return queueId;
}

export async function processEmailQueueItem(env: Env, queueId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM email_queue WHERE id = ?").bind(queueId).first<EmailQueueRow>();
  if (!row || row.status === "delivered" || row.status === "failed" || row.status === "paused") return;
  const timestamp = unixNow();
  if (row.scheduled_at > timestamp || (row.next_attempt_at ?? 0) > timestamp) return;
  let senders = await connectedSenders(env.DB);
  if (!senders.length && env.MOCK_MODE === "true") senders = [await ensureMockSender(env.DB)];
  senders = orderSenders(senders, row.sender_id, row.fallback_enabled !== 0);
  if (!senders.length) {
    await env.DB.prepare("UPDATE email_queue SET status = 'paused', last_error = 'No connected email sender', updated_at = ? WHERE id = ?")
      .bind(timestamp, queueId).run();
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

  let earliestReset: number | null = null;
  let attempts = row.attempt_count;
  const fallbackErrors: string[] = [];
  for (const sender of senders) {
    const quota = quotaState(sender, timestamp);
    if (!quota.available) {
      earliestReset = earliestReset === null ? quota.nextAvailableAt : Math.min(earliestReset, quota.nextAvailableAt);
      fallbackErrors.push(`${sender.provider}: local quota reached`);
      continue;
    }
    attempts += 1;
    await env.DB.prepare("UPDATE email_queue SET status = 'sending', attempt_count = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?")
      .bind(attempts, timestamp, timestamp, queueId).run();
    try {
      const provider = await providerFor(env, sender);
      const result = await provider.send({
        from: { email: sender.email, name: sender.display_name ?? undefined },
        to: row.recipient,
        subject: subject.value,
        html: html.value,
        text: text?.value,
        idempotencyKey: `inbox-orchard/${queueId}/${sender.id}`,
      });
      await markDelivered(env, row, sender, quota, result.messageId, timestamp);
      return;
    } catch (error) {
      if (error instanceof EmailProviderError && error.safeToFallback && row.fallback_enabled !== 0) {
        const nextAvailableAt = await markSenderUnavailable(env.DB, sender, error, timestamp);
        if (nextAvailableAt !== null) earliestReset = earliestReset === null ? nextAvailableAt : Math.min(earliestReset, nextAvailableAt);
        fallbackErrors.push(`${sender.provider}: ${error.message}`);
        continue;
      }
      await markAttemptFailed(env.DB, attempts, queueId, error, timestamp);
      return;
    }
  }

  const retryAt = earliestReset ?? timestamp + 60 * 60;
  await env.DB.prepare(
    "UPDATE email_queue SET status = 'retrying', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).bind(retryAt, `All senders unavailable (${fallbackErrors.join("; ")})`, timestamp, queueId).run();
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

interface QuotaState {
  available: boolean;
  nextAvailableAt: number;
  windowStart: number;
  sentInWindow: number;
  monthStart: number;
  sentInMonth: number;
}

async function connectedSenders(db: D1Database): Promise<SenderRow[]> {
  const rows = await db.prepare(
    `SELECT * FROM email_senders WHERE status = 'connected'
     ORDER BY CASE provider WHEN 'resend' THEN 0 WHEN 'brevo' THEN 1 WHEN 'gmail' THEN 2 ELSE 3 END, created_at`,
  ).all<SenderRow>();
  return rows.results ?? [];
}

function orderSenders(senders: SenderRow[], preferredId: string | null, allowFallback: boolean): SenderRow[] {
  if (!preferredId) return allowFallback ? senders : senders.slice(0, 1);
  const preferred = senders.find((sender) => sender.id === preferredId);
  if (!allowFallback) return preferred ? [preferred] : [];
  return preferred ? [preferred, ...senders.filter((sender) => sender.id !== preferredId)] : senders;
}

function quotaState(sender: SenderRow, timestamp: number): QuotaState {
  const dayExpired = !sender.sent_window_start || timestamp - sender.sent_window_start >= 24 * 60 * 60;
  const windowStart = dayExpired ? timestamp : sender.sent_window_start!;
  const sentInWindow = dayExpired ? 0 : sender.sent_in_window;
  const currentMonth = utcMonthStart(timestamp);
  const monthExpired = !sender.sent_month_start || sender.sent_month_start < currentMonth;
  const monthStart = monthExpired ? currentMonth : sender.sent_month_start!;
  const sentInMonth = monthExpired ? 0 : sender.sent_in_month;
  const dayExhausted = sentInWindow >= sender.safety_limit;
  const monthExhausted = sender.monthly_limit !== null && sentInMonth >= sender.monthly_limit;
  const resets: number[] = [];
  if (dayExhausted) resets.push(windowStart + 24 * 60 * 60);
  if (monthExhausted) resets.push(nextUtcMonthStart(timestamp));
  return {
    available: !dayExhausted && !monthExhausted,
    nextAvailableAt: resets.length ? Math.max(...resets) : timestamp,
    windowStart,
    sentInWindow,
    monthStart,
    sentInMonth,
  };
}

async function markDelivered(
  env: Env,
  row: EmailQueueRow,
  sender: SenderRow,
  quota: QuotaState,
  messageId: string,
  timestamp: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_queue SET status = 'delivered', sender_id = ?, provider = ?, provider_message_id = ?, delivered_at = ?,
       next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`,
    ).bind(sender.id, sender.provider, messageId, timestamp, timestamp, row.id),
    env.DB.prepare(
      `UPDATE email_senders SET sent_window_start = ?, sent_in_window = ?, sent_month_start = ?, sent_in_month = ?,
       last_error = NULL, updated_at = ? WHERE id = ?`,
    ).bind(quota.windowStart, quota.sentInWindow + 1, quota.monthStart, quota.sentInMonth + 1, timestamp, sender.id),
    env.DB.prepare(
      "INSERT INTO email_events (id, queue_id, type, safe_payload_json, created_at) VALUES (?, ?, 'delivered', ?, ?)",
    ).bind(id("eevt"), row.id, JSON.stringify({ provider: sender.provider, senderId: sender.id, messageId }), timestamp),
  ]);
  await incrementUsage(env.DB, "emails_sent", 1);
}

async function markSenderUnavailable(
  db: D1Database,
  sender: SenderRow,
  error: EmailProviderError,
  timestamp: number,
): Promise<number | null> {
  if (error.kind === "auth") {
    await db.prepare("UPDATE email_senders SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?")
      .bind(error.message, timestamp, sender.id).run();
    return null;
  }
  const monthly = /month|monthly|credit/i.test(error.message) && sender.monthly_limit !== null;
  if (monthly) {
    await db.prepare("UPDATE email_senders SET sent_month_start = ?, sent_in_month = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .bind(utcMonthStart(timestamp), sender.monthly_limit, error.message, timestamp, sender.id).run();
    return nextUtcMonthStart(timestamp);
  }
  await db.prepare("UPDATE email_senders SET sent_window_start = ?, sent_in_window = safety_limit, last_error = ?, updated_at = ? WHERE id = ?")
    .bind(timestamp, error.message, timestamp, sender.id).run();
  return timestamp + 24 * 60 * 60;
}

async function markAttemptFailed(
  db: D1Database,
  attempts: number,
  queueId: string,
  error: unknown,
  timestamp: number,
): Promise<void> {
  const terminal = attempts >= 6;
  const backoff = Math.min(6 * 60 * 60, 60 * 2 ** Math.max(0, attempts - 1));
  await db.prepare(
    "UPDATE email_queue SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
  ).bind(
    terminal ? "failed" : "retrying",
    terminal ? null : timestamp + backoff,
    error instanceof Error ? error.message : String(error),
    timestamp,
    queueId,
  ).run();
}

function utcMonthStart(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
}

function nextUtcMonthStart(timestamp: number): number {
  const date = new Date(timestamp * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
}

async function providerFor(env: Env, sender: SenderRow): Promise<EmailProvider> {
  if (sender.provider === "mock") return new MockEmailProvider();
  if (sender.provider === "gmail") {
    if (!sender.credentials_ciphertext) throw new Error("Sender credentials are missing");
    const token = await activeGoogleAccessToken(env, sender.credentials_ciphertext, async (ciphertext) => {
      await env.DB.prepare("UPDATE email_senders SET credentials_ciphertext = ?, updated_at = ? WHERE id = ?")
        .bind(ciphertext, unixNow(), sender.id).run();
    });
    return new GmailProvider(token);
  }
  const credentials = sender.credentials_ciphertext
    ? JSON.parse(await openSecret(sender.credentials_ciphertext, env.ENCRYPTION_KEY ?? "")) as Record<string, unknown>
    : {};
  const fallbackKey = sender.provider === "resend" ? env.RESEND_API_KEY : env.BREVO_API_KEY;
  const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey : fallbackKey ?? "";
  if (!apiKey) throw new Error(`${sender.provider === "resend" ? "Resend" : "Brevo"} API key is missing`);
  return sender.provider === "resend" ? new ResendProvider(apiKey) : new BrevoProvider(apiKey);
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
