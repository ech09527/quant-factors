CREATE TABLE IF NOT EXISTS ml_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_type TEXT NOT NULL,
  business_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  mlflow_experiment TEXT,
  mlflow_run_id TEXT,
  error_reason TEXT,
  diagnostics TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_type, business_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_tasks_status_updated
  ON ml_tasks (status, updated_at);

CREATE TABLE IF NOT EXISTS factor_validations (
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

CREATE INDEX IF NOT EXISTS idx_factor_validations_task_id
  ON factor_validations (task_id);

CREATE INDEX IF NOT EXISTS idx_factor_validations_idea_id
  ON factor_validations (idea_id);

INSERT INTO workflow_settings (key, value)
VALUES ('factor_validation_batch_enabled', '0')
ON CONFLICT(key) DO NOTHING;
