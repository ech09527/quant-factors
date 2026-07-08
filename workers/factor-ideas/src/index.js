var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/api/http.ts
function corsOrigin(env, request) {
  const configured = env.API_CORS_ORIGIN?.trim();
  if (configured) {
    return configured;
  }
  const origin = request.headers.get("Origin");
  return origin ?? "*";
}
__name(corsOrigin, "corsOrigin");
function withCors(response, env, request, allowMethods = "GET, POST, OPTIONS") {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", corsOrigin(env, request));
  headers.set("Access-Control-Allow-Methods", allowMethods);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
__name(withCors, "withCors");
function jsonResponse(data, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(data), { status, headers });
}
__name(jsonResponse, "jsonResponse");
function parsePositiveInt(value, fallback, max) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  if (max !== void 0) {
    return Math.min(floored, max);
  }
  return floored;
}
__name(parsePositiveInt, "parsePositiveInt");

// src/api/auth.ts
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
__name(timingSafeEqual, "timingSafeEqual");
function extractBearerToken(request) {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token || null;
}
__name(extractBearerToken, "extractBearerToken");
function isAuthorized(request, env) {
  const expected = env.AUTH_PASSWORD?.trim();
  if (!expected) {
    return false;
  }
  const token = extractBearerToken(request);
  if (!token) {
    return false;
  }
  return timingSafeEqual(token, expected);
}
__name(isAuthorized, "isAuthorized");
function requiresAuth(pathname) {
  if (pathname === "/health") {
    return false;
  }
  if (pathname.startsWith("/api/")) {
    return true;
  }
  if (pathname === "/generate") {
    return true;
  }
  return false;
}
__name(requiresAuth, "requiresAuth");
function unauthorizedResponse(request, env) {
  return withCors(
    jsonResponse({ ok: false, error: "unauthorized" }, 401),
    env,
    request
  );
}
__name(unauthorizedResponse, "unauthorizedResponse");
function handleOptions(request, env, pathname) {
  if (request.method !== "OPTIONS") {
    return null;
  }
  if (!requiresAuth(pathname)) {
    return null;
  }
  return withCors(new Response(null, { status: 204 }), env, request);
}
__name(handleOptions, "handleOptions");

// src/dsl/title-hash.ts
function toUtf8Bytes(text) {
  return new TextEncoder().encode(text);
}
__name(toUtf8Bytes, "toUtf8Bytes");
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
function normalizeTitle(title) {
  return title.toLowerCase().replace(/[\s\W_]+/g, "");
}
__name(normalizeTitle, "normalizeTitle");
async function titleHash(title) {
  const normalized = normalizeTitle(title);
  const digest = await crypto.subtle.digest("SHA-256", toUtf8Bytes(normalized));
  return bytesToHex(digest);
}
__name(titleHash, "titleHash");

