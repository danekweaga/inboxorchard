import { describe, expect, it } from "vitest";
import { deleteAutomation, listAutomations, publishAutomation, saveAutomationDraft, setAutomationStatus } from "../src/automation/repository";
import { starterDefinition } from "../src/automation/schema";
import { makeTestDb } from "./helpers/fakeD1";

describe("campaign lifecycle controls", () => {
  it("lists active campaigns, stops them, and deletes them after work is done", async () => {
    const db = makeTestDb();
    const saved = await saveAutomationDraft(db, { definition: starterDefinition("Trial Reel campaign") });
    await publishAutomation(db, saved.automationId);

    expect(await listAutomations(db)).toMatchObject([{ id: saved.automationId, status: "published", active_run_count: 0 }]);
    await setAutomationStatus(db, saved.automationId, "paused");
    expect((await listAutomations(db))[0]?.status).toBe("paused");

    await deleteAutomation(db, saved.automationId);
    expect(await listAutomations(db)).toEqual([]);
  });
});
