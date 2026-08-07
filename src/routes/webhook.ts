// Webhook mode (Section 5B, OPTIONAL — active only when MODE=webhook). Push replaces both polls.
// GET verifies the subscription handshake; POST verifies the X-Hub-Signature-256 signature
// (mandatory) then normalizes comment/message events into the same transport-agnostic engine.

import { buildRuntime, toUnixSeconds } from "../runtime";
import type { Env, NormalizedComment, NormalizedMessage } from "../types";
import { json } from "./http";

/** GET /webhook — Meta subscription verification handshake. */
export function handleWebhookVerify(env: Env, url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === env.WEBHOOK_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

/** POST /webhook — verify signature, then dispatch normalized events to the engine. */
export async function handleWebhookEvent(env: Env, req: Request): Promise<Response> {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!(await verifySignature(env.APP_SECRET, raw, sig))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const rt = await buildRuntime(env);
  if (!rt) return json({ ok: true, note: "no account connected" });

  for (const entry of body.entry ?? []) {
    // Comment change events.
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const v = change.value;
      const igsid = v.from?.id;
      const mediaId = v.media?.id;
      if (!igsid || !mediaId || !v.id) continue;
      const evt: NormalizedComment = {
        kind: "comment",
        comment_id: v.id,
        igsid,
        username: v.from?.username,
        text: v.text ?? "",
        media_id: mediaId,
        timestamp: toUnixSeconds(v.timestamp),
      };
      await rt.engine.handleComment(evt);
    }

    // Messaging events (taps, replies, postbacks).
    for (const m of entry.messaging ?? []) {
      const igsid = m.sender?.id;
      if (!igsid || igsid === rt.igUserId) continue;
      const payload = m.postback?.payload ?? m.message?.quick_reply?.payload;
      const evt: NormalizedMessage = {
        kind: "message",
        igsid,
        text: m.message?.text ?? m.postback?.title,
        payload,
        timestamp: m.timestamp ? Math.floor(m.timestamp / 1000) : toUnixSeconds(undefined),
      };
      await rt.engine.handleMessage(evt);
    }
  }

  return json({ ok: true });
}

async function verifySignature(appSecret: string, raw: string, header: string | null): Promise<boolean> {
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
  entry?: WebhookEntry[];
}
interface WebhookEntry {
  changes?: Array<{ field: string; value: CommentValue }>;
  messaging?: MessagingEvent[];
}
interface CommentValue {
  id?: string;
  text?: string;
  timestamp?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
}
interface MessagingEvent {
  sender?: { id?: string };
  timestamp?: number;
  message?: { text?: string; quick_reply?: { payload?: string } };
  postback?: { payload?: string; title?: string };
}
