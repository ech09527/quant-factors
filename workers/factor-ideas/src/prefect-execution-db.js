import { PREFECT_ACTIVE_STATUSES, readPrefectStaleMinutes } from "./prefect-execution-config.js";
import { failMlTaskIfRunning } from "./ml-task-db.js";

function normalizeStatus(status) {
  const text = String(status ?? "").trim().toLowerCase();
  if (text === "succeeded") {
    return "completed";
  }
  return text || "scheduled";
}

export async function getPrefectFlowRunByBusiness(db, businessType, businessId) {
  const row = await db.prepare(
    `SELECT id, business_type, business_id, deployment_name, status, error_reason,
            created_at, updated_at, completed_at
       FROM prefect_flow_runs
      WHERE business_type = ? AND business_id = ?
      LIMIT 1`
  ).bind(String(businessType), String(businessId)).first();
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    business_type: String(row.business_type),
    business_id: String(row.business_id),
    deployment_name: String(row.deployment_name),
    status: String(row.status),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at)
  };
}

export async function upsertPrefectFlowRun(
  db,
  {
    flowRunId,
    businessType,
    businessId,
    deploymentName,
    status = "scheduled",
    errorReason = null
  }
) {
  const id = String(flowRunId ?? "").trim();
  const bizType = String(businessType ?? "").trim();
  const bizId = String(businessId ?? "").trim();
  const deployment = String(deploymentName ?? "").trim();
  if (!id || !bizType || !bizId || !deployment) {
    throw new Error("upsertPrefectFlowRun: missing required fields");
  }
  const normalized = normalizeStatus(status);
  const terminal = ["completed", "failed", "cancelled", "crashed"].includes(normalized);
  await db.prepare(
    `INSERT INTO prefect_flow_runs (
       id, business_type, business_id, deployment_name, status, error_reason,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
     ON CONFLICT(business_type, business_id) DO UPDATE SET
       id = excluded.id,
       deployment_name = excluded.deployment_name,
       status = excluded.status,
       error_reason = excluded.error_reason,
       updated_at = datetime('now'),
       completed_at = CASE
         WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at
         WHEN excluded.status IN ('completed', 'failed', 'cancelled', 'crashed')
           THEN COALESCE(prefect_flow_runs.completed_at, datetime('now'))
         ELSE NULL
       END`
  ).bind(
    id,
    bizType,
    bizId,
    deployment,
    normalized,
    errorReason,
    terminal ? new Date().toISOString() : null
  ).run();
  return getPrefectFlowRunByBusiness(db, bizType, bizId);
}

export async function updatePrefectFlowRunStatus(
  db,
  flowRunId,
  status,
  errorReason = null
) {
  const normalized = normalizeStatus(status);
  const terminal = ["completed", "failed", "cancelled", "crashed"].includes(normalized);
  const result = await db.prepare(
    `UPDATE prefect_flow_runs
        SET status = ?,
            error_reason = COALESCE(?, error_reason),
            updated_at = datetime('now'),
            completed_at = CASE
              WHEN ? IN ('completed', 'failed', 'cancelled', 'crashed')
                THEN COALESCE(completed_at, datetime('now'))
              ELSE completed_at
            END
      WHERE id = ?`
  ).bind(normalized, errorReason, normalized, String(flowRunId)).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function listActivePrefectFlowRuns(db, businessType = null, limit = 500) {
  const binds = [];
  let where = `status IN ('scheduled', 'pending', 'running')`;
  if (businessType) {
    where += ` AND business_type = ?`;
    binds.push(String(businessType));
  }
  const result = await db.prepare(
    `SELECT id, business_type, business_id, deployment_name, status, error_reason,
            created_at, updated_at
       FROM prefect_flow_runs
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT ?`
  ).bind(...binds, Math.min(Math.max(Number(limit) || 500, 1), 2000)).all();
  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    business_type: String(row.business_type),
    business_id: String(row.business_id),
    deployment_name: String(row.deployment_name),
    status: String(row.status),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  }));
}

export async function countPrefectFlowRunsByStatus(db) {
  const result = await db.prepare(
    `SELECT status, COUNT(*) AS cnt
       FROM prefect_flow_runs
      GROUP BY status`
  ).all();
  const counts = {
    scheduled: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    crashed: 0
  };
  for (const row of result.results ?? []) {
    const key = normalizeStatus(row.status);
    counts[key] = (counts[key] ?? 0) + Number(row.cnt ?? 0);
  }
  return counts;
}

export function isActivePrefectFlowRun(record) {
  if (!record) {
    return false;
  }
  return PREFECT_ACTIVE_STATUSES.has(normalizeStatus(record.status));
}

export async function reclaimStalePrefectFlowRuns(db, env = null) {
  const maxAgeMinutes = readPrefectStaleMinutes(env);
  const stale = await db.prepare(
    `SELECT id, business_type, business_id
       FROM prefect_flow_runs
      WHERE status IN ('scheduled', 'pending', 'running')
        AND updated_at < datetime('now', ?)`
  ).bind(`-${maxAgeMinutes} minutes`).all();

  let reclaimed = 0;
  for (const row of stale.results ?? []) {
    const reason = "stale prefect flow run reclaimed";
    await updatePrefectFlowRunStatus(db, row.id, "failed", reason);
    const taskId = Number(row.business_id);
    if (Number.isFinite(taskId) && taskId > 0) {
      await failMlTaskIfRunning(db, taskId, reason);
    }
    reclaimed += 1;
  }
  return { reclaimed, max_age_minutes: maxAgeMinutes };
}