// src/db/ideas.ts
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
__name(parseJsonArray, "parseJsonArray");
function rowToIdea(row) {
  return {
    id: Number(row.id),
    title: String(row.title),
    title_hash: String(row.title_hash),
    factor_expr: String(row.factor_expr),
    expr_hash: row.expr_hash == null ? null : String(row.expr_hash),
    expr_canonical: row.expr_canonical == null ? null : String(row.expr_canonical),
    hypothesis: String(row.hypothesis),
    formula_sketch: String(row.formula_sketch),
    expected_signal: String(row.expected_signal),
    risks: parseJsonArray(row.risks),
    data_sources: parseJsonArray(row.data_sources),
    dedup_tier: row.dedup_tier === "custom_pending" ? "custom_pending" : "builtin",
    source: String(row.source),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
__name(rowToIdea, "rowToIdea");
async function existsByHash(db, titleHashValue, exprHash2) {
  if (exprHash2) {
    const byExpr = await db.prepare("SELECT 1 AS found FROM ideas WHERE expr_hash = ? LIMIT 1").bind(exprHash2).first();
    if (byExpr) {
      return true;
    }
  }
  const byTitle = await db.prepare("SELECT 1 AS found FROM ideas WHERE title_hash = ? LIMIT 1").bind(titleHashValue).first();
  return Boolean(byTitle);
}
__name(existsByHash, "existsByHash");
async function insertIdea(db, idea, hashes) {
  const result = await db.prepare(
    `INSERT INTO ideas (
        title, title_hash, factor_expr, expr_hash, expr_canonical,
        hypothesis, formula_sketch, expected_signal, risks, data_sources,
        dedup_tier, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openai', datetime('now'))`
  ).bind(
    idea.title,
    hashes.title_hash,
    idea.factor_expr,
    hashes.expr_hash,
    hashes.expr_canonical,
    idea.hypothesis,
    idea.formula_sketch,
    idea.expected_signal,
    JSON.stringify(idea.risks),
    JSON.stringify(idea.data_sources),
    hashes.dedup_tier
  ).run();
  return Number(result.meta.last_row_id);
}
__name(insertIdea, "insertIdea");
async function getSaturatedPatterns(db, limit = 5) {
  const result = await db.prepare(
    `SELECT expr_canonical, COUNT(*) AS count
       FROM ideas
       WHERE expr_hash IS NOT NULL AND expr_canonical IS NOT NULL
       GROUP BY expr_canonical
       ORDER BY count DESC, expr_canonical ASC
       LIMIT ?`
  ).bind(limit).all();
  return (result.results ?? []).map((row) => ({
    expr_canonical: row.expr_canonical,
    count: Number(row.count)
  }));
}
__name(getSaturatedPatterns, "getSaturatedPatterns");
async function listIdeas(db, options) {
  const { limit, offset } = options;
  const countRow = await db.prepare("SELECT COUNT(*) AS total FROM ideas").first();
  const result = await db.prepare(
    `SELECT id, title, title_hash, factor_expr, expr_hash, expr_canonical,
              hypothesis, formula_sketch, expected_signal, risks, data_sources,
              dedup_tier, source, created_at, updated_at
       FROM ideas
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return {
    items: (result.results ?? []).map(rowToIdea),
    total: Number(countRow?.total ?? 0),
    limit,
    offset
  };
}
__name(listIdeas, "listIdeas");
async function getIdeaById(db, id) {
  const row = await db.prepare(
    `SELECT id, title, title_hash, factor_expr, expr_hash, expr_canonical,
              hypothesis, formula_sketch, expected_signal, risks, data_sources,
              dedup_tier, source, created_at, updated_at
       FROM ideas
       WHERE id = ?
       LIMIT 1`
  ).bind(id).first();
  return row ? rowToIdea(row) : null;
}
__name(getIdeaById, "getIdeaById");
async function countIdeas(db) {
  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM ideas").first();
  return {
    total: Number(totalRow?.total ?? 0)
  };
}
__name(countIdeas, "countIdeas");

// src/db/operators.ts
function rowToOperator(row) {
  return {
    id: Number(row.id),
    name: String(row.name),
    signature: String(row.signature),
    description: String(row.description),
    example: row.example == null ? void 0 : String(row.example),
    status: row.status === "active" ? "active" : "pending",
    source_idea_id: row.source_idea_id == null ? null : Number(row.source_idea_id),
    created_at: String(row.created_at)
  };
}
__name(rowToOperator, "rowToOperator");
async function getActiveOperators(db) {
  const result = await db.prepare(
    `SELECT id, name, signature, description, example, status, source_idea_id, created_at
       FROM custom_operators
       WHERE status = 'active'
       ORDER BY name ASC`
  ).all();
  return (result.results ?? []).map(rowToOperator);
}
__name(getActiveOperators, "getActiveOperators");
async function listOperators(db, options) {
  const { limit, offset, status } = options;
  const filters = [];
  const binds = [];
  if (status) {
    filters.push("status = ?");
    binds.push(status);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM custom_operators ${where}`).bind(...binds).first();
  const result = await db.prepare(
    `SELECT id, name, signature, description, example, status, source_idea_id, created_at
       FROM custom_operators
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  return {
    items: (result.results ?? []).map(rowToOperator),
    total: Number(countRow?.total ?? 0),
    limit,
    offset
  };
}
__name(listOperators, "listOperators");
async function getOperatorById(db, id) {
  const row = await db.prepare(
    `SELECT id, name, signature, description, example, status, source_idea_id, created_at
       FROM custom_operators
       WHERE id = ?
       LIMIT 1`
  ).bind(id).first();
  return row ? rowToOperator(row) : null;
}
__name(getOperatorById, "getOperatorById");
async function countOperatorsByStatus(db) {
  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM custom_operators").first();
  const activeRow = await db.prepare("SELECT COUNT(*) AS active FROM custom_operators WHERE status = 'active'").first();
  const pendingRow = await db.prepare("SELECT COUNT(*) AS pending FROM custom_operators WHERE status = 'pending'").first();
  return {
    total: Number(totalRow?.total ?? 0),
    active: Number(activeRow?.active ?? 0),
    pending: Number(pendingRow?.pending ?? 0)
  };
}
__name(countOperatorsByStatus, "countOperatorsByStatus");
async function insertPendingOperator(db, op, sourceIdeaId) {
  await db.prepare(
    `INSERT INTO custom_operators (name, signature, description, example, status, source_idea_id)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(name) DO NOTHING`
  ).bind(op.name, op.signature, op.description, op.example ?? null, sourceIdeaId ?? null).run();
}
__name(insertPendingOperator, "insertPendingOperator");

// src/db/validations.ts
function parseJsonObject(value) {
  if (value == null) {
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
__name(parseJsonObject, "parseJsonObject");
function rowToProfile(row) {
  return {
    key: String(row.key),
    name: String(row.name),
    label_kind: row.label_kind === "forward_volatility" ? "forward_volatility" : "forward_return",
    horizon_bars: Number(row.horizon_bars),
    description: String(row.description ?? ""),
    sort_order: Number(row.sort_order ?? 0),
    enabled: Number(row.enabled ?? 1) === 1,
    created_at: String(row.created_at)
  };
}
__name(rowToProfile, "rowToProfile");
function rowToValidation(row) {
  return {
    id: Number(row.id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: row.profile_name == null ? null : String(row.profile_name),
    label_kind: row.label_kind == null ? null : String(row.label_kind),
    horizon_bars: row.horizon_bars == null ? null : Number(row.horizon_bars),
    status: String(row.status),
    factor_sql: parseJsonObject(row.factor_sql),
    metrics: parseJsonObject(row.metrics),
    diagnostics: parseJsonObject(row.diagnostics),
    error_reason: row.error_reason == null ? null : String(row.error_reason),
    engine_version: row.engine_version == null ? null : String(row.engine_version),
    metrics_version: row.metrics_version == null ? null : String(row.metrics_version),
    evaluated_at: row.evaluated_at == null ? null : String(row.evaluated_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
__name(rowToValidation, "rowToValidation");
async function listValidationProfiles(db, options = {}) {
  const where = options.includeDisabled ? "" : "WHERE enabled = 1";
  const result = await db.prepare(
    `SELECT key, name, label_kind, horizon_bars, description, sort_order, enabled, created_at
       FROM validation_profiles
       ${where}
       ORDER BY sort_order ASC, key ASC`
  ).all();
  const items = (result.results ?? []).map(rowToProfile);
  return { items, total: items.length };
}
__name(listValidationProfiles, "listValidationProfiles");
var PROFILE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
var LABEL_KINDS = /* @__PURE__ */ new Set(["forward_return", "forward_volatility"]);
function validateProfileKey(key) {
  if (!PROFILE_KEY_PATTERN.test(key)) {
    return "key \u987B\u4E3A\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u4EC5\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF";
  }
  return null;
}
__name(validateProfileKey, "validateProfileKey");
function validateProfileFields(input) {
  if (input.name !== void 0 && !input.name.trim()) {
    return "name \u4E0D\u80FD\u4E3A\u7A7A";
  }
  if (input.label_kind !== void 0 && !LABEL_KINDS.has(input.label_kind)) {
    return "label_kind \u65E0\u6548";
  }
  if (input.horizon_bars !== void 0) {
    const horizon = Number(input.horizon_bars);
    if (!Number.isFinite(horizon) || horizon < 1 || horizon > 168) {
      return "horizon_bars \u987B\u5728 1\u2013168 \u4E4B\u95F4";
    }
  }
  return null;
}
__name(validateProfileFields, "validateProfileFields");
async function getValidationProfileByKey(db, key) {
  const row = await db.prepare(
    `SELECT key, name, label_kind, horizon_bars, description, sort_order, enabled, created_at
       FROM validation_profiles
       WHERE key = ?
       LIMIT 1`
  ).bind(key).first();
  return row ? rowToProfile(row) : null;
}
__name(getValidationProfileByKey, "getValidationProfileByKey");
async function countValidationsForProfile(db, profileKey) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM idea_validations WHERE profile_key = ?").bind(profileKey).first();
  return Number(row?.total ?? 0);
}
__name(countValidationsForProfile, "countValidationsForProfile");
async function createValidationProfile(db, input) {
  const key = input.key.trim();
  const keyError = validateProfileKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  const fieldError = validateProfileFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const existing = await getValidationProfileByKey(db, key);
  if (existing) {
    throw new Error(`\u9A8C\u8BC1\u914D\u7F6E\u5DF2\u5B58\u5728: ${key}`);
  }
  await db.prepare(
    `INSERT INTO validation_profiles
         (key, name, label_kind, horizon_bars, description, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    key,
    input.name.trim(),
    input.label_kind,
    Math.floor(input.horizon_bars),
    (input.description ?? "").trim(),
    Math.floor(input.sort_order ?? 0),
    input.enabled === false ? 0 : 1
  ).run();
  const created = await getValidationProfileByKey(db, key);
  if (!created) {
    throw new Error("\u521B\u5EFA\u9A8C\u8BC1\u914D\u7F6E\u5931\u8D25");
  }
  return created;
}
__name(createValidationProfile, "createValidationProfile");
async function updateValidationProfile(db, key, input) {
  const existing = await getValidationProfileByKey(db, key);
  if (!existing) {
    throw new Error("\u9A8C\u8BC1\u914D\u7F6E\u4E0D\u5B58\u5728");
  }
  const fieldError = validateProfileFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const validationCount = await countValidationsForProfile(db, key);
  if (validationCount > 0 && (input.label_kind !== void 0 || input.horizon_bars !== void 0)) {
    const labelChanged = input.label_kind !== void 0 && input.label_kind !== existing.label_kind;
    const horizonChanged = input.horizon_bars !== void 0 && input.horizon_bars !== existing.horizon_bars;
    if (labelChanged || horizonChanged) {
      throw new Error("\u5DF2\u6709\u9A8C\u8BC1\u4EFB\u52A1\u5F15\u7528\u8BE5\u914D\u7F6E\uFF0C\u4E0D\u53EF\u4FEE\u6539 label_kind \u6216 horizon_bars");
    }
  }
  const name = input.name !== void 0 ? input.name.trim() : existing.name;
  const label_kind = input.label_kind ?? existing.label_kind;
  const horizon_bars = input.horizon_bars !== void 0 ? Math.floor(input.horizon_bars) : existing.horizon_bars;
  const description = input.description !== void 0 ? input.description.trim() : existing.description;
  const sort_order = input.sort_order !== void 0 ? Math.floor(input.sort_order) : existing.sort_order;
  const enabled = input.enabled !== void 0 ? input.enabled ? 1 : 0 : existing.enabled ? 1 : 0;
  await db.prepare(
    `UPDATE validation_profiles
       SET name = ?, label_kind = ?, horizon_bars = ?, description = ?,
           sort_order = ?, enabled = ?
       WHERE key = ?`
  ).bind(name, label_kind, horizon_bars, description, sort_order, enabled, key).run();
  const updated = await getValidationProfileByKey(db, key);
  if (!updated) {
    throw new Error("\u66F4\u65B0\u9A8C\u8BC1\u914D\u7F6E\u5931\u8D25");
  }
  return updated;
}
__name(updateValidationProfile, "updateValidationProfile");
async function deleteValidationProfile(db, key) {
  const existing = await getValidationProfileByKey(db, key);
  if (!existing) {
    throw new Error("\u9A8C\u8BC1\u914D\u7F6E\u4E0D\u5B58\u5728");
  }
  const validationCount = await countValidationsForProfile(db, key);
  if (validationCount > 0) {
    await db.prepare("UPDATE validation_profiles SET enabled = 0 WHERE key = ?").bind(key).run();
    return { deleted: false, disabled: true };
  }
  await db.prepare("DELETE FROM validation_profiles WHERE key = ?").bind(key).run();
  return { deleted: true };
}
__name(deleteValidationProfile, "deleteValidationProfile");
async function listIdeaValidations(db, ideaId) {
  const result = await db.prepare(
    `SELECT
         iv.id, iv.idea_id, iv.profile_key, iv.status, iv.factor_sql, iv.metrics,
         iv.diagnostics, iv.error_reason, iv.engine_version, iv.metrics_version,
         iv.evaluated_at, iv.created_at, iv.updated_at,
         vp.name AS profile_name, vp.label_kind, vp.horizon_bars
       FROM idea_validations iv
       JOIN validation_profiles vp ON vp.key = iv.profile_key
       WHERE iv.idea_id = ?
       ORDER BY vp.sort_order ASC, iv.id ASC`
  ).bind(ideaId).all();
  const items = (result.results ?? []).map(rowToValidation);
  return { items, total: items.length, idea_id: ideaId };
}
__name(listIdeaValidations, "listIdeaValidations");
async function getIdeaValidationById(db, validationId) {
  const row = await db.prepare(
    `SELECT
         iv.id, iv.idea_id, iv.profile_key, iv.status, iv.factor_sql, iv.metrics,
         iv.diagnostics, iv.error_reason, iv.engine_version, iv.metrics_version,
         iv.evaluated_at, iv.created_at, iv.updated_at,
         vp.name AS profile_name, vp.label_kind, vp.horizon_bars
       FROM idea_validations iv
       JOIN validation_profiles vp ON vp.key = iv.profile_key
       WHERE iv.id = ?
       LIMIT 1`
  ).bind(validationId).first();
  return row ? rowToValidation(row) : null;
}
__name(getIdeaValidationById, "getIdeaValidationById");
var VALIDATION_SORT_FIELDS = {
  mean_ic: "mean_ic",
  mean_rank_ic: "mean_rank_ic",
  ic_ir: "ic_ir",
  rank_ic_ir: "rank_ic_ir",
  n_periods: "n_periods",
  evaluated_at: "evaluated_at",
  updated_at: "updated_at"
};
function rowToValidationResult(row) {
  const validation = rowToValidation(row);
  return {
    ...validation,
    idea_title: String(row.idea_title ?? ""),
    idea_title_hash: String(row.idea_title_hash ?? "")
  };
}
__name(rowToValidationResult, "rowToValidationResult");
function buildValidationResultsQuery(options) {
  const sortRaw = options.sort?.trim() || "updated_at";
  const sort = sortRaw in VALIDATION_SORT_FIELDS ? sortRaw : "updated_at";
  const order = options.order === "asc" ? "asc" : "desc";
  const abs = options.abs !== false;
  const limit = Math.min(Math.max(Number(options.limit ?? 30) || 30, 1), 200);
  const offset = Math.max(Number(options.offset ?? 0) || 0, 0);
  const status = options.status?.trim() || null;
  const profile_key = options.profile_key?.trim() || null;
  const whereParts = ["1 = 1"];
  const binds = [];
  if (status) {
    whereParts.push("iv.status = ?");
    binds.push(status);
  }
  if (profile_key) {
    whereParts.push("iv.profile_key = ?");
    binds.push(profile_key);
  }
  let orderExpr;
  if (sort === "updated_at") {
    orderExpr = "iv.updated_at";
  } else if (sort === "evaluated_at") {
    orderExpr = "COALESCE(iv.evaluated_at, iv.updated_at)";
  } else if (status === "success") {
    whereParts.push("iv.metrics IS NOT NULL");
    whereParts.push(`json_extract(iv.metrics, '$.${sort}') IS NOT NULL`);
    const metricExpr = `CAST(json_extract(iv.metrics, '$.${sort}') AS REAL)`;
    orderExpr = abs ? `ABS(${metricExpr})` : metricExpr;
  } else if (status && status !== "success") {
    orderExpr = "iv.updated_at";
  } else {
    const metricExpr = `CAST(json_extract(iv.metrics, '$.${sort}') AS REAL)`;
    orderExpr = `CASE WHEN iv.metrics IS NULL THEN 1 ELSE 0 END, ${abs ? `ABS(${metricExpr})` : metricExpr}`;
  }
  const orderSql = `ORDER BY ${orderExpr} ${order.toUpperCase()}, iv.id DESC`;
  return {
    whereSql: whereParts.join(" AND "),
    binds,
    orderSql,
    sort,
    order,
    abs,
    limit,
    offset,
    status,
    profile_key
  };
}
__name(buildValidationResultsQuery, "buildValidationResultsQuery");
async function listValidationResults(db, options = {}) {
  const query = buildValidationResultsQuery(options);
  const baseFrom = `
    FROM idea_validations iv
    JOIN ideas i ON i.id = iv.idea_id
    JOIN validation_profiles vp ON vp.key = iv.profile_key
    WHERE ${query.whereSql}`;
  const countRow = await db.prepare(`SELECT COUNT(*) AS total ${baseFrom}`).bind(...query.binds).first();
  const result = await db.prepare(
    `SELECT
         iv.id, iv.idea_id, iv.profile_key, iv.status, iv.factor_sql, iv.metrics,
         iv.diagnostics, iv.error_reason, iv.engine_version, iv.metrics_version,
         iv.evaluated_at, iv.created_at, iv.updated_at,
         vp.name AS profile_name, vp.label_kind, vp.horizon_bars,
         i.title AS idea_title, i.title_hash AS idea_title_hash
       ${baseFrom}
       ${query.orderSql}
       LIMIT ? OFFSET ?`
  ).bind(...query.binds, query.limit, query.offset).all();
  const items = (result.results ?? []).map(rowToValidationResult);
  return {
    items,
    total: Number(countRow?.total ?? 0),
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
    order: query.order,
    abs: query.abs,
    status: query.status,
    profile_key: query.profile_key
  };
}
__name(listValidationResults, "listValidationResults");
async function enqueueIdeaValidations(db, ideaId, profileKeys) {
  let profiles;
  if (profileKeys && profileKeys.length > 0) {
    const placeholders = profileKeys.map(() => "?").join(", ");
    const result = await db.prepare(
      `SELECT key, name, label_kind, horizon_bars, description, sort_order, enabled, created_at
         FROM validation_profiles
         WHERE enabled = 1 AND key IN (${placeholders})
         ORDER BY sort_order ASC`
    ).bind(...profileKeys).all();
    profiles = (result.results ?? []).map(rowToProfile);
  } else {
    const listed2 = await listValidationProfiles(db);
    profiles = listed2.items;
  }
  let created = 0;
  let skipped = 0;
  for (const profile of profiles) {
    const existing = await db.prepare(
      "SELECT id FROM idea_validations WHERE idea_id = ? AND profile_key = ? LIMIT 1"
    ).bind(ideaId, profile.key).first();
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.prepare(
      `INSERT INTO idea_validations (idea_id, profile_key, status, updated_at)
         VALUES (?, ?, 'pending', datetime('now'))`
    ).bind(ideaId, profile.key).run();
    created += 1;
  }
  const listed = await listIdeaValidations(db, ideaId);
  return { created, skipped, items: listed.items };
}
__name(enqueueIdeaValidations, "enqueueIdeaValidations");
function rowToWorkflowJob(row) {
  return {
    validation_id: Number(row.validation_id),
    idea_id: Number(row.idea_id),
    profile_key: String(row.profile_key),
    profile_name: String(row.profile_name),
    label_kind: row.label_kind === "forward_volatility" ? "forward_volatility" : "forward_return",
    horizon_bars: Number(row.horizon_bars),
    title: String(row.title),
    title_hash: String(row.title_hash),
    factor_expr: String(row.factor_expr),
    hypothesis: String(row.hypothesis),
    formula_sketch: String(row.formula_sketch),
    expected_signal: String(row.expected_signal),
    data_sources: parseJsonArray2(row.data_sources),
    status: String(row.status)
  };
}
__name(rowToWorkflowJob, "rowToWorkflowJob");
function parseJsonArray2(value) {
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
__name(parseJsonArray2, "parseJsonArray");
async function reclaimStaleValidationJobs(db, maxAgeMinutes = 10) {
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
__name(reclaimStaleValidationJobs, "reclaimStaleValidationJobs");
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
async function countValidationWorkflowJobs(db) {
  const countRow = await db.prepare(`SELECT COUNT(*) AS total ${VALIDATION_WORKFLOW_JOB_FROM}`).first();
  return Number(countRow?.total ?? 0);
}
__name(countValidationWorkflowJobs, "countValidationWorkflowJobs");
async function listPendingValidationWorkflowJobs(db, limit) {
  await reclaimStaleValidationJobs(db);
  const total = await countValidationWorkflowJobs(db);
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
    items: (result.results ?? []).map(rowToWorkflowJob),
    total,
    limit
  };
}
__name(listPendingValidationWorkflowJobs, "listPendingValidationWorkflowJobs");
async function claimValidationWorkflowJobs(db, jobs) {
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
__name(claimValidationWorkflowJobs, "claimValidationWorkflowJobs");
async function reportValidationWorkflowResults(db, items) {
  let updated = 0;
  for (const item of items) {
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
      item.status,
      item.factor_sql ? JSON.stringify(item.factor_sql) : null,
      item.metrics ? JSON.stringify(item.metrics) : null,
      item.diagnostics ? JSON.stringify(item.diagnostics) : null,
      item.error_reason ?? null,
      item.engine_version ?? null,
      item.metrics_version ?? null,
      item.evaluated_at ?? null,
      item.validation_id
    ).run();
    updated += Number(result.meta.changes ?? 0);
  }
  return { updated };
}
__name(reportValidationWorkflowResults, "reportValidationWorkflowResults");
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
    sort_order: Number(row.sort_order ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}
__name(rowToJupyterServer, "rowToJupyterServer");
function defaultRuntimeConfig() {
  return { target_file: "futures/um/klines/1h.parquet" };
}
__name(defaultRuntimeConfig, "defaultRuntimeConfig");
function parseRuntimeConfigValue(raw) {
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
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("runtime_config \u5FC5\u987B\u662F\u5408\u6CD5 JSON \u5BF9\u8C61");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime_config \u5FC5\u987B\u662F JSON \u5BF9\u8C61");
  }
  return parsed;
}
__name(parseRuntimeConfigValue, "parseRuntimeConfigValue");
function serializeRuntimeConfig(config) {
  return JSON.stringify(config ?? defaultRuntimeConfig());
}
__name(serializeRuntimeConfig, "serializeRuntimeConfig");
async function listEnabledJupyterServers(db) {
  const result = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config,
         enabled, sort_order, last_used_at, created_at, updated_at
       FROM jupyter_servers
       WHERE enabled = 1
       ORDER BY sort_order ASC, key ASC`
  ).all();
  const items = (result.results ?? []).map(rowToJupyterServer);
  return { items, total: items.length };
}
__name(listEnabledJupyterServers, "listEnabledJupyterServers");
async function markJupyterServerUsed(db, key) {
  const result = await db.prepare(
    `UPDATE jupyter_servers
       SET last_used_at = datetime('now'), updated_at = datetime('now')
       WHERE key = ?`
  ).bind(key).run();
  return { updated: Number(result.meta.changes ?? 0) };
}
__name(markJupyterServerUsed, "markJupyterServerUsed");
var JUPYTER_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;
var CONNECT_MODES = /* @__PURE__ */ new Set(["batch_api", "kernel_channels"]);
function validateJupyterKey(key) {
  if (!JUPYTER_KEY_PATTERN.test(key)) {
    return "key \u987B\u4E3A\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u4EC5\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u3001\u8FDE\u5B57\u7B26";
  }
  return null;
}
__name(validateJupyterKey, "validateJupyterKey");
function validateJupyterFields(input) {
  if (input.name !== void 0 && !String(input.name).trim()) {
    return "name \u4E0D\u80FD\u4E3A\u7A7A";
  }
  if (input.base_url !== void 0 && !String(input.base_url).trim()) {
    return "base_url \u4E0D\u80FD\u4E3A\u7A7A";
  }
  if (input.auth_token !== void 0 && !String(input.auth_token).trim()) {
    return "auth_token \u4E0D\u80FD\u4E3A\u7A7A";
  }
  if (input.connect_mode !== void 0 && !CONNECT_MODES.has(input.connect_mode)) {
    return "connect_mode \u65E0\u6548";
  }
  if (input.runtime_config !== void 0) {
    try {
      parseRuntimeConfigValue(input.runtime_config);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}
__name(validateJupyterFields, "validateJupyterFields");
async function getJupyterServerByKey(db, key) {
  const row = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config,
         enabled, sort_order, last_used_at, created_at, updated_at
       FROM jupyter_servers
       WHERE key = ?
       LIMIT 1`
  ).bind(key).first();
  return row ? rowToJupyterServer(row) : null;
}
__name(getJupyterServerByKey, "getJupyterServerByKey");
async function listJupyterServers(db, options = {}) {
  const where = options.includeDisabled ? "" : "WHERE enabled = 1";
  const result = await db.prepare(
    `SELECT
         key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
         auth_header, auth_scheme, auth_token, runtime_config,
         enabled, sort_order, last_used_at, created_at, updated_at
       FROM jupyter_servers
       ${where}
       ORDER BY sort_order ASC, key ASC`
  ).all();
  const items = (result.results ?? []).map(rowToJupyterServer);
  return { items, total: items.length };
}
__name(listJupyterServers, "listJupyterServers");
async function createJupyterServer(db, input) {
  const key = input.key.trim();
  const keyError = validateJupyterKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  const fieldError = validateJupyterFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const existing = await getJupyterServerByKey(db, key);
  if (existing) {
    throw new Error(`Jupyter Server \u5DF2\u5B58\u5728: ${key}`);
  }
  const connect_mode = input.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api";
  const runtime_config = serializeRuntimeConfig(
    input.runtime_config !== void 0 ? parseRuntimeConfigValue(input.runtime_config) : defaultRuntimeConfig()
  );
  await db.prepare(
    `INSERT INTO jupyter_servers
         (key, name, base_url, evaluate_path, proxy_url, connect_mode, ws_base_url, kernel_name,
          auth_header, auth_scheme, auth_token, runtime_config, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    key,
    input.name.trim(),
    input.base_url.trim().replace(/\/$/, ""),
    (input.evaluate_path ?? "/api/quant-factors/evaluate-batch").trim() || "/api/quant-factors/evaluate-batch",
    input.proxy_url == null || String(input.proxy_url).trim() === "" ? null : String(input.proxy_url).trim(),
    connect_mode,
    input.ws_base_url == null || String(input.ws_base_url).trim() === "" ? null : String(input.ws_base_url).trim().replace(/\/$/, ""),
    String(input.kernel_name ?? "python3").trim() || "python3",
    String(input.auth_header ?? "Authorization").trim() || "Authorization",
    String(input.auth_scheme ?? "token").trim() || "token",
    input.auth_token.trim(),
    runtime_config,
    input.enabled === false ? 0 : 1,
    Math.floor(input.sort_order ?? 0)
  ).run();
  const created = await getJupyterServerByKey(db, key);
  if (!created) {
    throw new Error("\u521B\u5EFA Jupyter Server \u5931\u8D25");
  }
  return created;
}
__name(createJupyterServer, "createJupyterServer");
async function updateJupyterServer(db, key, input) {
  const existing = await getJupyterServerByKey(db, key);
  if (!existing) {
    throw new Error("Jupyter Server \u4E0D\u5B58\u5728");
  }
  const fieldError = validateJupyterFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const name = input.name !== void 0 ? input.name.trim() : existing.name;
  const base_url = input.base_url !== void 0 ? input.base_url.trim().replace(/\/$/, "") : existing.base_url;
  const evaluate_path = input.evaluate_path !== void 0 ? input.evaluate_path.trim() || "/api/quant-factors/evaluate-batch" : existing.evaluate_path;
  const proxy_url = input.proxy_url !== void 0 ? input.proxy_url == null || String(input.proxy_url).trim() === "" ? null : String(input.proxy_url).trim() : existing.proxy_url;
  const connect_mode = input.connect_mode !== void 0 ? input.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api" : existing.connect_mode;
  const ws_base_url = input.ws_base_url !== void 0 ? input.ws_base_url == null || String(input.ws_base_url).trim() === "" ? null : String(input.ws_base_url).trim().replace(/\/$/, "") : existing.ws_base_url;
  const kernel_name = input.kernel_name !== void 0 ? String(input.kernel_name).trim() || "python3" : existing.kernel_name;
  const auth_header = input.auth_header !== void 0 ? String(input.auth_header).trim() || "Authorization" : existing.auth_header;
  const auth_scheme = input.auth_scheme !== void 0 ? String(input.auth_scheme).trim() || "token" : existing.auth_scheme;
  const auth_token = input.auth_token !== void 0 ? input.auth_token.trim() : existing.auth_token;
  const runtime_config = input.runtime_config !== void 0 ? serializeRuntimeConfig(parseRuntimeConfigValue(input.runtime_config)) : serializeRuntimeConfig(existing.runtime_config);
  const enabled = input.enabled !== void 0 ? input.enabled ? 1 : 0 : existing.enabled ? 1 : 0;
  const sort_order = input.sort_order !== void 0 ? Math.floor(input.sort_order) : existing.sort_order;
  await db.prepare(
    `UPDATE jupyter_servers
       SET name = ?, base_url = ?, evaluate_path = ?, proxy_url = ?, connect_mode = ?,
           ws_base_url = ?, kernel_name = ?, auth_header = ?, auth_scheme = ?, auth_token = ?,
           runtime_config = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
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
    enabled,
    sort_order,
    key
  ).run();
  const updated = await getJupyterServerByKey(db, key);
  if (!updated) {
    throw new Error("\u66F4\u65B0 Jupyter Server \u5931\u8D25");
  }
  return updated;
}
__name(updateJupyterServer, "updateJupyterServer");
async function deleteJupyterServer(db, key) {
  const existing = await getJupyterServerByKey(db, key);
  if (!existing) {
    throw new Error("Jupyter Server \u4E0D\u5B58\u5728");
  }
  await db.prepare("DELETE FROM jupyter_servers WHERE key = ?").bind(key).run();
  return { deleted: true, key };
}
__name(deleteJupyterServer, "deleteJupyterServer");

// src/api/routes.ts
function notFound(message) {
  return jsonResponse({ ok: false, error: message }, 404);
}
__name(notFound, "notFound");
function badRequest(message) {
  return jsonResponse({ ok: false, error: message }, 400);
}
__name(badRequest, "badRequest");
function wrap(env, request, response) {
  return withCors(response, env, request);
}
__name(wrap, "wrap");
async function handleApiRequest(request, env, pathname) {
  if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
    return wrap(env, request, new Response(null, { status: 204 }));
  }
  const url = new URL(request.url);
  if (request.method === "GET") {
    return handleApiGet(request, env, pathname, url);
  }
  if (request.method === "POST") {
    return handleApiPost(request, env, pathname);
  }
  if (request.method === "PATCH") {
    return handleApiPatch(request, env, pathname);
  }
  if (request.method === "DELETE") {
    return handleApiDelete(request, env, pathname);
  }
  return null;
}
__name(handleApiRequest, "handleApiRequest");
function conflict(message) {
  return jsonResponse({ ok: false, error: message }, 409);
}
__name(conflict, "conflict");
async function parseJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
__name(parseJsonBody, "parseJsonBody");
async function handleValidationProfileMutation(request, env, pathname, method) {
  if (pathname === "/api/validation-profiles" && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await createValidationProfile(env.DB, {
        key: String(body.key ?? ""),
        name: String(body.name ?? ""),
        label_kind: body.label_kind === "forward_volatility" ? "forward_volatility" : "forward_return",
        horizon_bars: Number(body.horizon_bars),
        description: body.description == null ? "" : String(body.description),
        sort_order: body.sort_order == null ? 0 : Number(body.sort_order),
        enabled: body.enabled !== false
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u5DF2\u5B58\u5728")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  const match = pathname.match(/^\/api\/validation-profiles\/([a-z][a-z0-9_]*)$/);
  if (!match) {
    return null;
  }
  const key = match[1];
  if (method === "PATCH") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await updateValidationProfile(env.DB, key, {
        name: body.name == null ? void 0 : String(body.name),
        label_kind: body.label_kind === void 0 ? void 0 : body.label_kind === "forward_volatility" ? "forward_volatility" : "forward_return",
        horizon_bars: body.horizon_bars == null ? void 0 : Number(body.horizon_bars),
        description: body.description == null ? void 0 : String(body.description),
        sort_order: body.sort_order == null ? void 0 : Number(body.sort_order),
        enabled: body.enabled === void 0 ? void 0 : Boolean(body.enabled)
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u4E0D\u5B58\u5728")) {
        return wrap(env, request, notFound(message));
      }
      if (message.includes("\u4E0D\u53EF\u4FEE\u6539")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  if (method === "DELETE") {
    try {
      const result = await deleteValidationProfile(env.DB, key);
      return wrap(env, request, jsonResponse(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u4E0D\u5B58\u5728")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  return null;
}
__name(handleValidationProfileMutation, "handleValidationProfileMutation");
async function handleJupyterServerMutation(request, env, pathname, method) {
  if (pathname === "/api/jupyter-servers" && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await createJupyterServer(env.DB, {
        key: String(body.key ?? ""),
        name: String(body.name ?? ""),
        base_url: String(body.base_url ?? ""),
        evaluate_path: body.evaluate_path == null ? void 0 : String(body.evaluate_path),
        proxy_url: body.proxy_url,
        connect_mode: body.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api",
        ws_base_url: body.ws_base_url,
        kernel_name: body.kernel_name == null ? void 0 : String(body.kernel_name),
        auth_header: body.auth_header == null ? void 0 : String(body.auth_header),
        auth_scheme: body.auth_scheme == null ? void 0 : String(body.auth_scheme),
        auth_token: String(body.auth_token ?? ""),
        runtime_config: body.runtime_config,
        sort_order: body.sort_order == null ? 0 : Number(body.sort_order),
        enabled: body.enabled !== false
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u5DF2\u5B58\u5728")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  const match = pathname.match(/^\/api\/jupyter-servers\/([a-z][a-z0-9_-]*)$/);
  if (!match) {
    return null;
  }
  const key = match[1];
  if (method === "PATCH") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await updateJupyterServer(env.DB, key, {
        name: body.name == null ? void 0 : String(body.name),
        base_url: body.base_url == null ? void 0 : String(body.base_url),
        evaluate_path: body.evaluate_path == null ? void 0 : String(body.evaluate_path),
        proxy_url: body.proxy_url,
        connect_mode: body.connect_mode === void 0 ? void 0 : body.connect_mode === "kernel_channels" ? "kernel_channels" : "batch_api",
        ws_base_url: body.ws_base_url,
        kernel_name: body.kernel_name == null ? void 0 : String(body.kernel_name),
        auth_header: body.auth_header == null ? void 0 : String(body.auth_header),
        auth_scheme: body.auth_scheme == null ? void 0 : String(body.auth_scheme),
        auth_token: body.auth_token == null ? void 0 : String(body.auth_token),
        runtime_config: body.runtime_config,
        sort_order: body.sort_order == null ? void 0 : Number(body.sort_order),
        enabled: body.enabled === void 0 ? void 0 : Boolean(body.enabled)
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u4E0D\u5B58\u5728")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  if (method === "DELETE") {
    try {
      const result = await deleteJupyterServer(env.DB, key);
      return wrap(env, request, jsonResponse(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("\u4E0D\u5B58\u5728")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }
  return null;
}
__name(handleJupyterServerMutation, "handleJupyterServerMutation");
async function handleApiPatch(request, env, pathname) {
  const jupyterResponse = await handleJupyterServerMutation(request, env, pathname, "PATCH");
  if (jupyterResponse) {
    return jupyterResponse;
  }
  return handleValidationProfileMutation(request, env, pathname, "PATCH");
}
__name(handleApiPatch, "handleApiPatch");
async function handleApiDelete(request, env, pathname) {
  const jupyterResponse = await handleJupyterServerMutation(request, env, pathname, "DELETE");
  if (jupyterResponse) {
    return jupyterResponse;
  }
  return handleValidationProfileMutation(request, env, pathname, "DELETE");
}
__name(handleApiDelete, "handleApiDelete");
async function handleApiPost(request, env, pathname) {
  const jupyterResponse = await handleJupyterServerMutation(request, env, pathname, "POST");
  if (jupyterResponse) {
    return jupyterResponse;
  }
  const profileResponse = await handleValidationProfileMutation(
    request,
    env,
    pathname,
    "POST"
  );
  if (profileResponse) {
    return profileResponse;
  }
  const VALIDATION_STATUSES = /* @__PURE__ */ new Set(["pending", "running", "success", "failed", "skipped"]);
  if (pathname === "/api/workflow/validation-jobs/claim") {
    let jobs = [];
    try {
      const body = await request.json();
      if (Array.isArray(body.jobs)) {
        jobs = body.jobs.map((item) => ({
          idea_id: Number(item.idea_id),
          profile_key: String(item.profile_key ?? "")
        })).filter((item) => Number.isFinite(item.idea_id) && item.idea_id > 0 && item.profile_key);
      } else if (Array.isArray(body.ids)) {
        const ids = body.ids.map(Number).filter((id2) => Number.isFinite(id2) && id2 > 0);
        if (ids.length > 0) {
          const placeholders = ids.map(() => "?").join(", ");
          const rows = await env.DB.prepare(
            `SELECT id AS validation_id, idea_id, profile_key
               FROM idea_validations
               WHERE id IN (${placeholders})`
          ).bind(...ids).all();
          jobs = (rows.results ?? []).map((row) => ({
            idea_id: Number(row.idea_id),
            profile_key: String(row.profile_key)
          }));
        }
      }
    } catch {
      return wrap(env, request, badRequest("invalid json body"));
    }
    const result2 = await claimValidationWorkflowJobs(env.DB, jobs);
    return wrap(env, request, jsonResponse(result2));
  }
  if (pathname === "/api/workflow/validation-jobs/report") {
    try {
      const body = await request.json();
      const items = Array.isArray(body.items) ? body.items : [];
      const parsed = items.map((item) => ({
        validation_id: Number(item.validation_id),
        status: String(item.status),
        factor_sql: item.factor_sql && typeof item.factor_sql === "object" ? item.factor_sql : null,
        metrics: item.metrics && typeof item.metrics === "object" ? item.metrics : null,
        diagnostics: item.diagnostics && typeof item.diagnostics === "object" ? item.diagnostics : null,
        error_reason: item.error_reason == null ? null : String(item.error_reason),
        engine_version: item.engine_version == null ? null : String(item.engine_version),
        metrics_version: item.metrics_version == null ? null : String(item.metrics_version),
        evaluated_at: item.evaluated_at == null ? null : String(item.evaluated_at)
      })).filter(
        (item) => Number.isFinite(item.validation_id) && item.validation_id > 0 && VALIDATION_STATUSES.has(item.status)
      ).map((item) => ({
        ...item,
        status: item.status
      }));
      const result2 = await reportValidationWorkflowResults(env.DB, parsed);
      return wrap(env, request, jsonResponse(result2));
    } catch {
      return wrap(env, request, badRequest("invalid json body"));
    }
  }
  if (pathname === "/api/workflow/jupyter-servers/mark-used") {
    try {
      const body = await request.json();
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key) {
        return wrap(env, request, badRequest("missing key"));
      }
      const result2 = await markJupyterServerUsed(env.DB, key);
      return wrap(env, request, jsonResponse(result2));
    } catch {
      return wrap(env, request, badRequest("invalid json body"));
    }
  }
  const ideaValidationsMatch = pathname.match(/^\/api\/ideas\/(\d+)\/validations$/);
  if (!ideaValidationsMatch) {
    return null;
  }
  const id = Number(ideaValidationsMatch[1]);
  if (!Number.isFinite(id) || id <= 0) {
    return wrap(env, request, badRequest("invalid idea id"));
  }
  const idea = await getIdeaById(env.DB, id);
  if (!idea) {
    return wrap(env, request, notFound("idea not found"));
  }
  let profileKeys;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await request.json();
      if (Array.isArray(body.profile_keys)) {
        profileKeys = body.profile_keys.map(String).filter(Boolean);
      }
    } catch {
      return wrap(env, request, badRequest("invalid json body"));
    }
  }
  const result = await enqueueIdeaValidations(env.DB, id, profileKeys);
  return wrap(env, request, jsonResponse(result));
}
__name(handleApiPost, "handleApiPost");
async function handleApiGet(request, env, pathname, url) {
  if (pathname === "/api/auth/check") {
    return wrap(env, request, jsonResponse({ ok: true }));
  }
  if (pathname === "/api/validation-profiles") {
    const includeDisabled = url.searchParams.get("include_disabled") === "1" || url.searchParams.get("include_disabled")?.toLowerCase() === "true";
    const data = await listValidationProfiles(env.DB, { includeDisabled });
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/jupyter-servers") {
    const includeDisabled = url.searchParams.get("include_disabled") === "1" || url.searchParams.get("include_disabled")?.toLowerCase() === "true";
    const data = await listJupyterServers(env.DB, { includeDisabled });
    return wrap(env, request, jsonResponse(data));
  }
  const jupyterMatch = pathname.match(/^\/api\/jupyter-servers\/([a-z][a-z0-9_-]*)$/);
  if (jupyterMatch) {
    const key = jupyterMatch[1];
    const item = await getJupyterServerByKey(env.DB, key);
    if (!item) {
      return wrap(env, request, notFound("jupyter server not found"));
    }
    return wrap(env, request, jsonResponse({ item }));
  }
  const profileMatch = pathname.match(/^\/api\/validation-profiles\/([a-z][a-z0-9_]*)$/);
  if (profileMatch) {
    const key = profileMatch[1];
    const item = await getValidationProfileByKey(env.DB, key);
    if (!item) {
      return wrap(env, request, notFound("validation profile not found"));
    }
    const validation_count = await countValidationsForProfile(env.DB, key);
    return wrap(env, request, jsonResponse({ item, validation_count }));
  }
  if (pathname === "/api/validations") {
    const sort = url.searchParams.get("sort")?.trim() || void 0;
    const orderParam = url.searchParams.get("order")?.trim().toLowerCase();
    const order = orderParam === "asc" || orderParam === "desc" ? orderParam : void 0;
    const absParam = url.searchParams.get("abs");
    const abs = absParam == null ? void 0 : absParam === "1" || absParam.toLowerCase() === "true";
    const limit = parsePositiveInt(url.searchParams.get("limit"), 30, 200);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
    const statusParam = url.searchParams.get("status");
    const status = statusParam == null || statusParam === "" ? null : statusParam.trim() || null;
    const profile_key = url.searchParams.get("profile_key")?.trim() || void 0;
    const data = await listValidationResults(env.DB, {
      sort,
      order,
      abs,
      limit,
      offset,
      status,
      profile_key: profile_key || null
    });
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/workflow/validation-jobs") {
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 200);
    const data = await listPendingValidationWorkflowJobs(env.DB, limit);
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/workflow/jupyter-servers") {
    const data = await listEnabledJupyterServers(env.DB);
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/stats") {
    const [ideas, operators] = await Promise.all([
      countIdeas(env.DB),
      countOperatorsByStatus(env.DB)
    ]);
    return wrap(
      env,
      request,
      jsonResponse({
        ideas_total: ideas.total,
        operators_total: operators.total,
        operators_active: operators.active,
        operators_pending: operators.pending
      })
    );
  }
  if (pathname === "/api/ideas") {
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 100);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
    const data = await listIdeas(env.DB, { limit, offset });
    return wrap(env, request, jsonResponse(data));
  }
  const ideaMatch = pathname.match(/^\/api\/ideas\/(\d+)$/);
  if (ideaMatch) {
    const id = Number(ideaMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return wrap(env, request, badRequest("invalid idea id"));
    }
    const idea = await getIdeaById(env.DB, id);
    if (!idea) {
      return wrap(env, request, notFound("idea not found"));
    }
    return wrap(env, request, jsonResponse({ item: idea }));
  }
  const ideaValidationsMatch = pathname.match(/^\/api\/ideas\/(\d+)\/validations$/);
  if (ideaValidationsMatch) {
    const id = Number(ideaValidationsMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return wrap(env, request, badRequest("invalid idea id"));
    }
    const idea = await getIdeaById(env.DB, id);
    if (!idea) {
      return wrap(env, request, notFound("idea not found"));
    }
    const data = await listIdeaValidations(env.DB, id);
    return wrap(env, request, jsonResponse(data));
  }
  const validationMatch = pathname.match(/^\/api\/validations\/(\d+)$/);
  if (validationMatch) {
    const id = Number(validationMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return wrap(env, request, badRequest("invalid validation id"));
    }
    const validation = await getIdeaValidationById(env.DB, id);
    if (!validation) {
      return wrap(env, request, notFound("validation not found"));
    }
    return wrap(env, request, jsonResponse({ item: validation }));
  }
  if (pathname === "/api/operators") {
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 100);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
    const status = url.searchParams.get("status")?.trim() || void 0;
    const data = await listOperators(env.DB, { limit, offset, status });
    return wrap(env, request, jsonResponse(data));
  }
  const operatorMatch = pathname.match(/^\/api\/operators\/(\d+)$/);
  if (operatorMatch) {
    const id = Number(operatorMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return wrap(env, request, badRequest("invalid operator id"));
    }
    const operator = await getOperatorById(env.DB, id);
    if (!operator) {
      return wrap(env, request, notFound("operator not found"));
    }
    return wrap(env, request, jsonResponse({ item: operator }));
  }
  return null;
}
__name(handleApiGet, "handleApiGet");

// src/datasets.ts
var DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/ech09527/quant-factors/main";
function directoryName(slug) {
  return slug.replace("/", "__");
}
__name(directoryName, "directoryName");
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.text();
}
__name(fetchText, "fetchText");
async function loadEnabledSlugs(base) {
  const yamlText = await fetchText(`${base}/datasets/datasets.yaml`);
  if (!yamlText) {
    return ["yhydev97/quant-data"];
  }
  const slugs = [];
  let currentSlug = null;
  let currentEnabled = false;
  for (const line of yamlText.split("\n")) {
    const slugMatch = line.match(/^\s+slug:\s+(.+)$/);
    if (slugMatch) {
      if (currentSlug && currentEnabled) {
        slugs.push(currentSlug);
      }
      currentSlug = slugMatch[1].trim();
      currentEnabled = false;
      continue;
    }
    const enabledMatch = line.match(/^\s+enabled:\s+(true|false)/);
    if (enabledMatch && currentSlug) {
      currentEnabled = enabledMatch[1] === "true";
    }
  }
  if (currentSlug && currentEnabled) {
    slugs.push(currentSlug);
  }
  return slugs.length > 0 ? slugs : ["yhydev97/quant-data"];
}
__name(loadEnabledSlugs, "loadEnabledSlugs");
async function loadDatasetSummary(base, slug) {
  const dir = directoryName(slug);
  const [readme, schemaText] = await Promise.all([
    fetchText(`${base}/datasets/${dir}/README.md`),
    fetchText(`${base}/datasets/${dir}/schema.json`)
  ]);
  const parts = [`### \u6570\u636E\u96C6: \`${slug}\``];
  if (readme) {
    parts.push("\n#### README\n", readme.trim());
  }
  if (schemaText) {
    parts.push("\n#### schema.json\n", "```json", schemaText.trim(), "```");
  }
  if (!readme && !schemaText) {
    parts.push("\n\uFF08\u65E0\u6CD5\u4ECE GitHub Raw \u62C9\u53D6 README/schema\uFF09");
  }
  parts.push("");
  return parts.join("\n");
}
__name(loadDatasetSummary, "loadDatasetSummary");
async function loadDatasetSection(env) {
  const override = env.DATASET_SECTION?.trim();
  if (override) {
    return override;
  }
  try {
    const base = (env.GITHUB_RAW_BASE ?? DEFAULT_RAW_BASE).replace(/\/$/, "");
    const slugs = await loadEnabledSlugs(base);
    const sections = await Promise.all(slugs.map((slug) => loadDatasetSummary(base, slug)));
    return sections.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`loadDatasetSection fallback: ${message}`);
    return [
      "### \u6570\u636E\u96C6: `yhydev97/quant-data`",
      "",
      "\uFF08\u65E0\u6CD5\u62C9\u53D6 GitHub Raw\uFF0C\u4F7F\u7528\u79BB\u7EBF\u5360\u4F4D\u8BF4\u660E\uFF1B\u90E8\u7F72\u5230 Cloudflare \u540E\u5E94\u80FD\u6B63\u5E38\u62C9\u53D6\u3002\uFF09",
      ""
    ].join("\n");
  }
}
__name(loadDatasetSection, "loadDatasetSection");

// src/dsl/registeredOps.ts
var REGISTERED_OPS = /* @__PURE__ */ new Set([
  "Ref",
  "Mean",
  "Std",
  "Sum",
  "Max",
  "Min",
  "Delta",
  "Rank",
  "Med",
  "Quantile",
  "Corr",
  "Abs",
  "Sign",
  "Log",
  "Neg",
  "Add",
  "Sub",
  "Mul",
  "Div",
  "CSRank",
  "CSZScore"
]);
var UNARY_OPS = /* @__PURE__ */ new Set(["Abs", "Sign", "Log", "Neg"]);
var BINARY_OPS = /* @__PURE__ */ new Set(["Add", "Sub", "Mul", "Div"]);
var ROLLING_OPS = /* @__PURE__ */ new Set([
  "Ref",
  "Mean",
  "Std",
  "Sum",
  "Max",
  "Min",
  "Delta",
  "Rank",
  "Med",
  "Quantile"
]);
var PAIR_ROLLING_OPS = /* @__PURE__ */ new Set(["Corr"]);
var CROSS_SECTIONAL_OPS = /* @__PURE__ */ new Set(["CSRank", "CSZScore"]);
var COMMUTATIVE_OPS = /* @__PURE__ */ new Set(["Add", "Mul"]);

// src/dsl/canonicalize.ts
var ALLOWED_FIELDS = /* @__PURE__ */ new Set([
  "open",
  "high",
  "low",
  "close",
  "volume",
  "quote_volume",
  "count",
  "taker_buy_volume",
  "taker_buy_quote_volume",
  "log_ret_1",
  "ret_24h",
  "vol_24h"
]);
var SCIENTIFIC_EPSILON = 1e-8;
var CanonicalizeError = class extends Error {
  static {
    __name(this, "CanonicalizeError");
  }
  constructor(message) {
    super(message);
    this.name = "CanonicalizeError";
  }
};
function normalizeConst(value) {
  if (Object.is(value, -0)) {
    return 0;
  }
  if (Math.abs(value - SCIENTIFIC_EPSILON) < Number.EPSILON * 10) {
    return SCIENTIFIC_EPSILON;
  }
  if (Math.abs(value + SCIENTIFIC_EPSILON) < Number.EPSILON * 10) {
    return -SCIENTIFIC_EPSILON;
  }
  if (Number.isInteger(value)) {
    return value;
  }
  return Object.is(value, 0) ? 0 : value;
}
__name(normalizeConst, "normalizeConst");
function formatConst(value) {
  const normalized = normalizeConst(value);
  if (normalized === SCIENTIFIC_EPSILON) {
    return "1e-8";
  }
  if (normalized === -SCIENTIFIC_EPSILON) {
    return "-1e-8";
  }
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }
  const asSci = normalized.toExponential();
  if (/e[+-]\d+$/.test(asSci)) {
    const [mantissa, exp] = asSci.split("e");
    const expNum = Number(exp);
    return `${mantissa}e${expNum >= 0 ? "+" : ""}${expNum}`;
  }
  return String(normalized);
}
__name(formatConst, "formatConst");
function normalizeField(name) {
  const lower = name.replace(/^\$/, "").toLowerCase();
  if (!ALLOWED_FIELDS.has(lower)) {
    throw new CanonicalizeError(`Field not allowed: ${name}`);
  }
  return lower;
}
__name(normalizeField, "normalizeField");
function collectCommutativeChildren(node, op) {
  if (node.kind === "Binary" && node.op === op) {
    return [...collectCommutativeChildren(node.left, op), ...collectCommutativeChildren(node.right, op)];
  }
  return [node];
}
__name(collectCommutativeChildren, "collectCommutativeChildren");
function foldCommutative(op, nodes) {
  if (nodes.length === 0) {
    throw new CanonicalizeError(`Empty ${op}`);
  }
  if (nodes.length === 1) {
    return nodes[0];
  }
  let result = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    result = { kind: "Binary", op, left: result, right: nodes[i] };
  }
  return result;
}
__name(foldCommutative, "foldCommutative");
function canonicalizeNode(node) {
  switch (node.kind) {
    case "Field":
      return { kind: "Field", name: normalizeField(node.name) };
    case "Const":
      return { kind: "Const", value: normalizeConst(node.value) };
    case "Unary":
      return { kind: "Unary", op: node.op, arg: canonicalizeNode(node.arg) };
    case "Binary": {
      if (COMMUTATIVE_OPS.has(node.op)) {
        const children = collectCommutativeChildren(node, node.op).map(
          (child) => canonicalizeNode(child)
        );
        children.sort((a, b) => stableDump(a).localeCompare(stableDump(b)));
        return foldCommutative(node.op, children);
      }
      return {
        kind: "Binary",
        op: node.op,
        left: canonicalizeNode(node.left),
        right: canonicalizeNode(node.right)
      };
    }
    case "Rolling":
      return {
        kind: "Rolling",
        op: node.op,
        arg: canonicalizeNode(node.arg),
        window: canonicalizeNode(node.window)
      };
    case "PairRolling":
      return {
        kind: "PairRolling",
        op: node.op,
        left: canonicalizeNode(node.left),
        right: canonicalizeNode(node.right),
        window: canonicalizeNode(node.window)
      };
    case "CrossSectional":
      return {
        kind: "CrossSectional",
        op: node.op,
        arg: canonicalizeNode(node.arg)
      };
    case "Custom":
      return {
        kind: "Custom",
        op: node.op,
        args: node.args.map((arg) => canonicalizeNode(arg))
      };
    default: {
      const _exhaustive = node;
      return _exhaustive;
    }
  }
}
__name(canonicalizeNode, "canonicalizeNode");
function stableDump(obj) {
  switch (obj.kind) {
    case "Field":
      return `field:${obj.name}`;
    case "Const":
      return `const:${formatConst(obj.value)}`;
    case "Unary":
      return `${obj.op}(${stableDump(obj.arg)})`;
    case "Binary":
      return `${obj.op}(${stableDump(obj.left)},${stableDump(obj.right)})`;
    case "Rolling":
      return `${obj.op}(${stableDump(obj.arg)},${stableDump(obj.window)})`;
    case "PairRolling":
      return `${obj.op}(${stableDump(obj.left)},${stableDump(obj.right)},${stableDump(obj.window)})`;
    case "CrossSectional":
      return `${obj.op}(${stableDump(obj.arg)})`;
    case "Custom":
      return `${obj.op}(${obj.args.map((arg) => stableDump(arg)).join(",")})`;
    default: {
      const _exhaustive = obj;
      return _exhaustive;
    }
  }
}
__name(stableDump, "stableDump");
function canonicalize(ast) {
  return canonicalizeNode(ast);
}
__name(canonicalize, "canonicalize");

// src/dsl/hash.ts
function toUtf8Bytes2(text) {
  return new TextEncoder().encode(text);
}
__name(toUtf8Bytes2, "toUtf8Bytes");
function bytesToHex2(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex2, "bytesToHex");
async function exprHash(canonical) {
  const payload = stableDump(canonical);
  const digest = await crypto.subtle.digest("SHA-256", toUtf8Bytes2(payload));
  return bytesToHex2(digest);
}
__name(exprHash, "exprHash");

// src/dsl/parse.ts
var ParseError = class extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
    this.name = "ParseError";
  }
  pos;
  static {
    __name(this, "ParseError");
  }
};
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const pos = i;
    if (ch === "(") {
      tokens.push({ type: "lparen", pos });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", pos });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", pos });
      i++;
      continue;
    }
    if ("+-*/".includes(ch)) {
      tokens.push({ type: "op", value: ch, pos });
      i++;
      continue;
    }
    if (ch === "$") {
      i++;
      const start = i;
      if (i >= input.length || !/[A-Za-z_]/.test(input[i])) {
        throw new ParseError("Expected field name after $", pos);
      }
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        i++;
      }
      tokens.push({ type: "field", name: input.slice(start, i), pos });
      continue;
    }
    if (/[0-9]/.test(ch) || ch === "." && i + 1 < input.length && /[0-9]/.test(input[i + 1])) {
      const start = i;
      while (i < input.length && /[0-9]/.test(input[i])) {
        i++;
      }
      if (i < input.length && input[i] === ".") {
        i++;
        while (i < input.length && /[0-9]/.test(input[i])) {
          i++;
        }
      }
      if (i < input.length && (input[i] === "e" || input[i] === "E")) {
        i++;
        if (i < input.length && (input[i] === "+" || input[i] === "-")) {
          i++;
        }
        const expStart = i;
        while (i < input.length && /[0-9]/.test(input[i])) {
          i++;
        }
        if (i === expStart) {
          throw new ParseError("Expected exponent digits", pos);
        }
      }
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ParseError(`Invalid number: ${raw}`, pos);
      }
      tokens.push({ type: "number", value, pos });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        i++;
      }
      tokens.push({ type: "ident", name: input.slice(start, i), pos });
      continue;
    }
    throw new ParseError(`Unexpected character: ${ch}`, pos);
  }
  return tokens;
}
__name(tokenize, "tokenize");
var Parser = class {
  constructor(tokens) {
    this.tokens = tokens;
  }
  tokens;
  static {
    __name(this, "Parser");
  }
  index = 0;
  parse() {
    const expr = this.parseExpr();
    if (this.index < this.tokens.length) {
      const t = this.tokens[this.index];
      throw new ParseError(`Unexpected token after expression`, t.pos);
    }
    return expr;
  }
  peek() {
    return this.tokens[this.index];
  }
  consume() {
    const t = this.tokens[this.index];
    if (!t) {
      throw new ParseError("Unexpected end of input", this.tokens.at(-1)?.pos ?? 0);
    }
    this.index++;
    return t;
  }
  parseExpr() {
    return this.parseAddSub();
  }
  parseAddSub() {
    let left = this.parseMulDiv();
    while (true) {
      const t = this.peek();
      if (!t || t.type !== "op" || t.value !== "+" && t.value !== "-") {
        break;
      }
      this.consume();
      const right = this.parseMulDiv();
      const op = t.value === "+" ? "Add" : "Sub";
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }
  parseMulDiv() {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (!t || t.type !== "op" || t.value !== "*" && t.value !== "/") {
        break;
      }
      this.consume();
      const right = this.parseUnary();
      const op = t.value === "*" ? "Mul" : "Div";
      left = { kind: "Binary", op, left, right };
    }
    return left;
  }
  parseUnary() {
    const t = this.peek();
    if (t?.type === "op" && t.value === "-") {
      this.consume();
      const arg = this.parseUnary();
      return { kind: "Unary", op: "Neg", arg };
    }
    if (t?.type === "op" && t.value === "+") {
      this.consume();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }
  parsePrimary() {
    const t = this.peek();
    if (!t) {
      throw new ParseError("Unexpected end of input", this.tokens.at(-1)?.pos ?? 0);
    }
    if (t.type === "number") {
      this.consume();
      return { kind: "Const", value: t.value };
    }
    if (t.type === "field") {
      this.consume();
      return { kind: "Field", name: t.name };
    }
    if (t.type === "ident") {
      const name = t.name;
      this.consume();
      if (this.peek()?.type === "lparen") {
        return this.parseCall(name);
      }
      throw new ParseError(`Unknown bare identifier: ${name}`, t.pos);
    }
    if (t.type === "lparen") {
      this.consume();
      const expr = this.parseExpr();
      const closing = this.consume();
      if (closing.type !== "rparen") {
        throw new ParseError("Expected )", closing.pos);
      }
      return expr;
    }
    throw new ParseError(`Unexpected token`, t.pos);
  }
  parseCall(name) {
    if (!REGISTERED_OPS.has(name)) {
      throw new ParseError(`Unknown operator: ${name}`, this.peek()?.pos ?? 0);
    }
    this.consume();
    const args = [];
    if (this.peek()?.type !== "rparen") {
      args.push(this.parseExpr());
      while (this.peek()?.type === "comma") {
        this.consume();
        args.push(this.parseExpr());
      }
    }
    const closing = this.consume();
    if (closing.type !== "rparen") {
      throw new ParseError("Expected )", closing.pos);
    }
    return buildCallNode(name, args);
  }
};
function buildCallNode(name, args) {
  if (CROSS_SECTIONAL_OPS.has(name)) {
    if (args.length !== 1) {
      throw new ParseError(`${name} expects 1 argument, got ${args.length}`, 0);
    }
    return { kind: "CrossSectional", op: name, arg: args[0] };
  }
  if (UNARY_OPS.has(name)) {
    if (args.length !== 1) {
      throw new ParseError(`${name} expects 1 argument, got ${args.length}`, 0);
    }
    return { kind: "Unary", op: name, arg: args[0] };
  }
  if (BINARY_OPS.has(name)) {
    if (args.length !== 2) {
      throw new ParseError(`${name} expects 2 arguments, got ${args.length}`, 0);
    }
    return { kind: "Binary", op: name, left: args[0], right: args[1] };
  }
  if (ROLLING_OPS.has(name)) {
    if (args.length !== 2) {
      throw new ParseError(`${name} expects 2 arguments, got ${args.length}`, 0);
    }
    return { kind: "Rolling", op: name, arg: args[0], window: args[1] };
  }
  if (PAIR_ROLLING_OPS.has(name)) {
    if (args.length !== 3) {
      throw new ParseError(`${name} expects 3 arguments, got ${args.length}`, 0);
    }
    return {
      kind: "PairRolling",
      op: name,
      left: args[0],
      right: args[1],
      window: args[2]
    };
  }
  return { kind: "Custom", op: name, args };
}
__name(buildCallNode, "buildCallNode");
function parseFactorExpr(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ParseError("Empty expression", 0);
  }
  const tokens = tokenize(trimmed);
  return new Parser(tokens).parse();
}
__name(parseFactorExpr, "parseFactorExpr");

