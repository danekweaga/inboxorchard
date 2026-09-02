import type { AutomationDefinition, AutomationNode, TriggerType } from "../automation/schema";
import { composeGuidedJourney, createGuidedJourney, JOURNEY_IDS, type GuidedJourney } from "./guided-journey";
import { parseSmartList } from "./smart-paste";

export interface AiCampaignPackage {
  schemaVersion: 1;
  campaignName: string;
  campaignDescription: string;
  keywords: string[];
  publicReplies: string[];
  openingDm: string;
  openingButton: string;
  requireFollow: boolean;
  followPrompt: string;
  followProfileUrl: string;
  followButton: string;
  askForEmail: boolean;
  emailQuestion: string;
  deliveryDm: string;
  deliveryLink: string;
  thankYouEnabled: boolean;
  thankYouMessage: string;
  thankYouDelayMinutes: number;
}

export interface AppliedAiCampaign {
  definition: AutomationDefinition;
  journey: GuidedJourney;
}

const triggerLabels: Partial<Record<TriggerType, string>> = {
  instagram_comment: "a comment on an Instagram post or Reel",
  instagram_dm: "an Instagram DM containing a keyword",
  keyword: "an Instagram DM containing a keyword",
  story_reply: "a reply to an Instagram Story",
  story_mention: "an Instagram Story mention",
};

/** Build a provider-neutral prompt whose final answer can be imported without field-by-field copying. */
export function buildFullCampaignPrompt(triggerType: TriggerType): string {
  const trigger = triggerLabels[triggerType] ?? "an Instagram conversation";
  const needsKeywords = ["instagram_comment", "instagram_dm", "keyword"].includes(triggerType);
  const needsPublicReplies = triggerType === "instagram_comment";
  return [
    "You are helping me write one complete Instagram automation for Inbox Orchard.",
    `The automation starts from ${trigger}.`,
    "",
    "First, ask me one short batch of questions for any missing details: the offer/resource, audience, tone, campaign name, trigger keywords, destination link, Instagram profile URL, whether following is required, whether to collect email, and follow-up timing. Do not write the final package until I answer.",
    "",
    "After I answer, write concise, natural copy for every step. Then output exactly one valid JSON object inside one ```json code block. Do not put explanations or commentary after the JSON. Use these exact camelCase keys and value types:",
    "",
    "{",
    '  "schemaVersion": 1,',
    '  "campaignName": "A short useful campaign name",',
    '  "campaignDescription": "One sentence describing the campaign",',
    `  "keywords": ${needsKeywords ? '["keyword one", "keyword two", "common misspelling"]' : "[]"},`,
    `  "publicReplies": ${needsPublicReplies ? '["Sent it — check your DMs 👀", "It is waiting in your inbox"]' : "[]"},`,
    '  "openingDm": "The first DM explaining what they requested and asking them to tap the button",',
    '  "openingButton": "Send it",',
    '  "requireFollow": true,',
    '  "followPrompt": "A respectful message asking non-followers to follow before continuing",',
    '  "followProfileUrl": "https://instagram.com/your_username",',
    '  "followButton": "I am following",',
    '  "askForEmail": false,',
    '  "emailQuestion": "What email should I send it to?",',
    '  "deliveryDm": "The final DM delivering the promised resource",',
    '  "deliveryLink": "https://example.com/resource",',
    '  "thankYouEnabled": true,',
    '  "thankYouMessage": "A natural delayed thank-you message",',
    '  "thankYouDelayMinutes": 45',
    "}",
    "",
    "Rules:",
    "- Return valid JSON: double quotes, no comments, no trailing commas, and no placeholder text.",
    "- Keep public replies varied, human, and under 12 words each.",
    "- The opening DM must tell the person to tap the opening button to continue.",
    "- Only ask for an email when it is genuinely needed; make the reason clear.",
    "- Use a complete https:// URL for the resource and Instagram profile.",
    "- Do not claim that you verified whether someone follows the account.",
    "- Do not add keys or change key names. Inbox Orchard will parse this object automatically.",
  ].join("\n");
}

