import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import { readJupyterExecutionTimeoutMinutes } from "./jupyter-execution-config.js";
import { readPrefectStaleMinutes } from "./prefect-execution-config.js";
import { reclaimStalePrefectFlowRuns } from "./prefect-execution-db.js";
import {
  BUSINESS_TYPE_FACTOR_VALIDATION,
  createMlTask,
  parseJsonObject,
  reclaimStaleMlTasks,
  releaseMlTaskClaims,
  reportMlTaskResults,
  stripKernelExecutionDiagnostics,
  updateMlTaskDiagnostics
} from "./ml-task-db.js";

const FACTOR_VALIDATION_EXPERIMENT = "factor-validation";

function readStaleRunningMinutes(env, fallback = 5) {
  const parsed = Number(env?.VALIDATION_STALE_RUNNING_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 60);
}

function buildFactorValidationJobFrom(staleRunningMinutes) {
  return `
    FROM ideas i
    CROSS JOIN validation_profiles vp
    LEFT JOIN factor_validations fv
      ON fv.idea_id = i.id AND fv.profile_key = vp.key
    LEFT JOIN ml_tasks mt
      ON mt.id = fv.task_id
    WHERE vp.enabled = 1
      AND i.factor_sql IS NOT NULL
      AND TRIM(i.factor_sql) != ''
      AND TRIM(i.factor_sql) != 'null'
      AND (fv.id IS NULL OR mt.status NOT IN ('success', 'skipped'))
      AND (
        fv.id IS NULL
        OR mt.status != 'running'
        OR mt.updated_at < datetime('now', '-${staleRunningMinutes} minutes')
      )`;
}

