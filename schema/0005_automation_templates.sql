CREATE TABLE IF NOT EXISTS automation_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'My templates',
  definition_json TEXT NOT NULL,
  source_automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_templates_updated
  ON automation_templates(updated_at DESC);
