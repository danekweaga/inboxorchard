-- Inbox Orchard platform schema.
-- Keeps the original chatmany campaign tables intact as a compatibility path while adding
-- normalized inbox, CRM, workflow, resource, email, AI, usage, and reliability domains.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  username TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  token_status TEXT,
  token_expires_at INTEGER,
  webhook_status TEXT,
  credentials_ciphertext TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_provider
  ON channel_connections(provider);

CREATE TABLE IF NOT EXISTS instagram_media (
  id TEXT PRIMARY KEY,
  media_type TEXT,
  caption TEXT,
  permalink TEXT,
  thumbnail_url TEXT,
  media_url TEXT,
  comments_count INTEGER,
  published_at INTEGER,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instagram_media_published
  ON instagram_media(published_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  instagram_user_id TEXT UNIQUE,
  username TEXT,
  display_name TEXT,
  email TEXT,
  lead_score INTEGER NOT NULL DEFAULT 0,
  source_content_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_identities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  username TEXT,
  profile_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(contact_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id, added_at DESC);

CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('text','number','boolean','date','email','url','select')),
  options_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_field_values (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(contact_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_field_values_field ON contact_field_values(field_id);

CREATE TABLE IF NOT EXISTS conversations_v2 (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'instagram',
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_type TEXT,
  source_external_id TEXT,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  messaging_window_expires_at INTEGER,
  automation_lock_run_id TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_updated ON conversations_v2(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_v2_unread ON conversations_v2(unread_count, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations_v2(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','system')),
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  payload_json TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'received',
  provider_timestamp INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations_v2(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_contact ON timeline_events(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events(status, next_attempt_at, received_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  trigger_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  draft_version_id TEXT,
  published_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_status_trigger
  ON automations(status, trigger_type, priority);

CREATE TABLE IF NOT EXISTS automation_versions (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  definition_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(automation_id, version)
);
CREATE INDEX IF NOT EXISTS idx_automation_versions_automation
  ON automation_versions(automation_id, version DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES automation_versions(id) ON DELETE RESTRICT,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations_v2(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL,
  trigger_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  current_node_id TEXT,
  context_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(automation_id, trigger_event_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_contact
  ON automation_runs(contact_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status
  ON automation_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS automation_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_automation_run_steps_run
  ON automation_run_steps(run_id, started_at);

CREATE TABLE IF NOT EXISTS automation_wait_states (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  wait_type TEXT NOT NULL,
  expected_json TEXT,
  resume_after INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  resumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_automation_wait_due
  ON automation_wait_states(resume_after, resumed_at);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK(type IN ('link','file','image','pdf','text')),
  target_url TEXT,
  r2_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_active ON resources(active, updated_at DESC);

CREATE TABLE IF NOT EXISTS tracked_links (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  destination_url TEXT NOT NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  campaign TEXT,
  source_content_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  ip_hash TEXT,
  user_agent TEXT,
  referrer TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_clicks_link ON link_clicks(tracked_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_clicks_contact ON link_clicks(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_senders (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','brevo','mock')),
  email TEXT NOT NULL,
  display_name TEXT,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  credentials_ciphertext TEXT,
  safety_limit INTEGER NOT NULL DEFAULT 450,
  sent_window_start INTEGER,
  sent_in_window INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_senders_status ON email_senders(status, provider);

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_queue (
  id TEXT PRIMARY KEY,
  sender_id TEXT REFERENCES email_senders(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  recipient TEXT NOT NULL,
  template_id TEXT REFERENCES email_templates(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER,
  last_error TEXT,
  provider_message_id TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_queue_due
  ON email_queue(status, next_attempt_at, scheduled_at);

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES email_queue(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  safe_payload_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_events_queue ON email_events(queue_id, created_at);

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  action_json TEXT NOT NULL,
  UNIQUE(sequence_id, position)
);

CREATE TABLE IF NOT EXISTS sequence_subscriptions (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  next_step_position INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(sequence_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_sequence_subscriptions_due
  ON sequence_subscriptions(status, next_run_at);

CREATE TABLE IF NOT EXISTS ai_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  identity_text TEXT NOT NULL DEFAULT '',
  tone_text TEXT NOT NULL DEFAULT '',
  goal_text TEXT NOT NULL DEFAULT '',
  rules_text TEXT NOT NULL DEFAULT '',
  confidence_threshold REAL NOT NULL DEFAULT 0.75,
  autopilot_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_knowledge_sources (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES ai_agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  search_text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_agent ON ai_knowledge_sources(agent_id, enabled);

CREATE TABLE IF NOT EXISTS custom_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  schema_json TEXT,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  credentials_ciphertext TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
  ON integration_connections(provider, status);

CREATE TABLE IF NOT EXISTS conversion_events (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  source_content_id TEXT,
  type TEXT NOT NULL,
  value_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversion_events_created ON conversion_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversion_events_content ON conversion_events(source_content_id, type);

CREATE TABLE IF NOT EXISTS usage_counters (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(day, metric)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  safe_metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS durable_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 100,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_durable_jobs_due
  ON durable_jobs(status, available_at, priority, created_at);

PRAGMA optimize;