/** Parse a bare or fenced AI response, tolerating brief prose before the JSON object. */
export function parseAiCampaignPackage(value: string): AiCampaignPackage {
  const parsed = JSON.parse(extractJsonObject(value)) as unknown;
  if (!isRecord(parsed)) throw new Error("The pasted answer must contain one JSON object.");
  if (parsed.schemaVersion !== undefined && Number(parsed.schemaVersion) !== 1) {
    throw new Error("This campaign package uses an unsupported schema version.");
  }

  const campaignName = requiredString(parsed, "campaignName", "campaign name");
  const openingDm = requiredString(parsed, "openingDm", "opening DM");
  const openingButton = requiredString(parsed, "openingButton", "opening button");
  const deliveryDm = stringField(parsed, "deliveryDm");
  const deliveryLink = stringField(parsed, "deliveryLink");
  if (!deliveryDm && !deliveryLink) throw new Error("Add a delivery DM or delivery link to the AI answer.");
  if (deliveryLink && !isHttpsUrl(deliveryLink)) throw new Error("The delivery link must be a complete https:// URL.");

  const requireFollow = booleanField(parsed, "requireFollow", true);
  const followPrompt = stringField(parsed, "followPrompt");
  const followProfileUrl = stringField(parsed, "followProfileUrl");
  const followButton = stringField(parsed, "followButton") || "I’m following";
  if (requireFollow && !followPrompt) throw new Error("The AI answer is missing the follow prompt.");
  if (requireFollow && !isHttpsUrl(followProfileUrl)) throw new Error("The Instagram profile URL must be a complete https:// URL.");

  const askForEmail = booleanField(parsed, "askForEmail", false);
  const emailQuestion = stringField(parsed, "emailQuestion");
  if (askForEmail && !emailQuestion) throw new Error("The AI answer is missing the email question.");

  const thankYouEnabled = booleanField(parsed, "thankYouEnabled", true);
  const thankYouMessage = stringField(parsed, "thankYouMessage");
  if (thankYouEnabled && !thankYouMessage) throw new Error("The AI answer is missing the thank-you message.");

  return {
    schemaVersion: 1,
    campaignName,
    campaignDescription: stringField(parsed, "campaignDescription"),
    keywords: stringList(parsed.keywords, "keywords"),
    publicReplies: stringList(parsed.publicReplies, "lines"),
    openingDm,
    openingButton,
    requireFollow,
    followPrompt,
    followProfileUrl,
    followButton,
    askForEmail,
    emailQuestion,
    deliveryDm,
    deliveryLink,
    thankYouEnabled,
    thankYouMessage,
    thankYouDelayMinutes: clampNumber(parsed.thankYouDelayMinutes, 45, 1, 43_200),
  };
}

export function applyAiCampaignPackage(
  definition: AutomationDefinition,
  currentNodes: AutomationNode[],
  campaign: AiCampaignPackage,
): AppliedAiCampaign {
  const triggerType = definition.trigger.type;
  const completeSeed = composeGuidedJourney(
    triggerType,
    createGuidedJourney(triggerType, currentNodes).nodes,
    { follow: true, email: true, thanks: true },
  ).nodes;
  const seed = completeSeed.map((node) => {
    if (node.id === JOURNEY_IDS.publicReply) {
      const replies = campaign.publicReplies.length ? campaign.publicReplies : ["Sent it — check your DMs 👀"];
      return { ...node, config: { ...node.config, text: replies[0], replies } };
    }
    if (node.id === JOURNEY_IDS.opening) return {
      ...node,
      config: { ...node.config, text: campaign.openingDm, buttons: [{ title: campaign.openingButton, payload: "OPENING_CONFIRMED" }] },
    };
    if (node.id === JOURNEY_IDS.follow) return {
      ...node,
      config: {
        ...node.config,
        text: campaign.followPrompt,
        buttons: [
          { title: "Follow me", url: campaign.followProfileUrl },
          { title: campaign.followButton, payload: "FOLLOW_CONFIRMED" },
        ],
      },
    };
    if (node.id === JOURNEY_IDS.email) return { ...node, config: { ...node.config, text: campaign.emailQuestion, field: "email" } };
    if (node.id === JOURNEY_IDS.delivery) return {
      ...node,
      type: "send_text" as const,
      label: "Delivery message",
      config: { text: [campaign.deliveryDm, campaign.deliveryLink].filter(Boolean).join("\n\n") },
    };
    if (node.id === JOURNEY_IDS.thankDelay) return { ...node, config: { ...node.config, seconds: campaign.thankYouDelayMinutes * 60 } };
    if (node.id === JOURNEY_IDS.thanks) return { ...node, config: { ...node.config, text: campaign.thankYouMessage } };
    return node;
  });
  const journey = composeGuidedJourney(triggerType, seed, {
    follow: campaign.requireFollow,
    email: campaign.askForEmail,
    thanks: campaign.thankYouEnabled,
  });

  const triggerConfig = { ...definition.trigger.config };
  if (["instagram_comment", "instagram_dm", "keyword"].includes(triggerType) && campaign.keywords.length) {
    const currentMatch = isRecord(triggerConfig.match) ? triggerConfig.match : {};
    triggerConfig.match = {
      ...currentMatch,
      mode: "contains_any",
      include: campaign.keywords,
      exclude: Array.isArray(currentMatch.exclude) ? currentMatch.exclude : [],
      caseSensitive: currentMatch.caseSensitive === true,
    };
  }

  return {
    journey,
    definition: {
      ...definition,
      name: campaign.campaignName,
      description: campaign.campaignDescription,
      trigger: { ...definition.trigger, config: triggerConfig },
      startNodeId: journey.startNodeId,
      nodes: journey.nodes,
      edges: journey.edges,
    },
  };
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Paste the JSON answer from your AI first.");
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  if (start < 0) throw new Error("No JSON object was found in the pasted answer.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return unfenced.slice(start, index + 1);
  }
  throw new Error("The JSON object is incomplete. Copy the AI answer again.");
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = stringField(record, key);
  if (!value) throw new Error(`The AI answer is missing the ${label}.`);
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key].trim() : "";
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}

function stringList(value: unknown, kind: "keywords" | "lines"): string[] {
  if (Array.isArray(value)) return parseSmartList(value.filter((item): item is string => typeof item === "string").join("\n"), kind);
  return typeof value === "string" ? parseSmartList(value, kind) : [];
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function isHttpsUrl(value: string): boolean {
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
