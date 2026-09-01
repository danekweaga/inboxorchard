import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { AutomationExecutor } from "../automation/executor";
import { createGoogleAuthorizeUrl } from "../auth/google";
import { deleteAutomation, getAutomation, listAutomations, publishAutomation, saveAutomationDraft, setAutomationStatus } from "../automation/repository";
import { simulateWorkflow } from "../automation/simulator";
import { starterDefinition } from "../automation/schema";
import { AUTOMATION_TEMPLATES } from "../automation/templates";
import { deleteCustomAutomationTemplate, listCustomAutomationTemplates, saveCustomAutomationTemplate } from "../automation/custom-templates";
import { validateWorkflow } from "../automation/validator";
import { id, sha256, unixNow } from "../core/id";
import { findOrCreateContactConversation, getContactDetail, getConversationDetail, incrementUsage, listContactsV2, listInbox, persistInboundMessage, usageSummary } from "../data/platform";
import { clearAuth, getAuth, kvSet, now } from "../db";
import { queueEmail } from "../email/queue";
import { INSTAGRAM_CAPABILITIES } from "../providers/capabilities";
import { WorkersAIProvider } from "../providers/ai";
import { BrevoProvider } from "../providers/email";
import { createLinkResource, uploadResource } from "../providers/storage";
import { enqueueJob } from "../queue/jobs";
import { sealSecret, timingSafeEqual } from "../security/crypto";
import { createSession, requestOriginAllowed, SESSION_COOKIE, verifySession } from "../security/session";
import { sendManualReply, suggestReply } from "../services/messaging";
import { refreshInstagramMedia } from "../services/media-sync";
import { createSequence } from "../services/sequences";
import { buildRuntime } from "../runtime";
import type { Env } from "../types";
import { isFreeMode, isMockMode, metaAppId, metaAppSecret, metaVerifyToken } from "../types";

type AppEnv = { Bindings: Env };

export const platformApi = new Hono<AppEnv>();

platformApi.get("/session", async (context) => {
  const session = getCookie(context, SESSION_COOKIE);
  return context.json({ authenticated: await verifySession(session, context.env.SESSION_SECRET ?? "") });
});

platformApi.post("/session", async (context) => {
  const payload = await safeJson(context.req.raw);
  const token = typeof payload.token === "string" ? payload.token : "";
  if (!context.env.OWNER_TOKEN || !timingSafeEqual(token, context.env.OWNER_TOKEN)) return jsonError("Invalid owner token", 401);
  if (!context.env.SESSION_SECRET) return jsonError("SESSION_SECRET is not configured", 503);
  const session = await createSession(context.env.SESSION_SECRET);
  setCookie(context, SESSION_COOKIE, session, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return context.json({ authenticated: true });
});

platformApi.delete("/session", (context) => {
  deleteCookie(context, SESSION_COOKIE, { path: "/" });
  return context.json({ authenticated: false });
});

platformApi.use("*", async (context, next) => {
  const authorization = context.req.header("authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const bearerAllowed = Boolean(context.env.OWNER_TOKEN) && timingSafeEqual(bearer, context.env.OWNER_TOKEN);
  const cookieAllowed = await verifySession(getCookie(context, SESSION_COOKIE), context.env.SESSION_SECRET ?? "");
  if (!bearerAllowed && !cookieAllowed) return jsonError("Unauthorized", 401);
  if (cookieAllowed && !bearerAllowed && !requestOriginAllowed(context.req.raw, context.env.PUBLIC_APP_ORIGIN)) return jsonError("Cross-origin write rejected", 403);
  await next();
});

platformApi.get("/bootstrap", async (context) => {
  let auth: Awaited<ReturnType<typeof getAuth>> = null;
  let authError: string | null = null;
  try {
    auth = await getAuth(context.env.DB, context.env.ENCRYPTION_KEY);
  } catch (error) {
    authError = error instanceof Error ? error.message : String(error);
  }
  const missingSecrets = [
    ["META_APP_ID", metaAppId(context.env)],
    ["META_APP_SECRET", metaAppSecret(context.env)],
    ["META_VERIFY_TOKEN", metaVerifyToken(context.env)],
    ["SESSION_SECRET", context.env.SESSION_SECRET],
    ["ENCRYPTION_KEY", context.env.ENCRYPTION_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);
  return context.json({
    product: { name: "Inbox Orchard", version: "0.2.0", singleTenant: true },
    freeMode: isFreeMode(context.env),
    mockMode: isMockMode(context.env),
    missingSecrets,
    instagram: auth ? {
      connected: true,
      username: auth.username,
      accountType: auth.account_type,
      accountId: auth.ig_user_id,
      expiresAt: auth.expires_at,
      expiresInDays: Math.max(0, Math.round((auth.expires_at - now()) / 86400)),
      tokenStatus: auth.expires_at <= now() ? "expired" : "active",
      webhookStatus: context.env.MODE === "webhook" ? "configured" : "polling fallback",
    } : { connected: false, error: authError },
    capabilities: INSTAGRAM_CAPABILITIES,
  });
});

platformApi.get("/instagram/stories", async (context) => {
  const runtime = await buildRuntime(context.env);
  if (!runtime) return jsonError("Instagram is not connected or its access token has expired", 400);
  try {
    return context.json({ stories: await runtime.client.getStories(30) });
  } catch (error) {
    console.error("[inbox-orchard] failed to load Instagram Stories", error);
    return jsonError(error instanceof Error ? error.message : "Could not load Instagram Stories", 502);
  }
});

platformApi.get("/instagram/media", async (context) => {
  try {
    return context.json({ media: await refreshInstagramMedia(context.env, 100) });
  } catch (error) {
    console.error("[inbox-orchard] failed to load Instagram media", error);
    return jsonError(error instanceof Error ? error.message : "Could not load Instagram posts and Reels", 502);
  }
});

platformApi.get("/dashboard", async (context) => {
  const days = Math.max(1, Math.min(365, Number(context.req.query("days")) || 30));
  const since = unixNow() - days * 86400;
  const [inbound, outbound, contacts, conversations, clicks, emails, qualified, resources, runCounts] = await Promise.all([
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM messages WHERE direction = 'inbound' AND created_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM messages WHERE direction = 'outbound' AND created_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM contacts WHERE first_seen_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM conversations_v2 WHERE created_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM link_clicks WHERE created_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM contacts WHERE email IS NOT NULL AND updated_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM contacts WHERE lead_score > 0 AND updated_at >= ?", since),
    scalar(context.env.DB, "SELECT COUNT(*) AS value FROM conversion_events WHERE type = 'resource_delivered' AND created_at >= ?", since),
    context.env.DB.prepare(
      `SELECT status, COUNT(*) AS value FROM automation_runs WHERE started_at >= ? GROUP BY status`,
    ).bind(since).all<{ status: string; value: number }>(),
  ]);
  return context.json({
    days,
    cards: {
      dmsReceived: inbound,
      automatedMessages: outbound,
      conversationsStarted: conversations,
      uniqueContacts: contacts,
      linksClicked: clicks,
      emailsCollected: emails,
      qualifiedLeads: qualified,
      resourcesDelivered: resources,
    },
    runs: Object.fromEntries((runCounts.results ?? []).map((row) => [row.status, row.value])),
  });
});

platformApi.get("/content", async (context) => {
  let syncWarning: string | null = null;
  try {
    await refreshInstagramMedia(context.env, 100);
  } catch (error) {
    syncWarning = error instanceof Error ? error.message : "Instagram content could not be refreshed";
    console.warn("[inbox-orchard] content media refresh unavailable", error);
  }
  const rows = await context.env.DB.prepare(
    `SELECT m.id, m.media_type, m.caption, m.permalink, m.thumbnail_url, m.media_url,
      m.published_at AS timestamp, m.comments_count,
      (SELECT COUNT(*) FROM conversations_v2 c WHERE c.source_external_id = m.id) AS dm_conversations,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.source_content_id = m.id AND (ct.email IS NOT NULL OR ct.lead_score > 0)) AS leads,
      (SELECT COUNT(*) FROM link_clicks lc JOIN tracked_links tl ON tl.id = lc.tracked_link_id WHERE tl.source_content_id = m.id) AS clicks
     FROM instagram_media m ORDER BY COALESCE(m.published_at, m.synced_at) DESC LIMIT 100`,
  ).all();
  return context.json({ content: rows.results ?? [], syncWarning });
});

platformApi.get("/inbox", async (context) => context.json({
  conversations: await listInbox(context.env.DB, Number(context.req.query("limit")) || 40, numericQuery(context.req.query("before"))),
}));

platformApi.get("/inbox/:id", async (context) => {
  const detail = await getConversationDetail(context.env.DB, context.req.param("id"));
  return detail ? context.json(detail) : jsonError("Conversation not found", 404);
});

platformApi.post("/inbox/:id/reply", async (context) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(2000), idempotencyKey: z.string().min(8).max(160).optional() })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid reply", 400);
  try {
    return context.json(await sendManualReply(context.env, {
      conversationId: context.req.param("id"), text: parsed.data.text,
      idempotencyKey: parsed.data.idempotencyKey ?? crypto.randomUUID(),
    }));
  } catch (error) {
    return jsonError(errorMessage(error), 409);
  }
});

