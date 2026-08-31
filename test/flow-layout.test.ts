import { describe, expect, it } from "vitest";
import type { AutomationNode } from "../src/automation/schema";
import { arrangeAutomationNodes, compactLinearAutomation } from "../src/client/flow-layout";

function steps(count: number): AutomationNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `step_${index}`,
    type: index === count - 1 ? "end" : "send_text",
    label: `Step ${index + 1}`,
    config: index === count - 1 ? {} : { text: `Message ${index + 1}` },
    position: { x: 70 + index * 235, y: 150 },
  }));
}

describe("automation canvas layout", () => {
  it("wraps a long journey into a compact three-column snake", () => {
    const arranged = arrangeAutomationNodes(steps(7));
    expect(arranged.map((node) => node.position)).toEqual([
      { x: 55, y: 65 }, { x: 315, y: 65 }, { x: 575, y: 65 },
      { x: 575, y: 220 }, { x: 315, y: 220 }, { x: 55, y: 220 },
      { x: 55, y: 375 },
    ]);
  });

  it("keeps an existing custom multi-row arrangement", () => {
    const custom = steps(5).map((node, index) => ({ ...node, position: { x: index * 120, y: index % 2 * 180 } }));
    expect(compactLinearAutomation(custom)).toEqual(custom);
  });
});
