-- Prefect flow run ledger (replaces jupyter_executions for EXECUTION_BACKEND=prefect)

CREATE TABLE IF NOT EXISTS prefect_flow_runs (
  id TEXT PRIMARY KEY,
  business_type TEXT NOT NULL,
  business_id TEXT NOT NULL,
  deployment_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (business_type, business_id)
);

CREATE INDEX IF NOT EXISTS idx_prefect_flow_runs_status
  ON prefect_flow_runs (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_prefect_flow_runs_business
  ON prefect_flow_runs (business_type, business_id);
