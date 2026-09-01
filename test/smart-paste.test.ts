import { describe, expect, it } from "vitest";
import { buildAiListPrompt, parseSmartList } from "../src/client/smart-paste";

describe("smart list paste", () => {
  it("separates comma, line, bullet, and numbered keyword lists into unique items", () => {
    expect(parseSmartList("guide, toolkit; GUIDE\n• checklist\n4. templates", "keywords")).toEqual([
      "guide", "toolkit", "checklist", "templates",
    ]);
  });

  it("keeps commas inside reply sentences while separating pasted lines", () => {
    expect(parseSmartList("1. Got you, check your DMs\n- Just sent it 👀", "lines")).toEqual([
      "Got you, check your DMs", "Just sent it 👀",
    ]);
  });

  it("builds provider-neutral prompts with paste-friendly output rules", () => {
    const prompt = buildAiListPrompt("keywords", "comment");
    expect(prompt).toContain("Offer/topic:");
    expect(prompt).toContain("one per line");
    expect(prompt).not.toContain("ChatGPT");
  });
});
