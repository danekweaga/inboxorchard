import { Hono, type Context } from "hono";
import { AutomationExecutor } from "./automation/executor";
import { refreshTokenIfDue } from "./auth/refresh";
import { handleGoogleCallback } from "./auth/google";
import { id, sha256, unixNow } from "./core/id";
import { claimPollSlot } from "./db";
import { dueEmailIds, processEmailQueueItem } from "./email/queue";
import { pollComments } from "./poller/commentPoll";
import { pollMessages } from "./poller/messagePoll";
import { dueJobIds, enqueueJob, type QueueJob } from "./queue/jobs";
import { platformApi } from "./routes/platform-api";
import { handleAuthorize, handleCallback } from "./routes/auth";
import { handleWebhookEvent, handleWebhookVerify } from "./routes/webhook";
import { buildRuntime } from "./runtime";
import { processDurableJob } from "./services/jobs";
import { processDueSequences } from "./services/sequences";
import type { Env } from "./types";

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.use("*", async (context, next) => {
  await next();
  context.header("Referrer-Policy", "strict-origin-when-cross-origin");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.get("/health", (context) => context.json({ ok: true, mode: context.env.MODE, mockMode: context.env.MOCK_MODE === "true" }));
app.get("/auth/authorize", (context) => handleAuthorize(context.env, new URL(context.req.url)));
app.get("/auth/callback", (context) => handleCallback(context.env, new URL(context.req.url)));
app.get("/auth/google/callback", (context) => handleGoogleCallback(context.env, new URL(context.req.url)));
app.get("/webhook", (context) => handleWebhookVerify(context.env, new URL(context.req.url)));
app.post("/webhook", (context) => handleWebhookEvent(context.env, context.req.raw));
app.post("/hooks/:id", handleCustomWebhook);
app.get("/l/:slug", handleTrackedRedirect);
app.get("/r/:id", handleResourceDownload);
app.route("/api", platformApi);

const handler = {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    if (event.cron === "0 3 * * *") {
      context.waitUntil(refreshTokenIfDue(env).then((result) => console.log(`[dmflow] token refresh: ${result.status}`)));
    }
    if (event.cron !== "* * * * *") return;

    const work: Promise<unknown>[] = [processDueWork(env), processDueSequences(env)];
    if (env.MODE === "polling" && env.MOCK_MODE !== "true") work.push(runPoll(env));
    context.waitUntil(Promise.all(work));
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const handled = await processDurableJob(env, message.body.id);
        if (handled) message.ack();
        else message.retry();
      } catch (error) {
        console.error("[dmflow] queue job failed", message.body.id, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;

export default handler;

async function processDueWork(env: Env): Promise<void> {
  const [jobs, emails] = await Promise.all([dueJobIds(env.DB, 25), dueEmailIds(env.DB, 25)]);
  for (const job of jobs) await processDurableJob(env, job.id);
  for (const emailId of emails) await processEmailQueueItem(env, emailId);
  const minute = Math.floor(unixNow() / 60);
  await new AutomationExecutor(env).handleTrigger({ type: "scheduled", eventId: `schedule:${minute}`, timestamp: unixNow() });
}

async function runPoll(env: Env): Promise<void> {
  const interval = Math.max(30, Number(env.POLL_INTERVAL_SECONDS) || 90);
  if (!(await claimPollSlot(env.DB, interval))) return;
  const runtime = await buildRuntime(env);
  if (!runtime) return;
  await pollComments(runtime, env.DB);
  await pollMessages(runtime, env.DB);
}

async function handleTrackedRedirect(context: Context<AppEnv>): Promise<Response> {
  const row = await context.env.DB.prepare(
    "SELECT id, destination_url, contact_id FROM tracked_links WHERE slug = ?",
  ).bind(context.req.param("slug")).first<{ id: string; destination_url: string; contact_id: string | null }>();
  if (!row) return context.text("Link not found", 404);
  let destination: URL;
  try {
    destination = new URL(row.destination_url);
    if (!["http:", "https:"].includes(destination.protocol)) throw new Error("Unsafe redirect");
  } catch {
    return context.text("Link unavailable", 410);
  }
  const sourceIp = context.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = await sha256(`${context.env.ENCRYPTION_KEY ?? "dmflow"}:${sourceIp}`);
  await context.env.DB.prepare(
    `INSERT INTO link_clicks (id, tracked_link_id, contact_id, ip_hash, user_agent, referrer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id("click"), row.id, row.contact_id, ipHash,
    (context.req.header("user-agent") ?? "").slice(0, 500),
    (context.req.header("referer") ?? "").slice(0, 1000),
    unixNow(),
  ).run();
  return context.redirect(destination.toString(), 302);
}

async function handleResourceDownload(context: Context<AppEnv>): Promise<Response> {
  const resource = await context.env.DB.prepare(
    "SELECT r2_key, file_name, mime_type FROM resources WHERE id = ? AND active = 1",
  ).bind(context.req.param("id")).first<{ r2_key: string | null; file_name: string | null; mime_type: string | null }>();
  if (!resource?.r2_key || !context.env.RESOURCES) return context.text("Resource not found", 404);
  const object = await context.env.RESOURCES.get(resource.r2_key);
  if (!object) return context.text("Resource not found", 404);
  const safeName = (resource.file_name ?? "resource").replace(/["\\\r\n]/g, "_");
  return new Response(object.body, {
    headers: {
      "content-type": resource.mime_type ?? object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${safeName}"`,
      "cache-control": "private, max-age=60",
    },
  });
}

async function handleCustomWebhook(context: Context<AppEnv>): Promise<Response> {
  const webhook = await context.env.DB.prepare("SELECT id, secret_hash, automation_id FROM custom_webhooks WHERE id = ? AND active = 1")
    .bind(context.req.param("id")).first<{ id: string; secret_hash: string; automation_id: string | null }>();
  if (!webhook?.automation_id) return context.json({ error: "Webhook not found" }, 404);
  const authorization = context.req.header("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : context.req.header("x-dmflow-secret") ?? "";
  if (!supplied || await sha256(supplied) !== webhook.secret_hash) return context.json({ error: "Unauthorized" }, 401);
  const raw = await context.req.text();
  try { JSON.parse(raw); } catch { return context.json({ error: "Webhook body must be JSON" }, 400); }
  const idempotencySource = context.req.header("x-idempotency-key") ?? raw;
  const idempotencyKey = await sha256(`custom:${webhook.id}:${idempotencySource}`);
  const eventId = id("wh");
  const result = await context.env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events
      (id, provider, external_event_id, idempotency_key, event_type, payload_json, received_at, status, attempt_count)
     VALUES (?, 'custom', ?, ?, 'webhook', ?, ?, 'pending', 0)`,
  ).bind(eventId, context.req.header("x-idempotency-key") ?? null, idempotencyKey, raw, unixNow()).run();
  if ((result.meta.changes ?? 0) === 0) return context.json({ ok: true, duplicate: true });
  await enqueueJob(context.env, "custom_webhook", { eventId, automationId: webhook.automation_id }, { priority: 20 });
  return context.json({ ok: true, accepted: true, eventId }, 202);
}
