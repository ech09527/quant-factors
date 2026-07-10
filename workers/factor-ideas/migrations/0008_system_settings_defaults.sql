INSERT INTO workflow_settings (key, value)
VALUES
  ('kernel_cleanup_enabled', '1'),
  ('validation_batch_limit', '10')
ON CONFLICT(key) DO NOTHING;
