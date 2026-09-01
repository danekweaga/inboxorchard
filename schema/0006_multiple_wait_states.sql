-- Preserve completed waits so a journey can pause more than once while still
-- enforcing a single active wait for each automation run.
ALTER TABLE automation_wait_states RENAME TO automation_wait_states_old;
DROP INDEX IF EXISTS idx_automation_wait_due;

CREATE TABLE automation_wait_states (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  wait_type TEXT NOT NULL,
  expected_json TEXT,
  resume_after INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  resumed_at INTEGER
);

INSERT INTO automation_wait_states
  (id, run_id, node_id, wait_type, expected_json, resume_after, expires_at, created_at, resumed_at)
SELECT id, run_id, node_id, wait_type, expected_json, resume_after, expires_at, created_at, resumed_at
FROM automation_wait_states_old;

DROP TABLE automation_wait_states_old;

CREATE INDEX idx_automation_wait_due
  ON automation_wait_states(resume_after, resumed_at);
CREATE UNIQUE INDEX idx_automation_wait_active_run
  ON automation_wait_states(run_id) WHERE resumed_at IS NULL;
