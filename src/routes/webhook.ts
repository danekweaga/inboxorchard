// Durable Instagram webhook gateway: verify, persist raw delivery, deduplicate, then enqueue.

import { id, sha256, unixNow } from "../core/id";
import { enqueueJob } from "../queue/jobs";
import type { Env } from "../types";
import { metaAppSecret, metaVerifyToken } from "../types";
import { json } from "./http";

/** GET /webhook — Meta subscription verification handshake. */
export function handleWebhookVerify(env: Env, url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === metaVerifyToken(env) && challenge) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

/** POST /webhook — acknowledge only after the raw delivery is safely persisted. */
export async function handleWebhookEvent(env: Env, req: Request): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!(await verifySignature(metaAppSecret(env), raw, sig))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const eventId = id("wh");
  const idempotencyKey = await sha256(`instagram:${raw}`);
  const externalEventId = firstExternalId(body);
  const eventType = inferEventType(body);
  const receivedAt = unixNow();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events
      (id, provider, external_event_id, idempotency_key, event_type, payload_json, received_at, status, attempt_count)
     VALUES (?, 'instagram', ?, ?, ?, ?, ?, 'pending', 0)`,
  ).bind(eventId, externalEventId, idempotencyKey, eventType, raw, receivedAt).run();
  if ((result.meta.changes ?? 0) === 0) {
    return json({ ok: true, duplicate: true });
  }
  await enqueueJob(env, "webhook_event", { eventId }, { priority: 10 });
  return json({ ok: true, accepted: true, event_id: eventId }, 202);
}

export async function verifySignature(appSecret: string, raw: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const expected = header.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const actual = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

// ---- webhook payload shapes (subset we consume) ----

interface WebhookBody {
  entry?: Array<{
    changes?: Array<{ field?: string; value?: { id?: string } }>;
    messaging?: Array<{ message?: { mid?: string }; postback?: { mid?: string } }>;
  }>;
}

function firstExternalId(body: WebhookBody): string | null {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) if (change.value?.id) return change.value.id;
    for (const event of entry.messaging ?? []) {
      const value = event.message?.mid ?? event.postback?.mid;
      if (value) return value;
    }
  }
  return null;
}

function inferEventType(body: WebhookBody): string {
  for (const entry of body.entry ?? []) {
    const field = entry.changes?.[0]?.field;
    if (field) return field;
    if (entry.messaging?.some((event) => event.postback)) return "messaging_postback";
    if (entry.messaging?.length) return "messages";
  }
  return "unknown";
}
