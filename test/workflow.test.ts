import { describe, expect, it } from "vitest";
import { shouldAllowReentry, triggerMatches } from "../src/automation/executor";
import { starterDefinition } from "../src/automation/schema";
import { simulateWorkflow } from "../src/automation/simulator";
import { validateWorkflow } from "../src/automation/validator";
import { shouldRunLegacyCommentFallback } from "../src/services/ingestion";

describe("structured workflow validation", () => {
  it("accepts the starter workflow", () => {
    expect(validateWorkflow(starterDefinition()).valid).toBe(true);
  });

  it("rejects unsupported hallucinated nodes", () => {
    const definition = starterDefinition();
    const invalid = { ...definition, nodes: [{ ...definition.nodes[0], type: "scrape_followers" }, definition.nodes[1]] };
    expect(validateWorkflow(invalid)).toMatchObject({ valid: false });
  });

  it("rejects cycles", () => {
    const definition = starterDefinition();
    definition.edges.push({ id: "cycle", source: "end", target: "send_welcome" });
    const result = validateWorkflow(definition);
    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
  });

  it("rejects private-network webhook targets", () => {
    const definition = starterDefinition();
    definition.nodes[0] = { ...definition.nodes[0]!, type: "call_webhook", config: { url: "https://127.0.0.1/admin" } };
    const result = validateWorkflow(definition);
    expect(result.issues.some((issue) => issue.code === "unsafe_url")).toBe(true);
  });

  it("rejects link-only buttons before a wait step", () => {
    const definition = starterDefinition();
    definition.nodes = [
      { id: "opening", type: "send_buttons", label: "Opening", position: { x: 0, y: 0 }, config: { text: "Tap", buttons: [{ title: "Open", url: "https://example.com" }] } },
      { id: "wait", type: "wait_for_response", label: "Wait", position: { x: 200, y: 0 }, config: { field: "confirmed" } },
    ];
    definition.startNodeId = "opening";
    definition.edges = [{ id: "opening-wait", source: "opening", target: "wait" }];
    expect(validateWorkflow(definition).issues.some((issue) => issue.code === "wait_button_requires_postback")).toBe(true);
  });
});

describe("automation re-entry protection", () => {
  const now = 2_000_000;
  it("blocks running and completed one-time runs", () => {
    expect(shouldAllowReentry("once", { status: "running", started_at: now - 10, updated_at: now - 10 }, now)).toBe(false);
    expect(shouldAllowReentry("once", { status: "completed", started_at: now - 90_000, updated_at: now - 89_000 }, now)).toBe(false);
  });

  it("supports a 24-hour window and delayed retry after failure", () => {
    expect(shouldAllowReentry("after_24h", { status: "completed", started_at: now - 86_399, updated_at: now - 80_000 }, now)).toBe(false);
    expect(shouldAllowReentry("after_24h", { status: "completed", started_at: now - 86_400, updated_at: now - 80_000 }, now)).toBe(true);
    expect(shouldAllowReentry("once", { status: "failed", started_at: now - 1_000, updated_at: now - 301 }, now)).toBe(true);
  });
});

describe("legacy comment fallback", () => {
  it("never invokes the old campaign engine in webhook mode", () => {
    expect(shouldRunLegacyCommentFallback("webhook", 0)).toBe(false);
    expect(shouldRunLegacyCommentFallback("webhook", 1)).toBe(false);
  });

  it("keeps polling-mode compatibility when no structured run starts", () => {
    expect(shouldRunLegacyCommentFallback("polling", 0)).toBe(true);
    expect(shouldRunLegacyCommentFallback("polling", 1)).toBe(false);
  });
});

describe("workflow simulator", () => {
  it("pauses for a real test-user response and resumes when supplied", () => {
    const definition = starterDefinition("Qualification");
    definition.nodes = [
      { id: "ask", type: "ask_question", label: "Ask year", position: { x: 0, y: 0 }, config: { text: "What year?", field: "year" } },
      { id: "end", type: "end", label: "End", position: { x: 200, y: 0 }, config: {} },
    ];
    definition.startNodeId = "ask";
    definition.edges = [{ id: "ask-end", source: "ask", target: "end" }];

    const waiting = simulateWorkflow(definition);
    expect(waiting).toMatchObject({ status: "waiting", waitingNodeId: "ask" });

    const resumed = simulateWorkflow(definition, { responses: { ask: "2" } });
    expect(resumed.status).toBe("completed");
    expect(resumed.context.year).toBe("2");
  });

  it("never invokes external actions", () => {
    const definition = starterDefinition();
    const result = simulateWorkflow(definition);
    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.summary.startsWith("Would send DM"))).toBe(true);
  });
});

describe("Instagram content selection", () => {
  it("runs a comment automation only for a selected post or Reel", () => {
    const definition = starterDefinition("Selected post");
    definition.trigger = { type: "instagram_comment", config: { mediaIds: ["post_123"], match: { mode: "contains_any", include: ["guide"], exclude: [], caseSensitive: false } } };
    expect(triggerMatches(definition, { type: "instagram_comment", eventId: "one", mediaId: "post_123", text: "GUIDE please" })).toBe(true);
    expect(triggerMatches(definition, { type: "instagram_comment", eventId: "two", mediaId: "post_999", text: "GUIDE please" })).toBe(false);
  });

  it("runs a Story automation only for the selected Story", () => {
    const definition = starterDefinition("Selected Story");
    definition.trigger = { type: "story_reply", config: { mediaIds: ["story_123"] } };
    expect(triggerMatches(definition, { type: "story_reply", eventId: "one", mediaId: "story_123", text: "Love this" })).toBe(true);
    expect(triggerMatches(definition, { type: "story_reply", eventId: "two", mediaId: "story_999", text: "Love this" })).toBe(false);
  });

  it("accepts public reply variations without a duplicate text field", () => {
    const definition = starterDefinition("Reply variations");
    definition.trigger = { type: "instagram_comment", config: {} };
    definition.nodes[0] = { ...definition.nodes[0]!, type: "public_comment_reply", config: { replies: ["Sent it", "Check your DMs"] } };
    expect(validateWorkflow(definition).valid).toBe(true);
  });
});
