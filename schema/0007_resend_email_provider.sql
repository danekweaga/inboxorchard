-- Add Resend plus calendar-month quota tracking used by safe provider failover.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE email_senders_v2 (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','brevo','resend','mock')),
  email TEXT NOT NULL,
  display_name TEXT,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  credentials_ciphertext TEXT,
  safety_limit INTEGER NOT NULL DEFAULT 450,
  sent_window_start INTEGER,
  sent_in_window INTEGER NOT NULL DEFAULT 0,
  monthly_limit INTEGER,
  sent_month_start INTEGER,
  sent_in_month INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO email_senders_v2 (
  id, provider, email, display_name, purpose, status, credentials_ciphertext,
  safety_limit, sent_window_start, sent_in_window, last_error, created_at, updated_at
)
SELECT
  id, provider, email, display_name, purpose, status, credentials_ciphertext,
  safety_limit, sent_window_start, sent_in_window, last_error, created_at, updated_at
FROM email_senders;

DROP TABLE email_senders;
ALTER TABLE email_senders_v2 RENAME TO email_senders;
CREATE INDEX idx_email_senders_status ON email_senders(status, provider);

ALTER TABLE email_queue ADD COLUMN fallback_enabled INTEGER NOT NULL DEFAULT 1;

PRAGMA defer_foreign_keys = OFF;
