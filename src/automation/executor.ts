import { id, unixNow } from "../core/id";
import { activeGoogleAccessToken } from "../auth/google";
import type { ContactRecord, ConversationRecord } from "../data/platform";
import { persistOutboundMessage } from "../data/platform";
import { queueEmail } from "../email/queue";
import { matchesTextTrigger, type TextMatchConfig } from "../engine/match";
import { appendGoogleSheetRow } from "../integrations/google-sheets";
import { callExternalHttp } from "../integrations/http";
import { evaluateMessagingPolicy } from "../policy/messaging";
import { WorkersAIProvider, relevantKnowledge } from "../providers/ai";
import { InstagramChannel } from "../providers/instagram";
import { buildRuntime } from "../runtime";
import { enqueueJob } from "../queue/jobs";
import type { Env } from "../types";
import type { AutomationDefinition, AutomationEdge, AutomationNode, TriggerType } from "./schema";
import { publishedDefinitions } from "./repository";

export interface AutomationTriggerContext {
  type: TriggerType;
  eventId: string;
  contactId?: string;
  conversationId?: string;
  instagramUserId?: string;
  text?: string;
  commentId?: string;
  mediaId?: string;
  timestamp?: number;
  automationId?: string;
  variables?: Record<string, unknown>;
}

interface RunRow {
  id: string;
  automation_id: string;
  version_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status: string;
  current_node_id: string | null;
  context_json: string;
  retry_count: number;
}

interface PreviousRunRow {
  status: string;
  started_at: number;
  updated_at: number;
}

export function shouldAllowReentry(
  policy: "once" | "after_24h" | "every_time",
  previous: PreviousRunRow | null,
  now: number,
): boolean {
  if (!previous) return true;
  if (previous.status === "running" || previous.status === "waiting") return false;
  if (previous.status === "failed") return now - previous.updated_at >= 300;
  if (policy === "every_time") return true;
  if (policy === "after_24h") return now - previous.started_at >= 86400;
  return false;
}

interface ExecutionContext extends AutomationTriggerContext {
  variables: Record<string, unknown>;
  privateReplyUsed?: boolean;
  depth?: number;
}

export class AutomationExecutor {
  constructor(private readonly env: Env) {}

  async handleTrigger(trigger: AutomationTriggerContext): Promise<string[]> {
    if (["instagram_dm", "story_reply", "story_mention"].includes(trigger.type) && trigger.conversationId) {
      const resumed = await this.resumeFromInbound(trigger);
      if (resumed) return [resumed];
    }
    const candidateTypes: TriggerType[] = trigger.type === "instagram_dm"
      ? ["instagram_dm", "keyword", "ai_intent"]
      : trigger.type === "story_reply" || trigger.type === "story_mention"
        ? [trigger.type, "instagram_dm", "keyword", "ai_intent"]
        : [trigger.type];
    const candidates = (await Promise.all(candidateTypes.map((type) => publishedDefinitions(this.env.DB, type))))
      .flat()
      .sort((left, right) => left.automation.priority - right.automation.priority || left.automation.created_at - right.automation.created_at);
    const aiCandidates = candidates.filter((candidate) => candidate.definition.trigger.type === "ai_intent");
    let matchedAiIntent: string | null = null;
    if (aiCandidates.length && trigger.text) {
      const intents = aiCandidates.map((candidate) => ({
        name: String(candidate.definition.trigger.config.intent ?? candidate.automation.name),
        examples: Array.isArray(candidate.definition.trigger.config.examples)
          ? candidate.definition.trigger.config.examples.filter((item): item is string => typeof item === "string")
          : [],
      }));
      const classified = await new WorkersAIProvider(this.env).classifyIntent(trigger.text, intents);
      if (classified.available) {
        const matched = aiCandidates.find((candidate) => {
          const name = String(candidate.definition.trigger.config.intent ?? candidate.automation.name);
          const threshold = Number(candidate.definition.trigger.config.confidence ?? 0.75);
          return classified.intent === name && classified.confidence >= threshold;
        });
        matchedAiIntent = matched?.automation.id ?? null;
      }
    }
    const started: string[] = [];
    for (const candidate of candidates) {
      if (trigger.automationId && candidate.automation.id !== trigger.automationId) continue;
      if (candidate.definition.trigger.type === "ai_intent" && candidate.automation.id !== matchedAiIntent) continue;
      if (!triggerMatches(candidate.definition, trigger)) continue;
      const effectiveTrigger = candidate.definition.trigger.type === trigger.type
        ? trigger
        : { ...trigger, type: candidate.definition.trigger.type };
      const runId = await this.startRun(candidate.automation.id, candidate.version.id, candidate.definition, effectiveTrigger);
      if (!runId) continue;
      started.push(runId);
      if (candidate.definition.settings.stopOtherAutomations) break;
    }
    return started;
  }

