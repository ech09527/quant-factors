import { readMlflowConfig } from "./jupyter-execution-config.js";
import { parseJsonObject } from "./ml-task-db.js";

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

function rowToConfig(row, { includeSecret = true } = {}) {
  const config = {
    key: String(row.key),
    name: String(row.name),
    tracking_uri: String(row.tracking_uri),
    username: String(row.username),
    enabled: Number(row.enabled ?? 0) === 1,
    sort_order: Number(row.sort_order ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
  if (includeSecret) {
    config.password = String(row.password ?? "");
  } else {
    config.password_set = Boolean(String(row.password ?? "").trim());
  }
  return config;
}

function validateKey(key) {
  if (!KEY_PATTERN.test(String(key ?? "").trim())) {
    return "key 须为小写字母开头，仅含小写字母、数字、下划线、连字符";
  }
  return null;
}

function validateFields(input, { requirePassword = false } = {}) {
  if (input.name !== undefined && !String(input.name).trim()) {
    return "name 不能为空";
  }
  if (input.tracking_uri !== undefined && !String(input.tracking_uri).trim()) {
    return "tracking_uri 不能为空";
  }
  if (input.username !== undefined && !String(input.username).trim()) {
    return "username 不能为空";
  }
  if (requirePassword && input.password !== undefined && !String(input.password).trim()) {
    return "password 不能为空";
  }
  return null;
}

function normalizeTrackingUri(value) {
  return String(value ?? "").trim().replace(/\/$/, "");
}

export function mlflowConfigFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    tracking_uri: normalizeTrackingUri(row.tracking_uri),
    username: String(row.username ?? "").trim(),
    password: String(row.password ?? "").trim()
  };
}

export async function resolveActiveMlflowConfig(db, env) {
  const row = await db
    .prepare(
      `SELECT key, name, tracking_uri, username, password, enabled,
              sort_order, last_used_at, created_at, updated_at
         FROM mlflow_tracking_configs
        WHERE enabled = 1
        ORDER BY sort_order ASC, key ASC
        LIMIT 1`
    )
    .first();
  const fromDb = mlflowConfigFromRow(row);
  if (fromDb?.tracking_uri && fromDb.username && fromDb.password) {
    return { ...fromDb, source: "d1", key: row ? String(row.key) : null };
  }
  const fromEnv = readMlflowConfig(env);
  if (fromEnv.tracking_uri && fromEnv.username && fromEnv.password) {
    return { ...fromEnv, source: "env", key: null };
  }
  return null;
}

export async function listMlflowTrackingConfigs(db, { includeDisabled = true } = {}) {
  const sql = includeDisabled
    ? `SELECT key, name, tracking_uri, username, password, enabled,
              sort_order, last_used_at, created_at, updated_at
         FROM mlflow_tracking_configs
         ORDER BY sort_order ASC, key ASC`
    : `SELECT key, name, tracking_uri, username, password, enabled,
              sort_order, last_used_at, created_at, updated_at
         FROM mlflow_tracking_configs
        WHERE enabled = 1
         ORDER BY sort_order ASC, key ASC`;
  const result = await db.prepare(sql).all();
  const items = (result.results ?? []).map((row) => rowToConfig(row, { includeSecret: false }));
  const active = items.find((item) => item.enabled) ?? null;
  return { items, active_key: active?.key ?? null };
}

export async function getMlflowTrackingConfigByKey(db, key, { includeSecret = false } = {}) {
  const row = await db
    .prepare(
      `SELECT key, name, tracking_uri, username, password, enabled,
              sort_order, last_used_at, created_at, updated_at
         FROM mlflow_tracking_configs
        WHERE key = ?
        LIMIT 1`
    )
    .bind(String(key))
    .first();
  return row ? rowToConfig(row, { includeSecret }) : null;
}

