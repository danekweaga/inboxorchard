const base = process.env.DMFLOW_SMOKE_URL ?? "http://127.0.0.1:5173";
const token = process.env.DMFLOW_OWNER_TOKEN ?? "dev-owner-token-change-me";
const metaAppSecret = process.env.DMFLOW_META_APP_SECRET ?? "local-mock-app-secret";
const suffix = crypto.randomUUID().slice(0, 8);

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      origin: base,
      ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${body.error ?? response.status}`);
  return body;
}

async function createAndPublish(definition) {
  const saved = await request("/api/automations", { method: "POST", body: JSON.stringify({ definition }) });
  await request(`/api/automations/${saved.automationId}/publish`, { method: "POST", body: "{}" });
  return saved.automationId;
}

function linear(name, trigger, nodes) {
  return {
    schemaVersion: 1,
    name: `${name} ${suffix}`,
    description: "Automated smoke verification",
    trigger,
    startNodeId: nodes[0].id,
    nodes: nodes.map((node, index) => ({ ...node, label: node.label ?? node.type, position: { x: index * 260, y: 100 } })),
    edges: nodes.slice(0, -1).map((node, index) => ({ id: `edge_${node.id}_${nodes[index + 1].id}`, source: node.id, target: nodes[index + 1].id })),
    settings: { stopOtherAutomations: true, priority: 100 },
  };
}

function matchTrigger(type, keyword) {
  return { type, config: { match: { mode: "exact", include: [keyword], exclude: [], caseSensitive: false } } };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function metaSignature(raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(metaAppSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const health = await fetch(`${base}/health`).then((response) => response.json());
assert(health.ok && health.mockMode, "Server must be healthy and in mock mode");

const keyword = `RESUME_${suffix}`;
await createAndPublish(linear("Keyword DM", matchTrigger("keyword", keyword), [
  { id: "send", type: "send_text", config: { text: "Here is your smoke-tested guide." } },
  { id: "end", type: "end", config: {} },
]));
const dm = await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "dm", instagramUserId: `smoke_dm_${suffix}`, username: `smoke.dm.${suffix}`, text: keyword }) });
assert(dm.runs.length === 1, "Keyword DM should start exactly one workflow run");

const resource = await request("/api/resources/link", { method: "POST", body: JSON.stringify({ name: `Smoke Guide ${suffix}`, url: "https://example.com/guide" }) });
const commentKeyword = `COMMENT_${suffix}`;
await createAndPublish(linear("Comment resource", matchTrigger("instagram_comment", commentKeyword), [
  { id: "public", type: "public_comment_reply", config: { text: "sent 🤝" } },
  { id: "resource", type: "send_resource", config: { resourceId: resource.resource.id } },
  { id: "end", type: "end", config: {} },
]));
const comment = await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "comment", instagramUserId: `smoke_comment_${suffix}`, username: `smoke.comment.${suffix}`, text: commentKeyword, mediaId: `media_${suffix}` }) });
assert(comment.runs.length === 1, "Comment event should start exactly one workflow run");
const inbox = await request("/api/inbox");
const commentConversation = inbox.conversations.find((item) => item.username === `smoke.comment.${suffix}`);
assert(commentConversation, "Comment-created conversation should appear in the inbox");
const commentDetail = await request(`/api/inbox/${commentConversation.id}`);
const trackedMessage = commentDetail.messages.find((message) => message.direction === "outbound" && /\/l\/[a-z0-9]+/i.test(message.text ?? ""));
assert(trackedMessage, "Resource delivery should contain a tracked link");
const trackedPath = trackedMessage.text.match(/\/l\/[a-z0-9]+/i)[0];
const trackedClick = await fetch(`${base}${trackedPath}`, { redirect: "manual" });
assert(trackedClick.status === 302, "Tracked link should record a click and redirect");

const field = await request("/api/custom-fields", { method: "POST", body: JSON.stringify({ name: `University Year ${suffix}`, type: "number" }) });
const qualificationKeyword = `QUALIFY_${suffix}`;
const qualification = linear("Resumable qualification", matchTrigger("keyword", qualificationKeyword), [
  { id: "ask", type: "ask_question", config: { text: "What year are you in?", field: "year" } },
  { id: "save", type: "update_field", config: { fieldId: field.id, valueFrom: "year" } },
  { id: "condition", type: "condition", config: { field: "year", operator: "contains", value: "2" } },
  { id: "beginner", type: "send_text", config: { text: "Beginner guide selected." } },
  { id: "end", type: "end", config: {} },
]);
qualification.nodes.push({ id: "advanced", type: "send_text", label: "Advanced branch", position: { x: 780, y: 250 }, config: { text: "Advanced guide selected." } });
qualification.edges = [
  { id: "ask-save", source: "ask", target: "save" },
  { id: "save-condition", source: "save", target: "condition" },
  { id: "true", source: "condition", sourceHandle: "true", label: "true", target: "beginner" },
  { id: "false", source: "condition", sourceHandle: "false", label: "false", target: "advanced" },
  { id: "beginner-end", source: "beginner", target: "end" },
  { id: "advanced-end", source: "advanced", target: "end" },
];
await createAndPublish(qualification);
const qualifyStart = await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "dm", instagramUserId: `smoke_qualify_${suffix}`, username: `smoke.qualify.${suffix}`, text: qualificationKeyword }) });
assert(qualifyStart.runs.length === 1, "Qualification should start");
const qualifyReply = await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "dm", instagramUserId: `smoke_qualify_${suffix}`, username: `smoke.qualify.${suffix}`, text: "2" }) });
assert(qualifyReply.runs[0] === qualifyStart.runs[0], "Inbound answer should resume the existing run");
const run = await request(`/api/automation-runs/${qualifyStart.runs[0]}`);
assert(run.run.status === "completed", "Resumed qualification run should complete");

const emailTemplate = await request("/api/email/templates", { method: "POST", body: JSON.stringify({ name: `Smoke email ${suffix}`, subject: "Your guide", htmlBody: "<p>Your guide is ready.</p>" }) });
const emailKeyword = `EMAIL_${suffix}`;
await createAndPublish(linear("Email capture", matchTrigger("keyword", emailKeyword), [
  { id: "ask", type: "ask_question", config: { text: "What email should I use?", field: "email" } },
  { id: "email", type: "send_email", config: { templateId: emailTemplate.id } },
  { id: "end", type: "end", config: {} },
]));
await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "dm", instagramUserId: `smoke_email_${suffix}`, username: `smoke.email.${suffix}`, text: emailKeyword }) });
await request("/api/mock/events", { method: "POST", body: JSON.stringify({ type: "dm", instagramUserId: `smoke_email_${suffix}`, username: `smoke.email.${suffix}`, text: `smoke.${suffix}@example.com` }) });
const email = await request("/api/email");
assert(email.queue.some((item) => item.recipient === `smoke.${suffix}@example.com`), "Captured email should be durably queued");

const simulator = await request("/api/automations/simulate", { method: "POST", body: JSON.stringify({ definition: qualification, incomingText: qualificationKeyword, responses: { ask: "2" } }) });
assert(simulator.status === "completed", "Simulator should exercise the qualification flow without external sends");

const webhookPayload = JSON.stringify({ entry: [{ messaging: [{ message: { mid: `smoke_webhook_${suffix}` } }] }] });
const webhookHeaders = { "content-type": "application/json", "x-hub-signature-256": await metaSignature(webhookPayload) };
const firstWebhook = await fetch(`${base}/webhook`, { method: "POST", headers: webhookHeaders, body: webhookPayload });
const firstWebhookBody = await firstWebhook.json();
assert(firstWebhook.status === 202 && firstWebhookBody.accepted, "A valid signed webhook should be durably accepted");
const duplicateWebhook = await fetch(`${base}/webhook`, { method: "POST", headers: webhookHeaders, body: webhookPayload });
const duplicateWebhookBody = await duplicateWebhook.json();
assert(duplicateWebhook.ok && duplicateWebhookBody.duplicate, "An identical webhook should be acknowledged as a duplicate");

const dashboard = await request("/api/dashboard");
assert(dashboard.cards.dmsReceived >= 4, "Dashboard should reflect persisted inbound messages");
assert(dashboard.cards.resourcesDelivered >= 1, "Dashboard should reflect resource delivery");
assert(dashboard.cards.linksClicked >= 1, "Dashboard should reflect tracked link clicks");

console.log(JSON.stringify({
  ok: true,
  suffix,
  flows: ["keyword_dm", "comment_resource", "tracked_link", "resumable_qualification", "email_capture", "simulator", "signed_webhook_deduplication"],
  dashboard: dashboard.cards,
}, null, 2));
