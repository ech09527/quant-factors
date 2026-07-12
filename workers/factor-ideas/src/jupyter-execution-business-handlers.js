import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import { reportFactorValidationResults } from "./factor-validation-db.js";
import { markerResultToReportItems } from "./jupyter-execution-completion.js";
import { getJupyterExecutionById } from "./jupyter-execution-db.js";
import { loadExecutionJob } from "./jupyter-execution-jobs.js";
import { reportTestFactorValidationResults } from "./test-factor-validation-db.js";

export async function handleJupyterExecutionBusinessCompletion(env, event) {
  const parsed = event?.parsed;
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  if (results.length === 0) {
    return { updated: 0 };
  }

  const execution = await getJupyterExecutionById(env.DB, event.executionId);
  if (!execution) {
    return { updated: 0 };
  }

  const job = await loadExecutionJob(env.DB, execution);
  if (!job) {
    return { updated: 0 };
  }

  const items = markerResultToReportItems(String(event.businessType ?? ""), job, parsed);
  if (event.businessType === "test_factor_validation") {
    return reportTestFactorValidationResults(env.DB, items);
  }
  if (event.businessType === "factor_validation") {
    return reportFactorValidationResults(env.DB, items);
  }

  return { updated: 0 };
}

export async function reportJupyterExecutionBusinessFailure(
  env,
  execution,
  job,
  errorReason,
  stage
) {
  const message = String(errorReason ?? "jupyter execution failed").slice(0, 4000);
  if (execution.business_type === "test_factor_validation") {
    const status = resolveFactorValidationTerminalStatus("failed", message);
    await reportTestFactorValidationResults(env.DB, [
      {
        task_id: job.task_id,
        test_factor_validation_id: job.test_factor_validation_id,
        status,
        factor_sql: job.factor_sql,
        diagnostics: { error: message, stage, mock_validation: true },
        error_reason: message
      }
    ]);
    return status;
  }
  if (execution.business_type === "factor_validation") {
    const status = resolveFactorValidationTerminalStatus("failed", message);
    await reportFactorValidationResults(env.DB, [
      {
        task_id: job.task_id,
        factor_validation_id: job.factor_validation_id,
        status,
        factor_sql: job.factor_sql,
        diagnostics: { error: message, stage },
        error_reason: message
      }
    ]);
    return status;
  }
  return "failed";
}