async function disableOtherMlflowConfigs(db, exceptKey = null) {
  if (exceptKey == null) {
    await db
      .prepare(
        `UPDATE mlflow_tracking_configs
            SET enabled = 0, updated_at = datetime('now')
          WHERE enabled = 1`
      )
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE mlflow_tracking_configs
          SET enabled = 0, updated_at = datetime('now')
        WHERE enabled = 1 AND key != ?`
    )
    .bind(String(exceptKey))
    .run();
}

export async function createMlflowTrackingConfig(db, input, env = null) {
  const key = String(input.key ?? "").trim();
  const keyError = validateKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  const fieldError = validateFields(input, { requirePassword: true });
  if (fieldError) {
    throw new Error(fieldError);
  }

  const enabled = input.enabled === false ? 0 : 1;
  if (enabled) {
    await disableOtherMlflowConfigs(db);
  }

  const trackingUri = normalizeTrackingUri(input.tracking_uri);
  const username = String(input.username).trim();
  const password = String(input.password).trim();

  await db
    .prepare(
      `INSERT INTO mlflow_tracking_configs
         (key, name, tracking_uri, username, password, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      key,
      String(input.name).trim(),
      trackingUri,
      username,
      password,
      enabled,
      Number(input.sort_order ?? 0) || 0
    )
    .run();

  const item = await getMlflowTrackingConfigByKey(db, key, { includeSecret: false });
  if (!env) {
    return item;
  }
  const experiment = await provisionValidationExperiment(env, {
    tracking_uri: trackingUri,
    username,
    password
  });
  return { ...item, experiment };
}

export async function updateMlflowTrackingConfig(db, key, input, env = null) {
  const existing = await getMlflowTrackingConfigByKey(db, key, { includeSecret: true });
  if (!existing) {
    return null;
  }

  const fieldError = validateFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }

  const enabled = input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0;
  if (enabled) {
    await disableOtherMlflowConfigs(db, key);
  }

  const password =
    input.password !== undefined && String(input.password).trim()
      ? String(input.password).trim()
      : existing.password;
  const trackingUri = normalizeTrackingUri(
    input.tracking_uri !== undefined ? input.tracking_uri : existing.tracking_uri
  );
  const username =
    input.username !== undefined ? String(input.username).trim() : existing.username;

  await db
    .prepare(
      `UPDATE mlflow_tracking_configs
          SET name = ?,
              tracking_uri = ?,
              username = ?,
              password = ?,
              enabled = ?,
              sort_order = ?,
              updated_at = datetime('now')
        WHERE key = ?`
    )
    .bind(
      input.name !== undefined ? String(input.name).trim() : existing.name,
      trackingUri,
      username,
      password,
      enabled,
      input.sort_order !== undefined ? Number(input.sort_order) || 0 : existing.sort_order,
      String(key)
    )
    .run();

  const item = await getMlflowTrackingConfigByKey(db, key, { includeSecret: false });
  if (!env) {
    return item;
  }
  const experiment = await provisionValidationExperiment(env, {
    tracking_uri: trackingUri,
    username,
    password
  });
  return { ...item, experiment };
}

