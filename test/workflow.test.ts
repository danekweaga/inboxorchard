import { describe, expect, it } from "vitest";
import { triggerMatches } from "../src/automation/executor";
import { starterDefinition } from "../src/automation/schema";
import { simulateWorkflow } from "../src/automation/simulator";
import { validateWorkflow } from "../src/automation/validator";

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