platformApi.post("/inbox/:id/suggest", async (context) => {
  try { return context.json({ suggestion: await suggestReply(context.env, context.req.param("id")) }); }
  catch (error) { return jsonError(errorMessage(error), 409); }
});

platformApi.post("/inbox/:id/trigger", async (context) => {
  const payload = await safeJson(context.req.raw);
  const automationId = typeof payload.automationId === "string" ? payload.automationId : "";
  const detail = await getConversationDetail(context.env.DB, context.req.param("id"));
  if (!detail || !automationId) return jsonError("Conversation and automation are required", 400);
  const runs = await new AutomationExecutor(context.env).handleTrigger({
    type: "manual", eventId: `manual:${crypto.randomUUID()}`, automationId,
    contactId: detail.contact.id, conversationId: detail.conversation.id,
    instagramUserId: detail.contact.instagram_user_id ?? undefined,
    timestamp: unixNow(),
  });
  return context.json({ runs });
});

platformApi.post("/inbox/:id/resource", async (context) => {
  const payload = await safeJson(context.req.raw);
  const resourceId = typeof payload.resourceId === "string" ? payload.resourceId : "";
  const [detail, resource] = await Promise.all([
    getConversationDetail(context.env.DB, context.req.param("id")),
    context.env.DB.prepare("SELECT id, name, target_url, r2_key FROM resources WHERE id = ? AND active = 1")
      .bind(resourceId).first<{ id: string; name: string; target_url: string | null; r2_key: string | null }>(),
  ]);
  if (!detail || !resource) return jsonError("Conversation or resource not found", 404);
  const base = context.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || new URL(context.req.url).origin;
  const destination = resource.target_url ?? `${base}/r/${resource.id}`;
  const slug = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
  await context.env.DB.prepare(
    `INSERT INTO tracked_links (id, slug, resource_id, destination_url, contact_id, source_content_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id("link"), slug, resource.id, destination, detail.contact.id, detail.conversation.source_external_id, unixNow()).run();
  try {
    const sent = await sendManualReply(context.env, {
      conversationId: detail.conversation.id,
      text: `${resource.name}: ${base}/l/${slug}`,
      idempotencyKey: `resource:${resource.id}:${crypto.randomUUID()}`,
    });
    await context.env.DB.prepare(
      `INSERT INTO conversion_events (id, contact_id, source_content_id, type, value_json, created_at)
       VALUES (?, ?, ?, 'resource_delivered', ?, ?)`,
    ).bind(id("conv"), detail.contact.id, detail.conversation.source_external_id, JSON.stringify({ resourceId: resource.id, manual: true }), unixNow()).run();
    return context.json(sent);
  } catch (error) { return jsonError(errorMessage(error), 409); }
});

platformApi.get("/contacts", async (context) => context.json({ contacts: await listContactsV2(context.env.DB, {
  search: context.req.query("search"),
  limit: Number(context.req.query("limit")) || 50,
  before: numericQuery(context.req.query("before")),
}) }));

platformApi.get("/exports/contacts.csv", async (context) => {
  const rows = await context.env.DB.prepare(
    "SELECT id, instagram_user_id, username, display_name, email, lead_score, source_content_id, first_seen_at, last_seen_at FROM contacts ORDER BY last_seen_at DESC",
  ).all<Record<string, string | number | null>>();
  return csvResponse(rows.results ?? [], "inbox-orchard-contacts.csv");
});

platformApi.get("/exports/analytics.csv", async (context) => {
  const rows = await context.env.DB.prepare(
    "SELECT day, metric, value, estimated, updated_at FROM usage_counters ORDER BY day DESC, metric",
  ).all<Record<string, string | number | null>>();
  return csvResponse(rows.results ?? [], "inbox-orchard-analytics.csv");
});

platformApi.get("/contacts/:id", async (context) => {
  const detail = await getContactDetail(context.env.DB, context.req.param("id"));
  return detail ? context.json(detail) : jsonError("Contact not found", 404);
});

platformApi.patch("/contacts/:id", async (context) => {
  const parsed = z.object({
    displayName: z.string().trim().max(160).nullable().optional(),
    email: z.string().email().nullable().optional(),
    leadScore: z.number().int().min(0).max(1000).optional(),
  }).safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid contact", 400);
  const current = await context.env.DB.prepare("SELECT id FROM contacts WHERE id = ?").bind(context.req.param("id")).first<{ id: string }>();
  if (!current) return jsonError("Contact not found", 404);
  await context.env.DB.prepare(
    `UPDATE contacts SET display_name = COALESCE(?, display_name), email = COALESCE(?, email),
     lead_score = COALESCE(?, lead_score), updated_at = ? WHERE id = ?`,
  ).bind(parsed.data.displayName ?? null, parsed.data.email ?? null, parsed.data.leadScore ?? null, unixNow(), current.id).run();
  return context.json({ ok: true });
});

platformApi.get("/tags", async (context) => {
  const rows = await context.env.DB.prepare("SELECT * FROM tags ORDER BY name").all();
  return context.json({ tags: rows.results ?? [] });
});

platformApi.post("/tags", async (context) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#64748b") })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid tag", 400);
  const tagId = id("tag");
  await context.env.DB.prepare("INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)")
    .bind(tagId, parsed.data.name, parsed.data.color, unixNow()).run();
  return context.json({ id: tagId }, 201);
});

platformApi.post("/contacts/:id/tags", async (context) => {
  const payload = await safeJson(context.req.raw);
  const tagId = typeof payload.tagId === "string" ? payload.tagId : "";
  if (!tagId) return jsonError("tagId is required", 400);
  await context.env.DB.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, added_at) VALUES (?, ?, ?)")
    .bind(context.req.param("id"), tagId, unixNow()).run();
  await triggerContactAutomation(context.env, context.req.param("id"), "tag_added", { tagId });
  return context.json({ ok: true });
});

platformApi.delete("/contacts/:id/tags/:tagId", async (context) => {
  await context.env.DB.prepare("DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?")
    .bind(context.req.param("id"), context.req.param("tagId")).run();
  await triggerContactAutomation(context.env, context.req.param("id"), "tag_removed", { tagId: context.req.param("tagId") });
  return context.json({ ok: true });
});

platformApi.put("/contacts/:id/fields/:fieldId", async (context) => {
  const payload = await safeJson(context.req.raw);
  const field = await context.env.DB.prepare("SELECT type FROM custom_fields WHERE id = ?")
    .bind(context.req.param("fieldId")).first<{ type: string }>();
  if (!field) return jsonError("Custom field not found", 404);
  const value = payload.value;
  await context.env.DB.prepare(
    `INSERT INTO contact_field_values (contact_id, field_id, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(contact_id, field_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(context.req.param("id"), context.req.param("fieldId"), JSON.stringify(value ?? null), unixNow()).run();
  if (field.type === "email" && typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    await context.env.DB.prepare("UPDATE contacts SET email = ?, updated_at = ? WHERE id = ?")
      .bind(value, unixNow(), context.req.param("id")).run();
  }
  await triggerContactAutomation(context.env, context.req.param("id"), "field_changed", { fieldId: context.req.param("fieldId"), value });
  return context.json({ ok: true });
});

platformApi.get("/custom-fields", async (context) => {
  const rows = await context.env.DB.prepare("SELECT * FROM custom_fields ORDER BY name").all();
  return context.json({ fields: rows.results ?? [] });
});

platformApi.post("/custom-fields", async (context) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["text", "number", "boolean", "date", "email", "url", "select"]),
    options: z.array(z.string()).optional(),
  }).safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid custom field", 400);
  const fieldId = id("field");
  await context.env.DB.prepare(
    "INSERT INTO custom_fields (id, name, type, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(fieldId, parsed.data.name, parsed.data.type, parsed.data.options ? JSON.stringify(parsed.data.options) : null, unixNow(), unixNow()).run();
  return context.json({ id: fieldId }, 201);
});

