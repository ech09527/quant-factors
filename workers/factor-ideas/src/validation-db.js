function readStaleRunningMinutes(env, fallback = 5) {
  const parsed = Number(env?.VALIDATION_STALE_RUNNING_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 60);
}

function buildValidationWorkflowJobFrom(staleRunningMinutes) {
  return `
    FROM ideas i
    CROSS JOIN validation_profiles vp
    LEFT JOIN idea_validations iv
      ON iv.idea_id = i.id AND iv.profile_key = vp.key
    WHERE vp.enabled = 1
      AND i.factor_sql IS NOT NULL
      AND TRIM(i.factor_sql) != ''
      AND TRIM(i.factor_sql) != 'null'
      AND (iv.id IS NULL OR iv.status NOT IN ('success', 'skipped'))
      AND (
        iv.id IS NULL
        OR iv.status != 'running'
        OR iv.updated_at < datetime('now', '-${staleRunningMinutes} minutes')
      )`;
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

function stripKernelExecutionDiagnostics(diagnostics) {
  const next = { ...(diagnostics ?? {}) };
  for (const key of KERNEL_EXECUTION_DIAGNOSTIC_KEYS) {
    delete next[key];
  }
  return next;
}

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

function rowToWorkflowJob(row) {
  return {
    validation_id: Number(row.validation_id),
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

function parseRuntimeConfigValue(raw) {
  if (raw == null || raw === "") {
    return { target_file: "futures/um/klines/1h.parquet" };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  const text = String(raw).trim();
  if (!text) {
    return { target_file: "futures/um/klines/1h.parquet" };
  }
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime_config 必须是 JSON 对象");
  }
  return parsed;
}

function rowToJupyterServer(row) {
  const maxKernelsRaw = row.max_kernels;
  const maxKernels =
    maxKernelsRaw == null || maxKernelsRaw === ""
      ? null
      : Number(maxKernelsRaw);
  return {
    key: String(row.key),
    name: String(row.name),
    base_url: String(row.base_url),
    evaluate_path: String(row.evaluate_path),
    proxy_url: row.proxy_url == null ? null : String(row.proxy_url),
    connect_mode: row.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api",
    ws_base_url: row.ws_base_url == null ? null : String(row.ws_base_url),
    kernel_name: String(row.kernel_name ?? "python3"),
    auth_header: String(row.auth_header),
    auth_scheme: String(row.auth_scheme),
    auth_token: String(row.auth_token),
    runtime_config: parseRuntimeConfigValue(row.runtime_config),
    max_kernels:
      maxKernelsRaw === 0 || maxKernelsRaw === "0"
        ? null
        : Number.isFinite(maxKernels) && maxKernels > 0
          ? Math.floor(maxKernels)
          : 30,
    enabled: Number(row.enabled ?? 1) === 1,
    sort_order: Number(row.sort_order ?? 0)
  };
}

export async function reclaimStaleValidationJobs(db, maxAgeMinutes = 60) {
  const result = await db.prepare(
    `UPDATE idea_validations
       SET status = 'failed',
           error_reason = COALESCE(error_reason, 'stale running reclaimed'),
           updated_at = datetime('now')
       WHERE status = 'running'
         AND updated_at < datetime('now', ?)`
  ).bind(`-${maxAgeMinutes} minutes`).run();
  return { reclaimed: Number(result.meta.changes ?? 0) };
}

export async function listPendingValidationWorkflowJobs(db, limit, env = null) {
  const staleRunningMinutes = readStaleRunningMinutes(env);
  await reclaimStaleValidationJobs(db, Math.max(staleRunningMinutes * 6, 30));
  const result = await db.prepare(
    `SELECT
         COALESCE(iv.id, 0) AS validation_id,
         i.id AS idea_id,
         vp.key AS profile_key,
         COALESCE(iv.status, 'queued') AS status,
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
       ${buildValidationWorkflowJobFrom(staleRunningMinutes)}
       ORDER BY
         CASE WHEN iv.id IS NULL THEN 0 WHEN iv.status = 'failed' THEN 1 ELSE 2 END,
         COALESCE(iv.updated_at, i.created_at) ASC,
         i.id ASC,
         vp.sort_order ASC,
         vp.key ASC
       LIMIT ?`
  ).bind(limit).all();
  return {
    items: (result.results ?? []).map(rowToWorkflowJob)
  };
}

export async function claimValidationWorkflowJobs(db, jobs) {
  if (jobs.length === 0) {
    return { claimed: 0, ids: [], jobs: [] };
  }
  let claimed = 0;
  const claimedIds = [];
  const claimedJobs = [];
  for (const job of jobs) {
    const ideaId = Number(job.idea_id);
    const profileKey = String(job.profile_key ?? "").trim();
    if (!Number.isFinite(ideaId) || ideaId <= 0 || !profileKey) {
      continue;
    }
    const existing = await db.prepare(
      `SELECT id, status, updated_at, diagnostics
         FROM idea_validations
         WHERE idea_id = ? AND profile_key = ?
         LIMIT 1`
    ).bind(ideaId, profileKey).first();
    let validationId = 0;
    if (existing) {
      const status = String(existing.status);
      if (status === "success" || status === "skipped" || status === "running") {
        continue;
      }
      const resetDiagnostics = stripKernelExecutionDiagnostics(
        parseJsonObject(existing.diagnostics) ?? {}
      );
      const diagnosticsJson =
        Object.keys(resetDiagnostics).length > 0 ? JSON.stringify(resetDiagnostics) : null;
      const result = await db.prepare(
        `UPDATE idea_validations
           SET status = 'running',
               error_reason = NULL,
               diagnostics = ?,
               updated_at = datetime('now')
           WHERE id = ? AND status NOT IN ('success', 'skipped', 'running')`
      ).bind(diagnosticsJson, existing.id).run();
      if (Number(result.meta.changes ?? 0) === 0) {
        continue;
      }
      validationId = Number(existing.id);
    } else {
      const insert = await db.prepare(
        `INSERT INTO idea_validations (idea_id, profile_key, status, updated_at)
           VALUES (?, ?, 'running', datetime('now'))`
      ).bind(ideaId, profileKey).run();
      validationId = Number(insert.meta.last_row_id ?? 0);
      if (validationId <= 0) {
        continue;
      }
    }
    claimed += 1;
    claimedIds.push(validationId);
    claimedJobs.push({ validation_id: validationId, idea_id: ideaId, profile_key: profileKey });
  }
  return { claimed, ids: claimedIds, jobs: claimedJobs };
}

export async function reportValidationWorkflowResults(db, items) {
  let updated = 0;
  for (const item of items) {
    const existing = await db.prepare(
      `SELECT profile_key, status, diagnostics
         FROM idea_validations
         WHERE id = ?
         LIMIT 1`
    ).bind(item.validation_id).first();
    if (!existing) {
      continue;
    }

    let status = item.status;
    let errorReason = item.error_reason ?? null;
    let metrics = item.metrics;
    let diagnostics = {
      ...(parseJsonObject(existing.diagnostics) ?? {}),
      ...(item.diagnostics ?? {})
    };

    if (status === "success") {
      const expectedProfile = String(existing.profile_key ?? "").trim();
      const actualProfile = String(
        metrics?.validation_profile_key ?? item.validation_profile_key ?? ""
      ).trim();
      if (expectedProfile && actualProfile && expectedProfile !== actualProfile) {
        status = "failed";
        errorReason = `validation_profile 不匹配: 期望 ${expectedProfile}, 实际 ${actualProfile}`;
        diagnostics = {
          ...(diagnostics ?? {}),
          profile_mismatch: { expected: expectedProfile, actual: actualProfile }
        };
      }
    }

    const result = await db.prepare(
      `UPDATE idea_validations
         SET status = ?,
             factor_sql = ?,
             metrics = ?,
             diagnostics = ?,
             error_reason = ?,
             engine_version = ?,
             metrics_version = ?,
             evaluated_at = ?,
             updated_at = datetime('now')
         WHERE id = ?`
    ).bind(
      status,
      item.factor_sql ? JSON.stringify(item.factor_sql) : null,
      metrics ? JSON.stringify(metrics) : null,
      diagnostics ? JSON.stringify(diagnostics) : null,
      errorReason,
      item.engine_version ?? null,
      item.metrics_version ?? null,
      item.evaluated_at ?? null,
      item.validation_id
    ).run();
    updated += Number(result.meta.changes ?? 0);
  }
  return { updated };
}

export async function updateValidationDiagnostics(db, validationId, patch) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM idea_validations
       WHERE id = ? AND status = 'running'
       LIMIT 1`
  ).bind(validationId).first();
  if (!existing) {
    return { updated: 0 };
  }
  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    ...(patch ?? {})
  };
  const result = await db.prepare(
    `UPDATE idea_validations
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'running'`
  ).bind(JSON.stringify(diagnostics), validationId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function listEnabledJupyterServers(db) {
  const result = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config, max_kernels,
         enabled, sort_order
       FROM jupyter_servers
       WHERE enabled = 1
       ORDER BY sort_order ASC, key ASC`
  ).all();
  return (result.results ?? []).map(rowToJupyterServer);
}

export async function markJupyterServerUsed(db, key) {
  const result = await db.prepare(
    `UPDATE jupyter_servers
       SET last_used_at = datetime('now'), updated_at = datetime('now')
       WHERE key = ?`
  ).bind(key).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function getJupyterServerByKey(db, key) {
  const result = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config, max_kernels,
         enabled, sort_order
       FROM jupyter_servers
       WHERE key = ?
       LIMIT 1`
  ).bind(key).first();
  return result ? rowToJupyterServer(result) : null;
}

export async function releaseValidationWorkflowClaims(db, validationIds, errorReason) {
  if (!validationIds.length) {
    return { released: 0 };
  }
  let released = 0;
  const reason = String(errorReason ?? "jupyter kernel capacity reached").trim();
  for (const validationId of validationIds) {
    const id = Number(validationId);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    const existing = await db.prepare(
      `SELECT diagnostics
         FROM idea_validations
         WHERE id = ? AND status = 'running'
         LIMIT 1`
    ).bind(id).first();
    if (!existing) {
      continue;
    }
    const diagnostics = stripKernelExecutionDiagnostics(
      parseJsonObject(existing.diagnostics) ?? {}
    );
    const diagnosticsJson =
      Object.keys(diagnostics).length > 0 ? JSON.stringify(diagnostics) : null;
    const result = await db.prepare(
      `UPDATE idea_validations
         SET status = 'failed',
             error_reason = ?,
             diagnostics = ?,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'running'`
    ).bind(reason, diagnosticsJson, id).run();
    released += Number(result.meta.changes ?? 0);
  }
  return { released };
}

export async function listValidationsPendingKernelCleanup(db, { limit, graceMinutes }) {
  const result = await db.prepare(
    `SELECT id, diagnostics, status, updated_at
       FROM idea_validations
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
      validation_id: Number(row.id),
      status: String(row.status),
      kernel_id: String(diagnostics.kernel_id ?? "").trim(),
      jupyter_server_key: String(diagnostics.jupyter_server_key ?? "").trim()
    };
  });
}