// src/dsl/index.ts
async function parseAndHash(factorExpr) {
  try {
    const ast = parseFactorExpr(factorExpr);
    const canonicalAst = canonicalize(ast);
    const canonical = stableDump(canonicalAst);
    const hash = await exprHash(canonicalAst);
    return { canonical, hash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
__name(parseAndHash, "parseAndHash");

// src/openai.ts
function extractJsonArray(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(payload);
}
__name(extractJsonArray, "extractJsonArray");
function parseIdeasPayload(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && "ideas" in parsed && Array.isArray(parsed.ideas)) {
    return parsed.ideas;
  }
  throw new Error("OpenAI response is not a JSON array of ideas");
}
__name(parseIdeasPayload, "parseIdeasPayload");
function chatCompletionsUrl(baseUrl) {
  const base = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  return `${base}/chat/completions`;
}
__name(chatCompletionsUrl, "chatCompletionsUrl");
async function requestIdeas(apiKey, model, prompt, baseUrl) {
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: 'You output only valid JSON. Wrap the ideas array in an object: {"ideas": [...]}.'
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI request failed (${response.status})`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned empty content");
  }
  return parseIdeasPayload(extractJsonArray(content));
}
__name(requestIdeas, "requestIdeas");
var MOCK_IDEAS_FOR_TEST = [
  {
    title: "\u6D4B\u8BD5\u98CE\u9669\u8C03\u6574\u52A8\u91CF",
    hypothesis: "\u9AD8\u6536\u76CA\u6CE2\u52A8\u6BD4\u5728\u672A\u6765\u6A2A\u622A\u9762\u6709\u9884\u6D4B\u529B",
    data_sources: ["yhydev97/quant-data"],
    formula_sketch: "ret_24h / vol_24h\uFF0C\u6A2A\u622A\u9762 rank",
    expected_signal: "\u6A2A\u622A\u9762\uFF1A\u505A\u591A\u9AD8\u5206\u4F4D",
    risks: ["\u6D41\u52A8\u6027\u4E0D\u8DB3"],
    factor_expr: "CSRank($ret_24h / ($vol_24h + 1e-8))"
  },
  {
    title: "\u6D4B\u8BD5\u91CD\u590D\u56E0\u5B50",
    hypothesis: "\u540C\u4E0A",
    data_sources: ["yhydev97/quant-data"],
    formula_sketch: "\u540C\u4E0A",
    expected_signal: "\u6A2A\u622A\u9762",
    risks: ["\u8FC7\u62DF\u5408"],
    factor_expr: "CSRank(Div($ret_24h, Add($vol_24h, 1e-8)))"
  }
];
async function generateIdeasFromOpenAi(apiKey, model, prompt, env) {
  if (apiKey === "mock-key-for-test") {
    return MOCK_IDEAS_FOR_TEST;
  }
  const mock = env?.MOCK_OPENAI_RESPONSE?.trim();
  if (mock) {
    return parseIdeasPayload(JSON.parse(mock));
  }
  const baseUrl = env?.OPENAI_BASE_URL;
  try {
    return await requestIdeas(apiKey, model, prompt, baseUrl);
  } catch (firstError) {
    try {
      return await requestIdeas(apiKey, model, prompt, baseUrl);
    } catch {
      throw firstError;
    }
  }
}
__name(generateIdeasFromOpenAi, "generateIdeasFromOpenAi");

// src/prompt.ts
var IDEA_SCHEMA = `{
  "type": "object",
  "required": [
    "title",
    "hypothesis",
    "data_sources",
    "formula_sketch",
    "expected_signal",
    "risks",
    "factor_expr"
  ],
  "properties": {
    "title": { "type": "string" },
    "hypothesis": { "type": "string" },
    "data_sources": { "type": "array", "items": { "type": "string" } },
    "formula_sketch": { "type": "string" },
    "expected_signal": { "type": "string" },
    "risks": { "type": "array", "items": { "type": "string" } },
    "factor_expr": {
      "type": "string",
      "description": "Qlib-style DSL string, e.g. CSRank($ret_24h / ($vol_24h + 1e-8))"
    },
    "custom_ops": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "signature", "description"],
        "properties": {
          "name": { "type": "string" },
          "signature": { "type": "string" },
          "description": { "type": "string" },
          "example": { "type": "string" }
        }
      }
    }
  }
}`;
function formatOperators(operators) {
  if (operators.length === 0) {
    return "\uFF08\u6682\u65E0\u5DF2\u6CE8\u518C\u7684\u81EA\u5B9A\u4E49\u7B97\u5B50\uFF09\n";
  }
  return operators.map((op) => {
    const lines = [
      `- **${op.name}** \`${op.signature}\``,
      `  - ${op.description}`
    ];
    if (op.example) {
      lines.push(`  - \u793A\u4F8B: \`${op.example}\``);
    }
    return lines.join("\n");
  }).join("\n");
}
__name(formatOperators, "formatOperators");
function formatSaturatedPatterns(patterns) {
  if (patterns.length === 0) {
    return "\uFF08\u6682\u65E0\u9971\u548C\u8868\u8FBE\u5F0F\u6A21\u5F0F\uFF09\n";
  }
  return patterns.map((p) => `- (${p.count}\xD7) \`${p.expr_canonical}\``).join("\n");
}
__name(formatSaturatedPatterns, "formatSaturatedPatterns");
function buildPrompt(options) {
  const { datasetSection, activeOperators, saturatedPatterns, maxIdeas } = options;
  const minIdeas = Math.max(1, maxIdeas);
  const maxBatch = Math.max(minIdeas, Math.min(5, maxIdeas + 2));
  return `\u4F60\u662F\u4E00\u4F4D\u91CF\u5316\u6295\u7814\u4E13\u5BB6\uFF0C\u8BF7\u57FA\u4E8E\u4E0B\u65B9\u6570\u636E\u96C6\u8BF4\u660E\u63D0\u51FA**\u65B0\u7684**\u91CF\u5316\u56E0\u5B50\u7814\u7A76\u601D\u8DEF\u3002

\u672C\u4ED3\u5E93\u6570\u636E\u96C6\u591A\u4E3A**\u591A\u6807\u7684\u9762\u677F**\uFF08symbol \xD7 \u65F6\u95F4\u6233\uFF0C\u5982 1h K \u7EBF\uFF09\u3002\u8BF7**\u4F18\u5148\u4EA7\u51FA\u6A2A\u622A\u9762\uFF08cross-sectional\uFF09\u56E0\u5B50**\uFF1A\u5728\u540C\u4E00 open_time \u5BF9 universe \u5185\u5404 symbol \u6392\u5E8F/\u5206\u4F4D/z-score\uFF0C\u7528\u4E8E\u591A\u7A7A\u8F6E\u52A8\u3002

## \u4EFB\u52A1\u8981\u6C42

1. \u6BCF\u6761\u60F3\u6CD5\u5FC5\u987B\u57FA\u4E8E\u5DF2\u63D0\u4F9B\u7684\u6570\u636E\u96C6 schema \u4E0E README\uFF0C\u5B57\u6BB5\u4E0E\u8BA1\u7B97\u903B\u8F91\u987B\u4E0E\u771F\u5B9E\u5217\u540D\u3001\u6570\u636E\u9891\u7387\u4E00\u81F4\u3002
2. **\u4E0D\u5F97\u91CD\u590D**\u5E38\u89C1\u5957\u8DEF\uFF1B\u6807\u9898\u5E94\u7B80\u6D01\u4E14\u53EF\u533A\u5206\u3002
3. \u751F\u6210\u7684\u60F3\u6CD5\u4E2D **\u81F3\u5C11 70% \u987B\u4E3A\u6A2A\u622A\u9762\u56E0\u5B50**\uFF08formula_sketch \u542B\u6309 open_time \u5206\u7EC4\u3001\u7EC4\u5185\u8DE8 symbol \u6BD4\u8F83\uFF09\uFF1B\u65F6\u5E8F\u7C7B\u60F3\u6CD5\u987B\u5728 expected_signal \u6807\u6CE8\u300C\u65F6\u5E8F\u300D\u3002
4. \u6A2A\u622A\u9762\u60F3\u6CD5\u7684 formula_sketch \u987B\u542B universe \u8FC7\u6EE4\uFF08\u5982 quote_volume\uFF09\u4E0E\u7EC4\u5185 rank/z-score \u6B65\u9AA4\uFF1Brisks \u987B\u542B\u6D41\u52A8\u6027\u6216\u5E78\u5B58\u8005\u504F\u5DEE\u7B49\u622A\u9762\u98CE\u9669\u3002
5. \u6BCF\u6761\u60F3\u6CD5\u5FC5\u987B\u5305\u542B **factor_expr**\uFF1AQlib \u98CE\u683C DSL \u5B57\u7B26\u4E32\uFF08\u5B57\u6BB5\u7528 $ \u524D\u7F00\uFF0C\u5982 $close\uFF1B\u5185\u7F6E\u7B97\u5B50\u5982 Ref\u3001Mean\u3001CSRank\u3001Add\u3001Div\uFF09\u3002
6. \u82E5\u4F7F\u7528**\u975E\u5185\u7F6E\u7B97\u5B50**\uFF0C\u5FC5\u987B\u5728 custom_ops \u4E2D\u9644\u5E26 name\u3001signature\u3001description\uFF08\u53CA\u53EF\u9009 example\uFF09\u3002
7. \u8F93\u51FA\u5FC5\u987B\u662F**\u4E25\u683C JSON \u5BF9\u8C61** \`{"ideas": [...]}\`\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\u6216\u89E3\u91CA\u6587\u5B57\u3002
8. \u6BCF\u4E2A\u5143\u7D20\u987B\u7B26\u5408\u4EE5\u4E0B JSON Schema\uFF1A

${IDEA_SCHEMA}

## \u5185\u7F6E DSL \u7B97\u5B50\uFF08\u53EF\u76F4\u63A5\u4F7F\u7528\uFF09

Ref, Mean, Std, Sum, Max, Min, Delta, Rank, Med, Quantile, Corr, Abs, Sign, Log, Neg, Add, Sub, Mul, Div, CSRank, CSZScore

## \u5DF2\u6CE8\u518C\u81EA\u5B9A\u4E49\u7B97\u5B50\uFF08\u53EF\u5728 factor_expr \u4E2D\u8C03\u7528\uFF09

${formatOperators(activeOperators)}

## \u9971\u548C\u8868\u8FBE\u5F0F\u6A21\u5F0F\uFF08\u8BF7\u907F\u514D\u96F7\u540C\u7ED3\u6784\uFF09

${formatSaturatedPatterns(saturatedPatterns)}

## \u8F93\u51FA\u683C\u5F0F\u793A\u4F8B

{
  "ideas": [
    {
      "title": "\u6A2A\u622A\u9762\u56E0\u5B50\u540D\u79F0",
      "hypothesis": "\u7ECF\u6D4E\u6216\u884C\u4E3A\u5047\u8BBE\u2026",
      "data_sources": ["owner/dataset-slug"],
      "formula_sketch": "\u6309 symbol \u8BA1\u7B97\u2026\uFF1B\u6BCF\u4E2A open_time \u6A2A\u622A\u9762 rank\u2026",
      "expected_signal": "\u6A2A\u622A\u9762\uFF1A\u505A\u591A\u9AD8\u5206\u4F4D\u3001\u505A\u7A7A\u4F4E\u5206\u4F4D\u2026",
      "risks": ["\u6D41\u52A8\u6027\u5206\u5C42", "\u65B0\u4E0A\u5E02 symbol \u6570\u636E\u4E0D\u8DB3"],
      "factor_expr": "CSRank($ret_24h / ($vol_24h + 1e-8))"
    }
  ]
}

\u8BF7\u4E00\u6B21\u751F\u6210 ${minIdeas}\uFF5E${maxBatch} \u6761\u4E92\u4E0D\u91CD\u590D\u7684\u65B0\u60F3\u6CD5\u3002

---

## \u53EF\u7528\u6570\u636E\u96C6

${datasetSection}`;
}
__name(buildPrompt, "buildPrompt");

