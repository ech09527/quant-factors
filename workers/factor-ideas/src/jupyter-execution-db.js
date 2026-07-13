export const JUPYTER_EXECUTION_STATUSES = new Set([
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed_out",
  "cleaning",
  "cleaned"
]);

const ACTIVE_EXECUTION_STATUSES = ["queued", "submitting", "running", "cleaning"];

function parseJsonObject(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function rowToExecution(row) {
  return {
    id: String(row.id),
    server_key: String(row.server_key),
    business_type: String(row.business_type),
    business_id: String(row.business_id),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    payload: parseJsonObject(row.payload_json),
    kernel_id: row.kernel_id == null ? null : String(row.kernel_id),
    session_id: row.session_id == null ? null : String(row.session_id),
    msg_id: row.msg_id == null ? null : String(row.msg_id),
    error_code: row.error_code == null ? null : String(row.error_code),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    cleanup_at: row.cleanup_at == null ? null : String(row.cleanup_at),
    heartbeat_at: row.heartbeat_at == null ? null : String(row.heartbeat_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function getJupyterExecutionById(db, executionId) {
  const row = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE id = ?
       LIMIT 1`
  ).bind(String(executionId)).first();
  return row ? rowToExecution(row) : null;
}

export async function getJupyterExecutionByBusiness(db, businessType, businessId) {
  const row = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE business_type = ? AND business_id = ?
       LIMIT 1`
  ).bind(String(businessType), String(businessId)).first();
  return row ? rowToExecution(row) : null;
}

export async function createOrRequeueJupyterExecution(db, {
  serverKey,
  businessType,
  businessId,
  priority = 0,
  payload = null
}) {
  const existing = await getJupyterExecutionByBusiness(db, businessType, businessId);
  const payloadJson = payload && typeof payload === "object" ? JSON.stringify(payload) : null;

  if (existing) {
    if (ACTIVE_EXECUTION_STATUSES.includes(existing.status)) {
      return { execution: existing, created: false, requeued: false };
    }
    if (existing.status === "skipped") {
      return { execution: existing, created: false, requeued: false, skipped: true };
    }
    const shouldRequeueTerminal = ["succeeded", "cleaned", "failed", "timed_out"].includes(
      existing.status
    );
    if (existing.status === "succeeded" || existing.status === "cleaned") {
      const taskRow = await db.prepare(
        `SELECT status
           FROM ml_tasks
           WHERE id = ? AND business_type = ?
           LIMIT 1`
      )
        .bind(Number(businessId), String(businessType))
        .first();
      const taskStatus = String(taskRow?.status ?? "");
      if (!["pending", "failed", "queued"].includes(taskStatus)) {
        return { execution: existing, created: false, requeued: false, skipped: true };
      }
    } else if (!shouldRequeueTerminal) {
      return { execution: existing, created: false, requeued: false, skipped: true };
    }
    await db.prepare(
      `UPDATE jupyter_executions
         SET status = 'queued',
             server_key = ?,
             priority = ?,
             payload_json = COALESCE(?, payload_json),
             kernel_id = NULL,
             session_id = NULL,
             msg_id = NULL,
             error_code = NULL,
             error_reason = NULL,
             submitted_at = NULL,
             completed_at = NULL,
             cleanup_at = NULL,
             heartbeat_at = NULL,
             updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('failed', 'timed_out', 'cleaned', 'succeeded')`
    ).bind(String(serverKey), Number(priority), payloadJson, existing.id).run();
    const execution = await getJupyterExecutionById(db, existing.id);
    return { execution, created: false, requeued: true };
  }

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO jupyter_executions (
         id, server_key, business_type, business_id, status, priority, payload_json,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'queued', ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    id,
    String(serverKey),
    String(businessType),
    String(businessId),
    Number(priority),
    payloadJson
  ).run();
  const execution = await getJupyterExecutionById(db, id);
  return { execution, created: true, requeued: false };
}

export async function listQueuedJupyterExecutionsForServer(db, serverKey, limit = 100) {
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE server_key = ?
         AND status = 'queued'
       ORDER BY priority ASC, created_at ASC
       LIMIT ?`
  )
    .bind(String(serverKey), Math.max(1, Number(limit) || 1))
    .all();
  return (result.results ?? []).map(rowToExecution);
}

export async function countActiveJupyterExecutionsForServer(db, serverKey) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM jupyter_executions
       WHERE server_key = ?
         AND status IN ('submitting', 'running')`
  )
    .bind(String(serverKey))
    .first();
  return Number(row?.n ?? 0);
}

export async function listActiveJupyterExecutionsForServer(db, serverKey) {
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE server_key = ?
         AND status IN ('queued', 'submitting', 'running', 'cleaning')
       ORDER BY priority ASC, created_at ASC`
  ).bind(String(serverKey)).all();
  return (result.results ?? []).map(rowToExecution);
}

export async function listJupyterExecutionsNeedingCleanup(db, { limit = 30, graceMinutes = 2 } = {}) {
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE status IN ('succeeded', 'failed', 'skipped', 'timed_out')
         AND kernel_id IS NOT NULL
         AND TRIM(kernel_id) != ''
         AND cleanup_at IS NULL
         AND updated_at < datetime('now', ?)
       ORDER BY updated_at ASC
       LIMIT ?`
  ).bind(`-${graceMinutes} minutes`, limit).all();
  return (result.results ?? []).map(rowToExecution);
}

export async function listTimedOutRunningExecutions(db, timeoutMinutes) {
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE status = 'running'
         AND submitted_at IS NOT NULL
         AND julianday(submitted_at) < julianday('now', ?)`
  ).bind(`-${timeoutMinutes} minutes`).all();
  return (result.results ?? []).map(rowToExecution);
}

/** execution 仍为 running，但 ml_tasks 已终态（slot 泄漏） */
export async function listOrphanedRunningExecutions(db, serverKey = null) {
  const params = [];
  let serverClause = "";
  if (serverKey) {
    serverClause = " AND je.server_key = ?";
    params.push(String(serverKey));
  }
  const result = await db.prepare(
    `SELECT je.*
       FROM jupyter_executions je
       JOIN ml_tasks mt ON je.business_id = CAST(mt.id AS TEXT)
       WHERE je.business_type = 'factor_validation'
         AND je.status = 'running'
         AND mt.status IN ('failed', 'success', 'skipped')
         ${serverClause}`
  ).bind(...params).all();
  return (result.results ?? []).map(rowToExecution);
}

/** status 仍为 running 但 cleanup_at 已写入（submit/finalize 竞态遗留） */
export async function listZombieRunningExecutions(db, serverKey = null) {
  const params = [];
  let serverClause = "";
  if (serverKey) {
    serverClause = " AND server_key = ?";
    params.push(String(serverKey));
  }
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE status = 'running'
         AND cleanup_at IS NOT NULL
         ${serverClause}`
  ).bind(...params).all();
  return (result.results ?? []).map(rowToExecution);
}

