import { id, unixNow } from "../core/id";
import type { AutomationDefinition } from "./schema";
import { validateWorkflow } from "./validator";

interface AutomationTemplateRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  definition_json: string;
  source_automation_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CustomAutomationTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  definition: AutomationDefinition;
  sourceAutomationId: string | null;
  custom: true;
  createdAt: number;
  updatedAt: number;
}

export async function listCustomAutomationTemplates(db: D1Database): Promise<CustomAutomationTemplate[]> {
  const rows = await db.prepare("SELECT * FROM automation_templates ORDER BY updated_at DESC").all<AutomationTemplateRow>();
  return (rows.results ?? []).flatMap((row) => {
    try {
      return [{
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        definition: JSON.parse(row.definition_json) as AutomationDefinition,
        sourceAutomationId: row.source_automation_id,
        custom: true as const,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }];
    } catch {
      return [];
    }
  });
}

export async function saveCustomAutomationTemplate(
  db: D1Database,
  input: { name: string; definition: unknown; sourceAutomationId?: string },
): Promise<{ id: string }> {
  const validation = validateWorkflow(input.definition);
  if (!validation.valid || !validation.definition) {
    throw new Error(validation.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join(" "));
  }
  const name = input.name.trim();
  if (!name) throw new Error("Template name is required");
  const templateId = id("atpl");
  const timestamp = unixNow();
  await db.prepare(
    `INSERT INTO automation_templates
      (id, name, description, category, definition_json, source_automation_id, created_at, updated_at)
     VALUES (?, ?, ?, 'My templates', ?, ?, ?, ?)`,
  ).bind(
    templateId,
    name.slice(0, 160),
    validation.definition.description || null,
    JSON.stringify(validation.definition),
    input.sourceAutomationId ?? null,
    timestamp,
    timestamp,
  ).run();
  return { id: templateId };
}

export async function deleteCustomAutomationTemplate(db: D1Database, templateId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM automation_templates WHERE id = ?").bind(templateId).run();
  return (result.meta.changes ?? 0) > 0;
}
