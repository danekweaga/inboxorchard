// Pure state-transition logic (Section 6 state machine). No I/O — the orchestrator (engine.ts)
// applies these decisions against the DB and the send queue.
//
//   NEW ─opening private reply─▶ AWAITING_TAP
//   AWAITING_TAP ─tap─▶ ( check_follow ? AWAITING_FOLLOW : ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_FOLLOW ─"I followed"─▶ ( verify && looks-unfollowed ? re-send, STAY (capped)
//                                    : ask_email ? AWAITING_EMAIL : DELIVER )
//   AWAITING_EMAIL ─email─▶ DELIVER
//   DELIVER ─▶ DONE

import type { Campaign, State } from "../types";

/** After a tap in AWAITING_TAP, where do we go next given the campaign toggles? */
export function afterTap(campaign: Campaign): State {
  if (campaign.check_follow) return "AWAITING_FOLLOW";
  if (campaign.ask_email) return "AWAITING_EMAIL";
  return "DELIVER";
}

/** After a confirmed follow, where next? */
export function afterFollow(campaign: Campaign): State {
  if (campaign.ask_email) return "AWAITING_EMAIL";
  return "DELIVER";
}

/**
 * The button title the engine is waiting to see for a given state (Section: Step 2). In polling
 * mode the hidden payload may be unavailable, so we resolve a tap by matching the inbound message
 * text against this expected title. `null` means "any inbound message advances" (AWAITING_TAP),
 * because the opening postback button does not post visible user text.
 */
export function expectedTitleForState(state: State, campaign: Campaign): string | null {
  switch (state) {
    case "AWAITING_TAP":
      return null; // any inbound message counts as the tap
    case "AWAITING_FOLLOW":
      return campaign.copy.follow_button ?? "✅ I followed";
    default:
      return null;
  }
}

const CAPPED_FOLLOW_RETRIES = 3;

export function followRetriesExhausted(retries: number): boolean {
  return retries >= CAPPED_FOLLOW_RETRIES;
}

/** Case-insensitive, whitespace-tolerant title comparison for polling-mode tap resolution. */
export function titleMatches(incoming: string | undefined, expected: string): boolean {
  if (!incoming) return false;
  return incoming.trim().toLowerCase() === expected.trim().toLowerCase();
}
