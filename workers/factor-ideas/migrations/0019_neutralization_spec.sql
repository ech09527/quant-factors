-- 二次验证存完整 exposures 配置；默认选型模式改为 auto（AI + 引擎回退）

ALTER TABLE factor_validations ADD COLUMN neutralization_spec TEXT;

UPDATE workflow_settings
   SET value = 'auto', updated_at = datetime('now')
 WHERE key = 'neutral_validation_key' AND value = 'liq_mom';

INSERT INTO workflow_settings (key, value)
VALUES ('neutral_validation_key', 'auto')
ON CONFLICT(key) DO NOTHING;
