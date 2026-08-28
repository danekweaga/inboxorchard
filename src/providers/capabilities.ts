export type CapabilityState = "available" | "access-dependent" | "unavailable";

export interface ProviderCapability {
  key: string;
  label: string;
  state: CapabilityState;
  detail: string;
}

/**
 * Conservative Instagram capability matrix for Instagram API with Instagram Login.
 * Access-dependent entries are never silently represented as available in the UI.
 */
export const INSTAGRAM_CAPABILITIES: ProviderCapability[] = [
  { key: "send_text", label: "Text messages", state: "available", detail: "Within an eligible conversation window." },
  { key: "send_media", label: "Image and media messages", state: "available", detail: "Uses the official Send API attachment payload." },
  { key: "quick_replies", label: "Quick replies", state: "available", detail: "Up to the limits exposed by the connected API version." },
  { key: "button_template", label: "Buttons", state: "available", detail: "Postback and URL buttons supported by the Send API." },
  { key: "comment_private_reply", label: "Comment private reply", state: "available", detail: "One private reply per comment, within Meta's eligibility window." },
  { key: "public_comment_reply", label: "Public comment reply", state: "available", detail: "Text replies to comments on owned media." },
  { key: "story_reply", label: "Story reply events", state: "access-dependent", detail: "Shown only when Meta delivers the event to this app/account access level." },
  { key: "story_mention", label: "Story mention events", state: "access-dependent", detail: "Availability varies by webhook field and account access level." },
  { key: "referrals", label: "Messaging referrals", state: "access-dependent", detail: "Requires the corresponding webhook subscription and payload." },
  { key: "reactions", label: "Message reactions", state: "access-dependent", detail: "Receive-only behavior depends on the enabled webhook fields." },
  { key: "seen_events", label: "Read/seen events", state: "access-dependent", detail: "Delivery depends on the enabled webhook fields." },
  { key: "comment_like", label: "Like a comment", state: "unavailable", detail: "The official Instagram API does not expose a comment-like operation." },
  { key: "follower_identity", label: "Verify an individual follower", state: "unavailable", detail: "The API does not expose an arbitrary follower list for this purpose." },
  { key: "cold_dm", label: "Cold outbound DM", state: "unavailable", detail: "A creator cannot arbitrarily initiate a DM outside supported entry points." },
];

export function capability(key: string): ProviderCapability | undefined {
  return INSTAGRAM_CAPABILITIES.find((item) => item.key === key);
}