export async function listActiveJupyterExecutionKernelBindings(db, serverKey = null) {
  const params = [];
  let serverClause = "";
  if (serverKey) {
    serverClause = " AND je.server_key = ?";
    params.push(String(serverKey));
  }
  const result = await db.prepare(
    `SELECT
         je.id AS execution_id,
         je.server_key,
         je.business_type,
         je.business_id,
         je.status AS execution_status,
         je.kernel_id,
         je.submitted_at,
         mt.status AS task_status
       FROM jupyter_executions je
       LEFT JOIN ml_tasks mt
         ON je.business_id = CAST(mt.id AS TEXT)
        AND je.business_type = mt.business_type
       WHERE je.kernel_id IS NOT NULL
         AND TRIM(je.kernel_id) != ''
         AND je.status IN ('submitting', 'running')
         ${serverClause}`
  ).bind(...params).all();

  const byKernelId = new Map();
  for (const row of result.results ?? []) {
    const kernelId = String(row.kernel_id ?? "").trim();
    if (!kernelId) {
      continue;
    }
    byKernelId.set(kernelId, {
      execution_id: String(row.execution_id),
      server_key: String(row.server_key ?? ""),
      business_type: String(row.business_type ?? ""),
      business_id: String(row.business_id ?? ""),
      execution_status: String(row.execution_status ?? ""),
      task_status: row.task_status == null ? null : String(row.task_status),
      submitted_at: row.submitted_at == null ? null : String(row.submitted_at)
    });
  }
  return byKernelId;
}

