import { afterEach, describe, expect, it, vi } from "vitest";
import { InstagramClient, REQUIRED_WEBHOOK_FIELDS } from "../src/api/client";
import { validateWorkflow } from "../src/automation/validator";
import { composeGuidedJourney, createGuidedJourney, JOURNEY_IDS } from "../src/client/guided-journey";

describe("guided DM journey", () => {
  it("creates an executable comment funnel with follow and thank-you stages", () => {
    const journey = createGuidedJourney("instagram_comment");
    expect(journey.nodes.map((node) => node.id)).toEqual([
      JOURNEY_IDS.publicReply,
      JOURNEY_IDS.opening,
      JOURNEY_IDS.openingWait,
      JOURNEY_IDS.follow,
      JOURNEY_IDS.followWait,
      JOURNEY_IDS.delivery,
      JOURNEY_IDS.thankDelay,
      JOURNEY_IDS.thanks,
      JOURNEY_IDS.end,
    ]);
    const result = validateWorkflow({
      schemaVersion: 1,
      name: "Guided Comment DM",
      description: "",
      trigger: { type: "instagram_comment", config: {} },
      startNodeId: journey.startNodeId,
      nodes: journey.nodes,
      edges: journey.edges,
      settings: { stopOtherAutomations: true, priority: 100, reentry: "once" },
    });
    expect(result.valid).toBe(true);
  });

  it("adds email capture and removes optional follow-up stages", () => {
    const initial = createGuidedJourney("instagram_dm");
    const journey = composeGuidedJourney("instagram_dm", initial.nodes, { follow: false, email: true, thanks: false });
    expect(journey.nodes.some((node) => node.id === JOURNEY_IDS.follow)).toBe(false);
    expect(journey.nodes.find((node) => node.id === JOURNEY_IDS.email)?.config.field).toBe("email");
    expect(journey.nodes.some((node) => node.id === JOURNEY_IDS.thanks)).toBe(false);
  });

  it("keeps an existing resource as the delivery action", () => {
    const journey = createGuidedJourney("instagram_comment", [{
      id: "resource",
      type: "send_resource",
      label: "Resource",
      position: { x: 0, y: 0 },
      config: { resourceId: "resource_123" },
    }]);
    expect(journey.nodes.find((node) => node.id === JOURNEY_IDS.delivery)).toMatchObject({
      type: "send_resource",
      config: { resourceId: "resource_123" },
    });
  });

  it("repairs an opening link button into a reply button that can resume the journey", () => {
    const initial = createGuidedJourney("instagram_comment");
    const opening = initial.nodes.find((node) => node.id === JOURNEY_IDS.opening)!;
    opening.config.buttons = [{ title: "Send it", url: "https://example.com/download" }];
    const journey = composeGuidedJourney("instagram_comment", initial.nodes, { follow: true, email: false, thanks: true });
    expect(journey.nodes.find((node) => node.id === JOURNEY_IDS.opening)?.config.buttons).toEqual([
      { title: "Send it", payload: "OPENING_CONFIRMED" },
    ]);
  });
});

describe("Instagram webhook subscription", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("subscribes the connected account to required real-time fields", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({ success: true });
    };
    vi.stubGlobal("fetch", fetchMock);
    await new InstagramClient("token", "v26.0", "ig_123").subscribeWebhooks();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://graph.instagram.com/v26.0/ig_123/subscribed_apps");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ subscribed_fields: REQUIRED_WEBHOOK_FIELDS });
  });
});