export async function listActiveJupyterKernelIds(db) {
  const result = await db.prepare(
    `SELECT diagnostics
       FROM idea_validations
       WHERE diagnostics IS NOT NULL
         AND status IN ('running', 'success', 'failed', 'skipped')
         AND json_extract(diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(diagnostics, '$.kernel_id')) != ''
         AND (
           status = 'running'
           OR json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL
         )`
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

export async function getValidationKernelCleanupTarget(db, validationId, expectedKernelId) {
  const row = await db.prepare(
    `SELECT status, diagnostics
       FROM idea_validations
       WHERE id = ?
       LIMIT 1`
  ).bind(validationId).first();
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
    validation_id: validationId,
    status,
    kernel_id: kernelId,
    jupyter_server_key: String(diagnostics.jupyter_server_key ?? "").trim()
  };
}

export async function markValidationKernelCleaned(db, validationId, kernelId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM idea_validations
       WHERE id = ?
       LIMIT 1`
  ).bind(validationId).first();
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
    `UPDATE idea_validations
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('success', 'failed', 'skipped')
         AND json_extract(diagnostics, '$.kernel_id') = ?
         AND json_extract(diagnostics, '$.kernel_cleaned_at') IS NULL`
  ).bind(JSON.stringify(nextDiagnostics), validationId, expectedKernelId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function patchValidationDiagnostics(db, validationId, patch = {}) {
  const existing = await db.prepare(
    `SELECT diagnostics
       FROM idea_validations
       WHERE id = ?
       LIMIT 1`
  ).bind(validationId).first();
  if (!existing) {
    return { updated: 0 };
  }

  const diagnostics = {
    ...(parseJsonObject(existing.diagnostics) ?? {}),
    ...patch
  };
  const result = await db.prepare(
    `UPDATE idea_validations
       SET diagnostics = ?,
           updated_at = datetime('now')
       WHERE id = ?`
  ).bind(JSON.stringify(diagnostics), validationId).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function listJupyterServers(db, { includeDisabled = false } = {}) {
  const where = includeDisabled ? "" : "WHERE enabled = 1";
  const result = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config, max_kernels,
         enabled, sort_order, last_used_at
       FROM jupyter_servers
       ${where}
       ORDER BY sort_order ASC, key ASC`
  ).all();
  return (result.results ?? []).map(rowToJupyterServer);
}

