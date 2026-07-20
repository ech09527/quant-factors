-- 因子验证支持中性化变体：同一 idea + profile 可存原始与中性化结果

CREATE TABLE factor_validations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL,
  profile_key TEXT NOT NULL,
  neutralization_key TEXT NOT NULL DEFAULT 'none',
  task_id INTEGER NOT NULL,
  factor_sql TEXT,
  evaluated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (idea_id, profile_key, neutralization_key),
  FOREIGN KEY (idea_id) REFERENCES ideas (id),
  FOREIGN KEY (task_id) REFERENCES ml_tasks (id)
);

INSERT INTO factor_validations_new (
  id, idea_id, profile_key, neutralization_key, task_id, factor_sql, evaluated_at, created_at, updated_at
)
SELECT
  id, idea_id, profile_key, 'none', task_id, factor_sql, evaluated_at, created_at, updated_at
FROM factor_validations;

DROP TABLE factor_validations;

ALTER TABLE factor_validations_new RENAME TO factor_validations;

CREATE INDEX IF NOT EXISTS idx_factor_validations_task_id
  ON factor_validations (task_id);

CREATE INDEX IF NOT EXISTS idx_factor_validations_idea_id
  ON factor_validations (idea_id);

CREATE INDEX IF NOT EXISTS idx_factor_validations_neutralization
  ON factor_validations (neutralization_key);

INSERT INTO workflow_settings (key, value)
VALUES
  ('neutral_validation_batch_enabled', '0'),
  ('neutral_validation_min_abs_mean_rank_ic', '0.01'),
  ('neutral_validation_batch_limit', '10'),
  ('neutral_validation_key', 'liq_mom')
ON CONFLICT(key) DO NOTHING;
