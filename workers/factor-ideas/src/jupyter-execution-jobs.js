import { parseJsonObject } from "./ml-task-db.js";

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

export async function loadFactorValidationJobByTaskId(db, taskId) {
  const row = await db.prepare(
    `SELECT
         fv.id AS factor_validation_id,
         fv.task_id,
         fv.idea_id,
         fv.profile_key,
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
       FROM factor_validations fv
       JOIN ml_tasks mt ON mt.id = fv.task_id
       JOIN ideas i ON i.id = fv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = fv.profile_key
       WHERE fv.task_id = ?
       LIMIT 1`
  ).bind(Number(taskId)).first();
  if (!row) {
    return null;
  }
  return {
    task_id: Number(row.task_id),
    factor_validation_id: Number(row.factor_validation_id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: row.profile_name == null ? null : String(row.profile_name),
    label_kind: row.label_kind == null ? null : String(row.label_kind),
    horizon_bars: row.horizon_bars == null ? null : Number(row.horizon_bars),
    title: String(row.title),
    title_hash: String(row.title_hash),
    factor_expr: String(row.factor_expr),
    hypothesis: String(row.hypothesis),
    formula_sketch: String(row.formula_sketch),
    expected_signal: String(row.expected_signal),
    data_sources: parseJsonArray(row.data_sources),
    factor_sql: parseJsonObject(row.factor_sql)
  };
}

export async function loadTestFactorValidationJobByTaskId(db, taskId) {
  const row = await db.prepare(
    `SELECT
         tfv.id AS test_factor_validation_id,
         tfv.task_id,
         tfv.idea_id,
         tfv.profile_key,
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
       FROM test_factor_validations tfv
       JOIN ml_tasks mt ON mt.id = tfv.task_id
       JOIN ideas i ON i.id = tfv.idea_id
       LEFT JOIN validation_profiles vp ON vp.key = tfv.profile_key
       WHERE tfv.task_id = ? AND mt.business_type = 'test_factor_validation'
       LIMIT 1`
  ).bind(Number(taskId)).first();
  if (!row) {
    return null;
  }
  return {
    task_id: Number(row.task_id),
    test_factor_validation_id: Number(row.test_factor_validation_id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: row.profile_name == null ? null : String(row.profile_name),
    label_kind: row.label_kind == null ? null : String(row.label_kind),
    horizon_bars: row.horizon_bars == null ? null : Number(row.horizon_bars),
    title: String(row.title),
    title_hash: String(row.title_hash),
    factor_expr: String(row.factor_expr),
    hypothesis: String(row.hypothesis),
    formula_sketch: String(row.formula_sketch),
    expected_signal: String(row.expected_signal),
    data_sources: parseJsonArray(row.data_sources),
    factor_sql: parseJsonObject(row.factor_sql)
  };
}

export async function loadExecutionJob(db, execution) {
  if (execution.business_type === "test_factor_validation") {
    return loadTestFactorValidationJobByTaskId(db, execution.business_id);
  }
  if (execution.business_type === "factor_validation") {
    return loadFactorValidationJobByTaskId(db, execution.business_id);
  }
  return null;
}