export async function deleteMlflowTrackingConfig(db, key) {
  const result = await db
    .prepare("DELETE FROM mlflow_tracking_configs WHERE key = ?")
    .bind(String(key))
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function touchMlflowTrackingConfigUsed(db, key) {
  if (!key) {
    return;
  }
  await db
    .prepare(
      `UPDATE mlflow_tracking_configs
          SET last_used_at = datetime('now'), updated_at = datetime('now')
        WHERE key = ?`
    )
    .bind(String(key))
    .run();
}

export function buildMlflowRunUrl(trackingUri, experimentId, runId) {
  const base = String(trackingUri ?? "").trim().replace(/\/$/, "");
  const run = String(runId ?? "").trim();
  const experiment = String(experimentId ?? "").trim();
  if (!base || !run || !experiment) {
    return null;
  }
  return `${base}/#/experiments/${experiment}/runs/${run}`;
}

export async function resolveMlflowConfigByKey(db, env, key) {
  if (key) {
    const row = await db
      .prepare(
        `SELECT key, name, tracking_uri, username, password, enabled,
                sort_order, last_used_at, created_at, updated_at
           FROM mlflow_tracking_configs
          WHERE key = ?
          LIMIT 1`
      )
      .bind(String(key))
      .first();
    const fromDb = mlflowConfigFromRow(row);
    if (fromDb?.tracking_uri && fromDb.username && fromDb.password) {
      return { ...fromDb, source: "d1", key: String(key) };
    }
  }
  return resolveActiveMlflowConfig(db, env);
}

export async function resolveMlflowConfigForTask(db, env, taskId) {
  const row = await db
    .prepare(
      `SELECT mlflow_tracking_config_key
         FROM ml_tasks
        WHERE id = ?
        LIMIT 1`
    )
    .bind(Number(taskId))
    .first();
  const key =
    row?.mlflow_tracking_config_key == null
      ? null
      : String(row.mlflow_tracking_config_key).trim() || null;
  return resolveMlflowConfigByKey(db, env, key);
}

async function fetchMlflowRunUrl(config, runId) {
  const trackingUri = String(config?.tracking_uri ?? "").trim().replace(/\/$/, "");
  const username = String(config?.username ?? "").trim();
  const password = String(config?.password ?? "").trim();
  const run = String(runId ?? "").trim();
  if (!trackingUri || !username || !password || !run) {
    return null;
  }
  const auth = btoa(`${username}:${password}`);
  const response = await fetch(
    `${trackingUri}/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(run)}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      }
    }
  );
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  const experimentId = payload?.run?.info?.experiment_id;
  return buildMlflowRunUrl(trackingUri, experimentId, run);
}

export async function backfillSuccessfulMlTasksMlflowTracking(db, env) {
  const active = await resolveActiveMlflowConfig(db, env);
  if (!active?.key) {
    throw new Error("无启用的 MLflow tracking 配置");
  }

  const result = await db
    .prepare(
      `SELECT id, mlflow_run_id, diagnostics
         FROM ml_tasks
        WHERE status = 'success'
          AND mlflow_run_id IS NOT NULL
          AND TRIM(mlflow_run_id) != ''
          AND (mlflow_tracking_config_key IS NULL OR TRIM(mlflow_tracking_config_key) = '')`
    )
    .all();

  let updated = 0;
  let urlsPatched = 0;
  for (const row of result.results ?? []) {
    const taskId = Number(row.id);
    const runId = String(row.mlflow_run_id ?? "").trim();
    if (!Number.isFinite(taskId) || taskId <= 0 || !runId) {
      continue;
    }

    const diagnostics = { ...(parseJsonObject(row.diagnostics) ?? {}) };
    if (!diagnostics.mlflow_run_url) {
      const runUrl = await fetchMlflowRunUrl(active, runId);
      if (runUrl) {
        diagnostics.mlflow_run_url = runUrl;
        urlsPatched += 1;
      }
    }

    const write = await db
      .prepare(
        `UPDATE ml_tasks
            SET mlflow_tracking_config_key = ?,
                diagnostics = ?,
                updated_at = datetime('now')
          WHERE id = ?`
      )
      .bind(
        active.key,
        Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null,
        taskId
      )
      .run();
    updated += Number(write.meta.changes ?? 0);
  }

  return {
    updated,
    urls_patched: urlsPatched,
    config_key: active.key,
    tracking_uri: active.tracking_uri
  };
}

const CONNECTIVITY_TEST_EXPERIMENT_PREFIX = "qf-write-probe-";

export function readValidationExperimentName(env) {
  return env.MLFLOW_EXPERIMENT_FACTOR_VALIDATION?.trim() || "factor-validation";
}

async function mlflowApiFetch(trackingUri, auth, path, { method = "GET", body = null } = {}) {
  const base = normalizeTrackingUri(trackingUri);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const detail =
      payload?.message ||
      payload?.error_message ||
      (typeof payload?.raw === "string" ? payload.raw : null) ||
      `HTTP ${response.status}`;
    throw new Error(`MLflow API ${response.status}: ${detail}`);
  }
  return payload;
}

async function mlflowGetExperimentByName(trackingUri, auth, experimentName) {
  const base = normalizeTrackingUri(trackingUri);
  const response = await fetch(
    `${base}/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(experimentName)}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      }
    }
  );
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const detail =
      payload?.message ||
      payload?.error_message ||
      text.slice(0, 300) ||
      `HTTP ${response.status}`;
    throw new Error(`MLflow API ${response.status}: ${detail}`);
  }
  return payload?.experiment ?? null;
}

