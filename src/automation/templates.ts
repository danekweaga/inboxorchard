import type { AutomationDefinition, TriggerType } from "./schema";

function linearTemplate(
  name: string,
  description: string,
  triggerType: TriggerType,
  nodes: AutomationDefinition["nodes"],
): AutomationDefinition {
  return {
    schemaVersion: 1,
    name,
    description,
    trigger: {
      type: triggerType,
      config: triggerType === "instagram_comment" || triggerType === "instagram_dm"
        ? { match: { mode: "contains_any", include: ["GUIDE"], exclude: ["SCAM"], caseSensitive: false } }
        : triggerType === "ai_intent"
          ? { intent: "Wants a creator resource", examples: ["Can I get the guide?", "Send me the template you mentioned"], confidence: 0.75 }
        : {},
    },
    startNodeId: nodes[0]?.id ?? "end",
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({ id: `e_${node.id}_${nodes[index + 1]!.id}`, source: node.id, target: nodes[index + 1]!.id })),
    settings: { stopOtherAutomations: true, priority: 100 },
  };
}

const end = (x: number) => ({ id: "end", type: "end" as const, label: "End", position: { x, y: 120 }, config: {} });

export const AUTOMATION_TEMPLATES: Array<{ id: string; category: string; definition: AutomationDefinition }> = [
  {
    id: "comment-to-dm",
    category: "Instagram",
    definition: linearTemplate("Comment → DM", "Reply publicly, then open a private conversation.", "instagram_comment", [
      { id: "public", type: "public_comment_reply", label: "Reply publicly", position: { x: 60, y: 120 }, config: { text: "sent 🤝" } },
      { id: "dm", type: "send_text", label: "Send private reply", position: { x: 340, y: 120 }, config: { text: "gotchu — check this out" } },
      end(620),
    ]),
  },
  {
    id: "comment-resource",
    category: "Resources",
    definition: linearTemplate("Comment → Resource", "Turn a keyword comment into a tracked resource delivery.", "instagram_comment", [
      { id: "public", type: "public_comment_reply", label: "Reply publicly", position: { x: 60, y: 120 }, config: { text: "just sent it 👀" } },
      { id: "resource", type: "send_resource", label: "Send resource", position: { x: 340, y: 120 }, config: { resourceId: "SELECT_RESOURCE" } },
      end(620),
    ]),
  },
  {
    id: "dm-keyword-resource",
    category: "Resources",
    definition: linearTemplate("DM Keyword → Resource", "Deliver a tracked resource when a DM contains a keyword.", "instagram_dm", [
      { id: "resource", type: "send_resource", label: "Send resource", position: { x: 80, y: 120 }, config: { resourceId: "SELECT_RESOURCE" } },
      end(380),
    ]),
  },
  {
    id: "capture-email",
    category: "Lead capture",
    definition: linearTemplate("Capture Email", "Ask for an email, persist the response, and add a subscriber tag.", "instagram_dm", [
      { id: "ask", type: "ask_question", label: "Ask for email", position: { x: 60, y: 120 }, config: { text: "Where should I email the full kit?", field: "email" } },
      { id: "field", type: "update_field", label: "Save email field", position: { x: 340, y: 120 }, config: { fieldId: "SELECT_EMAIL_FIELD", valueFrom: "email" } },
      { id: "tag", type: "add_tag", label: "Tag subscriber", position: { x: 620, y: 120 }, config: { tagId: "SELECT_TAG" } },
      end(900),
    ]),
  },
  {
    id: "lead-qualification",
    category: "Lead capture",
    definition: {
      ...linearTemplate("Lead Qualification", "Ask a qualifying question and branch on the answer.", "instagram_dm", [
        { id: "ask", type: "ask_question", label: "Ask university year", position: { x: 60, y: 160 }, config: { text: "What year are you in?", field: "university_year" } },
        { id: "condition", type: "condition", label: "First or second year?", position: { x: 350, y: 160 }, config: { field: "university_year", operator: "contains", value: "2" } },
        { id: "beginner", type: "send_resource", label: "Send beginner guide", position: { x: 650, y: 60 }, config: { resourceId: "SELECT_BEGINNER_RESOURCE" } },
        { id: "advanced", type: "send_resource", label: "Send internship guide", position: { x: 650, y: 260 }, config: { resourceId: "SELECT_ADVANCED_RESOURCE" } },
        end(940),
      ]),
      edges: [
        { id: "e_ask_condition", source: "ask", target: "condition" },
        { id: "e_true", source: "condition", sourceHandle: "true", target: "beginner", label: "true" },
        { id: "e_false", source: "condition", sourceHandle: "false", target: "advanced", label: "false" },
        { id: "e_beginner_end", source: "beginner", target: "end" },
        { id: "e_advanced_end", source: "advanced", target: "end" },
      ],
    },
  },
  {
    id: "story-reply",
    category: "Instagram",
    definition: linearTemplate("Story Reply", "Respond to an eligible Story reply event.", "story_reply", [
      { id: "thanks", type: "send_text", label: "Send thanks", position: { x: 80, y: 120 }, config: { text: "appreciate you replying 🫡" } },
      end(380),
    ]),
  },
  {
    id: "faq-bot",
    category: "AI",
    definition: linearTemplate("FAQ Bot", "Draft a grounded response from the configured knowledge base.", "instagram_dm", [
      { id: "reply", type: "ai_reply", label: "Grounded AI reply", position: { x: 80, y: 120 }, config: {} },
      end(380),
    ]),
  },
  {
    id: "email-follow-up",
    category: "Email",
    definition: linearTemplate("Email Follow-Up", "Queue a reusable email template after a short delay.", "manual", [
      { id: "delay", type: "delay", label: "Wait one day", position: { x: 60, y: 120 }, config: { seconds: 86400 } },
      { id: "email", type: "send_email", label: "Queue follow-up", position: { x: 340, y: 120 }, config: { templateId: "SELECT_EMAIL_TEMPLATE" } },
      end(620),
    ]),
  },
  {
    id: "tracked-resource-funnel",
    category: "Resources",
    definition: linearTemplate("Tracked Resource Funnel", "Deliver a tracked link and record a conversion goal.", "instagram_dm", [
      { id: "resource", type: "send_resource", label: "Send tracked resource", position: { x: 60, y: 120 }, config: { resourceId: "SELECT_RESOURCE" } },
      { id: "goal", type: "goal_reached", label: "Resource delivered", position: { x: 340, y: 120 }, config: { goal: "resource_delivered" } },
      end(620),
    ]),
  },
  {
    id: "ai-resource-assistant",
    category: "AI",
    definition: linearTemplate("AI Resource Assistant", "Match an eligible inbound request by intent and draft a grounded resource recommendation.", "ai_intent", [
      { id: "reply", type: "ai_reply", label: "Recommend a resource", position: { x: 80, y: 120 }, config: {} },
      end(380),
    ]),
  },
];