function buildFactorValidationJobFromForPrefect(staleMinutes) {
  return `
    FROM ideas i
    CROSS JOIN validation_profiles vp
    LEFT JOIN factor_validations fv
      ON fv.idea_id = i.id AND fv.profile_key = vp.key
    LEFT JOIN ml_tasks mt
      ON mt.id = fv.task_id
    WHERE vp.enabled = 1
      AND i.factor_sql IS NOT NULL
      AND TRIM(i.factor_sql) != ''
      AND TRIM(i.factor_sql) != 'null'
      AND (fv.id IS NULL OR mt.status NOT IN ('success', 'skipped'))
      AND (
        fv.id IS NULL
        OR mt.status NOT IN ('running', 'pending')
        OR (
          mt.status = 'running'
          AND mt.updated_at < datetime('now', '-${staleMinutes} minutes')
        )
        OR (
          mt.status = 'pending'
          AND (
            mt.submitted_at IS NULL
            OR mt.submitted_at < datetime('now', '-${staleMinutes} minutes')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM prefect_flow_runs pfr
         WHERE pfr.business_type = 'factor_validation'
           AND pfr.business_id = CAST(COALESCE(fv.task_id, 0) AS TEXT)
           AND pfr.status IN ('scheduled', 'pending', 'running')
      )`;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeWorkflowLabelKind(value) {
  if (value == null || value === "") {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function normalizeWorkflowHorizonBars(value) {
  if (value == null || value === "") {
    return null;
  }
  const horizon = Number(value);
  if (!Number.isFinite(horizon) || horizon < 1) {
    return null;
  }
  return Math.floor(horizon);
}

function rowToFactorValidationJob(row) {
  return {
    factor_validation_id: Number(row.factor_validation_id),
    task_id: Number(row.task_id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: String(row.profile_name),
    label_kind: normalizeWorkflowLabelKind(row.label_kind),
    horizon_bars: normalizeWorkflowHorizonBars(row.horizon_bars),
    title: String(row.title),
    title_hash: String(row.title_hash),
    factor_expr: String(row.factor_expr),
    hypothesis: String(row.hypothesis),
    formula_sketch: String(row.formula_sketch),
    expected_signal: String(row.expected_signal),
    data_sources: parseJsonArray(row.data_sources),
    factor_sql: parseJsonObject(row.factor_sql),
    status: String(row.status)
  };
}

export function rowToFactorValidationItem(row) {
  const diagnostics = parseJsonObject(row.diagnostics);
  const metrics =
    diagnostics?.metrics && typeof diagnostics.metrics === "object" && !Array.isArray(diagnostics.metrics)
      ? diagnostics.metrics
      : null;
  return {
    id: Number(row.id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: row.profile_name == null ? null : String(row.profile_name),
    task_id: Number(row.task_id),
    status: String(row.status),
    mlflow_experiment: row.mlflow_experiment == null ? null : String(row.mlflow_experiment),
    mlflow_run_id: row.mlflow_run_id == null ? null : String(row.mlflow_run_id),
    mlflow_run_url: row.mlflow_run_url == null ? null : String(row.mlflow_run_url),
    factor_sql: parseJsonObject(row.factor_sql),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    diagnostics,
    metrics,
    evaluated_at: row.evaluated_at == null ? null : String(row.evaluated_at),
    idea_title: row.idea_title == null ? null : String(row.idea_title),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function listPendingFactorValidationJobs(db, limit = null, env = null) {
  const staleRunningMinutes = readStaleRunningMinutes(env);
  await reclaimStaleMlTasks(db, readJupyterExecutionTimeoutMinutes(env, 45));
  const hasLimit = limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0;
  const sql = `SELECT
         COALESCE(fv.id, 0) AS factor_validation_id,
         COALESCE(fv.task_id, 0) AS task_id,
         i.id AS idea_id,
         vp.key AS profile_key,
         COALESCE(mt.status, 'queued') AS status,
         vp.name AS profile_name,
         vp.label_kind,
         vp.horizon_bars,
         i.title,
         i.title_hash,
         i.factor_expr,
         i.hypothesis,
         i.formula_sketch,
         i.expected_signal,
         i.data_sources,
         i.factor_sql
       ${buildFactorValidationJobFrom(staleRunningMinutes)}
       ORDER BY
         CASE COALESCE(mt.status, 'queued')
           WHEN 'queued' THEN 0
           WHEN 'pending' THEN 1
           WHEN 'failed' THEN 2
           ELSE 3
         END ASC,
         i.id ASC,
         vp.sort_order ASC,
         vp.key ASC${hasLimit ? " LIMIT ?" : ""}`;
  const result = hasLimit
    ? await db.prepare(sql).bind(Number(limit)).all()
    : await db.prepare(sql).all();

  return {
    items: (result.results ?? []).map(rowToFactorValidationJob)
  };
}

export async function ensureFactorValidationRecords(db, ideaId, profileKey) {
  const existing = await db.prepare(
    `SELECT fv.id, fv.task_id, mt.status
       FROM factor_validations fv
       JOIN ml_tasks mt ON mt.id = fv.task_id
       WHERE fv.idea_id = ? AND fv.profile_key = ?
       LIMIT 1`
  ).bind(ideaId, profileKey).first();

  if (existing) {
    return {
      factor_validation_id: Number(existing.id),
      task_id: Number(existing.task_id),
      status: String(existing.status)
    };
  }

  const taskId = await createMlTask(db, {
    businessType: BUSINESS_TYPE_FACTOR_VALIDATION,
    mlflowExperiment: FACTOR_VALIDATION_EXPERIMENT
  });

  const insert = await db.prepare(
    `INSERT INTO factor_validations (idea_id, profile_key, task_id, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(ideaId, profileKey, taskId).run();
  const factorValidationId = Number(insert.meta.last_row_id ?? 0);
  if (factorValidationId <= 0) {
    throw new Error("创建 factor_validations 失败");
  }

  await db.prepare(
    `UPDATE ml_tasks
       SET business_id = ?, updated_at = datetime('now')
       WHERE id = ?`
  ).bind(factorValidationId, taskId).run();

  return {
    factor_validation_id: factorValidationId,
    task_id: taskId,
    status: "pending"
  };
}

export async function claimFactorValidationJobs(db, jobs, env = null) {
  const staleRunningMinutes = readJupyterExecutionTimeoutMinutes(env, 45);
  let claimed = 0;
  const claimedIds = [];
  const claimedJobs = [];

  for (const job of jobs) {
    const ideaId = Number(job.idea_id);
    const profileKey = String(job.profile_key ?? "").trim();
    if (!Number.isFinite(ideaId) || ideaId <= 0 || !profileKey) {
      continue;
    }

    const record = await ensureFactorValidationRecords(db, ideaId, profileKey);
    const { factor_validation_id: factorValidationId, task_id: taskId } = record;

    const existing = await db.prepare(
      `SELECT status, diagnostics, updated_at
         FROM ml_tasks
         WHERE id = ?
         LIMIT 1`
    ).bind(taskId).first();
    if (!existing) {
      continue;
    }

    const status = String(existing.status ?? "");
    if (["success", "skipped"].includes(status)) {
      continue;
    }
    if (status === "running") {
      const updatedMs = Date.parse(String(existing.updated_at ?? "")) || 0;
      const isStale =
        updatedMs > 0 && Date.now() - updatedMs > staleRunningMinutes * 60_000;
      if (!isStale) {
        continue;
      }
    }

    const diagnostics = stripKernelExecutionDiagnostics(
      parseJsonObject(existing.diagnostics) ?? {}
    );
    delete diagnostics.report_phase;
    delete diagnostics.timing;
    const diagnosticsJson =
      Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null;

    const result = await db.prepare(
      `UPDATE ml_tasks
         SET status = 'running',
             error_reason = NULL,
             diagnostics = ?,
             submitted_at = datetime('now'),
             completed_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?
           AND (
             status NOT IN ('success', 'skipped', 'running')
             OR (
               status = 'running'
               AND updated_at < datetime('now', '-${staleRunningMinutes} minutes')
             )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM jupyter_executions je
              WHERE je.business_type = 'factor_validation'
                AND je.business_id = CAST(ml_tasks.id AS TEXT)
                AND je.status = 'running'
           )`
    ).bind(diagnosticsJson, taskId).run();
    if (Number(result.meta.changes ?? 0) === 0) {
      continue;
    }

    claimed += 1;
    claimedIds.push(taskId);
    claimedJobs.push({
      task_id: taskId,
      factor_validation_id: factorValidationId,
      idea_id: ideaId,
      profile_key: profileKey
    });
  }

  return { claimed, ids: claimedIds, jobs: claimedJobs };
}

export function mergeClaimedFactorValidationJobs(pendingItems, claimedJobs) {
  const claimMap = new Map();
  for (const item of claimedJobs) {
    claimMap.set(`${item.idea_id}:${item.profile_key}`, item);
  }
  return pendingItems
    .map((job) => {
      const claimed = claimMap.get(`${job.idea_id}:${job.profile_key}`);
      if (!claimed) {
        return null;
      }
      return {
        ...job,
        factor_validation_id: claimed.factor_validation_id,
        task_id: claimed.task_id
      };
    })
    .filter(Boolean);
}

export async function listPendingFactorValidationJobsForPrefect(db, limit = null, env = null) {
  const staleMinutes = readPrefectStaleMinutes(env);
  await reclaimStalePrefectFlowRuns(db, env);
  await reclaimStaleMlTasks(db, staleMinutes);
  const hasLimit = limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0;
  const sql = `SELECT
         COALESCE(fv.id, 0) AS factor_validation_id,
         COALESCE(fv.task_id, 0) AS task_id,
         i.id AS idea_id,
         vp.key AS profile_key,
         COALESCE(mt.status, 'queued') AS status,
         vp.name AS profile_name,
         vp.label_kind,
         vp.horizon_bars,
         i.title,
         i.title_hash,
         i.factor_expr,
         i.hypothesis,
         i.formula_sketch,
         i.expected_signal,
         i.data_sources,
         i.factor_sql
       ${buildFactorValidationJobFromForPrefect(staleMinutes)}
       ORDER BY
         CASE COALESCE(mt.status, 'queued')
           WHEN 'queued' THEN 0
           WHEN 'pending' THEN 1
           WHEN 'failed' THEN 2
           ELSE 3
         END ASC,
         i.id ASC,
         vp.sort_order ASC,
         vp.key ASC${hasLimit ? " LIMIT ?" : ""}`;
  const result = hasLimit
    ? await db.prepare(sql).bind(Number(limit)).all()
    : await db.prepare(sql).all();
  return { items: (result.results ?? []).map(rowToFactorValidationJob) };
}

export async function reserveFactorValidationJobsForPrefect(db, jobs) {
  let reserved = 0;
  const reservedJobs = [];

  for (const job of jobs) {
    const ideaId = Number(job.idea_id);
    const profileKey = String(job.profile_key ?? "").trim();
    if (!Number.isFinite(ideaId) || ideaId <= 0 || !profileKey) {
      continue;
    }

    const record = await ensureFactorValidationRecords(db, ideaId, profileKey);
    const { factor_validation_id: factorValidationId, task_id: taskId } = record;

    const existing = await db.prepare(
      `SELECT status, diagnostics
         FROM ml_tasks
         WHERE id = ?
         LIMIT 1`
    ).bind(taskId).first();
    if (!existing) {
      continue;
    }

    const status = String(existing.status ?? "");
    if (["success", "skipped", "running"].includes(status)) {
      continue;
    }

    const diagnostics = {
      ...(stripKernelExecutionDiagnostics(parseJsonObject(existing.diagnostics) ?? {})),
      dispatch_mode: "prefect",
      prefect_reserved: true
    };
    delete diagnostics.report_phase;
    delete diagnostics.timing;

    const result = await db.prepare(
      `UPDATE ml_tasks
         SET status = 'pending',
             error_reason = NULL,
             diagnostics = ?,
             submitted_at = datetime('now'),
             completed_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?
           AND status IN ('pending', 'failed')
           AND NOT EXISTS (
             SELECT 1
               FROM prefect_flow_runs pfr
              WHERE pfr.business_type = 'factor_validation'
                AND pfr.business_id = CAST(ml_tasks.id AS TEXT)
                AND pfr.status IN ('scheduled', 'pending', 'running')
           )`
    ).bind(JSON.stringify(diagnostics), taskId).run();
    if (Number(result.meta.changes ?? 0) === 0) {
      continue;
    }

    reserved += 1;
    reservedJobs.push({
      task_id: taskId,
      factor_validation_id: factorValidationId,
      idea_id: ideaId,
      profile_key: profileKey
    });
  }

  return { reserved, jobs: reservedJobs };
}

export async function markFactorValidationRunningAfterPrefect(
  db,
  taskId,
  { flowRunId, deploymentName }
) {
  const existing = await db.prepare(
    `SELECT status, diagnostics FROM ml_tasks WHERE id = ? LIMIT 1`
  ).bind(taskId).first();
  if (!existing) {
    return { updated: 0, reason: "task_not_found" };
  }
  if (String(existing.status ?? "") !== "pending") {
    return { updated: 0, reason: "not_pending" };
  }
  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    dispatch_mode: "prefect",
    prefect_flow_run_id: String(flowRunId ?? ""),
    prefect_deployment: String(deploymentName ?? "")
  };
  delete diagnostics.prefect_dispatch_error;
  const result = await db.prepare(
    `UPDATE ml_tasks
        SET status = 'running',
            diagnostics = ?,
            submitted_at = COALESCE(submitted_at, datetime('now')),
            updated_at = datetime('now')
      WHERE id = ?
        AND status = 'pending'`
  ).bind(JSON.stringify(diagnostics), taskId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export function buildFactorValidationPrefectJobPayload(job) {
  return {
    task_id: job.task_id,
    factor_validation_id: job.factor_validation_id,
    idea_id: job.idea_id,
    idea: {
      title: job.title,
      title_hash: job.title_hash,
      formula_sketch: job.formula_sketch,
      data_sources: job.data_sources
    },
    factor_sql: job.factor_sql,
    profile_key: job.profile_key,
    validation_profile_key: job.profile_key,
    label_kind: job.label_kind,
    horizon_bars: job.horizon_bars
  };
}

export function mergeReservedFactorValidationJobs(pendingItems, reservedJobs) {
  const map = new Map();
  for (const item of reservedJobs) {
    map.set(`${item.idea_id}:${item.profile_key}`, item);
  }
  return pendingItems
    .map((job) => {
      const reserved = map.get(`${job.idea_id}:${job.profile_key}`);
      if (!reserved) {
        return null;
      }
      return {
        ...job,
        factor_validation_id: reserved.factor_validation_id,
        task_id: reserved.task_id
      };
    })
    .filter(Boolean);
}

function coerceEvalPhaseRunningStatus(item) {
  const reportPhase = String(item.diagnostics?.report_phase ?? "").trim();
  if (reportPhase === "eval" && String(item.status ?? "") === "success") {
    return { ...item, status: "running" };
  }
  return item;
}

function normalizeFactorValidationReportItem(item) {
  const status = resolveFactorValidationTerminalStatus(item.status, item.error_reason);
  if (status === item.status) {
    return item;
  }
  const diagnostics = {
    ...(item.diagnostics ?? {}),
    permanent_failure_skipped: true,
    original_status: String(item.status ?? "failed")
  };
  return {
    ...item,
    status,
    diagnostics,
    error_reason: item.error_reason ?? "permanent validation error"
  };
}

export async function reportFactorValidationResults(db, items) {
  let updated = 0;
  const reports = [];
  for (const item of items) {
    const taskId = Number(item.task_id);
    const factorValidationId = Number(item.factor_validation_id);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      continue;
    }

    const normalized = normalizeFactorValidationReportItem(
      coerceEvalPhaseRunningStatus(item)
    );
    const taskReport = await reportMlTaskResults(db, [normalized]);
    const taskUpdated = Number(taskReport.results?.[0]?.updated ?? 0);
    updated += taskUpdated;
    reports.push({ task_id: taskId, updated: taskUpdated, normalized });

    if (taskUpdated <= 0 || !Number.isFinite(factorValidationId) || factorValidationId <= 0) {
      continue;
    }

    const factorSqlJson =
      normalized.factor_sql && typeof normalized.factor_sql === "object"
        ? JSON.stringify(normalized.factor_sql)
        : null;

    await db.prepare(
      `UPDATE factor_validations
         SET factor_sql = COALESCE(?, factor_sql),
             evaluated_at = COALESCE(?, evaluated_at),
             updated_at = datetime('now')
         WHERE id = ?`
    ).bind(factorSqlJson, normalized.evaluated_at ?? null, factorValidationId).run();
  }
  return { updated, reports };
}

export async function enqueueFactorValidations(db, ideaId, profileKeys) {
  const keys = [...new Set(profileKeys.map((key) => String(key).trim()).filter(Boolean))];
  const created = [];
  for (const profileKey of keys) {
    const record = await ensureFactorValidationRecords(db, ideaId, profileKey);
    created.push({
      factor_validation_id: record.factor_validation_id,
      task_id: record.task_id,
      profile_key: profileKey,
      status: record.status
    });
  }
  return { created };
}

const FACTOR_VALIDATION_SORT_FIELDS = {
  mean_ic: "mean_ic",
  mean_rank_ic: "mean_rank_ic",
  evaluated_at: "evaluated_at",
  updated_at: "updated_at"
};

function factorValidationMetricExpr(field) {
  return `CAST(json_extract(mt.diagnostics, '$.metrics.${field}') AS REAL)`;
}

function buildFactorValidationListQuery({
  ideaId = null,
  status = null,
  profileKeys = null,
  sort = null,
  order = null,
  abs = true,
  limit = 30,
  offset = 0
} = {}) {
  const sortRaw = sort?.trim() || "mean_rank_ic";
  const sortField =
    sortRaw in FACTOR_VALIDATION_SORT_FIELDS ? sortRaw : "mean_rank_ic";
  const orderDir = order === "asc" ? "asc" : "desc";
  const useAbs = abs !== false;
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const statusFilter =
    status != null && String(status).trim() ? String(status).trim() : null;

  const binds = [];
  const clauses = [];
  if (ideaId != null) {
    clauses.push("fv.idea_id = ?");
    binds.push(Number(ideaId));
  }
  if (statusFilter) {
    clauses.push("mt.status = ?");
    binds.push(statusFilter);
  }
  const keys = Array.isArray(profileKeys)
    ? profileKeys.map((key) => String(key).trim()).filter(Boolean)
    : [];
  if (keys.length > 0) {
    clauses.push(`fv.profile_key IN (${keys.map(() => "?").join(", ")})`);
    binds.push(...keys);
  }

  let orderExpr;
  if (sortField === "updated_at") {
    orderExpr = "fv.updated_at";
  } else if (sortField === "evaluated_at") {
    orderExpr = "COALESCE(fv.evaluated_at, fv.updated_at)";
  } else if (statusFilter === "success") {
    clauses.push("json_extract(mt.diagnostics, '$.metrics') IS NOT NULL");
    clauses.push(`json_extract(mt.diagnostics, '$.metrics.${sortField}') IS NOT NULL`);
    const metricExpr = factorValidationMetricExpr(sortField);
    orderExpr = useAbs ? `ABS(${metricExpr})` : metricExpr;
  } else if (statusFilter && statusFilter !== "success") {
    orderExpr = "fv.updated_at";
  } else {
    const metricExpr = factorValidationMetricExpr(sortField);
    orderExpr = `CASE WHEN json_extract(mt.diagnostics, '$.metrics') IS NULL THEN 1 ELSE 0 END, ${useAbs ? `ABS(${metricExpr})` : metricExpr}`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderSql = `ORDER BY ${orderExpr} ${orderDir.toUpperCase()}, fv.id DESC`;

  return {
    where,
    binds,
    orderSql,
    sort: sortField,
    order: orderDir,
    abs: useAbs,
    limit: safeLimit,
    offset: safeOffset,
    status: statusFilter
  };
}

export async function listFactorValidations(
  db,
  {
    ideaId = null,
    status = null,
    profileKeys = null,
    sort = null,
    order = null,
    abs = true,
    limit = 30,
    offset = 0
  } = {}
) {
  const query = buildFactorValidationListQuery({
    ideaId,
    status,
    profileKeys,
    sort,
    order,
    abs,
    limit,
    offset
  });

  const result = await db.prepare(
    `SELECT
         fv.id,
         fv.idea_id,
         fv.profile_key,
         vp.name AS profile_name,
         fv.task_id,
         mt.status,
         mt.mlflow_experiment,
         mt.mlflow_run_id,
         mt.error_reason,
         mt.diagnostics,
         fv.factor_sql,
         fv.evaluated_at,
         fv.created_at,
         fv.updated_at,
         i.title AS idea_title,
         json_extract(mt.diagnostics, '$.mlflow_run_url') AS mlflow_run_url
       FROM factor_validations fv
       JOIN ml_tasks mt ON mt.id = fv.task_id
       JOIN ideas i ON i.id = fv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = fv.profile_key
       ${query.where}
       ${query.orderSql}
       LIMIT ? OFFSET ?`
  ).bind(...query.binds, query.limit, query.offset).all();

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS total
       FROM factor_validations fv
       JOIN ml_tasks mt ON mt.id = fv.task_id
       ${query.where}`
  ).bind(...query.binds).first();

  return {
    items: (result.results ?? []).map(rowToFactorValidationItem),
    total: Number(countRow?.total ?? 0),
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
    order: query.order,
    abs: query.abs,
    status: query.status
  };
}

export async function getFactorValidationById(db, factorValidationId) {
  const row = await db.prepare(
    `SELECT
         fv.id,
         fv.idea_id,
         fv.profile_key,
         vp.name AS profile_name,
         fv.task_id,
         mt.status,
         mt.mlflow_experiment,
         mt.mlflow_run_id,
         mt.error_reason,
         mt.diagnostics,
         fv.factor_sql,
         fv.evaluated_at,
         fv.created_at,
         fv.updated_at,
         i.title AS idea_title,
         json_extract(mt.diagnostics, '$.mlflow_run_url') AS mlflow_run_url
       FROM factor_validations fv
       JOIN ml_tasks mt ON mt.id = fv.task_id
       JOIN ideas i ON i.id = fv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = fv.profile_key
       WHERE fv.id = ?
       LIMIT 1`
  ).bind(factorValidationId).first();
  return row ? rowToFactorValidationItem(row) : null;
}

export {
  releaseMlTaskClaims as releaseFactorValidationClaims,
  updateMlTaskDiagnostics as updateFactorValidationTaskDiagnostics
};
