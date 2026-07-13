import { prefectExecutionEnabled } from "./prefect-execution-config.js";
import { updatePrefectFlowRunStatus } from "./prefect-execution-db.js";

export async function syncPrefectFlowRunFromReport(
  db,
  businessType,
  taskId,
  { status, errorReason = null, reportPhase = null }
) {
  const bizId = String(taskId);
  const row = await db.prepare(
    `SELECT id, status
       FROM prefect_flow_runs
      WHERE business_type = ?
        AND business_id = ?
      LIMIT 1`
  ).bind(String(businessType), bizId).first();
  if (!row) {
    return { updated: 0, reason: "flow_run_not_found" };
  }

  const normalized = String(status ?? "").trim();
  const phase = String(reportPhase ?? "").trim();

  if (normalized === "running" && phase === "eval") {
    return updatePrefectFlowRunStatus(db, row.id, "running", null);
  }

  if (!["success", "failed", "skipped"].includes(normalized)) {
    return { updated: 0, reason: "non_terminal_report" };
  }

  const prefectStatus = normalized === "failed" ? "failed" : "completed";
  return updatePrefectFlowRunStatus(db, row.id, prefectStatus, errorReason);
}

export async function syncPrefectFlowRunsAfterReports(env, businessType, reports) {
  if (!prefectExecutionEnabled(env)) {
    return { synced: 0 };
  }
  let synced = 0;
  for (const report of reports ?? []) {
    if (Number(report?.updated ?? 0) <= 0) {
      continue;
    }
    const item = report.normalized ?? report;
    const taskId = Number(item.task_id);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      continue;
    }
    const reportPhase = String(item.diagnostics?.report_phase ?? "").trim() || null;
    const result = await syncPrefectFlowRunFromReport(env.DB, businessType, taskId, {
      status: item.status,
      errorReason: item.error_reason,
      reportPhase
    });
    if (Number(result?.updated ?? 0) > 0) {
      synced += 1;
    }
  }
  return { synced };
}
