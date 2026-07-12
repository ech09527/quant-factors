CREATE TABLE IF NOT EXISTS test_factor_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL,
  profile_key TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  factor_sql TEXT,
  evaluated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (idea_id, profile_key),
  FOREIGN KEY (idea_id) REFERENCES ideas (id),
  FOREIGN KEY (task_id) REFERENCES ml_tasks (id)
);

CREATE INDEX IF NOT EXISTS idx_test_factor_validations_task_id
  ON test_factor_validations (task_id);

CREATE INDEX IF NOT EXISTS idx_test_factor_validations_idea_id
  ON test_factor_validations (idea_id);

INSERT INTO workflow_settings (key, value)
VALUES ('test_factor_validation_batch_enabled', '0')
ON CONFLICT(key) DO NOTHING;
