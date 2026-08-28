import { automationDefinitionSchema, type AutomationDefinition, type AutomationNode } from "./schema";

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowValidation {
  valid: boolean;
  definition?: AutomationDefinition;
  issues: ValidationIssue[];
}

function stringConfig(node: AutomationNode, key: string): string {
  const value = node.config[key];
  return typeof value === "string" ? value.trim() : "";
}

export function validateWorkflow(input: unknown): WorkflowValidation {
  const parsed = automationDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        level: "error" as const,
        code: "schema",
        message: `${issue.path.join(".") || "definition"}: ${issue.message}`,
      })),
    };
  }
  const definition = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) issues.push({ level: "error", code: "duplicate_node", message: `Duplicate node id: ${node.id}`, nodeId: node.id });
    ids.add(node.id);
    validateNodeConfig(node, issues);
  }
  if (!ids.has(definition.startNodeId)) {
    issues.push({ level: "error", code: "missing_start", message: "The start node does not exist." });
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.source)) issues.push({ level: "error", code: "missing_edge_source", message: `Edge ${edge.id} has a missing source.` });
    if (!ids.has(edge.target)) issues.push({ level: "error", code: "missing_edge_target", message: `Edge ${edge.id} has a missing target.` });
  }

  const reachable = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of definition.edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  const visit = (nodeId: string) => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) visit(target);
  };
  visit(definition.startNodeId);
  for (const node of definition.nodes) {
    if (!reachable.has(node.id)) issues.push({ level: "warning", code: "unreachable", message: `${node.label} is unreachable.`, nodeId: node.id });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasCycle = false;
  const detectCycle = (nodeId: string) => {
    if (visiting.has(nodeId)) { hasCycle = true; return; }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) detectCycle(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  detectCycle(definition.startNodeId);
  if (hasCycle) issues.push({ level: "error", code: "cycle", message: "Workflow loops are blocked to prevent accidental infinite recursion." });

  const outgoingCounts = new Map<string, number>();
  for (const edge of definition.edges) outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1);
  for (const node of definition.nodes) {
    const count = outgoingCounts.get(node.id) ?? 0;
    if (node.type === "condition" && count < 2) issues.push({ level: "error", code: "condition_branches", message: "A condition needs true and false branches.", nodeId: node.id });
    if (node.type === "random_split" && count < 2) issues.push({ level: "error", code: "split_branches", message: "A random split needs at least two branches.", nodeId: node.id });
    if (node.type !== "end" && count === 0 && reachable.has(node.id)) issues.push({ level: "warning", code: "implicit_end", message: `${node.label} ends the run without an End node.`, nodeId: node.id });
  }

  if (["story_reply", "story_mention"].includes(definition.trigger.type)) {
    issues.push({ level: "warning", code: "access_dependent", message: "This Story capability depends on the connected Meta app access level and webhook fields." });
  }
  if (definition.nodes.some((node) => node.type === "public_comment_reply") && definition.trigger.type !== "instagram_comment") {
    issues.push({ level: "error", code: "comment_context", message: "Public comment replies require an Instagram comment trigger." });
  }
  if (definition.trigger.type === "ai_intent") {
    if (!String(definition.trigger.config.intent ?? "").trim()) issues.push({ level: "error", code: "missing_intent", message: "AI intent triggers need an intent name." });
    if (!Array.isArray(definition.trigger.config.examples) || definition.trigger.config.examples.length < 2) issues.push({ level: "error", code: "missing_examples", message: "AI intent triggers need at least two example messages." });
  }

  return { valid: !issues.some((issue) => issue.level === "error"), definition, issues };
}

function validateNodeConfig(node: AutomationNode, issues: ValidationIssue[]): void {
  const requireString = (key: string, label: string) => {
    if (!stringConfig(node, key)) issues.push({ level: "error", code: `missing_${key}`, message: `${node.label}: ${label} is required.`, nodeId: node.id });
  };
  switch (node.type) {
    case "send_text":
    case "ask_question":
    case "notify_owner":
    case "public_comment_reply":
      requireString("text", "message text");
      break;
    case "send_buttons":
      requireString("text", "message text");
      if (!Array.isArray(node.config.buttons) || node.config.buttons.length < 1 || node.config.buttons.length > 3) {
        issues.push({ level: "error", code: "invalid_buttons", message: `${node.label}: provide between one and three buttons.`, nodeId: node.id });
      }
      break;
    case "send_resource":
      requireString("resourceId", "resource");
      break;
    case "send_image":
      requireString("url", "HTTPS image URL");
      if (stringConfig(node, "url") && !isSafeHttpsUrl(stringConfig(node, "url"))) issues.push({ level: "error", code: "unsafe_image_url", message: `${node.label}: use a public HTTPS image URL.`, nodeId: node.id });
      break;
    case "add_tag":
    case "remove_tag":
      requireString("tagId", "tag");
      break;
    case "update_field":
      requireString("fieldId", "custom field");
      break;
    case "send_email":
      requireString("templateId", "email template");
      break;
    case "append_google_sheet":
      requireString("connectionId", "Google Sheets connection");
      break;
    case "start_automation":
      requireString("automationId", "automation");
      break;
    case "subscribe_sequence":
    case "unsubscribe_sequence":
      requireString("sequenceId", "sequence");
      break;
    case "goal_reached":
      requireString("goal", "goal name");
      break;
    case "call_webhook":
      requireString("url", "webhook URL");
      if (stringConfig(node, "url") && !isSafeHttpsUrl(stringConfig(node, "url"))) {
        issues.push({ level: "error", code: "unsafe_url", message: `${node.label}: only public HTTPS webhook URLs are allowed.`, nodeId: node.id });
      }
      break;
    case "delay": {
      const seconds = node.config.seconds;
      if (typeof seconds !== "number" || seconds < 1 || seconds > 30 * 86400) {
        issues.push({ level: "error", code: "invalid_delay", message: `${node.label}: delay must be between 1 second and 30 days.`, nodeId: node.id });
      }
      break;
    }
    case "wait_until": {
      const timestamp = node.config.timestamp;
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) issues.push({ level: "error", code: "invalid_wait_until", message: `${node.label}: provide a Unix timestamp.`, nodeId: node.id });
      break;
    }
    case "condition":
      requireString("field", "field");
      requireString("operator", "operator");
      break;
  }
}

export function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return false;
    if (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")) return false;
    return hostname.includes(".");
  } catch {
    return false;
  }
}