  private async startRun(
    automationId: string,
    versionId: string,
    definition: AutomationDefinition,
    trigger: AutomationTriggerContext,
  ): Promise<string | null> {
    const runId = id("run");
    const timestamp = unixNow();
    if (trigger.contactId && trigger.type !== "manual") {
      const previous = await this.env.DB.prepare(
        `SELECT status, started_at, updated_at FROM automation_runs
         WHERE automation_id = ? AND contact_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      ).bind(automationId, trigger.contactId).first<PreviousRunRow>();
      if (!shouldAllowReentry(definition.settings.reentry ?? "once", previous ?? null, timestamp)) return null;
    }
    if (trigger.conversationId && definition.settings.stopOtherAutomations) {
      const lock = await this.env.DB.prepare(
        `UPDATE conversations_v2 SET automation_lock_run_id = ?
         WHERE id = ? AND automation_lock_run_id IS NULL`,
      ).bind(runId, trigger.conversationId).run();
      if ((lock.meta.changes ?? 0) === 0) return null;
    }
    const inheritedDepth = typeof trigger.variables?.depth === "number" ? trigger.variables.depth : 0;
    const context: ExecutionContext = { ...trigger, variables: trigger.variables ?? {}, depth: inheritedDepth };
    const insert = await this.env.DB.prepare(
      `INSERT OR IGNORE INTO automation_runs
        (id, automation_id, version_id, contact_id, conversation_id, trigger_type, trigger_event_id,
         status, current_node_id, context_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).bind(
      runId, automationId, versionId, trigger.contactId ?? null, trigger.conversationId ?? null,
      trigger.type, trigger.eventId, definition.startNodeId, JSON.stringify(context), timestamp, timestamp,
    ).run();
    if ((insert.meta.changes ?? 0) === 0) {
      if (trigger.conversationId) {
        await this.env.DB.prepare("UPDATE conversations_v2 SET automation_lock_run_id = NULL WHERE id = ? AND automation_lock_run_id = ?")
          .bind(trigger.conversationId, runId).run();
      }
      return null;
    }
    await this.execute(runId, definition);
    return runId;
  }

  async execute(runId: string, suppliedDefinition?: AutomationDefinition): Promise<void> {
    const run = await this.env.DB.prepare("SELECT * FROM automation_runs WHERE id = ?").bind(runId).first<RunRow>();
    if (!run || run.status !== "running") return;
    const definition = suppliedDefinition ?? await this.definitionForRun(run);
    const context = JSON.parse(run.context_json) as ExecutionContext;
    let currentNodeId: string | undefined = run.current_node_id ?? definition.startNodeId;
    let steps = 0;
    try {
      while (currentNodeId && steps++ < 200) {
        const node = definition.nodes.find((item) => item.id === currentNodeId);
        if (!node) throw new Error(`Automation node not found: ${currentNodeId}`);
        const stepId = id("step");
        const startedAt = unixNow();
        await this.env.DB.prepare(
          `INSERT INTO automation_run_steps
            (id, run_id, node_id, node_type, status, input_json, attempt_count, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, 1, ?)`,
        ).bind(stepId, runId, node.id, node.type, JSON.stringify(safeStepInput(node, context)), startedAt).run();

        const result = await this.executeNode(run, definition, node, context);
        await this.env.DB.prepare(
          `UPDATE automation_run_steps SET status = ?, output_json = ?, completed_at = ? WHERE id = ?`,
        ).bind(result.waiting ? "waiting" : "completed", JSON.stringify(result.output ?? {}), unixNow(), stepId).run();
        await this.persistContext(runId, node.id, context);
        if (result.waiting) return;
        if (result.completed || node.type === "end") {
          await this.completeRun(runId, run.conversation_id);
          return;
        }
        currentNodeId = result.nextNodeId ?? chooseNext(definition, node, context);
        await this.env.DB.prepare("UPDATE automation_runs SET current_node_id = ?, updated_at = ? WHERE id = ?")
          .bind(currentNodeId ?? null, unixNow(), runId).run();
      }
      if (steps >= 200) throw new Error("Automation step limit reached");
      await this.completeRun(runId, run.conversation_id);
    } catch (error) {
      await this.failRun(runId, run.conversation_id, error);
      throw error;
    }
  }

  private async executeNode(
    run: RunRow,
    definition: AutomationDefinition,
    node: AutomationNode,
    context: ExecutionContext,
  ): Promise<{ waiting?: boolean; completed?: boolean; nextNodeId?: string; output?: unknown }> {
    switch (node.type) {
      case "send_text":
        return { output: await this.sendMessage(run, context, render(String(node.config.text ?? ""), context), {}, node.id) };
      case "send_buttons": {
        const buttons: Array<{ type: "postback" | "web_url"; title: string; payload?: string; url?: string }> = [];
        if (Array.isArray(node.config.buttons)) {
          for (const item of node.config.buttons) {
            if (!item || typeof item !== "object") continue;
            const button = item as Record<string, unknown>;
            const title = typeof button.title === "string" ? button.title : "Continue";
            if (typeof button.payload === "string") buttons.push({ type: "postback", title, payload: button.payload });
            else if (typeof button.url === "string") buttons.push({ type: "web_url", title, url: button.url });
            else buttons.push({ type: "postback", title, payload: `NODE_${node.id}` });
          }
        }
        const followWaitId = chooseNext(definition, node, context);
        const followWait = definition.nodes.find((item) => item.id === followWaitId);
        const isFollowPrompt = buttons.some((button) => button.payload === "FOLLOW_CONFIRMED")
          && followWait?.type === "wait_for_response"
          && followWait.config.field === "follow_confirmed";
        if (isFollowPrompt && context.instagramUserId && this.env.MOCK_MODE !== "true") {
          try {
            const runtime = await buildRuntime(this.env);
            const profile = runtime ? await runtime.client.getUserProfile(context.instagramUserId) : null;
            if (profile?.is_user_follow_business === true) {
              context.variables.follow_confirmed = true;
              return {
                nextNodeId: chooseNext(definition, followWait, context),
                output: { skipped: true, reason: "already_following" },
              };
            }
          } catch (error) {
            console.warn(`[inbox-orchard] follower lookup unavailable; showing confirmation prompt: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return { output: await this.sendMessage(run, context, render(String(node.config.text ?? ""), context), { buttons }, node.id) };
      }
      case "send_image":
        return { output: await this.sendMessage(run, context, "", { imageUrl: render(String(node.config.url ?? ""), context) }, node.id) };
      case "send_resource":
        return { output: await this.sendResource(run, context, String(node.config.resourceId ?? ""), node.id) };
      case "public_comment_reply": {
        if (!context.commentId) throw new Error("Public comment reply has no comment context");
        const mock = this.env.MOCK_MODE === "true";
        const runtime = mock ? null : await buildRuntime(this.env);
        if (!runtime && !mock) throw new Error("Instagram is not connected");
        const replies = Array.isArray(node.config.replies)
          ? node.config.replies.filter((reply): reply is string => typeof reply === "string" && reply.trim().length > 0)
          : [];
        const replyTemplate = replies.length ? replies[stableVariantIndex(context.eventId, replies.length)]! : String(node.config.text ?? "");
        const text = render(replyTemplate, context);
        if (runtime) {
          const channel = new InstagramChannel(this.env.DB, runtime.client);
          await channel.replyToComment(context.commentId, text, { idempotencyKey: `run:${run.id}:node:${node.id}` });
        }
        return { output: { simulated: !runtime, text } };
      }
      case "ask_question": {
        const text = render(String(node.config.text ?? ""), context);
        await this.sendMessage(run, context, text, {}, node.id);
        await this.pauseForResponse(run, node, context);
        return { waiting: true, output: { waitType: "response" } };
      }
      case "wait_for_response":
        await this.pauseForResponse(run, node, context);
        return { waiting: true, output: { waitType: "response" } };
      case "delay": {
        const seconds = Number(node.config.seconds);
        const waitId = id("wait");
        const resumeAfter = unixNow() + seconds;
        await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO automation_wait_states (id, run_id, node_id, wait_type, resume_after, created_at)
             VALUES (?, ?, ?, 'delay', ?, ?)`,
          ).bind(waitId, run.id, node.id, resumeAfter, unixNow()),
          this.env.DB.prepare("UPDATE automation_runs SET status = 'waiting', current_node_id = ?, updated_at = ? WHERE id = ?")
            .bind(node.id, unixNow(), run.id),
        ]);
        await enqueueJob(this.env, "automation_resume", { runId: run.id }, { delaySeconds: seconds, priority: 50 });
        return { waiting: true, output: { resumeAfter } };
      }
      case "wait_until": {
        const resumeAfter = Number(node.config.timestamp);
        if (!Number.isFinite(resumeAfter) || resumeAfter <= unixNow()) return {};
        const seconds = Math.min(86400, resumeAfter - unixNow());
        await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO automation_wait_states (id, run_id, node_id, wait_type, resume_after, created_at)
             VALUES (?, ?, ?, 'until', ?, ?)`,
          ).bind(id("wait"), run.id, node.id, resumeAfter, unixNow()),
          this.env.DB.prepare("UPDATE automation_runs SET status = 'waiting', current_node_id = ?, updated_at = ? WHERE id = ?")
            .bind(node.id, unixNow(), run.id),
        ]);
        await enqueueJob(this.env, "automation_resume", { runId: run.id }, { delaySeconds: seconds, priority: 50 });
        return { waiting: true, output: { resumeAfter } };
      }
      case "add_tag":
        await this.addTag(run, String(node.config.tagId ?? ""));
        return {};
      case "remove_tag":
        if (run.contact_id) await this.env.DB.prepare("DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?")
          .bind(run.contact_id, String(node.config.tagId ?? "")).run();
        return {};
      case "update_field":
        await this.updateField(run, node, context);
        return {};
      case "send_email": {
        if (!run.contact_id) throw new Error("Email action requires a contact");
        const contact = await this.contact(run.contact_id);
        const recipient = render(String(node.config.recipient ?? contact.email ?? ""), context);
        if (!recipient) throw new Error("Contact has no email address");
        const queueId = await queueEmail(this.env.DB, {
          senderId: typeof node.config.senderId === "string" ? node.config.senderId : undefined,
          recipient,
          templateId: String(node.config.templateId ?? ""),
          variables: { ...context.variables, instagram_username: contact.username, first_name: contact.display_name },
        });
        await enqueueJob(this.env, "email_send", { queueId }, { priority: 70 });
        return { output: { queueId } };
      }
      case "ai_reply": {
        const agent = await this.env.DB.prepare("SELECT * FROM ai_agents ORDER BY created_at LIMIT 1").first<Record<string, unknown>>();
        if (!agent) throw new Error("AI agent is not configured");
        const knowledge = await relevantKnowledge(this.env.DB, String(agent.id), context.text ?? "");
        const reply = await new WorkersAIProvider(this.env).generateReply({
          message: context.text ?? "",
          identity: String(agent.identity_text ?? ""), tone: String(agent.tone_text ?? ""),
          rules: String(agent.rules_text ?? ""), knowledge,
        });
        return { output: await this.sendMessage(run, context, reply, {}, node.id) };
      }
      case "call_webhook": {
        const output = await callExternalHttp({
          url: render(String(node.config.url ?? ""), context),
          method: typeof node.config.method === "string" ? node.config.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" : "POST",
          body: { ...context.variables, contactId: run.contact_id, conversationId: run.conversation_id },
        });
        return { output: { status: output.status } };
      }
      case "append_google_sheet":
        await this.appendSheet(node, context);
        return {};
      case "subscribe_sequence":
        await this.subscribeSequence(run, String(node.config.sequenceId ?? ""));
        return {};
      case "unsubscribe_sequence":
        if (run.contact_id) await this.env.DB.prepare(
          "UPDATE sequence_subscriptions SET status = 'unsubscribed', updated_at = ? WHERE contact_id = ? AND sequence_id = ?",
        ).bind(unixNow(), run.contact_id, String(node.config.sequenceId ?? "")).run();
        return {};
      case "notify_owner":
        await this.env.DB.prepare(
          `INSERT INTO audit_logs (id, action, entity_type, entity_id, safe_metadata_json, created_at)
           VALUES (?, 'owner_notification', 'automation_run', ?, ?, ?)`,
        ).bind(id("audit"), run.id, JSON.stringify({ text: render(String(node.config.text ?? ""), context) }), unixNow()).run();
        return {};
      case "start_automation": {
        const targetId = String(node.config.automationId ?? "");
        const depth = context.depth ?? 0;
        if (depth >= 5) throw new Error("Automation recursion limit reached");
        await this.handleTrigger({ ...context, type: "manual", eventId: `${run.id}:${node.id}`, automationId: targetId, variables: { ...context.variables, depth: depth + 1 } });
        return {};
      }
      case "goal_reached":
        if (run.contact_id) await this.env.DB.prepare(
          `INSERT INTO conversion_events (id, contact_id, automation_id, source_content_id, type, value_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id("conv"), run.contact_id, run.automation_id, context.mediaId ?? null, String(node.config.goal ?? "goal"), JSON.stringify(context.variables), unixNow()).run();
        return {};
      case "condition":
      case "random_split":
        return { nextNodeId: chooseNext(definition, node, context) };
      case "end":
        return { completed: true };
    }
  }

  async resumeDelayed(runId: string): Promise<void> {
    const run = await this.env.DB.prepare("SELECT * FROM automation_runs WHERE id = ?").bind(runId).first<RunRow>();
    if (!run || run.status !== "waiting") return;
    const wait = await this.env.DB.prepare(
      "SELECT id, node_id, resume_after FROM automation_wait_states WHERE run_id = ? AND resumed_at IS NULL",
    ).bind(runId).first<{ id: string; node_id: string; resume_after: number | null }>();
    if (!wait || (wait.resume_after ?? 0) > unixNow()) return;
    const definition = await this.definitionForRun(run);
    const node = definition.nodes.find((item) => item.id === wait.node_id);
    if (!node) throw new Error("Waiting node no longer exists in immutable version");
    const context = JSON.parse(run.context_json) as ExecutionContext;
    const next = chooseNext(definition, node, context);
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE automation_wait_states SET resumed_at = ? WHERE id = ?").bind(unixNow(), wait.id),
      this.env.DB.prepare("UPDATE automation_runs SET status = 'running', current_node_id = ?, updated_at = ? WHERE id = ?")
        .bind(next ?? null, unixNow(), runId),
    ]);
    await this.execute(runId, definition);
  }

  private async resumeFromInbound(trigger: AutomationTriggerContext): Promise<string | null> {
    const row = await this.env.DB.prepare(
      `SELECT r.* FROM automation_runs r JOIN automation_wait_states w ON w.run_id = r.id
       WHERE r.conversation_id = ? AND r.status = 'waiting' AND w.resumed_at IS NULL AND w.wait_type = 'response'
       ORDER BY r.started_at ASC LIMIT 1`,
    ).bind(trigger.conversationId).first<RunRow>();
    if (!row) return null;
    const definition = await this.definitionForRun(row);
    const wait = await this.env.DB.prepare("SELECT id, node_id, expected_json FROM automation_wait_states WHERE run_id = ? AND resumed_at IS NULL")
      .bind(row.id).first<{ id: string; node_id: string; expected_json: string | null }>();
    if (!wait) return null;
    const node = definition.nodes.find((item) => item.id === wait.node_id);
    if (!node) throw new Error("Waiting node no longer exists in immutable version");
    const context = JSON.parse(row.context_json) as ExecutionContext;
    const field = typeof node.config.field === "string" ? node.config.field : `response_${node.id}`;
    if (field.toLowerCase() === "email") {
      const value = (trigger.text ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
      if (row.contact_id) await this.env.DB.prepare("UPDATE contacts SET email = ?, updated_at = ? WHERE id = ?")
        .bind(value, unixNow(), row.contact_id).run();
    }
    context.variables[field] = trigger.text ?? "";
    context.text = trigger.text;
    const next = chooseNext(definition, node, context);
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE automation_wait_states SET resumed_at = ? WHERE id = ?").bind(unixNow(), wait.id),
      this.env.DB.prepare(
        `UPDATE automation_runs SET status = 'running', current_node_id = ?, context_json = ?, updated_at = ? WHERE id = ?`,
      ).bind(next ?? null, JSON.stringify(context), unixNow(), row.id),
    ]);
    await this.execute(row.id, definition);
    return row.id;
  }

