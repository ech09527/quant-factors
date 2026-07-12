export const ML_TASK_STATUSES = new Set([
  "pending",
  "running",
  "success",
  "failed",
  "skipped"
]);

export const BUSINESS_TYPE_FACTOR_VALIDATION = "factor_validation";
export const BUSINESS_TYPE_TEST_FACTOR_VALIDATION = "test_factor_validation";

export const ML_VALIDATION_BUSINESS_TYPES = new Set([
  BUSINESS_TYPE_FACTOR_VALIDATION,
  BUSINESS_TYPE_TEST_FACTOR_VALIDATION
]);

export function isMlValidationBusinessType(businessType) {
  return ML_VALIDATION_BUSINESS_TYPES.has(String(businessType ?? "").trim());
}

const KERNEL_EXECUTION_DIAGNOSTIC_KEYS = [
  "async",
  "stage",
  "jupyter_server_key",
  "jupyter_server_fallback_from",
  "jupyter_server_fallback_reason",
  "kernel_id",
  "session_id",
  "msg_id",
  "submitted_at",
  "kernel_cleaned_at",
  "kernel_cleanup_status",
  "kernel_cleanup_error",
  "kernel_cleanup_attempted_at"
];

export function parseJsonObject(value) {
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

export function stripKernelExecutionDiagnostics(diagnostics) {
  const next = { ...(diagnostics ?? {}) };
  for (const key of KERNEL_EXECUTION_DIAGNOSTIC_KEYS) {
    delete next[key];
  }
  return next;
}

export async function createMlTask(db, { businessType, businessId = null, mlflowExperiment }) {
  const insert = await db.prepare(
    `INSERT INTO ml_tasks (
         business_type, business_id, status, mlflow_experiment, created_at, updated_at
       )
       VALUES (?, ?, 'pending', ?, datetime('now'), datetime('now'))`
  ).bind(businessType, businessId, mlflowExperiment ?? null).run();
  const taskId = Number(insert.meta.last_row_id ?? 0);
  if (taskId <= 0) {
    throw new Error("创建 ml_tasks 失败");
  }
  return taskId;
}

export async function getMlTaskById(db, taskId) {
  const row = await db.prepare(
    `SELECT
         id, business_type, business_id, status, mlflow_experiment, mlflow_run_id,
         error_reason, diagnostics, submitted_at, completed_at, created_at, updated_at
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    business_type: String(row.business_type),
    business_id: row.business_id == null ? null : Number(row.business_id),
    status: String(row.status),
    mlflow_experiment: row.mlflow_experiment == null ? null : String(row.mlflow_experiment),
    mlflow_run_id: row.mlflow_run_id == null ? null : String(row.mlflow_run_id),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    diagnostics: parseJsonObject(row.diagnostics),
    submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function updateMlTaskDiagnostics(db, taskId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM ml_tasks
       WHERE id = ? AND status = 'running'
       LIMIT 1`
  ).bind(taskId).first();
  if (!existing) {
    return { updated: 0 };
  }
  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    ...(patch ?? {})
  };
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
  ).bind(JSON.stringify(diagnostics), taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function reportMlTaskResults(db, items) {
  let updated = 0;
  const results = [];
  for (const item of items) {
    const taskId = Number(item.task_id);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      continue;
    }
    const status = String(item.status ?? "failed");
    if (!ML_TASK_STATUSES.has(status)) {
      continue;
    }

    const existing = await db.prepare(
      `SELECT status, diagnostics
         FROM ml_tasks
         WHERE id = ?
         LIMIT 1`
    ).bind(taskId).first();
    if (!existing) {
      results.push({ task_id: taskId, updated: 0, status });
      continue;
    }

    const existingDiag = parseJsonObject(existing.diagnostics) ?? {};
    const existingPhase = String(existingDiag.report_phase ?? "").trim();

    const diagnostics = {
      ...existingDiag,
      ...(item.diagnostics ?? {})
    };
    if (item.mlflow_run_url) {
      diagnostics.mlflow_run_url = String(item.mlflow_run_url);
    }

    const reportPhase = String(item.diagnostics?.report_phase ?? "").trim();

    if (
      existingPhase === "eval" &&
      reportPhase !== "mlflow" &&
      status !== "running"
    ) {
      results.push({
        task_id: taskId,
        updated: 0,
        status,
        rejected: "eval_phase_requires_mlflow"
      });
      continue;
    }

    const statusGuard =
      reportPhase === "mlflow"
        ? "AND status IN ('running', 'success')"
        : "AND status IN ('running', 'pending')";

    const completedAt = status === "running" ? null : (item.completed_at ?? new Date().toISOString());
    const result = await db.prepare(
      `UPDATE ml_tasks
         SET status = ?,
             mlflow_experiment = COALESCE(?, mlflow_experiment),
             mlflow_run_id = COALESCE(?, mlflow_run_id),
             error_reason = ?,
             diagnostics = ?,
             completed_at = CASE WHEN ? = 'running' THEN NULL ELSE COALESCE(?, completed_at) END,
             updated_at = datetime('now')
       WHERE id = ?
         ${statusGuard}`
    ).bind(
      status,
      item.mlflow_experiment ?? null,
      item.mlflow_run_id ?? null,
      item.error_reason ?? null,
      Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null,
      status,
      completedAt,
      taskId
    ).run();
    const changes = Number(result.meta.changes ?? 0);
    updated += changes;
    results.push({ task_id: taskId, updated: changes, status });
  }
  return { updated, results };
}

