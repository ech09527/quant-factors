import { prefectExecutionEnabled } from "./prefect-execution-config.js";
import { getPrefectFlowRun } from "./prefect-client.js";
import {
  listActivePrefectFlowRuns,
  updatePrefectFlowRunStatus
} from "./prefect-execution-db.js";
import {
  failMlTaskIfRunning,
  getMlTaskById,
  parseJsonObject,
  reportMlTaskResults
} from "./ml-task-db.js";

const PREFECT_TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CRASHED", "CANCELLED", "CANCELED"]);
const RECONCILE_GRACE_MS = 60_000;

function mapPrefectApiState(flowRun) {
  const stateType = String(
    flowRun?.state_type ?? flowRun?.state?.type ?? ""
  ).trim().toUpperCase();
  if (stateType === "COMPLETED") {
    return "completed";
  }
  if (PREFECT_TERMINAL_STATES.has(stateType) && stateType !== "COMPLETED") {
    return "failed";
  }
  if (stateType === "RUNNING") {
    return "running";
  }
  if (stateType === "PENDING") {
    return "pending";
  }
  return "scheduled";
}

function prefectFlowEndedAt(flowRun) {
  const endTime =
    flowRun?.end_time ??
    flowRun?.state?.timestamp ??
    flowRun?.state?.state_details?.transitioned_at ??
    null;
  if (!endTime) {
    return null;
  }
  const parsed = Date.parse(String(endTime));
  return Number.isFinite(parsed) ? parsed : null;
}

async function reconcileMlTaskAfterTerminalPrefectFlow(db, taskId, { prefectStatus, flowRun }) {
  const row = await getMlTaskById(db, taskId);
  if (!row || row.status !== "running") {
    return { updated: 0, reason: "ml_task_not_running" };
  }

  const diagnostics = parseJsonObject(row.diagnostics) ?? {};
  const endedAt = prefectFlowEndedAt(flowRun);
  if (endedAt != null && Date.now() - endedAt < RECONCILE_GRACE_MS) {
    return { updated: 0, reason: "grace_period" };
  }

  if (row.mlflow_run_id || diagnostics.mlflow_run_url) {
    const result = await reportMlTaskResults(db, [
      {
        task_id: taskId,
        status: "success",
        diagnostics: {
          ...diagnostics,
          report_phase: "mlflow",
          prefect_reconciled: true
        },
        mlflow_run_id: row.mlflow_run_id,
        mlflow_experiment: row.mlflow_experiment,
        mlflow_run_url: diagnostics.mlflow_run_url ?? null
      }
    ]);
    return {
      updated: Number(result.results?.[0]?.updated ?? 0),
      status: "success",
      reason: "reconciled_success"
    };
  }

  const mlflowError = String(diagnostics.mlflow_error ?? "").trim();
  const errorReason =
    mlflowError ||
    String(flowRun?.state?.message ?? "").trim() ||
    (prefectStatus === "failed"
      ? "prefect flow failed without terminal worker report"
      : "prefect flow completed without terminal worker report");

  const failed = await failMlTaskIfRunning(db, taskId, errorReason);
  return {
    updated: failed.updated,
    status: "failed",
    reason: "reconciled_failed"
  };
}

export async function reconcilePrefectFlowRunFromApi(env, record) {
  if (!record?.id) {
    return { updated: 0, reason: "missing_flow_run" };
  }

  let flowRun;
  try {
    flowRun = await getPrefectFlowRun(env, record.id);
  } catch (error) {
    return {
      updated: 0,
      reason: "prefect_api_error",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const prefectStatus = mapPrefectApiState(flowRun);
  const ledgerStatus = String(record.status ?? "").trim().toLowerCase();
  let ledgerUpdated = 0;

  if (prefectStatus !== ledgerStatus) {
    const errorReason =
      prefectStatus === "failed"
        ? String(flowRun?.state?.message ?? "prefect flow failed").slice(0, 500)
        : null;
    const result = await updatePrefectFlowRunStatus(
      env.DB,
      record.id,
      prefectStatus,
      errorReason
    );
    ledgerUpdated = Number(result?.updated ?? 0);
  }

  let mlTaskUpdated = 0;
  if (["completed", "failed"].includes(prefectStatus)) {
    const taskId = Number(record.business_id);
    if (Number.isFinite(taskId) && taskId > 0) {
      const mlResult = await reconcileMlTaskAfterTerminalPrefectFlow(env.DB, taskId, {
        prefectStatus,
        flowRun
      });
      mlTaskUpdated = Number(mlResult.updated ?? 0);
    }
  }

  return {
    updated: ledgerUpdated + mlTaskUpdated,
    prefect_status: prefectStatus,
    ledger_updated: ledgerUpdated,
    ml_task_updated: mlTaskUpdated
  };
}

export async function reconcilePrefectFlowRunsFromApi(env, options = {}) {
  if (!prefectExecutionEnabled(env)) {
    return { skipped: true, reason: "prefect_execution_disabled" };
  }

  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  const activeRuns = await listActivePrefectFlowRuns(env.DB, options.businessType ?? null, limit);

  let reconciled = 0;
  let ledgerSynced = 0;
  let mlTasksFixed = 0;
  const errors = [];

  for (const record of activeRuns) {
    try {
      const result = await reconcilePrefectFlowRunFromApi(env, record);
      if (Number(result.updated ?? 0) > 0) {
        reconciled += 1;
      }
      ledgerSynced += Number(result.ledger_updated ?? 0) > 0 ? 1 : 0;
      mlTasksFixed += Number(result.ml_task_updated ?? 0) > 0 ? 1 : 0;
      if (result.reason === "prefect_api_error") {
        errors.push({ flow_run_id: record.id, error: result.error });
      }
    } catch (error) {
      errors.push({
        flow_run_id: record.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    scanned: activeRuns.length,
    reconciled,
    ledger_synced: ledgerSynced,
    ml_tasks_fixed: mlTasksFixed,
    errors
  };
}
