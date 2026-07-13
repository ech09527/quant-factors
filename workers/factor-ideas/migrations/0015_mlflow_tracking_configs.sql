CREATE TABLE IF NOT EXISTS mlflow_tracking_configs (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tracking_uri TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  experiment TEXT NOT NULL DEFAULT 'factor-validation',
  enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mlflow_tracking_configs_enabled_sort
  ON mlflow_tracking_configs (enabled, sort_order, key);