export async function releaseMlTaskClaims(db, taskIds, errorReason) {
  if (!taskIds.length) {
    return { released: 0 };
  }
  let released = 0;
  const reason = String(errorReason ?? "jupyter kernel capacity reached").trim();
  for (const taskIdRaw of taskIds) {
    const taskId = Number(taskIdRaw);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      continue;
    }
    const existing = await db.prepare(
      `SELECT diagnostics
         FROM ml_tasks
         WHERE id = ? AND status = 'running'
         LIMIT 1`
    ).bind(taskId).first();
    if (!existing) {
      continue;
    }
    const diagnostics = stripKernelExecutionDiagnostics(
      parseJsonObject(existing.diagnostics) ?? {}
    );
    const diagnosticsJson =
      Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null;
    const result = await db.prepare(
      `UPDATE ml_tasks
         SET status = 'failed',
             error_reason = ?,
             diagnostics = ?,
             completed_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND status = 'running'`
    ).bind(reason, diagnosticsJson, taskId).run();
    released += Number(result.meta.changes ?? 0);
  }
  return { released };
}

export async function listMlTasksPendingKernelCleanup(db, { limit, graceMinutes }) {
  const result = await db.prepare(
    `SELECT id, diagnostics, status, updated_at
       FROM ml_tasks
       WHERE status IN ('success', 'failed', 'skipped')
         AND diagnostics IS NOT NULL
         AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(diagnostics, '$.kernel_id')) != ''
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL
         AND updated_at < datetime('now', ?)
       ORDER BY updated_at ASC
       LIMIT ?`
  ).bind(`-${graceMinutes} minutes`, limit).all();

  return (result.results ?? []).map((row) => {
    const diagnostics = parseJsonObject(row.diagnostics) ?? {};
    return {
      task_id: Number(row.id),
      status: String(row.status),
      kernel_id: String(diagnostics.kernel_id ?? "").trim(),
      jupyter_server_key: String(diagnostics.jupyter_server_key ?? "").trim()
    };
  });
}

export async function listActiveMlTaskKernelIds(db) {
  const result = await db.prepare(
    `SELECT diagnostics
       FROM ml_tasks
       WHERE diagnostics IS NOT NULL
         AND status = 'running'
         AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(diagnostics, '$.kernel_id')) != ''
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL`
  ).all();

  const ids = new Set();
  for (const row of result.results ?? []) {
    const diagnostics = parseJsonObject(row.diagnostics) ?? {};
    const kernelId = String(diagnostics.kernel_id ?? "").trim();
    if (kernelId) {
      ids.add(kernelId);
    }
  }
  return ids;
}

