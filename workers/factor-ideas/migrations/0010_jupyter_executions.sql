CREATE TABLE IF NOT EXISTS jupyter_executions (
  id TEXT PRIMARY KEY,
  server_key TEXT NOT NULL,
  business_type TEXT NOT NULL,
  business_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  kernel_id TEXT,
  session_id TEXT,
  msg_id TEXT,
  error_code TEXT,
  error_reason TEXT,
  submitted_at TEXT,
  completed_at TEXT,
  cleanup_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_type, business_id)
);

CREATE INDEX IF NOT EXISTS idx_jupyter_executions_server_status
  ON jupyter_executions (server_key, status, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_jupyter_executions_cleanup
  ON jupyter_executions (status, cleanup_at, updated_at);