  private async pauseForResponse(run: RunRow, node: AutomationNode, context: ExecutionContext): Promise<void> {
    const timeoutSeconds = typeof node.config.timeoutSeconds === "number" ? Math.max(60, Math.min(30 * 86400, node.config.timeoutSeconds)) : 7 * 86400;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO automation_wait_states (id, run_id, node_id, wait_type, expected_json, expires_at, created_at)
         VALUES (?, ?, ?, 'response', ?, ?, ?)`,
      ).bind(id("wait"), run.id, node.id, JSON.stringify({ field: node.config.field ?? null }), unixNow() + timeoutSeconds, unixNow()),
      this.env.DB.prepare("UPDATE automation_runs SET status = 'waiting', current_node_id = ?, context_json = ?, updated_at = ? WHERE id = ?")
        .bind(node.id, JSON.stringify(context), unixNow(), run.id),
    ]);
  }

  private async sendMessage(
    run: RunRow,
    context: ExecutionContext,
    text: string,
    options: { buttons?: Array<{ type: "postback" | "web_url"; title: string; payload?: string; url?: string }>; imageUrl?: string } = {},
    nodeId = "manual",
  ): Promise<unknown> {
    if (!run.contact_id || !run.conversation_id || !context.instagramUserId) throw new Error("Message action requires an Instagram conversation");
    const conversation = await this.conversation(run.conversation_id);
    const mock = this.env.MOCK_MODE === "true";
    const runtime = mock ? null : await buildRuntime(this.env);
    if (!runtime && !mock) throw new Error("Instagram is not connected");
    let externalMessageId = `mock_${crypto.randomUUID()}`;
    if (runtime) {
      const channel = new InstagramChannel(this.env.DB, runtime.client);
      const idempotencyKey = `run:${run.id}:node:${nodeId}`;
      if (context.commentId && !context.privateReplyUsed) {
        const decision = evaluateMessagingPolicy({ action: "comment_private_reply", now: unixNow(), commentCreatedAt: context.timestamp });
        if (!decision.allowed) throw new Error(decision.reason);
        const result = await channel.sendPrivateCommentReply(context.commentId, text, options.buttons, { idempotencyKey });
        externalMessageId = result.externalMessageId ?? externalMessageId;
        context.privateReplyUsed = true;
      } else {
        const decision = evaluateMessagingPolicy({ action: "standard_message", now: unixNow(), lastInboundAt: conversation.last_inbound_at });
        if (!decision.allowed) throw new Error(decision.reason);
        const result = options.imageUrl
          ? await channel.sendImage(context.instagramUserId, options.imageUrl, { idempotencyKey })
          : options.buttons?.length
            ? await channel.sendButtons(context.instagramUserId, text, options.buttons, { idempotencyKey })
            : await channel.sendText(context.instagramUserId, text, { idempotencyKey });
        externalMessageId = result.externalMessageId ?? externalMessageId;
      }
    }
    await persistOutboundMessage(this.env.DB, {
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      externalMessageId,
      kind: options.imageUrl ? "image" : options.buttons?.length ? "buttons" : "text",
      text: text || options.imageUrl,
      payload: options,
      status: mock && !runtime ? "simulated" : "sent",
    });
    return { externalMessageId, simulated: mock && !runtime };
  }

  private async sendResource(run: RunRow, context: ExecutionContext, resourceId: string, nodeId: string): Promise<unknown> {
    const resource = await this.env.DB.prepare("SELECT * FROM resources WHERE id = ? AND active = 1")
      .bind(resourceId).first<{ id: string; name: string; type: string; target_url: string | null; r2_key: string | null }>();
    if (!resource) throw new Error("Resource not found");
    const base = this.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    const destination = resource.target_url ?? (base ? `${base}/r/${resource.id}` : "");
    if (!destination) throw new Error("PUBLIC_BASE_URL is required to deliver uploaded resources");
    const slug = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
    await this.env.DB.prepare(
      `INSERT INTO tracked_links
        (id, slug, resource_id, destination_url, contact_id, automation_id, source_content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id("link"), slug, resource.id, destination, run.contact_id, run.automation_id, context.mediaId ?? null, unixNow()).run();
    if (run.contact_id) await this.env.DB.prepare(
      `INSERT INTO conversion_events (id, contact_id, automation_id, source_content_id, type, value_json, created_at)
       VALUES (?, ?, ?, ?, 'resource_delivered', ?, ?)`,
    ).bind(id("conv"), run.contact_id, run.automation_id, context.mediaId ?? null, JSON.stringify({ resourceId: resource.id }), unixNow()).run();
    const trackedUrl = base ? `${base}/l/${slug}` : destination;
    return this.sendMessage(run, context, `${resource.name}: ${trackedUrl}`, {}, nodeId);
  }

