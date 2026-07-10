CREATE TABLE IF NOT EXISTS workflow_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workflow_settings (key, value)
VALUES ('validation_batch_enabled', '0')
ON CONFLICT(key) DO NOTHING;
