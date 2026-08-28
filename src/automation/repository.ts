import { id, sha256, unixNow } from "../core/id";
import type { AutomationDefinition } from "./schema";
import { validateWorkflow } from "./validator";

export interface AutomationListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  trigger_type: string;
  priority: number;
  draft_version_id: string | null;
  published_version_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationVersionRow {
  id: string;
  automation_id: string;
  version: number;
  status: string;
  definition_json: string;
  checksum: string;
  created_at: number;
  published_at: number | null;
}

export async function listAutomations(db: D1Database): Promise<AutomationListItem[]> {
  const rows = await db.prepare("SELECT * FROM automations ORDER BY updated_at DESC").all<AutomationListItem>();
  return rows.results ?? [];
}

export async function getAutomation(db: D1Database, automationId: string): Promise<{
  automation: AutomationListItem;
  draft: { version: AutomationVersionRow; definition: AutomationDefinition } | null;
  published: { version: AutomationVersionRow; definition: AutomationDefinition } | null;
  history: AutomationVersionRow[];
} | null> {
  const automation = await db.prepare("SELECT * FROM automations WHERE id = ?").bind(automationId).first<AutomationListItem>();
  if (!automation) return null;
  const historyResult = await db.prepare("SELECT * FROM automation_versions WHERE automation_id = ? ORDER BY version DESC")
    .bind(automationId).all<AutomationVersionRow>();
  const history = historyResult.results ?? [];
  const parse = (versionId: string | null) => {
    const version = history.find((item) => item.id === versionId);
    if (!version) return null;
    return { version, definition: JSON.parse(version.definition_json) as AutomationDefinition };
  };
  return { automation, draft: parse(automation.draft_version_id), published: parse(automation.published_version_id), history };
}

export async function saveAutomationDraft(
  db: D1Database,
  input: { automationId?: string; definition: unknown },
): Promise<{ automationId: string; versionId: string; version: number }> {
  const validation = validateWorkflow(input.definition);
  if (!validation.valid || !validation.definition) {
    throw new Error(validation.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join(" "));
  }
  const definition = validation.definition;
  const automationId = input.automationId ?? id("auto");
  const timestamp = unixNow();
  const current = await db.prepare("SELECT id FROM automations WHERE id = ?").bind(automationId).first<{ id: string }>();
  const versionRow = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM automation_versions WHERE automation_id = ?")
    .bind(automationId).first<{ version: number }>();
  const version = (versionRow?.version ?? 0) + 1;
  const versionId = id("aver");
  const definitionJson = JSON.stringify(definition);
  const checksum = await sha256(definitionJson);
  if (!current) {
    await db.prepare(
      `INSERT INTO automations
        (id, name, description, status, trigger_type, priority, draft_version_id, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).bind(automationId, definition.name, definition.description, definition.trigger.type, definition.settings.priority, versionId, timestamp, timestamp).run();
  }
  await db.batch([
    db.prepare(
      `INSERT INTO automation_versions
        (id, automation_id, version, status, definition_json, checksum, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(versionId, automationId, version, definitionJson, checksum, timestamp),
    db.prepare(
      `UPDATE automations SET name = ?, description = ?, trigger_type = ?, priority = ?,
       draft_version_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(definition.name, definition.description, definition.trigger.type, definition.settings.priority, versionId, timestamp, automationId),
  ]);
  return { automationId, versionId, version };
}

export async function publishAutomation(db: D1Database, automationId: string, versionId?: string): Promise<void> {
  const automation = await db.prepare("SELECT * FROM automations WHERE id = ?").bind(automationId).first<AutomationListItem>();
  if (!automation) throw new Error("Automation not found");
  const selected = versionId ?? automation.draft_version_id;
  if (!selected) throw new Error("No draft version to publish");
  const version = await db.prepare("SELECT * FROM automation_versions WHERE id = ? AND automation_id = ?")
    .bind(selected, automationId).first<AutomationVersionRow>();
  if (!version) throw new Error("Automation version not found");
  const validation = validateWorkflow(JSON.parse(version.definition_json));
  if (!validation.valid) throw new Error(validation.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join(" "));
  const timestamp = unixNow();
  await db.batch([
    db.prepare("UPDATE automation_versions SET status = 'published', published_at = ? WHERE id = ?")
      .bind(timestamp, selected),
    db.prepare("UPDATE automations SET status = 'published', published_version_id = ?, updated_at = ? WHERE id = ?")
      .bind(selected, timestamp, automationId),
  ]);
}

export async function setAutomationStatus(db: D1Database, automationId: string, status: "published" | "paused" | "draft"): Promise<void> {
  await db.prepare("UPDATE automations SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, unixNow(), automationId).run();
}

export async function deleteAutomation(db: D1Database, automationId: string): Promise<void> {
  const running = await db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ? AND status IN ('running','waiting')")
    .bind(automationId).first<{ count: number }>();
  if ((running?.count ?? 0) > 0) throw new Error("Pause or complete active runs before deleting this automation.");
  await db.prepare("DELETE FROM automations WHERE id = ?").bind(automationId).run();
}

export async function publishedDefinitions(db: D1Database, triggerType: string): Promise<Array<{
  automation: AutomationListItem;
  version: AutomationVersionRow;
  definition: AutomationDefinition;
}>> {
  const rows = await db.prepare(
    `SELECT a.id AS automation_id, a.name, a.description, a.status, a.trigger_type, a.priority,
      a.draft_version_id, a.published_version_id, a.created_at, a.updated_at,
      v.id AS version_id, v.version, v.status AS version_status, v.definition_json, v.checksum,
      v.created_at AS version_created_at, v.published_at
     FROM automations a JOIN automation_versions v ON v.id = a.published_version_id
     WHERE a.status = 'published' AND a.trigger_type = ? ORDER BY a.priority ASC, a.created_at ASC`,
  ).bind(triggerType).all<Record<string, string | number | null>>();
  return (rows.results ?? []).flatMap((row) => {
    try {
      const automation: AutomationListItem = {
        id: String(row.automation_id), name: String(row.name), description: row.description as string | null,
        status: String(row.status), trigger_type: String(row.trigger_type), priority: Number(row.priority),
        draft_version_id: row.draft_version_id as string | null, published_version_id: row.published_version_id as string | null,
        created_at: Number(row.created_at), updated_at: Number(row.updated_at),
      };
      const version: AutomationVersionRow = {
        id: String(row.version_id), automation_id: automation.id, version: Number(row.version),
        status: String(row.version_status), definition_json: String(row.definition_json), checksum: String(row.checksum),
        created_at: Number(row.version_created_at), published_at: row.published_at === null ? null : Number(row.published_at),
      };
      return [{ automation, version, definition: JSON.parse(version.definition_json) as AutomationDefinition }];
    } catch {
      return [];
    }
  });
}
