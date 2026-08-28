import { describe, expect, it } from "vitest";
import { COMMENT_PRIVATE_REPLY_WINDOW_SECONDS, evaluateMessagingPolicy, STANDARD_WINDOW_SECONDS } from "../src/policy/messaging";

describe("Instagram messaging policy", () => {
  const now = 2_000_000_000;

  it("allows a standard reply inside 24 hours", () => {
    const result = evaluateMessagingPolicy({ action: "standard_message", now, lastInboundAt: now - STANDARD_WINDOW_SECONDS + 1 });
    expect(result.allowed).toBe(true);
  });

  it("blocks automation outside the standard window", () => {
    const result = evaluateMessagingPolicy({ action: "standard_message", now, lastInboundAt: now - STANDARD_WINDOW_SECONDS - 1 });
    expect(result).toMatchObject({ allowed: false, code: "window_closed" });
  });

  it("allows one private comment reply for seven days", () => {
    const result = evaluateMessagingPolicy({ action: "comment_private_reply", now, commentCreatedAt: now - COMMENT_PRIVATE_REPLY_WINDOW_SECONDS });
    expect(result.allowed).toBe(true);
  });

  it("blocks a duplicate private reply", () => {
    const result = evaluateMessagingPolicy({ action: "comment_private_reply", now, commentCreatedAt: now, privateReplyAlreadySent: true });
    expect(result).toMatchObject({ allowed: false, code: "duplicate_private_reply" });
  });
});
