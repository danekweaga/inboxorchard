import { id, unixNow } from "../core/id";

export interface ContactRecord {
  id: string;
  instagram_user_id: string | null;
  username: string | null;
  display_name: string | null;
  email: string | null;
  lead_score: number;
  source_content_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationRecord {
  id: string;
  contact_id: string;
  channel: string;
  external_id: string | null;
  status: string;
  source_type: string | null;
  source_external_id: string | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  messaging_window_expires_at: number | null;
  automation_lock_run_id: string | null;
  unread_count: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  contact_id: string;
  external_message_id: string | null;
  direction: "inbound" | "outbound" | "system";
  kind: string;
  text: string | null;
  payload_json: string | null;
  delivery_status: string;
  provider_timestamp: number | null;
  created_at: number;
}

export async function findOrCreateContactConversation(
  db: D1Database,
  input: {
    instagramUserId: string;
    username?: string;
    sourceType?: string;
    sourceExternalId?: string;
    occurredAt?: number;
  },
): Promise<{ contact: ContactRecord; conversation: ConversationRecord }> {
  const timestamp = input.occurredAt ?? unixNow();
  let contact = await db
    .prepare("SELECT * FROM contacts WHERE instagram_user_id = ?")
    .bind(input.instagramUserId)
    .first<ContactRecord>();

  if (!contact) {
    const contactId = id("ct");
    await db.batch([
      db.prepare(
        `INSERT INTO contacts
          (id, instagram_user_id, username, source_content_id, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(contactId, input.instagramUserId, input.username ?? null, input.sourceExternalId ?? null, timestamp, timestamp, timestamp, timestamp),
      db.prepare(
        `INSERT INTO contact_identities
          (id, contact_id, provider, external_id, username, created_at, updated_at)
         VALUES (?, ?, 'instagram', ?, ?, ?, ?)`,
      ).bind(id("ident"), contactId, input.instagramUserId, input.username ?? null, timestamp, timestamp),
    ]);
    contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<ContactRecord>();
  } else {
    await db
      .prepare(
        `UPDATE contacts SET username = COALESCE(?, username), last_seen_at = MAX(last_seen_at, ?),
         source_content_id = COALESCE(source_content_id, ?), updated_at = ? WHERE id = ?`,
      )
      .bind(input.username ?? null, timestamp, input.sourceExternalId ?? null, unixNow(), contact.id)
      .run();
    contact = (await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contact.id).first<ContactRecord>()) ?? contact;
  }
  if (!contact) throw new Error("Contact creation failed");

  let conversation = await db
    .prepare("SELECT * FROM conversations_v2 WHERE channel = 'instagram' AND contact_id = ?")
    .bind(contact.id)
    .first<ConversationRecord>();
  if (!conversation) {
    const conversationId = id("conv");
    await db
      .prepare(
        `INSERT INTO conversations_v2
          (id, contact_id, channel, status, source_type, source_external_id, created_at, updated_at)
         VALUES (?, ?, 'instagram', 'open', ?, ?, ?, ?)`,
      )
      .bind(conversationId, contact.id, input.sourceType ?? null, input.sourceExternalId ?? null, timestamp, timestamp)
      .run();
    conversation = await db
      .prepare("SELECT * FROM conversations_v2 WHERE id = ?")
      .bind(conversationId)
      .first<ConversationRecord>();
  }
  if (!conversation) throw new Error("Conversation creation failed");
  return { contact, conversation };
}

export async function persistInboundMessage(
  db: D1Database,
  input: {
    conversation: ConversationRecord;
    contact: ContactRecord;
    externalMessageId?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    occurredAt: number;
  },
): Promise<{ message: MessageRecord; inserted: boolean }> {
  if (input.externalMessageId) {
    const existing = await db
      .prepare("SELECT * FROM messages WHERE external_message_id = ?")
      .bind(input.externalMessageId)
      .first<MessageRecord>();
    if (existing) return { message: existing, inserted: false };
  }
  const messageId = id("msg");
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (id, conversation_id, contact_id, external_message_id, direction, kind, text, payload_json,
         delivery_status, provider_timestamp, created_at)
       VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, 'received', ?, ?)`,
    )
    .bind(
      messageId,
      input.conversation.id,
      input.contact.id,
      input.externalMessageId ?? null,
      input.kind ?? "text",
      input.text ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.occurredAt,
      unixNow(),
    )
    .run();
  const inserted = (result.meta.changes ?? 0) > 0;
  const message = inserted
    ? await db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRecord>()
    : await db.prepare("SELECT * FROM messages WHERE external_message_id = ?").bind(input.externalMessageId ?? "").first<MessageRecord>();
  if (!message) throw new Error("Inbound message persistence failed");
  if (inserted) {
    const windowExpires = input.occurredAt + 24 * 60 * 60;
    await db.batch([
      db.prepare(
        `UPDATE conversations_v2 SET last_inbound_at = ?, messaging_window_expires_at = ?,
         unread_count = unread_count + 1, updated_at = ? WHERE id = ?`,
      ).bind(input.occurredAt, windowExpires, unixNow(), input.conversation.id),
      db.prepare(
        `INSERT INTO timeline_events (id, contact_id, conversation_id, type, summary, metadata_json, created_at)
         VALUES (?, ?, ?, 'message_received', ?, ?, ?)`,
      ).bind(
        id("time"),
        input.contact.id,
        input.conversation.id,
        input.text ? `Received: ${input.text.slice(0, 160)}` : `Received ${input.kind ?? "message"}`,
        JSON.stringify({ messageId }),
        unixNow(),
      ),
    ]);
  }
  return { message, inserted };
}

export async function persistOutboundMessage(
  db: D1Database,
  input: {
    conversationId: string;
    contactId: string;
    externalMessageId?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    status?: string;
  },
): Promise<MessageRecord> {
  const messageId = id("msg");
  const timestamp = unixNow();
  await db.batch([
    db.prepare(
      `INSERT INTO messages
        (id, conversation_id, contact_id, external_message_id, direction, kind, text, payload_json,
         delivery_status, provider_timestamp, created_at)
       VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      messageId,
      input.conversationId,
      input.contactId,
      input.externalMessageId ?? null,
      input.kind ?? "text",
      input.text ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.status ?? "sent",
      timestamp,
      timestamp,
    ),
    db.prepare("UPDATE conversations_v2 SET last_outbound_at = ?, updated_at = ? WHERE id = ?")
      .bind(timestamp, timestamp, input.conversationId),
    db.prepare(
      `INSERT INTO timeline_events (id, contact_id, conversation_id, type, summary, metadata_json, created_at)
       VALUES (?, ?, ?, 'message_sent', ?, ?, ?)`,
    ).bind(id("time"), input.contactId, input.conversationId, input.text ? `Sent: ${input.text.slice(0, 160)}` : "Sent message", JSON.stringify({ messageId }), timestamp),
  ]);
  const row = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRecord>();
  if (!row) throw new Error("Outbound message persistence failed");
  return row;
}

export async function listInbox(db: D1Database, limit = 40, before?: number): Promise<Array<ConversationRecord & {
  username: string | null;
  display_name: string | null;
  instagram_user_id: string | null;
  last_message: string | null;
  last_message_direction: string | null;
}>> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const cursor = before ?? Number.MAX_SAFE_INTEGER;
  const rows = await db
    .prepare(
      `SELECT c.*, ct.username, ct.display_name, ct.instagram_user_id,
        (SELECT m.text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_direction
       FROM conversations_v2 c
       JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.updated_at < ?
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .bind(cursor, safeLimit)
    .all<ConversationRecord & {
      username: string | null;
      display_name: string | null;
      instagram_user_id: string | null;
      last_message: string | null;
      last_message_direction: string | null;
    }>();
  return rows.results ?? [];
}

export async function getConversationDetail(db: D1Database, conversationId: string): Promise<{
  conversation: ConversationRecord;
  contact: ContactRecord;
  messages: MessageRecord[];
  tags: Array<{ id: string; name: string; color: string }>;
} | null> {
  const conversation = await db.prepare("SELECT * FROM conversations_v2 WHERE id = ?").bind(conversationId).first<ConversationRecord>();
  if (!conversation) return null;
  const [contact, messages, tags] = await Promise.all([
    db.prepare("SELECT * FROM contacts WHERE id = ?").bind(conversation.contact_id).first<ContactRecord>(),
    db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200").bind(conversationId).all<MessageRecord>(),
    db.prepare(
      `SELECT t.id, t.name, t.color FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id
       WHERE ct.contact_id = ? ORDER BY t.name`,
    ).bind(conversation.contact_id).all<{ id: string; name: string; color: string }>(),
  ]);
  if (!contact) return null;
  await db.prepare("UPDATE conversations_v2 SET unread_count = 0 WHERE id = ?").bind(conversationId).run();
  return { conversation, contact, messages: messages.results ?? [], tags: tags.results ?? [] };
}

export async function listContactsV2(
  db: D1Database,
  options: { search?: string; limit?: number; before?: number } = {},
): Promise<ContactRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, options.limit ?? 50));
  const cursor = options.before ?? Number.MAX_SAFE_INTEGER;
  if (options.search?.trim()) {
    const search = `%${options.search.trim().toLowerCase()}%`;
    const rows = await db.prepare(
      `SELECT * FROM contacts WHERE last_seen_at < ? AND
       (LOWER(COALESCE(username, '')) LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ? OR LOWER(COALESCE(email, '')) LIKE ?)
       ORDER BY last_seen_at DESC LIMIT ?`,
    ).bind(cursor, search, search, search, safeLimit).all<ContactRecord>();
    return rows.results ?? [];
  }
  const rows = await db.prepare("SELECT * FROM contacts WHERE last_seen_at < ? ORDER BY last_seen_at DESC LIMIT ?")
    .bind(cursor, safeLimit).all<ContactRecord>();
  return rows.results ?? [];
}

export async function getContactDetail(db: D1Database, contactId: string): Promise<{
  contact: ContactRecord;
  tags: Array<{ id: string; name: string; color: string }>;
  fields: Array<{ id: string; name: string; type: string; value_json: string | null }>;
  timeline: Array<{ id: string; type: string; summary: string; metadata_json: string | null; created_at: number }>;
} | null> {
  const contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<ContactRecord>();
  if (!contact) return null;
  const [tags, fields, timeline] = await Promise.all([
    db.prepare(
      `SELECT t.id, t.name, t.color FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id
       WHERE ct.contact_id = ? ORDER BY t.name`,
    ).bind(contactId).all<{ id: string; name: string; color: string }>(),
    db.prepare(
      `SELECT f.id, f.name, f.type, v.value_json FROM custom_fields f
       LEFT JOIN contact_field_values v ON v.field_id = f.id AND v.contact_id = ? ORDER BY f.name`,
    ).bind(contactId).all<{ id: string; name: string; type: string; value_json: string | null }>(),
    db.prepare("SELECT id, type, summary, metadata_json, created_at FROM timeline_events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 200")
      .bind(contactId).all<{ id: string; type: string; summary: string; metadata_json: string | null; created_at: number }>(),
  ]);
  return { contact, tags: tags.results ?? [], fields: fields.results ?? [], timeline: timeline.results ?? [] };
}

export async function incrementUsage(db: D1Database, metric: string, value = 1, estimated = true): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO usage_counters (day, metric, value, estimated, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, metric) DO UPDATE SET value = usage_counters.value + excluded.value,
       estimated = excluded.estimated, updated_at = excluded.updated_at`,
  ).bind(date, metric, value, estimated ? 1 : 0, unixNow()).run();
}

export async function usageSummary(db: D1Database, days = 30): Promise<Array<{ metric: string; value: number; estimated: number }>> {
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
  const rows = await db.prepare(
    "SELECT metric, SUM(value) AS value, MAX(estimated) AS estimated FROM usage_counters WHERE day >= ? GROUP BY metric ORDER BY metric",
  ).bind(since).all<{ metric: string; value: number; estimated: number }>();
  return rows.results ?? [];
}