  private async addTag(run: RunRow, tagId: string): Promise<void> {
    if (!run.contact_id) throw new Error("Tag action requires a contact");
    const tag = await this.env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind(tagId).first<{ name: string }>();
    if (!tag) throw new Error("Tag not found");
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, added_at) VALUES (?, ?, ?)")
        .bind(run.contact_id, tagId, unixNow()),
      this.env.DB.prepare(
        `INSERT INTO timeline_events (id, contact_id, conversation_id, type, summary, metadata_json, created_at)
         VALUES (?, ?, ?, 'tag_added', ?, ?, ?)`,
      ).bind(id("time"), run.contact_id, run.conversation_id, `Tag added: ${tag.name}`, JSON.stringify({ tagId }), unixNow()),
    ]);
  }

  private async updateField(run: RunRow, node: AutomationNode, context: ExecutionContext): Promise<void> {
    if (!run.contact_id) throw new Error("Field action requires a contact");
    const fieldId = String(node.config.fieldId ?? "");
    const value = node.config.valueFrom
      ? context.variables[String(node.config.valueFrom)]
      : node.config.value;
    await this.env.DB.prepare(
      `INSERT INTO contact_field_values (contact_id, field_id, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(contact_id, field_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).bind(run.contact_id, fieldId, JSON.stringify(value ?? null), unixNow()).run();
  }

  private async appendSheet(node: AutomationNode, context: ExecutionContext): Promise<void> {
    const connectionId = String(node.config.connectionId ?? "");
    const connection = await this.env.DB.prepare(
      "SELECT credentials_ciphertext, config_json FROM integration_connections WHERE id = ? AND provider = 'google_sheets' AND status = 'connected'",
    ).bind(connectionId).first<{ credentials_ciphertext: string | null; config_json: string }>();
    if (!connection?.credentials_ciphertext) throw new Error("Google Sheets connection is unavailable");
    const config = JSON.parse(connection.config_json) as { spreadsheetId?: string; range?: string };
    if (!config.spreadsheetId) throw new Error("Google Sheets connection is incomplete");
    const accessToken = await activeGoogleAccessToken(this.env, connection.credentials_ciphertext, async (ciphertext) => {
      await this.env.DB.prepare("UPDATE integration_connections SET credentials_ciphertext = ?, updated_at = ? WHERE id = ?")
        .bind(ciphertext, unixNow(), connectionId).run();
    });
    const values = Array.isArray(node.config.values)
      ? node.config.values.map((value) => render(String(value), context))
      : Object.values(context.variables);
    await appendGoogleSheetRow({ accessToken, spreadsheetId: config.spreadsheetId, range: config.range ?? "Sheet1!A:Z", values });
  }

  private async subscribeSequence(run: RunRow, sequenceId: string): Promise<void> {
    if (!run.contact_id) throw new Error("Sequence action requires a contact");
    const timestamp = unixNow();
    await this.env.DB.prepare(
      `INSERT INTO sequence_subscriptions
        (id, sequence_id, contact_id, status, next_step_position, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?)
       ON CONFLICT(sequence_id, contact_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
    ).bind(id("sub"), sequenceId, run.contact_id, timestamp, timestamp, timestamp).run();
  }

  private async definitionForRun(run: RunRow): Promise<AutomationDefinition> {
    const version = await this.env.DB.prepare("SELECT definition_json FROM automation_versions WHERE id = ?")
      .bind(run.version_id).first<{ definition_json: string }>();
    if (!version) throw new Error("Immutable automation version not found");
    return JSON.parse(version.definition_json) as AutomationDefinition;
  }

  private async contact(contactId: string): Promise<ContactRecord> {
    const row = await this.env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<ContactRecord>();
    if (!row) throw new Error("Contact not found");
    return row;
  }

  private async conversation(conversationId: string): Promise<ConversationRecord> {
    const row = await this.env.DB.prepare("SELECT * FROM conversations_v2 WHERE id = ?").bind(conversationId).first<ConversationRecord>();
    if (!row) throw new Error("Conversation not found");
    return row;
  }

  private async persistContext(runId: string, nodeId: string, context: ExecutionContext): Promise<void> {
    await this.env.DB.prepare("UPDATE automation_runs SET current_node_id = ?, context_json = ?, updated_at = ? WHERE id = ?")
      .bind(nodeId, JSON.stringify(context), unixNow(), runId).run();
  }

  private async completeRun(runId: string, conversationId: string | null): Promise<void> {
    const timestamp = unixNow();
    const statements = [this.env.DB.prepare(
      "UPDATE automation_runs SET status = 'completed', current_node_id = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(timestamp, timestamp, runId)];
    if (conversationId) statements.push(this.env.DB.prepare(
      "UPDATE conversations_v2 SET automation_lock_run_id = NULL WHERE id = ? AND automation_lock_run_id = ?",
    ).bind(conversationId, runId));
    await this.env.DB.batch(statements);
  }

  private async failRun(runId: string, conversationId: string | null, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const statements = [this.env.DB.prepare(
      "UPDATE automation_runs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
    ).bind(message, unixNow(), runId)];
    if (conversationId) statements.push(this.env.DB.prepare(
      "UPDATE conversations_v2 SET automation_lock_run_id = NULL WHERE id = ? AND automation_lock_run_id = ?",
    ).bind(conversationId, runId));
    await this.env.DB.batch(statements);
  }
}

function stableVariantIndex(seed: string, length: number): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % length;
}

export function triggerMatches(definition: AutomationDefinition, trigger: AutomationTriggerContext): boolean {
  const config = definition.trigger.config;
  if (trigger.type === "manual") return true;
  if (definition.trigger.type === "scheduled") {
    const interval = Math.max(1, Math.floor(Number(config.intervalMinutes) || 1));
    const minute = Math.floor((trigger.timestamp ?? unixNow()) / 60);
    return minute % interval === 0;
  }
  if (definition.trigger.type === "instagram_dm" || definition.trigger.type === "keyword" || definition.trigger.type === "instagram_comment" || definition.trigger.type === "story_reply" || definition.trigger.type === "story_mention") {
    if (definition.trigger.type === "instagram_comment" && Array.isArray(config.mediaIds) && config.mediaIds.length > 0 && !config.mediaIds.includes(trigger.mediaId)) return false;
    if ((definition.trigger.type === "story_reply" || definition.trigger.type === "story_mention") && Array.isArray(config.mediaIds) && config.mediaIds.length > 0 && !config.mediaIds.includes(trigger.mediaId)) return false;
    const match = config.match;
    if (!match || typeof match !== "object") return true;
    const record = match as Record<string, unknown>;
    return matchesTextTrigger(trigger.text ?? "", {
      mode: typeof record.mode === "string" ? record.mode as TextMatchConfig["mode"] : "contains_any",
      include: Array.isArray(record.include) ? record.include.filter((item): item is string => typeof item === "string") : [],
      exclude: Array.isArray(record.exclude) ? record.exclude.filter((item): item is string => typeof item === "string") : [],
      caseSensitive: record.caseSensitive === true,
    });
  }
  return true;
}

function render(template: string, context: ExecutionContext): string {
  const values: Record<string, unknown> = {
    incoming_text: context.text,
    instagram_user_id: context.instagramUserId,
    media_id: context.mediaId,
    ...context.variables,
  };
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => String(values[key] ?? ""));
}