platformApi.get("/automations", async (context) => context.json({ automations: await listAutomations(context.env.DB) }));
platformApi.get("/automations/starter", (context) => context.json({ definition: starterDefinition() }));
platformApi.get("/automations/templates", async (context) => context.json({
  templates: [
    ...(await listCustomAutomationTemplates(context.env.DB)),
    ...AUTOMATION_TEMPLATES.map((template) => ({ ...template, name: template.definition.name, description: template.definition.description, custom: false })),
  ],
}));

platformApi.post("/automations/templates", async (context) => {
  const payload = await safeJson(context.req.raw);
  let definition = payload.definition;
  let sourceAutomationId: string | undefined;
  if (typeof payload.automationId === "string") {
    const automation = await getAutomation(context.env.DB, payload.automationId);
    if (!automation) return jsonError("Automation not found", 404);
    definition = automation.published?.definition ?? automation.draft?.definition;
    sourceAutomationId = automation.automation.id;
  }
  if (!definition) return jsonError("Automation definition is required", 400);
  const fallbackName = typeof definition === "object" && definition && "name" in definition ? String(definition.name) : "Saved automation";
  try {
    const saved = await saveCustomAutomationTemplate(context.env.DB, {
      name: typeof payload.name === "string" ? payload.name : fallbackName,
      definition,
      sourceAutomationId,
    });
    return context.json(saved, 201);
  } catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.delete("/automations/templates/:id", async (context) => {
  return await deleteCustomAutomationTemplate(context.env.DB, context.req.param("id"))
    ? context.json({ ok: true })
    : jsonError("Template not found", 404);
});

platformApi.get("/automations/:id", async (context) => {
  const automation = await getAutomation(context.env.DB, context.req.param("id"));
  return automation ? context.json(automation) : jsonError("Automation not found", 404);
});

platformApi.get("/automations/:id/export", async (context) => {
  const automation = await getAutomation(context.env.DB, context.req.param("id"));
  if (!automation) return jsonError("Automation not found", 404);
  const definition = automation.draft?.definition ?? automation.published?.definition;
  if (!definition) return jsonError("Automation has no version to export", 404);
  return new Response(JSON.stringify(definition, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${safeFileName(definition.name)}.json"` },
  });
});

platformApi.post("/automations", async (context) => {
  const payload = await safeJson(context.req.raw);
  try {
    const saved = await saveAutomationDraft(context.env.DB, { automationId: typeof payload.automationId === "string" ? payload.automationId : undefined, definition: payload.definition });
    return context.json(saved, 201);
  } catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.post("/automations/:id/publish", async (context) => {
  const payload = await safeJson(context.req.raw);
  try {
    await publishAutomation(context.env.DB, context.req.param("id"), typeof payload.versionId === "string" ? payload.versionId : undefined);
    return context.json({ ok: true });
  } catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.post("/automations/:id/status", async (context) => {
  const payload = await safeJson(context.req.raw);
  if (!['published', 'paused', 'draft'].includes(String(payload.status))) return jsonError("Invalid status", 400);
  await setAutomationStatus(context.env.DB, context.req.param("id"), payload.status as "published" | "paused" | "draft");
  return context.json({ ok: true });
});

platformApi.delete("/automations/:id", async (context) => {
  try { await deleteAutomation(context.env.DB, context.req.param("id")); return context.json({ ok: true }); }
  catch (error) { return jsonError(errorMessage(error), 409); }
});

platformApi.post("/automations/validate", async (context) => context.json(validateWorkflow((await safeJson(context.req.raw)).definition)));
platformApi.post("/automations/simulate", async (context) => {
  const payload = await safeJson(context.req.raw);
  const result = simulateWorkflow(payload.definition, {
    incomingText: typeof payload.incomingText === "string" ? payload.incomingText : undefined,
    responses: isStringRecord(payload.responses) ? payload.responses : undefined,
  });
  if (result.status !== "invalid" && result.issues.every((issue) => issue.level !== "error")) {
    const dependencies = await workflowDependencyIssues(context.env.DB, result);
    result.issues.push(...dependencies);
  }
  return context.json(result);
});
platformApi.post("/automations/generate", async (context) => {
  const payload = await safeJson(context.req.raw);
  if (typeof payload.prompt !== "string" || payload.prompt.trim().length < 10) return jsonError("Describe the automation in at least 10 characters", 400);
  return context.json(await new WorkersAIProvider(context.env).generateAutomation(payload.prompt));
});

platformApi.get("/automation-runs", async (context) => {
  const rows = await context.env.DB.prepare(
    `SELECT r.*, a.name AS automation_name FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     ORDER BY r.started_at DESC LIMIT 100`,
  ).all();
  return context.json({ runs: rows.results ?? [] });
});

platformApi.get("/automation-runs/:id", async (context) => {
  const run = await context.env.DB.prepare("SELECT * FROM automation_runs WHERE id = ?").bind(context.req.param("id")).first();
  if (!run) return jsonError("Run not found", 404);
  const steps = await context.env.DB.prepare("SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY started_at")
    .bind(context.req.param("id")).all();
  return context.json({ run, steps: steps.results ?? [] });
});

platformApi.get("/resources", async (context) => {
  const rows = await context.env.DB.prepare("SELECT * FROM resources WHERE active = 1 ORDER BY updated_at DESC LIMIT 100").all();
  return context.json({ resources: rows.results ?? [] });
});

platformApi.post("/resources/link", async (context) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(1000).optional(), url: z.string().url() })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid resource", 400);
  try { return context.json({ resource: await createLinkResource(context.env.DB, parsed.data) }, 201); }
  catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.post("/resources/upload", async (context) => {
  try {
    const form = await context.req.formData();
    const file = form.get("file");
    const name = form.get("name");
    if (!(file instanceof File) || typeof name !== "string" || !name.trim()) return jsonError("Name and file are required", 400);
    const resource = await uploadResource(context.env.DB, context.env.RESOURCES, { name, description: String(form.get("description") ?? ""), file });
    await incrementUsage(context.env.DB, "r2_bytes_stored", file.size);
    return context.json({ resource }, 201);
  } catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.delete("/resources/:id", async (context) => {
  await context.env.DB.prepare("UPDATE resources SET active = 0, updated_at = ? WHERE id = ?")
    .bind(unixNow(), context.req.param("id")).run();
  return context.json({ ok: true });
});

platformApi.get("/email", async (context) => {
  const [senders, templates, queue, sequences] = await Promise.all([
    context.env.DB.prepare("SELECT id, provider, email, display_name, purpose, status, safety_limit, sent_in_window, last_error, updated_at FROM email_senders ORDER BY created_at").all(),
    context.env.DB.prepare("SELECT * FROM email_templates ORDER BY updated_at DESC").all(),
    context.env.DB.prepare("SELECT * FROM email_queue ORDER BY created_at DESC LIMIT 100").all(),
    context.env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = s.id) AS step_count,
       (SELECT COUNT(*) FROM sequence_subscriptions sub WHERE sub.sequence_id = s.id AND sub.status = 'active') AS active_subscribers
       FROM sequences s ORDER BY s.updated_at DESC`,
    ).all(),
  ]);
  return context.json({ senders: senders.results ?? [], templates: templates.results ?? [], queue: queue.results ?? [], sequences: sequences.results ?? [] });
});

platformApi.post("/email/sequences", async (context) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    steps: z.array(z.object({ delayMinutes: z.number().int().min(0).max(525600), action: z.record(z.string(), z.unknown()) })).min(1).max(50),
  }).safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid email sequence", 400);
  try { return context.json({ id: await createSequence(context.env.DB, parsed.data) }, 201); }
  catch (error) { return jsonError(errorMessage(error), 400); }
});

platformApi.post("/email/sequences/:id/status", async (context) => {
  const payload = await safeJson(context.req.raw);
  const status = String(payload.status);
  if (!["draft", "active", "paused"].includes(status)) return jsonError("Invalid sequence status", 400);
  await context.env.DB.prepare("UPDATE sequences SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, unixNow(), context.req.param("id")).run();
  return context.json({ ok: true });
});

platformApi.post("/email/templates", async (context) => {
  const parsed = z.object({ name: z.string().trim().min(1), subject: z.string().trim().min(1), htmlBody: z.string().min(1), textBody: z.string().optional() })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid email template", 400);
  const templateId = id("etpl");
  await context.env.DB.prepare(
    "INSERT INTO email_templates (id, name, subject, html_body, text_body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(templateId, parsed.data.name, parsed.data.subject, parsed.data.htmlBody, parsed.data.textBody ?? null, unixNow(), unixNow()).run();
  return context.json({ id: templateId }, 201);
});

platformApi.post("/email/queue", async (context) => {
  const parsed = z.object({ senderId: z.string().optional(), recipient: z.string().email(), templateId: z.string().min(1), variables: z.record(z.string(), z.unknown()).optional() })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid queued email", 400);
  const queueId = await queueEmail(context.env.DB, parsed.data);
  await enqueueJob(context.env, "email_send", { queueId }, { priority: 70 });
  return context.json({ id: queueId }, 201);
});

platformApi.post("/email/brevo", async (context) => {
  const parsed = z.object({ apiKey: z.string().min(10), email: z.string().email(), displayName: z.string().optional(), purpose: z.string().optional(), safetyLimit: z.number().int().min(1).max(5000).default(450) })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid Brevo sender", 400);
  if (!context.env.ENCRYPTION_KEY) return jsonError("ENCRYPTION_KEY is not configured", 503);
  const validation = await new BrevoProvider(parsed.data.apiKey).validateConnection();
  if (!validation.ok) return jsonError(validation.detail ?? "Brevo connection failed", 400);
  const senderId = id("sender");
  await context.env.DB.prepare(
    `INSERT INTO email_senders
      (id, provider, email, display_name, purpose, status, credentials_ciphertext, safety_limit, created_at, updated_at)
     VALUES (?, 'brevo', ?, ?, ?, 'connected', ?, ?, ?, ?)`,
  ).bind(senderId, parsed.data.email, parsed.data.displayName ?? null, parsed.data.purpose ?? null, await sealSecret(JSON.stringify({ apiKey: parsed.data.apiKey }), context.env.ENCRYPTION_KEY), parsed.data.safetyLimit, unixNow(), unixNow()).run();
  return context.json({ id: senderId }, 201);
});

platformApi.get("/ai-agent", async (context) => {
  const agent = await context.env.DB.prepare("SELECT * FROM ai_agents ORDER BY created_at LIMIT 1").first();
  const knowledge = agent && typeof agent === "object" && "id" in agent
    ? await context.env.DB.prepare("SELECT id, type, title, content, enabled, updated_at FROM ai_knowledge_sources WHERE agent_id = ? ORDER BY updated_at DESC").bind(String(agent.id)).all()
    : { results: [] };
  return context.json({ agent, knowledge: knowledge.results ?? [] });
});

platformApi.put("/ai-agent", async (context) => {
  const parsed = z.object({ identity: z.string().max(4000), tone: z.string().max(2000), goal: z.string().max(2000), rules: z.string().max(6000), confidenceThreshold: z.number().min(0).max(1).default(0.75), autopilotEnabled: z.boolean().default(false) })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid AI agent", 400);
  const existing = await context.env.DB.prepare("SELECT id FROM ai_agents ORDER BY created_at LIMIT 1").first<{ id: string }>();
  const agentId = existing?.id ?? id("agent");
  const timestamp = unixNow();
  if (existing) {
    await context.env.DB.prepare(
      `UPDATE ai_agents SET identity_text = ?, tone_text = ?, goal_text = ?, rules_text = ?,
       confidence_threshold = ?, autopilot_enabled = ?, updated_at = ? WHERE id = ?`,
    ).bind(parsed.data.identity, parsed.data.tone, parsed.data.goal, parsed.data.rules, parsed.data.confidenceThreshold, parsed.data.autopilotEnabled ? 1 : 0, timestamp, agentId).run();
  } else {
    await context.env.DB.prepare(
      `INSERT INTO ai_agents
        (id, name, identity_text, tone_text, goal_text, rules_text, confidence_threshold, autopilot_enabled, created_at, updated_at)
       VALUES (?, 'Creator Agent', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(agentId, parsed.data.identity, parsed.data.tone, parsed.data.goal, parsed.data.rules, parsed.data.confidenceThreshold, parsed.data.autopilotEnabled ? 1 : 0, timestamp, timestamp).run();
  }
  return context.json({ id: agentId });
});

platformApi.post("/ai-agent/knowledge", async (context) => {
  const parsed = z.object({ title: z.string().trim().min(1), content: z.string().trim().min(1).max(100000), type: z.enum(["faq", "note", "resource", "product", "pasted_text"]).default("note") })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid knowledge source", 400);
  const agent = await context.env.DB.prepare("SELECT id FROM ai_agents ORDER BY created_at LIMIT 1").first<{ id: string }>();
  if (!agent) return jsonError("Configure the AI agent first", 409);
  const sourceId = id("knowledge");
  await context.env.DB.prepare(
    `INSERT INTO ai_knowledge_sources (id, agent_id, type, title, content, search_text, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(sourceId, agent.id, parsed.data.type, parsed.data.title, parsed.data.content, `${parsed.data.title}\n${parsed.data.content}`.toLowerCase(), unixNow(), unixNow()).run();
  return context.json({ id: sourceId }, 201);
});

platformApi.delete("/ai-agent/knowledge/:id", async (context) => {
  await context.env.DB.prepare("DELETE FROM ai_knowledge_sources WHERE id = ?").bind(context.req.param("id")).run();
  return context.json({ ok: true });
});

platformApi.post("/integrations/instagram/connect", async (context) => {
  if (!metaAppId(context.env) || !metaAppSecret(context.env)) return jsonError("Meta credentials are not configured", 409);
  const ticket = crypto.randomUUID().replaceAll("-", "");
  await kvSet(context.env.DB, `oauth_ticket:${await sha256(ticket)}`, JSON.stringify({ expiresAt: unixNow() + 300 }));
  return context.json({ url: `/auth/authorize?ticket=${ticket}` });
});

platformApi.post("/integrations/instagram/disconnect", async (context) => {
  await clearAuth(context.env.DB);
  return context.json({ disconnected: true });
});

platformApi.post("/integrations/google/connect", async (context) => {
  const parsed = z.object({
    purpose: z.enum(["gmail", "sheets"]),
    spreadsheetId: z.string().optional(),
    range: z.string().max(200).optional(),
  }).safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid Google connection", 400);
  try { return context.json({ url: await createGoogleAuthorizeUrl(context.env, parsed.data) }); }
  catch (error) { return jsonError(errorMessage(error), 409); }
});

platformApi.get("/integrations", async (context) => {
  const [connections, webhooks] = await Promise.all([
    context.env.DB.prepare("SELECT id, provider, label, status, config_json, last_error, updated_at FROM integration_connections ORDER BY provider").all(),
    context.env.DB.prepare("SELECT id, name, automation_id, active, created_at, updated_at FROM custom_webhooks ORDER BY updated_at DESC").all(),
  ]);
  return context.json({ capabilities: INSTAGRAM_CAPABILITIES, connections: connections.results ?? [], customWebhooks: webhooks.results ?? [] });
});

platformApi.post("/integrations/custom-webhooks", async (context) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), automationId: z.string().min(1) })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid custom webhook", 400);
  const automation = await context.env.DB.prepare("SELECT id FROM automations WHERE id = ?")
    .bind(parsed.data.automationId).first<{ id: string }>();
  if (!automation) return jsonError("Automation not found", 404);
  const secret = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const webhookId = id("hook");
  const timestamp = unixNow();
  await context.env.DB.prepare(
    `INSERT INTO custom_webhooks (id, name, secret_hash, automation_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).bind(webhookId, parsed.data.name, await sha256(secret), parsed.data.automationId, timestamp, timestamp).run();
  const base = context.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || new URL(context.req.url).origin;
  return context.json({ id: webhookId, url: `${base}/hooks/${webhookId}`, secret }, 201);
});

platformApi.delete("/integrations/custom-webhooks/:id", async (context) => {
  await context.env.DB.prepare("UPDATE custom_webhooks SET active = 0, updated_at = ? WHERE id = ?")
    .bind(unixNow(), context.req.param("id")).run();
  return context.json({ ok: true });
});

platformApi.get("/webhook-events", async (context) => {
  const rows = await context.env.DB.prepare(
    `SELECT id, provider, external_event_id, event_type, received_at, processed_at, status, attempt_count, last_error
     FROM webhook_events ORDER BY received_at DESC LIMIT 100`,
  ).all();
  return context.json({ events: rows.results ?? [] });
});

platformApi.post("/webhook-events/:id/replay", async (context) => {
  const eventId = context.req.param("id");
  await context.env.DB.prepare("UPDATE webhook_events SET status = 'pending', last_error = NULL, next_attempt_at = NULL WHERE id = ?")
    .bind(eventId).run();
  const jobId = await enqueueJob(context.env, "webhook_event", { eventId }, { priority: 10 });
  return context.json({ jobId });
});

platformApi.get("/usage", async (context) => context.json({
  days: 30,
  metrics: await usageSummary(context.env.DB),
  labels: { providerValues: "Locally tracked estimate" },
}));

platformApi.get("/settings", async (context) => {
  const rows = await context.env.DB.prepare("SELECT key, value_json, updated_at FROM settings ORDER BY key").all<{ key: string; value_json: string; updated_at: number }>();
  return context.json({ settings: Object.fromEntries((rows.results ?? []).map((row) => [row.key, JSON.parse(row.value_json)])) });
});

platformApi.put("/settings/:key", async (context) => {
  const key = context.req.param("key");
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) return jsonError("Invalid settings key", 400);
  const payload = await safeJson(context.req.raw);
  await context.env.DB.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(payload.value ?? null), unixNow()).run();
  return context.json({ ok: true });
});

platformApi.get("/backup", async (context) => {
  const [automations, versions, automationTemplates, tags, fields, resources, templates, sequences, sequenceSteps, agents, knowledge, settings] = await Promise.all([
    context.env.DB.prepare("SELECT * FROM automations").all(),
    context.env.DB.prepare("SELECT * FROM automation_versions").all(),
    context.env.DB.prepare("SELECT * FROM automation_templates").all(),
    context.env.DB.prepare("SELECT * FROM tags").all(),
    context.env.DB.prepare("SELECT * FROM custom_fields").all(),
    context.env.DB.prepare("SELECT id, name, description, type, target_url, r2_key, file_name, mime_type, size_bytes, active, created_at, updated_at FROM resources").all(),
    context.env.DB.prepare("SELECT * FROM email_templates").all(),
    context.env.DB.prepare("SELECT * FROM sequences").all(),
    context.env.DB.prepare("SELECT * FROM sequence_steps").all(),
    context.env.DB.prepare("SELECT id, name, identity_text, tone_text, goal_text, rules_text, confidence_threshold, autopilot_enabled, created_at, updated_at FROM ai_agents").all(),
    context.env.DB.prepare("SELECT * FROM ai_knowledge_sources").all(),
    context.env.DB.prepare("SELECT * FROM settings").all(),
  ]);
  return context.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), includesSecrets: false, data: {
    automations: automations.results ?? [], automationVersions: versions.results ?? [], automationTemplates: automationTemplates.results ?? [], tags: tags.results ?? [],
    customFields: fields.results ?? [], resources: resources.results ?? [], emailTemplates: templates.results ?? [],
    sequences: sequences.results ?? [], sequenceSteps: sequenceSteps.results ?? [], aiAgents: agents.results ?? [],
    knowledge: knowledge.results ?? [], settings: settings.results ?? [],
  } });
});

platformApi.post("/backup/restore", async (context) => {
  const payload = await safeJson(context.req.raw);
  if (payload.schemaVersion !== 1 || !isRecord(payload.data)) return jsonError("Unsupported or invalid backup file", 400);
  const statements: D1PreparedStatement[] = [];
  const counts: Record<string, number> = {};
  let totalRows = 0;
  for (const definition of BACKUP_TABLES) {
    const value = payload.data[definition.dataKey];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return jsonError(`Backup section ${definition.dataKey} must be an array`, 400);
    totalRows += value.length;
    if (totalRows > 10_000) return jsonError("Backup contains more than 10,000 configuration rows", 413);
    for (const item of value) {
      if (!isRecord(item)) return jsonError(`Backup section ${definition.dataKey} contains an invalid row`, 400);
      const values = definition.columns.map((column) => item[column]);
      if (values.some((entry) => !isSqlValue(entry))) return jsonError(`Backup section ${definition.dataKey} contains an unsupported value`, 400);
      const placeholders = definition.columns.map(() => "?").join(", ");
      statements.push(context.env.DB.prepare(
        `INSERT OR REPLACE INTO ${definition.table} (${definition.columns.join(", ")}) VALUES (${placeholders})`,
      ).bind(...values));
    }
    counts[definition.dataKey] = value.length;
  }
  if (!statements.length) return jsonError("Backup contains no restorable configuration", 400);
  await context.env.DB.batch(statements);
  await context.env.DB.prepare(
    "INSERT INTO audit_logs (id, action, entity_type, safe_metadata_json, created_at) VALUES (?, 'backup_restored', 'configuration', ?, ?)",
  ).bind(id("audit"), JSON.stringify({ counts, includesSecrets: false }), unixNow()).run();
  return context.json({ ok: true, restored: counts, includesSecrets: false });
});

platformApi.post("/mock/events", async (context) => {
  if (!isMockMode(context.env)) return jsonError("Mock mode is disabled", 403);
  const parsed = z.object({ type: z.enum(["dm", "comment", "story_reply", "story_mention"]), instagramUserId: z.string().default("mock_user_1"), username: z.string().default("test.creator"), text: z.string().default("GUIDE"), mediaId: z.string().default("mock_media_1") })
    .safeParse(await safeJson(context.req.raw));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid mock event", 400);
  const timestamp = unixNow();
  const { contact, conversation } = await findOrCreateContactConversation(context.env.DB, {
    instagramUserId: parsed.data.instagramUserId, username: parsed.data.username,
    sourceType: parsed.data.type, sourceExternalId: parsed.data.mediaId, occurredAt: timestamp,
  });
  const eventId = `mock:${crypto.randomUUID()}`;
  if (parsed.data.type === "dm" || parsed.data.type.startsWith("story")) {
    await persistInboundMessage(context.env.DB, { contact, conversation, externalMessageId: eventId, text: parsed.data.text, kind: parsed.data.type, occurredAt: timestamp });
  }
  const triggerType = parsed.data.type === "dm" ? "instagram_dm" : parsed.data.type === "comment" ? "instagram_comment" : parsed.data.type;
  const runs = await new AutomationExecutor(context.env).handleTrigger({
    type: triggerType, eventId, contactId: contact.id, conversationId: conversation.id,
    instagramUserId: parsed.data.instagramUserId, text: parsed.data.text,
    commentId: parsed.data.type === "comment" ? `mock_comment_${crypto.randomUUID()}` : undefined,
    mediaId: parsed.data.mediaId, timestamp,
  });
  return context.json({ ok: true, runs, contactId: contact.id, conversationId: conversation.id });
});

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try { return await request.json() as Record<string, unknown>; }
  catch { return {}; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericQuery(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

async function scalar(db: D1Database, sql: string, value: number): Promise<number> {
  const row = await db.prepare(sql).bind(value).first<{ value: number }>();
  return row?.value ?? 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSqlValue(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

const BACKUP_TABLES = [
  { dataKey: "automations", table: "automations", columns: ["id", "name", "description", "status", "trigger_type", "priority", "draft_version_id", "published_version_id", "created_at", "updated_at"] },
  { dataKey: "automationVersions", table: "automation_versions", columns: ["id", "automation_id", "version", "status", "definition_json", "checksum", "created_at", "published_at"] },
  { dataKey: "automationTemplates", table: "automation_templates", columns: ["id", "name", "description", "category", "definition_json", "source_automation_id", "created_at", "updated_at"] },
  { dataKey: "tags", table: "tags", columns: ["id", "name", "color", "created_at"] },
  { dataKey: "customFields", table: "custom_fields", columns: ["id", "name", "type", "options_json", "created_at", "updated_at"] },
  { dataKey: "resources", table: "resources", columns: ["id", "name", "description", "type", "target_url", "r2_key", "file_name", "mime_type", "size_bytes", "active", "created_at", "updated_at"] },
  { dataKey: "emailTemplates", table: "email_templates", columns: ["id", "name", "subject", "html_body", "text_body", "created_at", "updated_at"] },
  { dataKey: "sequences", table: "sequences", columns: ["id", "name", "status", "created_at", "updated_at"] },
  { dataKey: "sequenceSteps", table: "sequence_steps", columns: ["id", "sequence_id", "position", "delay_minutes", "action_json"] },
  { dataKey: "aiAgents", table: "ai_agents", columns: ["id", "name", "identity_text", "tone_text", "goal_text", "rules_text", "confidence_threshold", "autopilot_enabled", "created_at", "updated_at"] },
  { dataKey: "knowledge", table: "ai_knowledge_sources", columns: ["id", "agent_id", "type", "title", "content", "search_text", "enabled", "created_at", "updated_at"] },
  { dataKey: "settings", table: "settings", columns: ["key", "value_json", "updated_at"] },
] as const;

function csvResponse(rows: Array<Record<string, string | number | null>>, filename: string): Response {
  const headers = rows.length ? Object.keys(rows[0]!) : [];
  const escape = (value: string | number | null | undefined) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` } });
}

function safeFileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "automation";
}

async function workflowDependencyIssues(
  db: D1Database,
  result: ReturnType<typeof simulateWorkflow>,
): Promise<Array<{ level: "error" | "warning"; code: string; message: string; nodeId?: string }>> {
  const issues: Array<{ level: "error" | "warning"; code: string; message: string; nodeId?: string }> = [];
  // The trace contains only nodes actually exercised. Validate referenced IDs from their summaries without executing them.
  for (const event of result.events) {
    if (!event.nodeId) continue;
    const resourceMatch = event.summary.match(/^Would deliver resource (.+)\.$/);
    if (resourceMatch?.[1]) {
      const exists = await db.prepare("SELECT id FROM resources WHERE id = ? AND active = 1").bind(resourceMatch[1]).first<{ id: string }>();
      if (!exists) issues.push({ level: "error", code: "missing_resource", message: `Resource ${resourceMatch[1]} is not available.`, nodeId: event.nodeId });
    }
    const emailMatch = event.summary.match(/^Would queue email template (.+)\.$/);
    if (emailMatch?.[1]) {
      const [template, sender] = await Promise.all([
        db.prepare("SELECT id FROM email_templates WHERE id = ?").bind(emailMatch[1]).first<{ id: string }>(),
        db.prepare("SELECT id FROM email_senders WHERE status = 'connected' LIMIT 1").first<{ id: string }>(),
      ]);
      if (!template) issues.push({ level: "error", code: "missing_email_template", message: `Email template ${emailMatch[1]} does not exist.`, nodeId: event.nodeId });
      if (!sender) issues.push({ level: "error", code: "missing_email_sender", message: "No connected email sender is available.", nodeId: event.nodeId });
    }
  }
  return issues;
}

async function triggerContactAutomation(
  env: Env,
  contactId: string,
  type: "tag_added" | "tag_removed" | "field_changed",
  variables: Record<string, unknown>,
): Promise<void> {
  const contact = await env.DB.prepare("SELECT instagram_user_id FROM contacts WHERE id = ?")
    .bind(contactId).first<{ instagram_user_id: string | null }>();
  const conversation = await env.DB.prepare("SELECT id FROM conversations_v2 WHERE contact_id = ? AND channel = 'instagram'")
    .bind(contactId).first<{ id: string }>();
  await new AutomationExecutor(env).handleTrigger({
    type,
    eventId: `${type}:${contactId}:${crypto.randomUUID()}`,
    contactId,
    conversationId: conversation?.id,
    instagramUserId: contact?.instagram_user_id ?? undefined,
    variables,
    timestamp: unixNow(),
  });
}
