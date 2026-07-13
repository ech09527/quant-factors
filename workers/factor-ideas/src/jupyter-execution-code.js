import { buildFactorValidationEvalCode } from "./factor-validation-kernel-builder.js";
import { buildAsyncEvalCode } from "./eval-kernel-builder.js";
import { buildJupyterExecutionCallbackConfig, wrapJupyterExecutionCodeWithHttpCallback } from "./jupyter-execution-callback-python.js";
import { readMlflowConfig, readReportConfig } from "./jupyter-execution-config.js";

function buildIdeaForEval(job) {
  return {
    title: job.title,
    title_hash: job.title_hash,
    formula_sketch: job.formula_sketch,
    data_sources: job.data_sources
  };
}

export function buildJupyterExecutionCode(env, execution, job, runtimeConfig) {
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  let innerCode;

  if (execution.business_type === "factor_validation") {
    const payload = {
      sample_start: sampleStart,
      jobs: [
        {
          task_id: Number(job.task_id),
          factor_validation_id: Number(job.factor_validation_id),
          idea_id: Number(job.idea_id),
          idea: buildIdeaForEval(job),
          factor_sql: job.factor_sql,
          profile_key: String(job.profile_key),
          validation_profile_key: String(job.profile_key),
          label_kind: job.label_kind,
          horizon_bars: job.horizon_bars
        }
      ],
      runtime_config: runtimeConfig,
      mlflow_config: readMlflowConfig(env),
      mlflow_slim: runtimeConfig?.mlflow_slim !== false,
      mlflow_preinstalled: runtimeConfig?.mlflow_preinstalled !== false
    };
    innerCode = buildFactorValidationEvalCode(payload);
  } else if (execution.business_type === "legacy_validation") {
    const reportConfig = readReportConfig(env, runtimeConfig);
    const payload = {
      sample_start: sampleStart,
      jobs: [
        {
          validation_id: Number(job.validation_id),
          idea: buildIdeaForEval(job),
          factor_sql: job.factor_sql,
          profile_key: String(job.profile_key),
          validation_profile_key: String(job.profile_key),
          label_kind: job.label_kind,
          horizon_bars: job.horizon_bars
        }
      ],
      runtime_config: runtimeConfig
    };
    return buildAsyncEvalCode(payload, reportConfig);
  } else {
    throw new Error(`不支持的 jupyter execution business_type: ${execution.business_type}`);
  }

  const callbackConfig = buildJupyterExecutionCallbackConfig(env, execution, runtimeConfig);
  return wrapJupyterExecutionCodeWithHttpCallback(innerCode, callbackConfig);
}

export function jupyterExecutionReportPath(execution) {
  if (execution.business_type === "factor_validation") {
    return "/api/workflow/ml-tasks/report";
  }
  if (execution.business_type === "legacy_validation") {
    return "/api/workflow/validation-jobs/report";
  }
  throw new Error(`不支持的 report path: ${execution.business_type}`);
}
