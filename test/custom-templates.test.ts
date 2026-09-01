import { describe, expect, it } from "vitest";
import { deleteCustomAutomationTemplate, listCustomAutomationTemplates, saveCustomAutomationTemplate } from "../src/automation/custom-templates";
import { saveAutomationDraft } from "../src/automation/repository";
import { starterDefinition } from "../src/automation/schema";
import { makeTestDb } from "./helpers/fakeD1";

describe("custom automation templates", () => {
  it("saves, lists, and deletes a reusable workflow snapshot", async () => {
    const db = makeTestDb();
    const definition = starterDefinition("Trial Reel giveaway");
    const campaign = await saveAutomationDraft(db, { definition });
    const saved = await saveCustomAutomationTemplate(db, { name: "My Trial Reel", definition, sourceAutomationId: campaign.automationId });

    const templates = await listCustomAutomationTemplates(db);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ id: saved.id, name: "My Trial Reel", custom: true, sourceAutomationId: campaign.automationId });
    expect(templates[0]?.definition.name).toBe("Trial Reel giveaway");

    expect(await deleteCustomAutomationTemplate(db, saved.id)).toBe(true);
    expect(await listCustomAutomationTemplates(db)).toEqual([]);
  });

  it("rejects invalid workflow definitions", async () => {
    const db = makeTestDb();
    await expect(saveCustomAutomationTemplate(db, { name: "Broken", definition: {} })).rejects.toThrow();
  });
});