function edgesFor(definition: AutomationDefinition, nodeId: string): AutomationEdge[] {
  return definition.edges.filter((edge) => edge.source === nodeId);
}

function chooseNext(definition: AutomationDefinition, node: AutomationNode, context: ExecutionContext): string | undefined {
  const edges = edgesFor(definition, node.id);
  if (node.type === "condition") {
    const actual = context.variables[String(node.config.field ?? "")];
    const expected = node.config.value;
    const operator = String(node.config.operator ?? "equals");
    const result = compare(actual, expected, operator);
    const handle = result ? "true" : "false";
    return edges.find((edge) => edge.sourceHandle === handle || edge.label?.toLowerCase() === handle)?.target
      ?? edges[result ? 0 : 1]?.target;
  }
  if (node.type === "random_split" && edges.length > 0) {
    let hash = 0;
    for (const char of context.eventId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return edges[hash % edges.length]?.target;
  }
  return edges[0]?.target;
}

function compare(actual: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "not_equals": return String(actual ?? "") !== String(expected ?? "");
    case "contains": return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "greater_than": return Number(actual) > Number(expected);
    case "less_than": return Number(actual) < Number(expected);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    default: return String(actual ?? "") === String(expected ?? "");
  }
}

function safeStepInput(node: AutomationNode, context: ExecutionContext): Record<string, unknown> {
  return { nodeType: node.type, eventId: context.eventId, hasContact: Boolean(context.contactId), configKeys: Object.keys(node.config) };
}