/** 活跃 execution + 关联 ml_tasks 状态（对账用） */
export async function listActiveExecutionsWithTaskStatus(db, serverKey) {
  const result = await db.prepare(
    `       SELECT
         je.id,
         je.server_key,
         je.business_type,
         je.business_id,
         je.status,
         je.kernel_id,
         je.created_at,
         je.submitted_at,
         je.heartbeat_at,
         je.updated_at,
         je.cleanup_at,
         mt.status AS task_status,
         mt.updated_at AS task_updated_at,
         mt.diagnostics AS task_diagnostics
       FROM jupyter_executions je
       LEFT JOIN ml_tasks mt
         ON je.business_id = CAST(mt.id AS TEXT)
        AND je.business_type = mt.business_type
       WHERE je.server_key = ?
         AND je.status IN ('submitting', 'running')
       ORDER BY je.updated_at ASC`
  ).bind(String(serverKey)).all();

  return (result.results ?? []).map((row) => ({
    id: String(row.id),
    server_key: String(row.server_key),
    business_type: String(row.business_type),
    business_id: String(row.business_id),
    status: String(row.status),
    kernel_id: row.kernel_id == null ? null : String(row.kernel_id),
    created_at: row.created_at == null ? null : String(row.created_at),
    submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
    heartbeat_at: row.heartbeat_at == null ? null : String(row.heartbeat_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    cleanup_at: row.cleanup_at == null ? null : String(row.cleanup_at),
    task_status: row.task_status == null ? null : String(row.task_status),
    task_updated_at: row.task_updated_at == null ? null : String(row.task_updated_at),
    task_diagnostics: row.task_diagnostics == null ? null : String(row.task_diagnostics)
  }));
}

export async function updateJupyterExecution(db, executionId, patch = {}) {
  const fields = [];
  const values = [];

  const allowed = {
    status: "status",
    kernel_id: "kernel_id",
    session_id: "session_id",
    msg_id: "msg_id",
    error_code: "error_code",
    error_reason: "error_reason",
    submitted_at: "submitted_at",
    completed_at: "completed_at",
    cleanup_at: "cleanup_at",
    heartbeat_at: "heartbeat_at",
    payload_json: "payload_json"
  };

  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) {
      continue;
    }
    let value = patch[key];
    if (key === "payload_json" && value && typeof value === "object") {
      value = JSON.stringify(value);
    }
    fields.push(`${column} = ?`);
    values.push(value);
  }

  if (fields.length === 0) {
    return { updated: 0 };
  }

  fields.push("updated_at = datetime('now')");
  const result = await db.prepare(
    `UPDATE jupyter_executions
       SET ${fields.join(", ")}
       WHERE id = ?`
  ).bind(...values, String(executionId)).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function listStaleSubmittingExecutions(db, staleMinutes = 10) {
  const result = await db.prepare(
    `SELECT *
       FROM jupyter_executions
       WHERE status = 'submitting'
         AND updated_at < datetime('now', ?)`
  ).bind(`-${staleMinutes} minutes`).all();
  return (result.results ?? []).map(rowToExecution);
}

export async function compareAndSetJupyterExecutionStatus(db, executionId, fromStatus, toStatus, patch = {}) {
  const current = await getJupyterExecutionById(db, executionId);
  if (!current || current.status !== fromStatus) {
    return { updated: 0, skipped: true };
  }
  return updateJupyterExecution(db, executionId, { status: toStatus, ...patch });
}
