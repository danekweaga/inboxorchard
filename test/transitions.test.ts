import { describe, expect, it } from "vitest";
import {
  afterFollow,
  afterTap,
  expectedTitleForState,
  followRetriesExhausted,
  titleMatches,
} from "../src/engine/transitions";
import type { Campaign } from "../src/types";

function campaign(overrides: Partial<Campaign>): Campaign {
  return {
    campaign_id: "c",
    media_id: "m",
    keywords: ["LINK"],
    reward: { type: "link", value: "https://x.com" },
    copy: { opening: "hi", delivery: "here {reward}" },
    ...overrides,
  };
}

describe("afterTap (Section 6 state machine)", () => {
  it("goes to AWAITING_FOLLOW when check_follow is on", () => {
    expect(afterTap(campaign({ check_follow: true, ask_email: true }))).toBe("AWAITING_FOLLOW");
  });
  it("skips follow, goes to AWAITING_EMAIL when only ask_email is on", () => {
    expect(afterTap(campaign({ ask_email: true }))).toBe("AWAITING_EMAIL");
  });
  it("goes straight to DELIVER when both gates are off ('send immediately')", () => {
    expect(afterTap(campaign({}))).toBe("DELIVER");
  });
});

describe("afterFollow", () => {
  it("goes to AWAITING_EMAIL when ask_email is on", () => {
    expect(afterFollow(campaign({ ask_email: true }))).toBe("AWAITING_EMAIL");
  });
  it("goes to DELIVER otherwise", () => {
    expect(afterFollow(campaign({}))).toBe("DELIVER");
  });
});

describe("polling-mode tap resolution (expected-title map)", () => {
  it("AWAITING_TAP expects no specific title (any message advances)", () => {
    expect(expectedTitleForState("AWAITING_TAP", campaign({}))).toBeNull();
  });
  it("AWAITING_FOLLOW expects the follow button title", () => {
    const c = campaign({ copy: { opening: "hi", delivery: "d", follow_button: "✅ I followed" } });
    expect(expectedTitleForState("AWAITING_FOLLOW", c)).toBe("✅ I followed");
  });
  it("titleMatches is case-insensitive and whitespace-tolerant", () => {
    expect(titleMatches("  ✅ I FOLLOWED ", "✅ I followed")).toBe(true);
    expect(titleMatches("something else", "✅ I followed")).toBe(false);
    expect(titleMatches(undefined, "x")).toBe(false);
  });
});

describe("follow retry cap (verify_follow_count mode)", () => {
  it("exhausts after 3 retries", () => {
    expect(followRetriesExhausted(0)).toBe(false);
    expect(followRetriesExhausted(2)).toBe(false);
    expect(followRetriesExhausted(3)).toBe(true);
  });
});
