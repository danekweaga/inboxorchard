-- Optional local-only demonstration data.
-- Run after local migrations with: npm run db:seed:demo
-- This file is never applied by deployment or production migrations.

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO tags (id, name, color, created_at)
VALUES ('tag_demo_resource', 'Resource Lead', '#7c3aed', 1787798400);

INSERT OR IGNORE INTO custom_fields (id, name, type, options_json, created_at, updated_at)
VALUES ('field_demo_year', 'University Year', 'number', NULL, 1787798400, 1787798400);

INSERT OR IGNORE INTO resources
  (id, name, description, type, target_url, active, created_at, updated_at)
VALUES
  ('resource_demo_resume', 'Demo Resume Kit', 'Replace this destination with your own creator resource.', 'link', 'https://example.com/resume-kit', 1, 1787798400, 1787798400);

INSERT OR IGNORE INTO email_templates
  (id, name, subject, html_body, text_body, created_at, updated_at)
VALUES
  ('email_template_demo', 'Demo resource follow-up', 'Your resource is ready', '<p>Here is the resource you requested.</p>', 'Here is the resource you requested.', 1787798400, 1787798400);

INSERT OR IGNORE INTO ai_agents
  (id, name, identity_text, tone_text, goal_text, rules_text, confidence_threshold, autopilot_enabled, created_at, updated_at)
VALUES
  ('agent_demo', 'Creator resource assistant', 'A helpful assistant for this creator.', 'Direct, warm, and concise.', 'Answer only from configured knowledge.', 'Never invent offers, prices, or policies.', 0.75, 0, 1787798400, 1787798400);

INSERT OR IGNORE INTO ai_knowledge_sources
  (id, agent_id, type, title, content, search_text, enabled, created_at, updated_at)
VALUES
  ('knowledge_demo', 'agent_demo', 'text', 'Demo resource', 'The Demo Resume Kit is a starter resource. Replace this text with your real FAQ and offer details.', 'demo resource resume kit starter faq offer details', 1, 1787798400, 1787798400);

INSERT OR IGNORE INTO contacts
  (id, instagram_user_id, username, display_name, email, lead_score, source_content_id, first_seen_at, last_seen_at, created_at, updated_at)
VALUES
  ('contact_demo', 'demo_instagram_user', 'demo.creator', 'Demo Contact', 'demo@example.com', 10, 'media_demo', 1787798400, 1787798520, 1787798400, 1787798520);

INSERT OR IGNORE INTO contact_identities
  (id, contact_id, provider, external_id, username, profile_json, created_at, updated_at)
VALUES
  ('identity_demo', 'contact_demo', 'instagram', 'demo_instagram_user', 'demo.creator', '{}', 1787798400, 1787798400);

INSERT OR IGNORE INTO contact_tags (contact_id, tag_id, added_at)
VALUES ('contact_demo', 'tag_demo_resource', 1787798460);

INSERT OR IGNORE INTO contact_field_values (contact_id, field_id, value_json, updated_at)
VALUES ('contact_demo', 'field_demo_year', '2', 1787798480);

INSERT OR IGNORE INTO conversations_v2
  (id, contact_id, channel, status, source_type, source_external_id, last_inbound_at, last_outbound_at, messaging_window_expires_at, unread_count, created_at, updated_at)
VALUES
  ('conversation_demo', 'contact_demo', 'instagram', 'open', 'instagram_comment', 'media_demo', 1787798460, 1787798520, 1787884860, 0, 1787798400, 1787798520);

INSERT OR IGNORE INTO messages
  (id, conversation_id, contact_id, external_message_id, direction, kind, text, delivery_status, provider_timestamp, created_at)
VALUES
  ('message_demo_in', 'conversation_demo', 'contact_demo', 'demo_message_in', 'inbound', 'text', 'RESUME', 'received', 1787798460, 1787798460),
  ('message_demo_out', 'conversation_demo', 'contact_demo', 'demo_message_out', 'outbound', 'text', 'Got you — here is the guide.', 'sent', 1787798520, 1787798520);

INSERT OR IGNORE INTO timeline_events
  (id, contact_id, conversation_id, type, summary, metadata_json, created_at)
VALUES
  ('timeline_demo_in', 'contact_demo', 'conversation_demo', 'message_received', 'Sent “RESUME”', '{}', 1787798460),
  ('timeline_demo_tag', 'contact_demo', 'conversation_demo', 'tag_added', 'Tag added: Resource Lead', '{}', 1787798480),
  ('timeline_demo_delivery', 'contact_demo', 'conversation_demo', 'resource_delivered', 'Demo Resume Kit delivered', '{}', 1787798520);

INSERT OR IGNORE INTO automations
  (id, name, description, status, trigger_type, priority, draft_version_id, published_version_id, created_at, updated_at)
VALUES
  ('automation_demo_resume', 'Demo Resume Resource', 'A portable keyword-to-resource example.', 'published', 'keyword', 100, 'automation_version_demo_resume', 'automation_version_demo_resume', 1787798400, 1787798400);

INSERT OR IGNORE INTO automation_versions
  (id, automation_id, version, status, definition_json, checksum, created_at, published_at)
VALUES
  ('automation_version_demo_resume', 'automation_demo_resume', 1, 'published',
   '{"schemaVersion":1,"name":"Demo Resume Resource","description":"A portable keyword-to-resource example.","trigger":{"type":"keyword","config":{"match":{"mode":"contains_any","include":["RESUME","CV"],"exclude":["SCAM"],"caseSensitive":false}}},"startNodeId":"resource","nodes":[{"id":"resource","type":"send_resource","label":"Send tracked resource","position":{"x":80,"y":120},"config":{"resourceId":"resource_demo_resume"}},{"id":"end","type":"end","label":"End","position":{"x":380,"y":120},"config":{}}],"edges":[{"id":"e_resource_end","source":"resource","target":"end"}],"settings":{"stopOtherAutomations":true,"priority":100}}',
   'demo-seed-checksum', 1787798400, 1787798400);

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('demo.seeded', 'true', 1787798400);
