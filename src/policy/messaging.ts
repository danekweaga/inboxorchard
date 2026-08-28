export type PolicyAction = "standard_message" | "comment_private_reply" | "manual_human_reply";

export interface MessagingPolicyInput {
  action: PolicyAction;
  now: number;
  lastInboundAt?: number | null;
  commentCreatedAt?: number | null;
  privateReplyAlreadySent?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  code: "allowed" | "window_closed" | "comment_window_closed" | "duplicate_private_reply" | "missing_context";
  reason: string;
  expiresAt?: number;
}

export const STANDARD_WINDOW_SECONDS = 24 * 60 * 60;
export const COMMENT_PRIVATE_REPLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export function evaluateMessagingPolicy(input: MessagingPolicyInput): PolicyDecision {
  if (input.action === "comment_private_reply") {
    if (input.privateReplyAlreadySent) {
      return { allowed: false, code: "duplicate_private_reply", reason: "Meta permits one private reply per comment." };
    }
    if (!input.commentCreatedAt) {
      return { allowed: false, code: "missing_context", reason: "The comment timestamp is required for a private reply." };
    }
    const expiresAt = input.commentCreatedAt + COMMENT_PRIVATE_REPLY_WINDOW_SECONDS;
    return input.now <= expiresAt
      ? { allowed: true, code: "allowed", reason: "Comment private-reply window is open.", expiresAt }
      : { allowed: false, code: "comment_window_closed", reason: "The comment private-reply window has closed.", expiresAt };
  }

  if (!input.lastInboundAt) {
    return { allowed: false, code: "missing_context", reason: "No eligible inbound interaction is recorded." };
  }
  const expiresAt = input.lastInboundAt + STANDARD_WINDOW_SECONDS;
  return input.now <= expiresAt
    ? { allowed: true, code: "allowed", reason: "Messaging window is open.", expiresAt }
    : { allowed: false, code: "window_closed", reason: "The standard Instagram messaging window has closed.", expiresAt };
}
