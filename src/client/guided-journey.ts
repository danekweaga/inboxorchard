import type { AutomationEdge, AutomationNode, TriggerType } from "../automation/schema";
import { arrangeAutomationNodes } from "./flow-layout";

export const JOURNEY_IDS = {
  publicReply: "journey_public_reply",
  opening: "journey_opening_dm",
  openingWait: "journey_opening_wait",
  follow: "journey_follow_prompt",
  followWait: "journey_follow_wait",
  email: "journey_email_question",
  delivery: "journey_delivery",
  thankDelay: "journey_thank_delay",
  thanks: "journey_thank_you",
  end: "journey_end",
} as const;

export interface JourneyToggles {
  follow: boolean;
  email: boolean;
  thanks: boolean;
}

export interface GuidedJourney {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  startNodeId: string;
}

export function isGuidedJourney(nodes: AutomationNode[]): boolean {
  const ids = new Set(nodes.map((node) => node.id));
  return ids.has(JOURNEY_IDS.opening) && ids.has(JOURNEY_IDS.delivery);
}

/** Repair older/simple-editor button configs while preserving the user's node layout and copy. */
export function repairGuidedJourneyButtons(nodes: AutomationNode[]): AutomationNode[] {
  if (!isGuidedJourney(nodes)) return nodes;
  return nodes.map((item) => {
    if (item.id === JOURNEY_IDS.opening && item.type === "send_buttons") {
      const buttons = Array.isArray(item.config.buttons) ? item.config.buttons.filter(isRecord) : [];
      if (buttons.some(isReplyButton)) return item;
      const first = buttons[0] ?? { title: "Send it" };
      return { ...item, config: { ...item.config, buttons: [{ ...first, url: undefined, payload: "OPENING_CONFIRMED" }] } };
    }
    if (item.id === JOURNEY_IDS.follow && item.type === "send_buttons") {
      const buttons = Array.isArray(item.config.buttons) ? item.config.buttons.filter(isRecord) : [];
      const confirmationIndex = buttons.findIndex((button) => button.payload === "FOLLOW_CONFIRMED" || isReplyButton(button));
      if (confirmationIndex >= 0) {
        const repaired = buttons.map((button, index) => index === confirmationIndex
          ? { ...button, url: undefined, payload: "FOLLOW_CONFIRMED" }
          : button);
        return { ...item, config: { ...item.config, buttons: repaired } };
      }
      const confirmation = { title: "I’m following", payload: "FOLLOW_CONFIRMED" };
      const repaired = buttons.length < 3 ? [...buttons, confirmation] : [...buttons.slice(0, 2), confirmation];
      return { ...item, config: { ...item.config, buttons: repaired } };
    }
    return item;
  });
}

export function createGuidedJourney(triggerType: TriggerType, previous: AutomationNode[] = []): GuidedJourney {
  const publicReply = previous.find((node) => node.type === "public_comment_reply");
  const existingResource = previous.find((node) => node.type === "send_resource");
  const existingMessage = previous.find((node) => node.type === "send_text");
  const seeds: AutomationNode[] = [];
  if (triggerType === "instagram_comment") {
    seeds.push(node(JOURNEY_IDS.publicReply, "public_comment_reply", "Public comment reply", {
      text: String(publicReply?.config.text ?? "Sent 🤝"),
      replies: Array.isArray(publicReply?.config.replies) ? publicReply.config.replies : [String(publicReply?.config.text ?? "Sent 🤝"), "Check your DMs 👀"],
    }));
  }
  seeds.push(
    node(JOURNEY_IDS.opening, "send_buttons", "Opening DM", {
      text: String(existingMessage?.config.text ?? "I got you — tap below and I’ll send it 👇"),
      buttons: [{ title: "Send it", payload: "OPENING_CONFIRMED" }],
    }),
    node(JOURNEY_IDS.openingWait, "wait_for_response", "Wait for opening tap", { field: "opening_confirmed" }),
    node(JOURNEY_IDS.follow, "send_buttons", "Ask them to follow", {
      text: "Quick thing — follow me and I’ll send it over 👇",
      buttons: [
        { title: "Follow me", url: "https://instagram.com/nonsocodes_" },
        { title: "I’m following", payload: "FOLLOW_CONFIRMED" },
      ],
    }),
    node(JOURNEY_IDS.followWait, "wait_for_response", "Wait for follow confirmation", { field: "follow_confirmed" }),
    existingResource
      ? node(JOURNEY_IDS.delivery, "send_resource", "Deliver resource", { ...existingResource.config })
      : node(JOURNEY_IDS.delivery, "send_text", "Delivery message", { text: "Here you go 👇" }),
    node(JOURNEY_IDS.thankDelay, "delay", "Wait before thank you", { seconds: 2700 }),
    node(JOURNEY_IDS.thanks, "send_text", "Thank-you message", { text: "Thanks for following! I’ll share more helpful resources soon." }),
    node(JOURNEY_IDS.end, "end", "End", {}),
  );
  return composeGuidedJourney(triggerType, seeds, { follow: true, email: false, thanks: true });
}

