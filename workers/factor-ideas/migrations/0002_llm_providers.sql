CREATE TABLE IF NOT EXISTS llm_providers (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  default_model TEXT NOT NULL,
  auth_header TEXT NOT NULL DEFAULT 'Authorization',
  auth_scheme TEXT NOT NULL DEFAULT 'Bearer',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_usage_bindings (
  usage_key TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL,
  model_override TEXT,
  temperature REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_key) REFERENCES llm_providers(key)
);

INSERT OR IGNORE INTO llm_usage_bindings (usage_key, provider_key, temperature)
SELECT 'idea_generation', key, 0.2
FROM llm_providers
WHERE enabled = 1
ORDER BY sort_order ASC, key ASC
LIMIT 1;

INSERT OR IGNORE INTO llm_usage_bindings (usage_key, provider_key, temperature)
SELECT 'validation_translation', key, 0.1
FROM llm_providers
WHERE enabled = 1
ORDER BY sort_order ASC, key ASC
LIMIT 1;
