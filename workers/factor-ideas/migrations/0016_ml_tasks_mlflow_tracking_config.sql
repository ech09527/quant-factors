ALTER TABLE ml_tasks ADD COLUMN mlflow_tracking_config_key TEXT;

CREATE INDEX IF NOT EXISTS idx_ml_tasks_mlflow_tracking_config_key
  ON ml_tasks (mlflow_tracking_config_key);