export function composeGuidedJourney(
  triggerType: TriggerType,
  current: AutomationNode[],
  toggles: JourneyToggles,
): GuidedJourney {
  const byId = new Map(current.map((item) => [item.id, item]));
  const required = (id: string, type: AutomationNode["type"], label: string, config: Record<string, unknown>) =>
    byId.get(id) ?? node(id, type, label, config);
  const ordered: AutomationNode[] = [];
  if (triggerType === "instagram_comment") ordered.push(required(JOURNEY_IDS.publicReply, "public_comment_reply", "Public comment reply", { text: "Sent 🤝", replies: ["Sent 🤝"] }));
  const opening = required(JOURNEY_IDS.opening, "send_buttons", "Opening DM", { text: "Tap below to continue 👇", buttons: [{ title: "Send it", payload: "OPENING_CONFIRMED" }] });
  const currentOpeningButton = Array.isArray(opening.config.buttons) && opening.config.buttons[0] && typeof opening.config.buttons[0] === "object"
    ? opening.config.buttons[0] as Record<string, unknown>
    : {};
  ordered.push(
    { ...opening, config: { ...opening.config, buttons: [{ title: String(currentOpeningButton.title ?? "Send it"), payload: "OPENING_CONFIRMED" }] } },
    required(JOURNEY_IDS.openingWait, "wait_for_response", "Wait for opening tap", { field: "opening_confirmed" }),
  );
  if (toggles.follow) ordered.push(
    required(JOURNEY_IDS.follow, "send_buttons", "Ask them to follow", { text: "Follow me and tap below.", buttons: [{ title: "Follow me", url: "https://instagram.com/" }, { title: "I’m following", payload: "FOLLOW_CONFIRMED" }] }),
    required(JOURNEY_IDS.followWait, "wait_for_response", "Wait for follow confirmation", { field: "follow_confirmed" }),
  );
  if (toggles.email) ordered.push(required(JOURNEY_IDS.email, "ask_question", "Ask for email", { text: "What email should I send it to?", field: "email" }));
  ordered.push(required(JOURNEY_IDS.delivery, "send_text", "Delivery message", { text: "Here you go 👇" }));
  if (toggles.thanks) ordered.push(
    required(JOURNEY_IDS.thankDelay, "delay", "Wait before thank you", { seconds: 2700 }),
    required(JOURNEY_IDS.thanks, "send_text", "Thank-you message", { text: "Thanks for following!" }),
  );
  ordered.push(required(JOURNEY_IDS.end, "end", "End", {}));

  const positioned = arrangeAutomationNodes(repairGuidedJourneyButtons(ordered));
  const edges = positioned.slice(0, -1).map((item, index) => ({
    id: `journey_edge_${item.id}_${positioned[index + 1]!.id}`,
    source: item.id,
    target: positioned[index + 1]!.id,
  }));
  return { nodes: positioned, edges, startNodeId: positioned[0]!.id };
}

function node(
  id: string,
  type: AutomationNode["type"],
  label: string,
  config: Record<string, unknown>,
): AutomationNode {
  return { id, type, label, config, position: { x: 0, y: 0 } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReplyButton(button: Record<string, unknown>): boolean {
  return typeof button.payload === "string" || button.type === "postback" || typeof button.url !== "string";
}
