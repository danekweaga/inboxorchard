import type { AutomationNode } from "../automation/schema";

const COLUMN_GAP = 260;
const ROW_GAP = 155;

export function arrangeAutomationNodes(nodes: AutomationNode[], columns = 3): AutomationNode[] {
  const safeColumns = Math.max(1, Math.floor(columns));
  return nodes.map((node, index) => {
    const row = Math.floor(index / safeColumns);
    const column = index % safeColumns;
    const visualColumn = row % 2 === 0 ? column : safeColumns - 1 - column;
    return {
      ...node,
      position: { x: 55 + visualColumn * COLUMN_GAP, y: 65 + row * ROW_GAP },
    };
  });
}

export function compactLinearAutomation(nodes: AutomationNode[]): AutomationNode[] {
  if (nodes.length < 4) return nodes;
  const rows = new Set(nodes.map((node) => Math.round(node.position.y / 40)));
  const xs = nodes.map((node) => node.position.x);
  const horizontalSpan = Math.max(...xs) - Math.min(...xs);
  return rows.size <= 1 && horizontalSpan > 780 ? arrangeAutomationNodes(nodes) : nodes;
}
