import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import { readJupyterExecutionTimeoutMinutes } from "./jupyter-execution-config.js";
import {
  BUSINESS_TYPE_TEST_FACTOR_VALIDATION,
  createMlTask,
  parseJsonObject,
  reclaimStaleMlTasks,
  releaseMlTaskClaims,
  reportMlTaskResults,
  stripKernelExecutionDiagnostics,
  updateMlTaskDiagnostics
} from "./ml-task-db.js";
import { TEST_FACTOR_VALIDATION_EXPERIMENT } from "./jupyter-execution-config.js";

function readStaleRunningMinutes(env, fallback = 5) {
  const parsed = Number(env?.VALIDATION_STALE_RUNNING_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 60);
}

function buildTestFactorValidationJobFrom(staleRunningMinutes) {
  return `
    FROM ideas i
    CROSS JOIN validation_profiles vp
    LEFT JOIN test_factor_validations tfv
      ON tfv.idea_id = i.id AND tfv.profile_key = vp.key
    LEFT JOIN ml_tasks mt
      ON mt.id = tfv.task_id AND mt.business_type = 'test_factor_validation'
    WHERE vp.enabled = 1
      AND i.factor_sql IS NOT NULL
      AND TRIM(i.factor_sql) != ''
      AND TRIM(i.factor_sql) != 'null'
      AND (tfv.id IS NULL OR mt.status NOT IN ('success', 'skipped'))
      AND (
        tfv.id IS NULL
        OR mt.status != 'running'
        OR mt.updated_at < datetime('now', '-${staleRunningMinutes} minutes')
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

function rowToTestFactorValidationJob(row) {
  return {
    test_factor_validation_id: Number(row.test_factor_validation_id),
    task_id: Number(row.task_id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: row.profile_name == null ? null : String(row.profile_name),
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

export function rowToTestFactorValidationItem(row) {
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
    diagnostics: parseJsonObject(row.diagnostics),
    evaluated_at: row.evaluated_at == null ? null : String(row.evaluated_at),
    idea_title: row.idea_title == null ? null : String(row.idea_title),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export async function listPendingTestFactorValidationJobs(db, limit = null, env = null) {
  const staleRunningMinutes = readStaleRunningMinutes(env);
  await reclaimStaleMlTasks(db, readJupyterExecutionTimeoutMinutes(env, 45));
  const hasLimit = limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0;
  const sql = `SELECT
         COALESCE(tfv.id, 0) AS test_factor_validation_id,
         COALESCE(tfv.task_id, 0) AS task_id,
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
       ${buildTestFactorValidationJobFrom(staleRunningMinutes)}
       ORDER BY
         CASE
           WHEN tfv.id IS NOT NULL AND mt.status = 'pending' THEN 0
           WHEN tfv.id IS NOT NULL AND mt.status = 'failed' THEN 1
           WHEN tfv.id IS NULL THEN 2
           ELSE 3
         END ASC,
         i.id ASC,
         vp.sort_order ASC,
         vp.key ASC${hasLimit ? " LIMIT ?" : ""}`;
  const result = hasLimit
    ? await db.prepare(sql).bind(Number(limit)).all()
    : await db.prepare(sql).all();

  return {
    items: (result.results ?? []).map(rowToTestFactorValidationJob)
  };
}

export async function ensureTestFactorValidationRecords(db, ideaId, profileKey) {
  const existing = await db.prepare(
    `SELECT tfv.id, tfv.task_id, mt.status
       FROM test_factor_validations tfv
       JOIN ml_tasks mt ON mt.id = tfv.task_id
       WHERE tfv.idea_id = ? AND tfv.profile_key = ?
       LIMIT 1`
  ).bind(ideaId, profileKey).first();

  if (existing) {
    return {
      test_factor_validation_id: Number(existing.id),
      task_id: Number(existing.task_id),
      status: String(existing.status)
    };
  }

  const taskId = await createMlTask(db, {
    businessType: BUSINESS_TYPE_TEST_FACTOR_VALIDATION,
    mlflowExperiment: TEST_FACTOR_VALIDATION_EXPERIMENT
  });

  const insert = await db.prepare(
    `INSERT INTO test_factor_validations (idea_id, profile_key, task_id, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(ideaId, profileKey, taskId).run();
  const testFactorValidationId = Number(insert.meta.last_row_id ?? 0);
  if (testFactorValidationId <= 0) {
    throw new Error("创建 test_factor_validations 失败");
  }

  await db.prepare(
    `UPDATE ml_tasks
       SET business_id = ?, updated_at = datetime('now')
       WHERE id = ?`
  ).bind(testFactorValidationId, taskId).run();

  return {
    test_factor_validation_id: testFactorValidationId,
    task_id: taskId,
    status: "pending"
  };
}

export async function claimTestFactorValidationJobs(db, jobs, env = null) {
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

    const record = await ensureTestFactorValidationRecords(db, ideaId, profileKey);
    const { test_factor_validation_id: testFactorValidationId, task_id: taskId } = record;

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
           AND business_type = 'test_factor_validation'
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
              WHERE je.business_type = 'test_factor_validation'
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
      test_factor_validation_id: testFactorValidationId,
      idea_id: ideaId,
      profile_key: profileKey
    });
  }

  return { claimed, ids: claimedIds, jobs: claimedJobs };
}

