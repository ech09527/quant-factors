import { reportFactorValidationResults } from "./factor-validation-db.js";
import { reportTestFactorValidationResults } from "./test-factor-validation-db.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function mergeResultDiagnostics(evaluation, result) {
  const evalDiagnostics = asObject(evaluation?.diagnostics) ?? {};
  const resultDiagnostics = asObject(result?.diagnostics) ?? {};
  const timing = asObject(result?.timing) ?? {};
  const metrics = asObject(evaluation?.metrics);
  const merged = { ...evalDiagnostics, ...resultDiagnostics };
  if (metrics && Object.keys(metrics).length > 0) {
    merged.metrics = metrics;
  }
  if (Object.keys(timing).length > 0) {
    merged.timing = { ...(asObject(merged.timing) ?? {}), ...timing };
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function mapSingleResultToReportItem(businessType, job, result) {
  const evaluation = asObject(result?.evaluation);
  const mlflow = asObject(result?.mlflow);
  const item = {
    task_id: Number(result?.task_id ?? job?.task_id),
    status: String(result?.status ?? "failed"),
    factor_sql: evaluation?.factor_sql ?? job?.factor_sql ?? null,
    evaluated_at: evaluation?.evaluated_at ?? result?.evaluated_at ?? null,
    error_reason: result?.error_reason ?? evaluation?.error_reason ?? null,
    diagnostics: mergeResultDiagnostics(evaluation, result),
    mlflow_run_id: mlflow?.mlflow_run_id == null ? null : String(mlflow.mlflow_run_id),
    mlflow_experiment: mlflow?.mlflow_experiment == null ? null : String(mlflow.mlflow_experiment),
    mlflow_run_url: mlflow?.mlflow_run_url == null ? null : String(mlflow.mlflow_run_url)
  };

  if (businessType === "test_factor_validation") {
    item.test_factor_validation_id = Number(
      result?.test_factor_validation_id ?? job?.test_factor_validation_id
    );
  } else if (businessType === "factor_validation") {
    item.factor_validation_id = Number(result?.factor_validation_id ?? job?.factor_validation_id);
  }

  return item;
}

export function markerResultToReportItems(businessType, job, parsed) {
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results.map((result) => mapSingleResultToReportItem(businessType, job, result));
}

export function mapBusinessStatusToExecutionStatus(status) {
  const normalized = String(status ?? "").trim();
  if (normalized === "success") {
    return "succeeded";
  }
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "skipped") {
    return "skipped";
  }
  return "failed";
}

function pickTerminalStatusFromResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "failed";
  }
  return mapBusinessStatusToExecutionStatus(results[0]?.status);
}

export async function applyMarkerCompletion(env, execution, job, parsed) {
  const businessType = String(execution?.business_type ?? "");
  const items = markerResultToReportItems(businessType, job, parsed);
  const terminalStatus = pickTerminalStatusFromResults(parsed?.results);

  if (businessType === "test_factor_validation") {
    const result = await reportTestFactorValidationResults(env.DB, items);
    return { terminalStatus, result };
  }
  if (businessType === "factor_validation") {
    const result = await reportFactorValidationResults(env.DB, items);
    return { terminalStatus, result };
  }

  throw new Error(`unsupported jupyter execution business_type: ${businessType}`);
}

export function buildCompletionEvent(execution, terminalStatus, parsed, errorCode = null, errorReason = null) {
  const firstResult = Array.isArray(parsed?.results) ? parsed.results[0] : null;
  const evaluation = asObject(firstResult?.evaluation);
  const diagnostics =
    asObject(firstResult?.diagnostics) ??
    asObject(evaluation?.diagnostics) ??
    null;
  const reportPhase =
    diagnostics?.report_phase == null ? null : String(diagnostics.report_phase);

  return {
    executionId: String(execution.id),
    businessType: String(execution.business_type),
    businessId: String(execution.business_id),
    status: terminalStatus,
    errorCode: errorCode == null ? null : String(errorCode),
    errorReason: errorReason == null ? null : String(errorReason),
    reportPhase,
    diagnostics,
    parsed
  };
}