/** finalize / 强制清扫：不要求 kernel_id 与入参一致，终态任务直接落 cleaned 账本。 */
export async function markMlTaskKernelCleanedForTask(db, taskId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!existing) {
    return { updated: 0, skipped: true, reason: "not_found" };
  }

  const diagnostics = parseJsonObject(existing.diagnostics) ?? {};
  if (diagnostics.kernel_cleaned_at) {
    return { updated: 0, skipped: true, reason: "already_cleaned" };
  }

  const nextDiagnostics = {
    ...diagnostics,
    ...patch,
    kernel_cleaned_at: new Date().toISOString()
  };
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL`
  ).bind(JSON.stringify(nextDiagnostics), taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function collectMlTaskKernelIdsForCleanup(db, taskId, executionKernelId = null) {
  const ids = new Set();
  const executionId = String(executionKernelId ?? "").trim();
  if (executionId) {
    ids.add(executionId);
  }
  const task = await getMlTaskById(db, taskId);
  const diagnosticsKernelId = String(task?.diagnostics?.kernel_id ?? "").trim();
  if (diagnosticsKernelId) {
    ids.add(diagnosticsKernelId);
  }
  return {
    kernel_ids: [...ids],
    jupyter_server_key: String(task?.diagnostics?.jupyter_server_key ?? "").trim()
  };
}

export async function markMlTaskKernelCleaned(db, taskId, kernelId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!existing) {
    return { updated: 0, skipped: true, reason: "not_found" };
  }

  const diagnostics = parseJsonObject(existing.diagnostics) ?? {};
  const expectedKernelId = String(kernelId ?? "").trim();
  const actualKernelId = String(diagnostics.kernel_id ?? "").trim();
  if (!expectedKernelId || actualKernelId !== expectedKernelId) {
    return { updated: 0, skipped: true, reason: "kernel_id_mismatch" };
  }
  if (diagnostics.kernel_cleaned_at) {
    return { updated: 0, skipped: true, reason: "already_cleaned" };
  }

  const nextDiagnostics = {
    ...diagnostics,
    ...patch,
    kernel_cleaned_at: new Date().toISOString()
  };
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('success', 'failed', 'skipped')
         AND json_extract(diagnostics, '$.kernel_id') = ?
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL`
  ).bind(JSON.stringify(nextDiagnostics), taskId, expectedKernelId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function getMlTaskKernelCleanupTarget(db, taskId, expectedKernelId) {
  const row = await db.prepare(
    `SELECT status, diagnostics
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!row) {
    return null;
  }

  const status = String(row.status ?? "");
  if (!["success", "failed", "skipped"].includes(status)) {
    return null;
  }

  const diagnostics = parseJsonObject(row.diagnostics) ?? {};
  const kernelId = String(diagnostics.kernel_id ?? "").trim();
  const expected = String(expectedKernelId ?? "").trim();
  if (!kernelId || !expected || kernelId !== expected) {
    return null;
  }
  if (diagnostics.kernel_cleaned_at) {
    return null;
  }

  return {
    task_id: taskId,
    status,
    kernel_id: kernelId,
    jupyter_server_key: String(diagnostics.jupyter_server_key ?? "").trim()
  };
}

export async function patchMlTaskDiagnostics(db, taskId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!existing) {
    return { updated: 0 };
  }

  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    ...(patch ?? {})
  };
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?`
  ).bind(JSON.stringify(diagnostics), taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function listJupyterMlTaskKernelBindings(db) {
  const result = await db.prepare(
    `SELECT
         mt.id AS task_id,
         mt.business_type,
         mt.business_id,
         mt.status,
         mt.mlflow_run_id,
         mt.updated_at,
         fv.id AS factor_validation_id,
         fv.idea_id,
         fv.profile_key,
         i.title,
         json_extract(mt.diagnostics, '$.kernel_id') AS kernel_id,
         json_extract(mt.diagnostics, '$.jupyter_server_key') AS jupyter_server_key,
         json_extract(mt.diagnostics, '$.kernel_cleaned_at') AS kernel_cleaned_at,
         json_extract(mt.diagnostics, '$.stage') AS stage
       FROM ml_tasks mt
       LEFT JOIN factor_validations fv ON fv.task_id = mt.id
       LEFT JOIN ideas i ON i.id = fv.idea_id
       WHERE mt.diagnostics IS NOT NULL
         AND json_extract(mt.diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(mt.diagnostics, '$.kernel_id')) != ''`
  ).all();

  const byKernelId = new Map();
  for (const row of result.results ?? []) {
    const kernelId = String(row.kernel_id ?? "").trim();
    if (!kernelId) {
      continue;
    }
    const binding = {
      task_id: Number(row.task_id),
      business_type: String(row.business_type ?? ""),
      business_id: row.business_id == null ? null : Number(row.business_id),
      status: String(row.status ?? ""),
      mlflow_run_id: row.mlflow_run_id == null ? null : String(row.mlflow_run_id),
      factor_validation_id: row.factor_validation_id == null ? null : Number(row.factor_validation_id),
      idea_id: row.idea_id == null ? null : Number(row.idea_id),
      profile_key: row.profile_key == null ? null : String(row.profile_key),
      title: row.title == null ? null : String(row.title),
      jupyter_server_key: String(row.jupyter_server_key ?? "").trim(),
      kernel_cleaned_at: row.kernel_cleaned_at == null ? null : String(row.kernel_cleaned_at),
      stage: row.stage == null ? null : String(row.stage),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    };
    const existing = byKernelId.get(kernelId);
    if (!existing || String(binding.updated_at ?? "") >= String(existing.updated_at ?? "")) {
      byKernelId.set(kernelId, binding);
    }
  }
  return byKernelId;
}

export async function listMlTasksWithUncleanedKernels(db, { limit }) {
  const result = await db.prepare(
    `SELECT id, diagnostics, status, updated_at
       FROM ml_tasks
       WHERE diagnostics IS NOT NULL
         AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(diagnostics, '$.kernel_id')) != ''
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL
       ORDER BY updated_at ASC
       LIMIT ?`
  ).bind(limit).all();

  return (result.results ?? []).map((row) => {
    const diagnostics = parseJsonObject(row.diagnostics) ?? {};
    return {
      task_id: Number(row.id),
      status: String(row.status ?? ""),
      kernel_id: String(diagnostics.kernel_id ?? "").trim(),
      jupyter_server_key: String(diagnostics.jupyter_server_key ?? "").trim(),
    };
  });
}

export async function markMlTaskRunningIfPending(db, taskId, diagnosticsPatch = {}) {
  const existing = await db.prepare(
    `SELECT status, diagnostics
       FROM ml_tasks
       WHERE id = ?
       LIMIT 1`
  ).bind(taskId).first();
  if (!existing || String(existing.status ?? "") !== "pending") {
    return { updated: 0 };
  }

  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    ...(diagnosticsPatch ?? {})
  };
  const diagnosticsJson = Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null;

  const result = await db.prepare(
    `UPDATE ml_tasks
       SET status = 'running',
           submitted_at = datetime('now'),
           completed_at = NULL,
           error_reason = NULL,
           diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'pending'`
  ).bind(diagnosticsJson, taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function failMlTaskIfRunning(db, taskId, reason = "force kernel cleanup") {
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET status = 'failed',
           error_reason = COALESCE(error_reason, ?),
           completed_at = COALESCE(completed_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
  ).bind(reason, taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function failMlTaskIfActive(db, taskId, reason = "execution reconcile failed") {
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET status = 'failed',
           error_reason = COALESCE(error_reason, ?),
           completed_at = COALESCE(completed_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'running')`
  ).bind(reason, taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function reclaimStaleMlTasks(db, maxAgeMinutes = 60) {
  const result = await db.prepare(
    `UPDATE ml_tasks
       SET status = 'failed',
           error_reason = COALESCE(error_reason, 'stale running reclaimed'),
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE status = 'running'
         AND updated_at < datetime('now', ?)`
  ).bind(`-${maxAgeMinutes} minutes`).run();
  return { reclaimed: Number(result.meta.changes ?? 0) };
}