export function mergeClaimedTestFactorValidationJobs(pendingItems, claimedJobs) {
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
        test_factor_validation_id: claimed.test_factor_validation_id,
        task_id: claimed.task_id
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

function normalizeTestFactorValidationReportItem(item) {
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

export async function reportTestFactorValidationResults(db, items) {
  let updated = 0;
  const reports = [];
  for (const item of items) {
    const taskId = Number(item.task_id);
    const testFactorValidationId = Number(item.test_factor_validation_id);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      continue;
    }

    const normalized = normalizeTestFactorValidationReportItem(
      coerceEvalPhaseRunningStatus(item)
    );
    const taskReport = await reportMlTaskResults(db, [normalized]);
    const taskUpdated = Number(taskReport.results?.[0]?.updated ?? 0);
    updated += taskUpdated;
    reports.push({ task_id: taskId, updated: taskUpdated, normalized });

    if (taskUpdated <= 0 || !Number.isFinite(testFactorValidationId) || testFactorValidationId <= 0) {
      continue;
    }

    const factorSqlJson =
      normalized.factor_sql && typeof normalized.factor_sql === "object"
        ? JSON.stringify(normalized.factor_sql)
        : null;

    await db.prepare(
      `UPDATE test_factor_validations
         SET factor_sql = COALESCE(?, factor_sql),
             evaluated_at = COALESCE(?, evaluated_at),
             updated_at = datetime('now')
         WHERE id = ?`
    ).bind(factorSqlJson, normalized.evaluated_at ?? null, testFactorValidationId).run();
  }
  return { updated, reports };
}

export async function resetTestFactorValidationWorkflow(db) {
  const execDelete = await db.prepare(
    `DELETE FROM jupyter_executions WHERE business_type = 'test_factor_validation'`
  ).run();

  const tasksReset = await db.prepare(
    `UPDATE ml_tasks
       SET status = 'pending',
           error_reason = NULL,
           diagnostics = NULL,
           submitted_at = NULL,
           completed_at = NULL,
           mlflow_run_id = NULL,
           updated_at = datetime('now')
     WHERE business_type = 'test_factor_validation'
       AND status != 'pending'`
  ).run();

  const tfvReset = await db.prepare(
    `UPDATE test_factor_validations
       SET factor_sql = NULL,
           evaluated_at = NULL,
           updated_at = datetime('now')`
  ).run();

  const pendingRow = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM ideas i
       CROSS JOIN validation_profiles vp
       WHERE vp.enabled = 1
         AND i.factor_sql IS NOT NULL
         AND TRIM(i.factor_sql) != ''
         AND TRIM(i.factor_sql) != 'null'`
  ).first();

  return {
    jupyter_executions_deleted: Number(execDelete.meta.changes ?? 0),
    ml_tasks_reset: Number(tasksReset.meta.changes ?? 0),
    test_factor_validations_cleared: Number(tfvReset.meta.changes ?? 0),
    eligible_idea_profile_pairs: Number(pendingRow?.n ?? 0)
  };
}

export async function enqueueTestFactorValidations(db, ideaId, profileKeys) {
  const keys = [...new Set(profileKeys.map((key) => String(key).trim()).filter(Boolean))];
  const created = [];
  for (const profileKey of keys) {
    const record = await ensureTestFactorValidationRecords(db, ideaId, profileKey);
    created.push({
      test_factor_validation_id: record.test_factor_validation_id,
      task_id: record.task_id,
      profile_key: profileKey,
      status: record.status
    });
  }
  return { created };
}

export async function listTestFactorValidations(
  db,
  { ideaId = null, status = null, profileKeys = null, limit = 30, offset = 0 } = {}
) {
  const params = [];
  const clauses = ["mt.business_type = 'test_factor_validation'"];
  if (ideaId != null) {
    clauses.push("tfv.idea_id = ?");
    params.push(Number(ideaId));
  }
  if (status != null && String(status).trim()) {
    clauses.push("mt.status = ?");
    params.push(String(status).trim());
  }
  const keys = Array.isArray(profileKeys)
    ? profileKeys.map((key) => String(key).trim()).filter(Boolean)
    : [];
  if (keys.length > 0) {
    clauses.push(`tfv.profile_key IN (${keys.map(() => "?").join(", ")})`);
    params.push(...keys);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  params.push(limit, offset);

  const result = await db.prepare(
    `SELECT
         tfv.id,
         tfv.idea_id,
         tfv.profile_key,
         vp.name AS profile_name,
         tfv.task_id,
         mt.status,
         mt.mlflow_experiment,
         mt.mlflow_run_id,
         mt.error_reason,
         mt.diagnostics,
         tfv.factor_sql,
         tfv.evaluated_at,
         tfv.created_at,
         tfv.updated_at,
         i.title AS idea_title,
         json_extract(mt.diagnostics, '$.mlflow_run_url') AS mlflow_run_url
       FROM test_factor_validations tfv
       JOIN ml_tasks mt ON mt.id = tfv.task_id
       JOIN ideas i ON i.id = tfv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = tfv.profile_key
       ${where}
       ORDER BY tfv.updated_at DESC
       LIMIT ? OFFSET ?`
  ).bind(...params).all();

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS total
       FROM test_factor_validations tfv
       JOIN ml_tasks mt ON mt.id = tfv.task_id
       ${where}`
  ).bind(...params.slice(0, -2)).first();

  return {
    items: (result.results ?? []).map(rowToTestFactorValidationItem),
    total: Number(countRow?.total ?? 0),
    limit,
    offset
  };
}

export async function getTestFactorValidationById(db, testFactorValidationId) {
  const row = await db.prepare(
    `SELECT
         tfv.id,
         tfv.idea_id,
         tfv.profile_key,
         vp.name AS profile_name,
         tfv.task_id,
         mt.status,
         mt.mlflow_experiment,
         mt.mlflow_run_id,
         mt.error_reason,
         mt.diagnostics,
         tfv.factor_sql,
         tfv.evaluated_at,
         tfv.created_at,
         tfv.updated_at,
         i.title AS idea_title,
         json_extract(mt.diagnostics, '$.mlflow_run_url') AS mlflow_run_url
       FROM test_factor_validations tfv
       JOIN ml_tasks mt ON mt.id = tfv.task_id
       JOIN ideas i ON i.id = tfv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = tfv.profile_key
       WHERE tfv.id = ? AND mt.business_type = 'test_factor_validation'
       LIMIT 1`
  ).bind(testFactorValidationId).first();
  return row ? rowToTestFactorValidationItem(row) : null;
}

export {
  releaseMlTaskClaims as releaseTestFactorValidationClaims,
  updateMlTaskDiagnostics as updateTestFactorValidationTaskDiagnostics
};
