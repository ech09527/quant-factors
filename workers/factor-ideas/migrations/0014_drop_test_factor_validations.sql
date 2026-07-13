DELETE FROM prefect_flow_runs WHERE business_type = 'test_factor_validation';
DELETE FROM jupyter_executions WHERE business_type = 'test_factor_validation';
DROP TABLE IF EXISTS test_factor_validations;
DELETE FROM ml_tasks WHERE business_type = 'test_factor_validation';
DELETE FROM workflow_settings WHERE key = 'test_factor_validation_batch_enabled';
