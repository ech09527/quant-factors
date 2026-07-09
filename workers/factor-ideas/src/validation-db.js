const VALIDATION_WORKFLOW_JOB_FROM = `
    FROM ideas i
    CROSS JOIN validation_profiles vp
    LEFT JOIN idea_validations iv
      ON iv.idea_id = i.id AND iv.profile_key = vp.key
    WHERE vp.enabled = 1
      AND (iv.id IS NULL OR iv.status NOT IN ('success', 'skipped'))
      AND (
        iv.id IS NULL
        OR iv.status != 'running'
        OR iv.updated_at < datetime('now', '-10 minutes')
      )`;

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
    enabled: Number(row.enabled ?? 1) === 1,
    sort_order: Number(row.sort_order ?? 0)
  };
}

export async function reclaimStaleValidationJobs(db, maxAgeMinutes = 120) {
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

export async function listPendingValidationWorkflowJobs(db, limit) {
  await reclaimStaleValidationJobs(db);
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
         i.data_sources
       ${VALIDATION_WORKFLOW_JOB_FROM}
       ORDER BY
         CASE WHEN iv.id IS NULL THEN 0 WHEN iv.status = 'failed' THEN 1 ELSE 2 END,
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
      `SELECT id, status, updated_at
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
      const result = await db.prepare(
        `UPDATE idea_validations
           SET status = 'running', error_reason = NULL, updated_at = datetime('now')
           WHERE id = ? AND status NOT IN ('success', 'skipped', 'running')`
      ).bind(existing.id).run();
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
      `SELECT profile_key, status
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
    let diagnostics = item.diagnostics;

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

export async function updateValidationDiagnostics(db, validationId, diagnostics) {
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
         auth_header, auth_scheme, auth_token, runtime_config,
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
