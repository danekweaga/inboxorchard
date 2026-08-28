import { validateWorkflow, type WorkflowValidation } from "../automation/validator";
import type { Env } from "../types";
import { incrementUsage } from "../data/platform";

export interface IntentResult {
  intent: string | null;
  confidence: number;
  available: boolean;
  reason?: string;
}

export interface AIProvider {
  classifyIntent(text: string, intents: Array<{ name: string; examples: string[] }>): Promise<IntentResult>;
  generateReply(input: { message: string; identity: string; tone: string; rules: string; knowledge: string[] }): Promise<string>;
  generateAutomation(prompt: string): Promise<WorkflowValidation>;
}

interface WorkersAI {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function responseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["response", "result", "text", "generated_text"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  throw new Error("AI provider returned an unsupported response shape");
}

function jsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

export class WorkersAIProvider implements AIProvider {
  private readonly model: string;

  constructor(private readonly env: Env) {
    this.model = env.AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  }

  private async run(prompt: string): Promise<string> {
    if (!this.env.AI) throw new Error("Workers AI is not configured");
    const result = await (this.env.AI as unknown as WorkersAI).run(this.model, {
      messages: [
        { role: "system", content: "Return concise, safe output. Never invent product capabilities or resources." },
        { role: "user", content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });
    await incrementUsage(this.env.DB, "ai_requests", 1);
    return responseText(result).trim();
  }

  async classifyIntent(text: string, intents: Array<{ name: string; examples: string[] }>): Promise<IntentResult> {
    try {
      const output = await this.run(
        `Classify the message into one intent or null. Return JSON only: {"intent":string|null,"confidence":number}.\n` +
        `Intents: ${JSON.stringify(intents)}\nMessage: ${JSON.stringify(text)}`,
      );
      const parsed = jsonFromText(output) as { intent?: unknown; confidence?: unknown };
      const intent = typeof parsed.intent === "string" && intents.some((item) => item.name === parsed.intent) ? parsed.intent : null;
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      return { intent, confidence, available: true };
    } catch (error) {
      return { intent: null, confidence: 0, available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async generateReply(input: { message: string; identity: string; tone: string; rules: string; knowledge: string[] }): Promise<string> {
    return this.run(
      `Draft one Instagram DM reply. Do not add commentary.\nIdentity: ${input.identity}\nTone: ${input.tone}\n` +
      `Rules: ${input.rules}\nRelevant knowledge: ${input.knowledge.join("\n---\n") || "No matching knowledge."}\n` +
      `Inbound message: ${input.message}`,
    );
  }

  async generateAutomation(prompt: string): Promise<WorkflowValidation> {
    try {
      const output = await this.run(
        `Create an Inbox Orchard automation JSON object using schemaVersion 1. Use only these node types:\n` +
        `send_text, send_buttons, send_image, send_resource, public_comment_reply, ask_question, add_tag, remove_tag, ` +
        `update_field, send_email, ai_reply, call_webhook, append_google_sheet, start_automation, subscribe_sequence, ` +
        `unsubscribe_sequence, notify_owner, delay, wait_until, wait_for_response, condition, random_split, goal_reached, end.\n` +
        `Triggers: instagram_dm, keyword, ai_intent, instagram_comment, story_reply, story_mention, webhook, scheduled, tag_added, tag_removed, field_changed, manual, sequence.\n` +
        `Return JSON only. Include schemaVersion, name, description, trigger, startNodeId, nodes with id/type/label/position/config, edges, and settings.\n` +
        `Request: ${prompt}`,
      );
      return validateWorkflow(jsonFromText(output));
    } catch (error) {
      return { valid: false, issues: [{ level: "error", code: "ai_generation_failed", message: error instanceof Error ? error.message : String(error) }] };
    }
  }
}

export async function relevantKnowledge(db: D1Database, agentId: string, query: string, limit = 5): Promise<string[]> {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3))].slice(0, 5);
  if (terms.length === 0) return [];
  const clauses = terms.map(() => "LOWER(search_text) LIKE ?").join(" OR ");
  const rows = await db.prepare(
    `SELECT content FROM ai_knowledge_sources WHERE agent_id = ? AND enabled = 1 AND (${clauses}) LIMIT ?`,
  ).bind(agentId, ...terms.map((term) => `%${term}%`), Math.max(1, Math.min(10, limit))).all<{ content: string }>();
  return (rows.results ?? []).map((row) => row.content);
}
