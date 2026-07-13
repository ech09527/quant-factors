const JUPYTER_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CONNECT_MODES = new Set(["batch_api", "kernel_channels"]);

const JUPYTER_SERVER_COLUMNS = `
  key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
  auth_header, auth_scheme, auth_token, runtime_config, max_kernels,
  enabled, sort_order, last_used_at, expires_at, created_at, updated_at
`;

function defaultRuntimeConfig() {
  return { target_file: "futures/um/klines/1h.parquet" };
}

export function parseRuntimeConfigValue(raw) {
  if (raw == null || raw === "") {
    return defaultRuntimeConfig();
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  const text = String(raw).trim();
  if (!text) {
    return defaultRuntimeConfig();
  }
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime_config 必须是 JSON 对象");
  }
  return parsed;
}

function serializeRuntimeConfig(config) {
  return JSON.stringify(config ?? defaultRuntimeConfig());
}

function isExpiredAt(value) {
  if (value == null || value === "") {
    return false;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) && ms <= Date.now();
}

export function resolveExpiresAt(input = {}) {
  const expiresAtRaw = input.expires_at;
  if (expiresAtRaw != null && String(expiresAtRaw).trim()) {
    const ms = Date.parse(String(expiresAtRaw).trim());
    if (!Number.isFinite(ms)) {
      throw new Error("expires_at 无效");
    }
    if (ms <= Date.now()) {
      throw new Error("expires_at 必须晚于当前时间");
    }
    return new Date(ms).toISOString();
  }

  const expiresInMinutesRaw = input.expires_in_minutes;
  const expiresInHoursRaw = input.expires_in_hours;
  const temporary = input.temporary === true || input.temporary === 1 || input.temporary === "1";

  let minutes = null;
  if (expiresInMinutesRaw != null && String(expiresInMinutesRaw).trim() !== "") {
    minutes = Number(expiresInMinutesRaw);
  } else if (expiresInHoursRaw != null && String(expiresInHoursRaw).trim() !== "") {
    minutes = Number(expiresInHoursRaw) * 60;
  } else if (temporary) {
    minutes = 24 * 60;
  }

  if (minutes == null) {
    return null;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("过期时间必须大于 0");
  }
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function rowToJupyterServer(row) {
  const maxKernelsRaw = row.max_kernels;
  const maxKernels =
    maxKernelsRaw == null || maxKernelsRaw === "" ? null : Number(maxKernelsRaw);
  const expiresAt = row.expires_at == null ? null : String(row.expires_at);
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
    sort_order: Number(row.sort_order ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    expires_at: expiresAt,
    temporary: Boolean(expiresAt),
    expired: isExpiredAt(expiresAt),
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

function validateJupyterKey(key) {
  if (!JUPYTER_KEY_PATTERN.test(key)) {
    return "key 须为小写字母开头，仅含小写字母、数字、下划线、连字符";
  }
  return null;
}

function validateJupyterFields(input) {
  if (input.name !== undefined && !String(input.name).trim()) {
    return "name 不能为空";
  }
  if (input.base_url !== undefined && !String(input.base_url).trim()) {
    return "base_url 不能为空";
  }
  if (input.auth_token !== undefined && !String(input.auth_token).trim()) {
    return "auth_token 不能为空";
  }
  if (input.connect_mode !== undefined && !CONNECT_MODES.has(input.connect_mode)) {
    return "connect_mode 无效";
  }
  if (input.runtime_config !== undefined) {
    parseRuntimeConfigValue(input.runtime_config);
  }
  try {
    resolveExpiresAt(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function activeServerClause(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `(${prefix}expires_at IS NULL OR datetime(${prefix}expires_at) > datetime('now'))`;
}

export async function cleanupExpiredJupyterServers(db) {
  const result = await db.prepare(
    `DELETE FROM jupyter_servers
     WHERE expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime('now')`
  ).run();
  return { deleted: Number(result.meta.changes ?? 0) };
}

export async function getJupyterServerByKey(db, key, { includeExpired = false } = {}) {
  const result = await db.prepare(
    `SELECT ${JUPYTER_SERVER_COLUMNS}
       FROM jupyter_servers
       WHERE key = ?
       LIMIT 1`
  ).bind(key).first();
  if (!result) {
    return null;
  }
  const item = rowToJupyterServer(result);
  if (!includeExpired && item.expired) {
    return null;
  }
  return item;
}

export async function listJupyterServers(db, { includeDisabled = false, includeExpired = true } = {}) {
  const clauses = [];
  if (!includeDisabled) {
    clauses.push("enabled = 1");
  }
  if (!includeExpired) {
    clauses.push(activeServerClause());
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.prepare(
    `SELECT ${JUPYTER_SERVER_COLUMNS}
       FROM jupyter_servers
       ${where}
       ORDER BY
         CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END,
         sort_order ASC,
         key ASC`
  ).all();
  return (result.results ?? []).map(rowToJupyterServer);
}

export async function listEnabledJupyterServers(db) {
  const result = await db.prepare(
    `SELECT ${JUPYTER_SERVER_COLUMNS}
       FROM jupyter_servers
       WHERE enabled = 1
         AND ${activeServerClause()}
       ORDER BY sort_order ASC, key ASC`
  ).all();
  return (result.results ?? []).map(rowToJupyterServer);
}

export async function markJupyterServerUsed(db, key) {
  const result = await db.prepare(
    `UPDATE jupyter_servers
       SET last_used_at = datetime('now'), updated_at = datetime('now')
       WHERE key = ?
         AND ${activeServerClause()}`
  ).bind(key).run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function createJupyterServer(db, input) {
  const key = String(input.key ?? "").trim();
  const keyError = validateJupyterKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  const fieldError = validateJupyterFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const existing = await getJupyterServerByKey(db, key, { includeExpired: true });
  if (existing) {
    throw new Error(`Jupyter Server 已存在: ${key}`);
  }

  const connect_mode = input.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api";
  const runtime_config = serializeRuntimeConfig(
    input.runtime_config !== undefined ? parseRuntimeConfigValue(input.runtime_config) : defaultRuntimeConfig(),
  );
  const max_kernels =
    input.max_kernels === 0 || input.max_kernels === "0"
      ? null
      : input.max_kernels == null || input.max_kernels === ""
        ? 30
        : Math.floor(Number(input.max_kernels));
  const expires_at = resolveExpiresAt(input);

  await db.prepare(
    `INSERT INTO jupyter_servers
         (key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
          auth_header, auth_scheme, auth_token, runtime_config, max_kernels, enabled, sort_order, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    key,
    String(input.name).trim(),
    String(input.base_url).trim().replace(/\/$/, ""),
    (input.evaluate_path ?? "/api/quant-factors/evaluate-batch").trim() || "/api/quant-factors/evaluate-batch",
    input.proxy_url == null || String(input.proxy_url).trim() === "" ? null : String(input.proxy_url).trim(),
    connect_mode,
    input.ws_base_url == null || String(input.ws_base_url).trim() === ""
      ? null
      : String(input.ws_base_url).trim().replace(/\/$/, ""),
    String(input.kernel_name ?? "python3").trim() || "python3",
    String(input.auth_header ?? "Authorization").trim() || "Authorization",
    String(input.auth_scheme ?? "token").trim() || "token",
    String(input.auth_token).trim(),
    runtime_config,
    max_kernels,
    input.enabled === false ? 0 : 1,
    Math.floor(input.sort_order ?? 0),
    expires_at,
  ).run();

  const created = await getJupyterServerByKey(db, key, { includeExpired: true });
  if (!created) {
    throw new Error("创建 Jupyter Server 失败");
  }
  return created;
}

export async function updateJupyterServer(db, key, input) {
  const existing = await getJupyterServerByKey(db, key, { includeExpired: true });
  if (!existing) {
    throw new Error("Jupyter Server 不存在");
  }
  const fieldError = validateJupyterFields({ ...existing, ...input });
  if (fieldError) {
    throw new Error(fieldError);
  }

  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  const base_url =
    input.base_url !== undefined ? String(input.base_url).trim().replace(/\/$/, "") : existing.base_url;
  const evaluate_path =
    input.evaluate_path !== undefined
      ? String(input.evaluate_path).trim() || "/api/quant-factors/evaluate-batch"
      : existing.evaluate_path;
  const proxy_url =
    input.proxy_url !== undefined
      ? input.proxy_url == null || String(input.proxy_url).trim() === ""
        ? null
        : String(input.proxy_url).trim()
      : existing.proxy_url;
  const connect_mode =
    input.connect_mode !== undefined
      ? input.connect_mode === "kernel_channels"
        ? "kernel_channels"
        : "batch_api"
      : existing.connect_mode;
  const ws_base_url =
    input.ws_base_url !== undefined
      ? input.ws_base_url == null || String(input.ws_base_url).trim() === ""
        ? null
        : String(input.ws_base_url).trim().replace(/\/$/, "")
      : existing.ws_base_url;
  const kernel_name =
    input.kernel_name !== undefined ? String(input.kernel_name).trim() || "python3" : existing.kernel_name;
  const auth_header =
    input.auth_header !== undefined ? String(input.auth_header).trim() || "Authorization" : existing.auth_header;
  const auth_scheme =
    input.auth_scheme !== undefined ? String(input.auth_scheme).trim() || "token" : existing.auth_scheme;
  const auth_token = input.auth_token !== undefined ? String(input.auth_token).trim() : existing.auth_token;
  const runtime_config =
    input.runtime_config !== undefined
      ? serializeRuntimeConfig(parseRuntimeConfigValue(input.runtime_config))
      : serializeRuntimeConfig(existing.runtime_config);
  const max_kernels =
    input.max_kernels !== undefined
      ? input.max_kernels === 0 || input.max_kernels === "0"
        ? null
        : input.max_kernels == null || input.max_kernels === ""
          ? 30
          : Math.floor(Number(input.max_kernels))
      : existing.max_kernels ?? 30;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
  const sort_order = input.sort_order !== undefined ? Math.floor(input.sort_order) : existing.sort_order;

  let expires_at = existing.expires_at;
  if (
    input.expires_at !== undefined ||
    input.expires_in_hours !== undefined ||
    input.expires_in_minutes !== undefined ||
    input.temporary !== undefined
  ) {
    if (input.temporary === false || input.temporary === 0 || input.temporary === "0") {
      expires_at = null;
    } else {
      expires_at = resolveExpiresAt({
        temporary: input.temporary ?? existing.temporary,
        expires_at: input.expires_at,
        expires_in_hours: input.expires_in_hours,
        expires_in_minutes: input.expires_in_minutes,
      });
    }
  }

  await db.prepare(
    `UPDATE jupyter_servers
       SET name = ?, base_url = ?, evaluate_path = ?, proxy_url = ?, connect_mode = ?,
           ws_base_url = ?, kernel_name = ?, auth_header = ?, auth_scheme = ?, auth_token = ?,
           runtime_config = ?, max_kernels = ?, enabled = ?, sort_order = ?, expires_at = ?,
           updated_at = datetime('now')
       WHERE key = ?`
  ).bind(
    name,
    base_url,
    evaluate_path,
    proxy_url,
    connect_mode,
    ws_base_url,
    kernel_name,
    auth_header,
    auth_scheme,
    auth_token,
    runtime_config,
    max_kernels,
    enabled,
    sort_order,
    expires_at,
    key,
  ).run();

  const updated = await getJupyterServerByKey(db, key, { includeExpired: true });
  if (!updated) {
    throw new Error("更新 Jupyter Server 失败");
  }
  return updated;
}

export async function deleteJupyterServer(db, key) {
  const existing = await getJupyterServerByKey(db, key, { includeExpired: true });
  if (!existing) {
    throw new Error("Jupyter Server 不存在");
  }
  await db.prepare("DELETE FROM jupyter_servers WHERE key = ?").bind(key).run();
  return { deleted: true, key };
}
