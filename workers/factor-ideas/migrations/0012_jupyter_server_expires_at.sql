ALTER TABLE jupyter_servers ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jupyter_servers_expires_at
  ON jupyter_servers (expires_at);