export async function listJupyterKernelValidationBindings(db) {
  const result = await db.prepare(
    `SELECT
         iv.id AS validation_id,
         iv.status,
         iv.idea_id,
         iv.profile_key,
         i.title,
         json_extract(iv.diagnostics, '$.kernel_id') AS kernel_id,
         json_extract(iv.diagnostics, '$.jupyter_server_key') AS jupyter_server_key,
         json_extract(iv.diagnostics, '$.kernel_cleaned_at') AS kernel_cleaned_at,
         iv.updated_at
       FROM idea_validations iv
       JOIN ideas i ON i.id = iv.idea_id
       WHERE iv.diagnostics IS NOT NULL
         AND json_extract(iv.diagnostics, '$.kernel_id') IS NOT NULL
         AND TRIM(json_extract(iv.diagnostics, '$.kernel_id')) != ''`
  ).all();

  const byKernelId = new Map();
  for (const row of result.results ?? []) {
    const kernelId = String(row.kernel_id ?? "").trim();
    if (!kernelId) {
      continue;
    }
    byKernelId.set(kernelId, {
      validation_id: Number(row.validation_id),
      status: String(row.status ?? ""),
      idea_id: Number(row.idea_id),
      profile_key: String(row.profile_key ?? ""),
      title: String(row.title ?? ""),
      jupyter_server_key: String(row.jupyter_server_key ?? "").trim(),
      kernel_cleaned_at: row.kernel_cleaned_at == null ? null : String(row.kernel_cleaned_at),
      updated_at: row.updated_at == null ? null : String(row.updated_at),
    });
  }
  return byKernelId;
}

export function mergeClaimedJobs(pendingItems, claimedJobs) {
  const claimMap = new Map();
  for (const item of claimedJobs) {
    claimMap.set(`${item.idea_id}:${item.profile_key}`, item.validation_id);
  }
  return pendingItems
    .map((job) => {
      const key = `${job.idea_id}:${job.profile_key}`;
      const validationId = claimMap.get(key);
      if (!validationId) {
        return null;
      }
      return { ...job, validation_id: validationId };
    })
    .filter(Boolean);
}
