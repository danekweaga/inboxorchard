import { z } from "zod";

export const triggerTypes = [
  "instagram_dm",
  "keyword",
  "ai_intent",
  "instagram_comment",
  "story_reply",
  "story_mention",
  "webhook",
  "scheduled",
  "tag_added",
  "tag_removed",
  "field_changed",
  "manual",
  "sequence",
] as const;

export const nodeTypes = [
  "send_text",
  "send_buttons",
  "send_image",
  "send_resource",
  "public_comment_reply",
  "ask_question",
  "add_tag",
  "remove_tag",
  "update_field",
  "send_email",
  "ai_reply",
  "call_webhook",
  "append_google_sheet",
  "start_automation",
  "subscribe_sequence",
  "unsubscribe_sequence",
  "notify_owner",
  "delay",
  "wait_until",
  "wait_for_response",
  "condition",
  "random_split",
  "goal_reached",
  "end",
] as const;

export type TriggerType = (typeof triggerTypes)[number];
export type AutomationNodeType = (typeof nodeTypes)[number];

export const textMatchSchema = z.object({
  mode: z.enum(["exact", "contains", "contains_any", "contains_all", "starts_with", "regex"]).default("contains_any"),
  include: z.array(z.string().trim().min(1)).default([]),
  exclude: z.array(z.string().trim().min(1)).default([]),
  caseSensitive: z.boolean().default(false),
});

export const automationTriggerSchema = z.object({
  type: z.enum(triggerTypes),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const automationNodeSchema = z.object({
  id: z.string().trim().min(1).max(120),
  type: z.enum(nodeTypes),
  label: z.string().trim().min(1).max(160),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const automationEdgeSchema = z.object({
  id: z.string().trim().min(1).max(160),
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  sourceHandle: z.string().optional(),
  label: z.string().max(120).optional(),
});

export const automationDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).default(""),
  trigger: automationTriggerSchema,
  startNodeId: z.string().trim().min(1),
  nodes: z.array(automationNodeSchema).min(1).max(200),
  edges: z.array(automationEdgeSchema).max(400),
  settings: z.object({
    stopOtherAutomations: z.boolean().default(true),
    priority: z.number().int().min(0).max(1000).default(100),
  }).default({ stopOtherAutomations: true, priority: 100 }),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationNode = z.infer<typeof automationNodeSchema>;
export type AutomationEdge = z.infer<typeof automationEdgeSchema>;

export function starterDefinition(name = "Untitled automation"): AutomationDefinition {
  return {
    schemaVersion: 1,
    name,
    description: "",
    trigger: { type: "instagram_dm", config: { match: { mode: "contains_any", include: ["GUIDE"], exclude: [], caseSensitive: false } } },
    startNodeId: "send_welcome",
    nodes: [
      { id: "send_welcome", type: "send_text", label: "Send welcome", position: { x: 80, y: 120 }, config: { text: "Got you — here’s the guide." } },
      { id: "end", type: "end", label: "End", position: { x: 380, y: 120 }, config: {} },
    ],
    edges: [{ id: "edge_welcome_end", source: "send_welcome", target: "end" }],
    settings: { stopOtherAutomations: true, priority: 100 },
  };
}
