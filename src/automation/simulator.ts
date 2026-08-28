import type { AutomationDefinition, AutomationEdge, AutomationNode } from "./schema";
import { validateWorkflow, type ValidationIssue } from "./validator";

export interface SimulationEvent {
  nodeId?: string;
  type: "trigger" | "action" | "branch" | "wait" | "complete" | "error";
  summary: string;
  output?: unknown;
}

export interface SimulationResult {
  status: "completed" | "waiting" | "invalid";
  events: SimulationEvent[];
  issues: ValidationIssue[];
  context: Record<string, unknown>;
  waitingNodeId?: string;
}

export function simulateWorkflow(
  input: unknown,
  options: { incomingText?: string; context?: Record<string, unknown>; responses?: Record<string, string>; random?: number } = {},
): SimulationResult {
  const validation = validateWorkflow(input);
  if (!validation.valid || !validation.definition) return { status: "invalid", events: [], issues: validation.issues, context: {} };
  const definition = validation.definition;
  const context: Record<string, unknown> = { incomingText: options.incomingText ?? "", ...(options.context ?? {}) };
  const events: SimulationEvent[] = [{ type: "trigger", summary: `${definition.trigger.type} trigger matched (simulation only).` }];
  let currentId: string | undefined = definition.startNodeId;
  let steps = 0;
  while (currentId && steps++ < 250) {
    const node: AutomationNode | undefined = definition.nodes.find((item) => item.id === currentId);
    if (!node) {
      events.push({ type: "error", summary: `Missing node ${currentId}.` });
      return { status: "invalid", events, issues: validation.issues, context };
    }
    events.push({ nodeId: node.id, type: "action", summary: simulateNodeSummary(node) });
    if (node.type === "end") {
      events.push({ nodeId: node.id, type: "complete", summary: "Run completed." });
      return { status: "completed", events, issues: validation.issues, context };
    }
    if (node.type === "ask_question" || node.type === "wait_for_response") {
      const response = options.responses?.[node.id];
      if (!response) {
        events.push({ nodeId: node.id, type: "wait", summary: "Run paused for a test-user response." });
        return { status: "waiting", events, issues: validation.issues, context, waitingNodeId: node.id };
      }
      const field = typeof node.config.field === "string" ? node.config.field : `response_${node.id}`;
      context[field] = response;
      events.push({ nodeId: node.id, type: "branch", summary: `Test user replied: ${response}` });
    }
    currentId = nextNode(definition, node, context, options.random ?? 0.42);
  }
  if (steps >= 250) {
    events.push({ type: "error", summary: "Simulation step limit reached." });
    return { status: "invalid", events, issues: [...validation.issues, { level: "error", code: "step_limit", message: "Simulation step limit reached." }], context };
  }
  events.push({ type: "complete", summary: "Run ended." });
  return { status: "completed", events, issues: validation.issues, context };
}

function simulateNodeSummary(node: AutomationNode): string {
  switch (node.type) {
    case "send_text": return `Would send DM: ${String(node.config.text ?? "")}`;
    case "send_resource": return `Would deliver resource ${String(node.config.resourceId ?? "")}.`;
    case "send_email": return `Would queue email template ${String(node.config.templateId ?? "")}.`;
    case "public_comment_reply": return `Would reply publicly: ${String(node.config.text ?? "")}`;
    case "delay": return `Would wait ${String(node.config.seconds ?? "?")} seconds.`;
    default: return `${node.label} (${node.type})`;
  }
}

function outgoing(definition: AutomationDefinition, nodeId: string): AutomationEdge[] {
  return definition.edges.filter((edge) => edge.source === nodeId);
}

function nextNode(definition: AutomationDefinition, node: AutomationNode, context: Record<string, unknown>, random: number): string | undefined {
  const edges = outgoing(definition, node.id);
  if (node.type === "condition") {
    const field = String(node.config.field ?? "");
    const operator = String(node.config.operator ?? "equals");
    const expected = node.config.value;
    const actual = context[field];
    const result = compare(actual, expected, operator);
    return edges.find((edge) => edge.sourceHandle === (result ? "true" : "false") || edge.label?.toLowerCase() === (result ? "true" : "false"))?.target
      ?? edges[result ? 0 : 1]?.target;
  }
  if (node.type === "random_split" && edges.length) {
    return edges[Math.min(edges.length - 1, Math.floor(Math.max(0, Math.min(0.9999, random)) * edges.length))]?.target;
  }
  return edges[0]?.target;
}

function compare(actual: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "not_equals": return actual !== expected;
    case "contains": return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "greater_than": return Number(actual) > Number(expected);
    case "less_than": return Number(actual) < Number(expected);
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    default: return actual === expected || String(actual ?? "") === String(expected ?? "");
  }
}
