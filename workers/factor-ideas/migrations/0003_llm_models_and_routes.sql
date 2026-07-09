CREATE TABLE IF NOT EXISTS llm_provider_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL,
  model_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_key) REFERENCES llm_providers(key) ON DELETE CASCADE,
  UNIQUE(provider_key, model_name)
);

INSERT OR IGNORE INTO llm_provider_models (provider_key, model_name, enabled, sort_order)
SELECT key, default_model, 1, 0
FROM llm_providers
WHERE default_model IS NOT NULL AND trim(default_model) != '';

CREATE TABLE IF NOT EXISTS llm_usage_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usage_key TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  model_name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  temperature REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_key) REFERENCES llm_providers(key) ON DELETE CASCADE,
  UNIQUE(usage_key, provider_key, model_name)
);

INSERT OR IGNORE INTO llm_usage_routes (usage_key, provider_key, model_name, priority, temperature, enabled)
SELECT
  b.usage_key,
  b.provider_key,
  COALESCE(NULLIF(trim(b.model_override), ''), p.default_model),
  0,
  b.temperature,
  1
FROM llm_usage_bindings b
JOIN llm_providers p ON p.key = b.provider_key
WHERE COALESCE(NULLIF(trim(b.model_override), ''), p.default_model) IS NOT NULL
  AND trim(COALESCE(NULLIF(trim(b.model_override), ''), p.default_model)) != '';

DROP TABLE IF EXISTS llm_usage_bindings;
