import { buildRuntime, toUnixSeconds } from "../runtime";
import { findOrCreateContactConversation, persistInboundMessage } from "../data/platform";
import { id, unixNow } from "../core/id";
import { AutomationExecutor } from "../automation/executor";
import type { Env, NormalizedComment, NormalizedMessage } from "../types";

interface StoredWebhookEvent {
  id: string;
  payload_json: string;
  status: string;
}

export async function processWebhookEvent(env: Env, eventId: string): Promise<void> {
  const stored = await env.DB.prepare("SELECT id, payload_json, status FROM webhook_events WHERE id = ?")
    .bind(eventId).first<StoredWebhookEvent>();
  if (!stored || stored.status === "processed") return;

  await env.DB.prepare(
    "UPDATE webhook_events SET status = 'processing', attempt_count = attempt_count + 1 WHERE id = ?",
  ).bind(eventId).run();
  try {
    const body = JSON.parse(stored.payload_json) as WebhookBody;
    const runtime = env.MOCK_MODE === "true" ? null : await buildRuntime(env);
    const automations = new AutomationExecutor(env);
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments" && change.field !== "live_comments") continue;
        const value = change.value;
        const instagramUserId = value.from?.id;
        const mediaId = value.media?.id;
        if (!instagramUserId || !mediaId || !value.id) continue;
        const timestamp = toUnixSeconds(value.timestamp);
        await env.DB.prepare(
          `INSERT INTO instagram_media (id, media_type, published_at, synced_at) VALUES (?, 'UNKNOWN', ?, ?)
           ON CONFLICT(id) DO UPDATE SET synced_at = excluded.synced_at`,
        ).bind(mediaId, timestamp, unixNow()).run();
        const { contact, conversation } = await findOrCreateContactConversation(env.DB, {
          instagramUserId,
          username: value.from?.username,
          sourceType: change.field === "live_comments" ? "live" : "comment",
          sourceExternalId: mediaId,
          occurredAt: timestamp,
        });
        await env.DB.prepare(
          `INSERT OR IGNORE INTO timeline_events
            (id, contact_id, conversation_id, type, summary, metadata_json, created_at)
           VALUES (?, ?, ?, 'comment_received', ?, ?, ?)`,
        ).bind(
          `time_comment_${value.id}`,
          contact.id,
          conversation.id,
          value.text ? `Commented: ${value.text.slice(0, 160)}` : "Commented on content",
          JSON.stringify({ commentId: value.id, mediaId }),
          timestamp,
        ).run();
        const event: NormalizedComment = {
          kind: "comment",
          comment_id: value.id,
          igsid: instagramUserId,
          username: value.from?.username,
          text: value.text ?? "",
          media_id: mediaId,
          timestamp,
        };
        const started = await automations.handleTrigger({
          type: "instagram_comment",
          eventId: `comment:${value.id}`,
          contactId: contact.id,
          conversationId: conversation.id,
          instagramUserId,
          text: value.text ?? "",
          commentId: value.id,
          mediaId,
          timestamp,
        });
        // Structured automations have deterministic priority over legacy campaigns.
        if (started.length === 0 && runtime) await runtime.engine.handleComment(event);
      }

      for (const messageEvent of entry.messaging ?? []) {
        const instagramUserId = messageEvent.sender?.id;
        if (!instagramUserId || instagramUserId === runtime?.igUserId) continue;
        // Delivery/read/seen receipts share the messaging envelope but are not user input. Letting
        // them reach the automation engine would incorrectly resume a wait step just because the
        // recipient opened the DM, causing follow prompts and delivery messages to fire early.
        if (!messageEvent.message && !messageEvent.postback) continue;
        const timestamp = messageEvent.timestamp
          ? Math.floor(messageEvent.timestamp / 1000)
          : unixNow();
        const payload = messageEvent.postback?.payload ?? messageEvent.message?.quick_reply?.payload;
        const text = messageEvent.message?.text ?? messageEvent.postback?.title;
        const messageId = messageEvent.message?.mid ?? messageEvent.postback?.mid;
        const storyId = messageEvent.message?.reply_to?.story?.id;
        const eventType = messageEvent.postback
          ? "postback"
          : messageEvent.message?.is_story_mention
            ? "story_mention"
            : messageEvent.message?.reply_to?.story
              ? "story_reply"
              : "message";
        const { contact, conversation } = await findOrCreateContactConversation(env.DB, {
          instagramUserId,
          occurredAt: timestamp,
          sourceType: eventType,
          sourceExternalId: storyId,
        });
        const persisted = await persistInboundMessage(env.DB, {
          contact,
          conversation,
          externalMessageId: messageId,
          text,
          kind: eventType,
          payload: messageEvent,
          occurredAt: timestamp,
        });
        if (!persisted.inserted) continue;
        const normalized: NormalizedMessage = {
          kind: "message",
          igsid: instagramUserId,
          message_id: messageId,
          text,
          payload,
          timestamp,
          event_type: eventType,
          raw: messageEvent,
        };
        const triggerType = eventType === "story_reply" || eventType === "story_mention" ? eventType : "instagram_dm";
        const started = await automations.handleTrigger({
          type: triggerType,
          eventId: `message:${messageId ?? id("inbound")}`,
          contactId: contact.id,
          conversationId: conversation.id,
          instagramUserId,
          text,
          mediaId: storyId,
          timestamp,
        });
        if (started.length === 0 && runtime) await runtime.engine.handleMessage(normalized);
        // Generic automation resume/trigger is connected by the automation service.
        await env.DB.prepare(
          `INSERT INTO audit_logs (id, action, entity_type, entity_id, safe_metadata_json, created_at)
           VALUES (?, 'inbound_message_ingested', 'message', ?, ?, ?)`,
        ).bind(id("audit"), persisted.message.id, JSON.stringify({ eventType, storyId }), unixNow()).run();
      }
    }
    await env.DB.prepare(
      "UPDATE webhook_events SET status = 'processed', processed_at = ?, last_error = NULL WHERE id = ?",
    ).bind(unixNow(), eventId).run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE webhook_events SET status = 'failed', last_error = ?, next_attempt_at = ? WHERE id = ?",
    ).bind(error instanceof Error ? error.message : String(error), unixNow() + 60, eventId).run();
    throw error;
  }
}

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
  message?: {
    mid?: string;
    text?: string;
    quick_reply?: { payload?: string };
    is_story_mention?: boolean;
    reply_to?: { story?: { id?: string; url?: string } };
  };
  postback?: { mid?: string; payload?: string; title?: string };
}
