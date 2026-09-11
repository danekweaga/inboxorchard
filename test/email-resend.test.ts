import { afterEach, describe, expect, it, vi } from "vitest";
import { processEmailQueueItem, queueEmail } from "../src/email/queue";
import { EmailProviderError, ResendProvider } from "../src/providers/email";
import { sealSecret } from "../src/security/crypto";
import type { Env } from "../src/types";
import { makeTestDb } from "./helpers/fakeD1";

const encryptionKey = "test-encryption-key-that-is-long-enough";

afterEach(() => vi.unstubAllGlobals());

describe("Resend email provider", () => {
  it("sends with a deterministic idempotency key", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer re_test_key", "Idempotency-Key": "queue/sender" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ from: "Inbox Orchard <hello@example.com>", to: ["person@example.net"] });
      return Response.json({ id: "resend_123" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ResendProvider("re_test_key").send({
      from: { email: "hello@example.com", name: "Inbox Orchard" },
      to: "person@example.net",
      subject: "Your guide",
      html: "<p>Here it is</p>",
      idempotencyKey: "queue/sender",
    });
    expect(result.messageId).toBe("resend_123");
  });

  it("classifies a quota response as safe to fail over", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Monthly quota exceeded" }, { status: 429 })));
    await expect(new ResendProvider("re_test_key").send({
      from: { email: "hello@example.com" }, to: "person@example.net", subject: "Guide", html: "<p>Guide</p>",
    })).rejects.toMatchObject({ kind: "quota", safeToFallback: true } satisfies Partial<EmailProviderError>);
  });

  it("accepts a recognized sending-only key that cannot list domains", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(new ResendProvider("re_sending_only").validateConnection()).resolves.toEqual({ ok: true });
  });
});

describe("email provider failover", () => {
  it("uses Brevo when Resend explicitly reports that its quota is exhausted", async () => {
    const db = makeTestDb();
    await insertTemplate(db);
    await insertSender(db, "resend", "sender_resend", "resend@example.com", "re_resend_key", 100, 3_000);
    await insertSender(db, "brevo", "sender_brevo", "brevo@example.com", "brevo_key", 280, null);
    const fetchMock = vi.fn(async (url: string) => url.includes("resend.com")
      ? Response.json({ message: "Monthly quota exceeded" }, { status: 429 })
      : Response.json({ messageId: "brevo_123" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const queueId = await queueEmail(db, { recipient: "person@example.net", templateId: "template_1" });
    await processEmailQueueItem(env(db), queueId);

    const queued = await db.prepare("SELECT status, provider, sender_id, provider_message_id FROM email_queue WHERE id = ?").bind(queueId).first<Record<string, unknown>>();
    expect(queued).toMatchObject({ status: "delivered", provider: "brevo", sender_id: "sender_brevo", provider_message_id: "brevo_123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fail over after an ambiguous network error that could have delivered", async () => {
    const db = makeTestDb();
    await insertTemplate(db);
    await insertSender(db, "resend", "sender_resend", "resend@example.com", "re_resend_key", 100, 3_000);
    await insertSender(db, "brevo", "sender_brevo", "brevo@example.com", "brevo_key", 280, null);
    const fetchMock = vi.fn(async () => { throw new Error("Connection closed after send"); });
    vi.stubGlobal("fetch", fetchMock);

    const queueId = await queueEmail(db, { recipient: "person@example.net", templateId: "template_1" });
    await processEmailQueueItem(env(db), queueId);

    const queued = await db.prepare("SELECT status, attempt_count, last_error FROM email_queue WHERE id = ?").bind(queueId).first<Record<string, unknown>>();
    expect(queued).toMatchObject({ status: "retrying", attempt_count: 1, last_error: "Connection closed after send" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function env(db: D1Database): Env {
  return { DB: db, ENCRYPTION_KEY: encryptionKey, MOCK_MODE: "false" } as Env;
}

async function insertTemplate(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT INTO email_templates (id, name, subject, html_body, text_body, created_at, updated_at) VALUES ('template_1', 'Guide', 'Your guide', '<p>Here it is</p>', 'Here it is', 1, 1)",
  ).run();
}

async function insertSender(
  db: D1Database,
  provider: "resend" | "brevo",
  senderId: string,
  email: string,
  apiKey: string,
  dailyLimit: number,
  monthlyLimit: number | null,
): Promise<void> {
  const credentials = await sealSecret(JSON.stringify({ apiKey }), encryptionKey);
  await db.prepare(
    `INSERT INTO email_senders
      (id, provider, email, status, credentials_ciphertext, safety_limit, monthly_limit, created_at, updated_at)
     VALUES (?, ?, ?, 'connected', ?, ?, ?, 1, 1)`,
  ).bind(senderId, provider, email, credentials, dailyLimit, monthlyLimit).run();
}