// src/config.ts
function readOpenAiKey(env) {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY \u672A\u914D\u7F6E\uFF0C\u8BF7\u5728 .dev.vars \u6216 Worker Secret \u4E2D\u8BBE\u7F6E");
  }
  return key;
}
__name(readOpenAiKey, "readOpenAiKey");
function readOpenAiModel(env) {
  return env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}
__name(readOpenAiModel, "readOpenAiModel");

// src/generate.ts
var REQUIRED_FIELDS = [
  "title",
  "hypothesis",
  "data_sources",
  "formula_sketch",
  "expected_signal",
  "risks",
  "factor_expr"
];
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
__name(isNonEmptyString, "isNonEmptyString");
function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isNonEmptyString(item));
}
__name(isStringArray, "isStringArray");
function validateIdea(idea) {
  if (!idea || typeof idea !== "object") {
    return "idea is not an object";
  }
  const record = idea;
  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (field === "data_sources" || field === "risks") {
      if (!isStringArray(value)) {
        return `missing or invalid field: ${field}`;
      }
      continue;
    }
    if (!isNonEmptyString(value)) {
      return `missing or invalid field: ${field}`;
    }
  }
  if (record.custom_ops !== void 0) {
    if (!Array.isArray(record.custom_ops)) {
      return "custom_ops must be an array";
    }
    for (const op of record.custom_ops) {
      if (!op || typeof op !== "object") {
        return "invalid custom_ops entry";
      }
      const customOp = op;
      if (!isNonEmptyString(customOp.name) || !isNonEmptyString(customOp.signature) || !isNonEmptyString(customOp.description)) {
        return "custom_ops entry missing name/signature/description";
      }
    }
  }
  return null;
}
__name(validateIdea, "validateIdea");
function collectCustomOpNames(node, names) {
  switch (node.kind) {
    case "Custom":
      names.add(node.op);
      for (const arg of node.args) {
        collectCustomOpNames(arg, names);
      }
      break;
    case "Unary":
      collectCustomOpNames(node.arg, names);
      break;
    case "Binary":
      collectCustomOpNames(node.left, names);
      collectCustomOpNames(node.right, names);
      break;
    case "Rolling":
      collectCustomOpNames(node.arg, names);
      collectCustomOpNames(node.window, names);
      break;
    case "PairRolling":
      collectCustomOpNames(node.left, names);
      collectCustomOpNames(node.right, names);
      collectCustomOpNames(node.window, names);
      break;
    case "CrossSectional":
      collectCustomOpNames(node.arg, names);
      break;
    case "Field":
    case "Const":
      break;
    default: {
      const _exhaustive = node;
      return _exhaustive;
    }
  }
}
__name(collectCustomOpNames, "collectCustomOpNames");
function extractCustomOpNames(factorExpr) {
  try {
    const ast = parseFactorExpr(factorExpr);
    const names = /* @__PURE__ */ new Set();
    collectCustomOpNames(ast, names);
    return [...names];
  } catch {
    return [];
  }
}
__name(extractCustomOpNames, "extractCustomOpNames");
function hasUnregisteredCustomOps(factorExpr, activeCustomOps) {
  return extractCustomOpNames(factorExpr).some(
    (name) => !REGISTERED_OPS.has(name) && !activeCustomOps.has(name)
  );
}
__name(hasUnregisteredCustomOps, "hasUnregisteredCustomOps");
async function buildHashes(idea, activeCustomOps) {
  const title_hash = await titleHash(idea.title);
  if (hasUnregisteredCustomOps(idea.factor_expr, activeCustomOps)) {
    return {
      title_hash,
      expr_hash: null,
      expr_canonical: null,
      dedup_tier: "custom_pending"
    };
  }
  const parsed = await parseAndHash(idea.factor_expr);
  if ("error" in parsed) {
    return { error: parsed.error };
  }
  return {
    title_hash,
    expr_hash: parsed.hash,
    expr_canonical: parsed.canonical,
    dedup_tier: "builtin"
  };
}
__name(buildHashes, "buildHashes");
async function persistIdea(db, idea, hashes) {
  const ideaId = await insertIdea(db, idea, hashes);
  const customOps = idea.custom_ops ?? [];
  for (const op of customOps) {
    await insertPendingOperator(db, op, ideaId);
  }
  return ideaId;
}
__name(persistIdea, "persistIdea");
async function processIdeas(db, ideas, activeCustomOps) {
  let created = 0;
  let skipped = 0;
  const errors = [];
  for (const idea of ideas) {
    const validationError = validateIdea(idea);
    if (validationError) {
      errors.push(`${idea.title || "(untitled)"}: ${validationError}`);
      continue;
    }
    const hashes = await buildHashes(idea, activeCustomOps);
    if ("error" in hashes) {
      errors.push(`${idea.title}: ${hashes.error}`);
      continue;
    }
    if (await existsByHash(db, hashes.title_hash, hashes.expr_hash)) {
      skipped++;
      continue;
    }
    await persistIdea(db, idea, hashes);
    created++;
  }
  return { created, skipped, errors };
}
__name(processIdeas, "processIdeas");
function parseMaxIdeas(env, maxIdeas) {
  if (typeof maxIdeas === "number" && Number.isFinite(maxIdeas) && maxIdeas > 0) {
    return Math.floor(maxIdeas);
  }
  const fromEnv = Number(env.MAX_IDEAS ?? "3");
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 3;
}
__name(parseMaxIdeas, "parseMaxIdeas");
async function runGenerate(env, maxIdeas) {
  const target = parseMaxIdeas(env, maxIdeas);
  let created = 0;
  let skipped = 0;
  const errors = [];
  const apiKey = readOpenAiKey(env);
  const model = readOpenAiModel(env);
  const [activeOperators, saturatedPatterns, datasetSection] = await Promise.all([
    getActiveOperators(env.DB),
    getSaturatedPatterns(env.DB),
    loadDatasetSection(env)
  ]);
  const activeCustomOps = new Set(activeOperators.map((op) => op.name));
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts && created < target; attempt++) {
    const remaining = target - created;
    const attemptPrompt = buildPrompt({
      datasetSection,
      activeOperators,
      saturatedPatterns,
      maxIdeas: remaining
    });
    try {
      const ideas = await generateIdeasFromOpenAi(apiKey, model, attemptPrompt, env);
      const batch = await processIdeas(env.DB, ideas, activeCustomOps);
      created += batch.created;
      skipped += batch.skipped;
      errors.push(...batch.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`attempt ${attempt + 1}: ${message}`);
    }
  }
  return { created, skipped, errors };
}
__name(runGenerate, "runGenerate");

// src/index.ts
function parseMaxIdeasParam(value, env) {
  if (!value) {
    return void 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return void 0;
  }
  return Math.floor(parsed);
}
__name(parseMaxIdeasParam, "parseMaxIdeasParam");
var index_default = {
  async scheduled(_controller, env) {
    const result = await runGenerate(env, 1);
    console.log(JSON.stringify(result));
    if (result.errors.length > 0 && result.created === 0) {
      console.error(result.errors.join("; "));
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const optionsResponse = handleOptions(request, env, pathname);
    if (optionsResponse) {
      return optionsResponse;
    }
    if (requiresAuth(pathname) && !isAuthorized(request, env)) {
      return unauthorizedResponse(request, env);
    }
    const apiResponse = await handleApiRequest(request, env, pathname);
    if (apiResponse) {
      return apiResponse;
    }
    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && pathname === "/generate") {
      const maxIdeas = parseMaxIdeasParam(url.searchParams.get("max_ideas"), env);
      try {
        const result = await runGenerate(env, maxIdeas);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("generate failed:", error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
