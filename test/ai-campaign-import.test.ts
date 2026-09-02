import { describe, expect, it } from "vitest";
import { starterDefinition } from "../src/automation/schema";
import {
  applyAiCampaignPackage,
  buildFullCampaignPrompt,
  parseAiCampaignPackage,
  type AiCampaignPackage,
} from "../src/client/ai-campaign-import";
import { JOURNEY_IDS } from "../src/client/guided-journey";

const packageJson: AiCampaignPackage = {
  schemaVersion: 1,
  campaignName: "Creator Toolkit",
  campaignDescription: "Sends a toolkit to people who comment.",
  keywords: ["TOOLKIT", "creator kit"],
  publicReplies: ["Sent — check your DMs 👀", "It’s in your inbox"],
  openingDm: "I have your creator toolkit. Tap below and I’ll send it.",
  openingButton: "Send my toolkit",
  requireFollow: true,
  followPrompt: "Follow me first, then tap below so I can send it.",
  followProfileUrl: "https://instagram.com/example",
  followButton: "I’m following",
  askForEmail: true,
  emailQuestion: "What email should I send the backup copy to?",
  deliveryDm: "Here is your creator toolkit:",
  deliveryLink: "https://example.com/toolkit",
  thankYouEnabled: true,
  thankYouMessage: "Thanks for checking out the toolkit!",
  thankYouDelayMinutes: 30,
};

describe("one-paste AI campaign setup", () => {
  it("builds a prompt with an exact provider-neutral import contract", () => {
    const prompt = buildFullCampaignPrompt("instagram_comment");
    expect(prompt).toContain("one complete Instagram automation");
    expect(prompt).toContain('"publicReplies"');
    expect(prompt).toContain('"deliveryLink"');
    expect(prompt).toContain("valid JSON");
    expect(prompt).not.toContain("You are ChatGPT");
  });

  it("parses fenced JSON even when an AI adds text before it", () => {
    const parsed = parseAiCampaignPackage(`Here is the finished package:\n\n\`\`\`json\n${JSON.stringify(packageJson, null, 2)}\n\`\`\``);
    expect(parsed.campaignName).toBe("Creator Toolkit");
    expect(parsed.keywords).toEqual(["TOOLKIT", "creator kit"]);
    expect(parsed.deliveryLink).toBe("https://example.com/toolkit");
  });

  it("fills the trigger and every guided journey stage", () => {
    const initial = starterDefinition();
    initial.trigger.type = "instagram_comment";
    initial.trigger.config = { mediaIds: ["media_123"], match: { mode: "contains_any", include: ["OLD"], exclude: [], caseSensitive: false } };
    const result = applyAiCampaignPackage(initial, initial.nodes, packageJson);

    expect(result.definition.name).toBe("Creator Toolkit");
    expect(result.definition.trigger.config.mediaIds).toEqual(["media_123"]);
    expect((result.definition.trigger.config.match as { include: string[] }).include).toEqual(["TOOLKIT", "creator kit"]);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.publicReply)?.config.replies).toEqual(packageJson.publicReplies);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.opening)?.config.text).toBe(packageJson.openingDm);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.follow)?.config.text).toBe(packageJson.followPrompt);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.email)?.config.text).toBe(packageJson.emailQuestion);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.delivery)?.config.text).toBe("Here is your creator toolkit:\n\nhttps://example.com/toolkit");
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.thankDelay)?.config.seconds).toBe(1_800);
    expect(result.journey.nodes.find((node) => node.id === JOURNEY_IDS.thanks)?.config.text).toBe(packageJson.thankYouMessage);
  });

  it("removes optional stages when the AI package disables them", () => {
    const initial = starterDefinition();
    const result = applyAiCampaignPackage(initial, initial.nodes, {
      ...packageJson,
      requireFollow: false,
      askForEmail: false,
      thankYouEnabled: false,
    });
    expect(result.journey.nodes.some((node) => node.id === JOURNEY_IDS.follow)).toBe(false);
    expect(result.journey.nodes.some((node) => node.id === JOURNEY_IDS.email)).toBe(false);
    expect(result.journey.nodes.some((node) => node.id === JOURNEY_IDS.thanks)).toBe(false);
  });

  it("rejects unsafe delivery links and incomplete answers", () => {
    expect(() => parseAiCampaignPackage(JSON.stringify({ ...packageJson, deliveryLink: "javascript:alert(1)" }))).toThrow("https://");
    expect(() => parseAiCampaignPackage(JSON.stringify({ ...packageJson, openingDm: "" }))).toThrow("opening DM");
  });
});
