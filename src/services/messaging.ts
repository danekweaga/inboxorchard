import { unixNow } from "../core/id";
import { getConversationDetail, persistOutboundMessage } from "../data/platform";
import { evaluateMessagingPolicy } from "../policy/messaging";
import { WorkersAIProvider, relevantKnowledge } from "../providers/ai";
import { InstagramChannel } from "../providers/instagram";
import { buildRuntime } from "../runtime";
import type { Env } from "../types";

export async function sendManualReply(
  env: Env,
  input: { conversationId: string; text: string; idempotencyKey: string },
): Promise<{ externalMessageId: string; simulated: boolean }> {
  const detail = await getConversationDetail(env.DB, input.conversationId);
  if (!detail) throw new Error("Conversation not found");
  const decision = evaluateMessagingPolicy({
    action: "manual_human_reply",
    now: unixNow(),
    lastInboundAt: detail.conversation.last_inbound_at,
  });
  if (!decision.allowed) throw new Error(decision.reason);
  const mock = env.MOCK_MODE === "true";
  const runtime = mock ? null : await buildRuntime(env);
  if (!runtime && !mock) throw new Error("Instagram is not connected");
  let externalMessageId = `mock_${crypto.randomUUID()}`;
  if (runtime) {
    const recipientId = detail.contact.instagram_user_id;
    if (!recipientId) throw new Error("Contact has no Instagram identity");
    const result = await new InstagramChannel(env.DB, runtime.client).sendText(recipientId, input.text, {
      idempotencyKey: `manual:${input.idempotencyKey}`,
      conversationId: input.conversationId,
      contactId: detail.contact.id,
    });
    externalMessageId = result.externalMessageId ?? externalMessageId;
  }
  await persistOutboundMessage(env.DB, {
    conversationId: input.conversationId,
    contactId: detail.contact.id,
    externalMessageId,
    text: input.text,
    status: runtime ? "sent" : "simulated",
  });
  return { externalMessageId, simulated: !runtime };
}

export async function suggestReply(env: Env, conversationId: string): Promise<string> {
  const detail = await getConversationDetail(env.DB, conversationId);
  if (!detail) throw new Error("Conversation not found");
  const inbound = [...detail.messages].reverse().find((message) => message.direction === "inbound" && message.text);
  if (!inbound?.text) throw new Error("No inbound text is available");
  const agent = await env.DB.prepare("SELECT * FROM ai_agents ORDER BY created_at LIMIT 1").first<{
    id: string;
    identity_text: string;
    tone_text: string;
    rules_text: string;
  }>();
  if (!agent) throw new Error("Configure the AI agent first");
  const knowledge = await relevantKnowledge(env.DB, agent.id, inbound.text);
  return new WorkersAIProvider(env).generateReply({
    message: inbound.text,
    identity: agent.identity_text,
    tone: agent.tone_text,
    rules: agent.rules_text,
    knowledge,
  });
}