async function mlflowCreateExperiment(trackingUri, auth, experimentName) {
  const payload = await mlflowApiFetch(trackingUri, auth, "/api/2.0/mlflow/experiments/create", {
    method: "POST",
    body: { name: experimentName }
  });
  const experimentId = String(payload?.experiment_id ?? "").trim();
  if (!experimentId) {
    throw new Error(`创建 experiment 失败: ${experimentName}`);
  }
  return experimentId;
}

export async function ensureMlflowExperiment(trackingUri, auth, experimentName) {
  const name = String(experimentName ?? "").trim();
  if (!name) {
    throw new Error("experiment 名称不能为空");
  }
  const existing = await mlflowGetExperimentByName(trackingUri, auth, name);
  const existingId = String(existing?.experiment_id ?? "").trim();
  if (existingId) {
    return { name, experiment_id: existingId, created: false };
  }
  const experimentId = await mlflowCreateExperiment(trackingUri, auth, name);
  return { name, experiment_id: experimentId, created: true };
}

async function mlflowWriteProbeRun(trackingUri, auth, experimentId) {
  const now = Date.now();
  const createPayload = await mlflowApiFetch(trackingUri, auth, "/api/2.0/mlflow/runs/create", {
    method: "POST",
    body: {
      experiment_id: experimentId,
      start_time: now,
      run_name: `qf-connectivity-test-${now}`
    }
  });
  const runId = String(createPayload?.run?.info?.run_id ?? "").trim();
  if (!runId) {
    throw new Error("创建测试 Run 失败");
  }
  await mlflowApiFetch(trackingUri, auth, "/api/2.0/mlflow/runs/update", {
    method: "POST",
    body: {
      run_id: runId,
      status: "FINISHED",
      end_time: Date.now()
    }
  });
  return runId;
}

async function provisionValidationExperiment(env, credentials) {
  const trackingUri = normalizeTrackingUri(credentials.tracking_uri);
  const username = String(credentials.username ?? "").trim();
  const password = String(credentials.password ?? "").trim();
  if (!trackingUri || !username || !password) {
    throw new Error("缺少 MLflow 凭证，无法创建 experiment");
  }
  const auth = btoa(`${username}:${password}`);
  return ensureMlflowExperiment(trackingUri, auth, readValidationExperimentName(env));
}

export async function testMlflowTrackingConnection(db, env, input) {
  let trackingUri = normalizeTrackingUri(input.tracking_uri);
  let username = String(input.username ?? "").trim();
  let password = String(input.password ?? "").trim();
  const configKey = String(input.key ?? "").trim();

  if (!password && configKey) {
    const existing = await getMlflowTrackingConfigByKey(db, configKey, { includeSecret: true });
    if (existing) {
      password = String(existing.password ?? "").trim();
      if (!trackingUri) {
        trackingUri = normalizeTrackingUri(existing.tracking_uri);
      }
      if (!username) {
        username = String(existing.username ?? "").trim();
      }
    }
  }

  if (!trackingUri) {
    throw new Error("tracking_uri 不能为空");
  }
  if (!username || !password) {
    throw new Error("username 与 password 不能为空");
  }

  const auth = btoa(`${username}:${password}`);
  const startedAt = Date.now();

  const searchPayload = await mlflowApiFetch(
    trackingUri,
    auth,
    "/api/2.0/mlflow/experiments/search",
    {
      method: "POST",
      body: { max_results: 5, order_by: ["name ASC"] }
    }
  );
  const existingExperiments = (searchPayload?.experiments ?? [])
    .map((item) => String(item?.name ?? "").trim())
    .filter(Boolean);

  const probeName = `${CONNECTIVITY_TEST_EXPERIMENT_PREFIX}${Date.now()}`;
  const probeExperimentId = await mlflowCreateExperiment(trackingUri, auth, probeName);
  let testRunId = "";
  try {
    testRunId = await mlflowWriteProbeRun(trackingUri, auth, probeExperimentId);
  } finally {
    try {
      await mlflowApiFetch(trackingUri, auth, "/api/2.0/mlflow/experiments/delete", {
        method: "POST",
        body: { experiment_id: probeExperimentId }
      });
    } catch {
      // 清理失败不影响连通性判定
    }
  }

  return {
    ok: true,
    tracking_uri: trackingUri,
    test_experiment: probeName,
    existing_experiments: existingExperiments,
    test_run_id: testRunId,
    latency_ms: Date.now() - startedAt
  };
}
