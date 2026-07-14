var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

import { buildIdeaGenerationPrompt as buildPrompt } from "./idea-prompt.js";
import { validateFactorSqlBasic, hasStoredFactorSql } from "./factor-sql-validate.js";
import {
  cleanupExpiredJupyterServers,
  createJupyterServer,
  deleteJupyterServer,
  getJupyterServerByKey,
  listEnabledJupyterServers,
  listJupyterServers,
  markJupyterServerUsed,
  parseRuntimeConfigValue,
  updateJupyterServer,
} from "./jupyter-server-db.js";

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
    factor_sql: parseJsonObject(row.factor_sql),
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
async function insertIdea(db, idea, hashes, source = "openai") {
  const result = await db.prepare(
    `INSERT INTO ideas (
        title, title_hash, factor_expr, expr_hash, expr_canonical,
        hypothesis, formula_sketch, expected_signal, risks, data_sources,
        factor_sql, dedup_tier, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
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
    idea.factor_sql ? JSON.stringify(idea.factor_sql) : null,
    hashes.dedup_tier,
    source
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
  const { limit, offset, source, title } = options;
  const filters = [];
  const binds = [];
  if (source) {
    filters.push("source = ?");
    binds.push(source);
  }
  const titleQuery = title != null && String(title).trim() ? String(title).trim() : null;
  if (titleQuery) {
    filters.push("instr(lower(title), lower(?)) > 0");
    binds.push(titleQuery);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM ideas ${where}`).bind(...binds).first();
  const result = await db.prepare(
    `SELECT id, title, title_hash, factor_expr, expr_hash, expr_canonical,
              hypothesis, formula_sketch, expected_signal, risks, data_sources,
              factor_sql, dedup_tier, source, created_at, updated_at
       FROM ideas
       ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  return {
    items: (result.results ?? []).map(rowToIdea),
    total: Number(countRow?.total ?? 0),
    limit,
    offset,
    source: source || null,
    title: titleQuery
  };
}
__name(listIdeas, "listIdeas");
async function listIdeaSources(db) {
  const result = await db.prepare(
    `SELECT DISTINCT source
       FROM ideas
       WHERE source IS NOT NULL AND TRIM(source) != ''
       ORDER BY source ASC`
  ).all();
  return {
    items: (result.results ?? []).map((row) => String(row.source))
  };
}
__name(listIdeaSources, "listIdeaSources");
async function getIdeaById(db, id) {
  const row = await db.prepare(
    `SELECT id, title, title_hash, factor_expr, expr_hash, expr_canonical,
              hypothesis, formula_sketch, expected_signal, risks, data_sources,
              factor_sql, dedup_tier, source, created_at, updated_at
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
  const next = { ...diagnostics ?? {} };
  for (const key of KERNEL_EXECUTION_DIAGNOSTIC_KEYS) {
    delete next[key];
  }
  return next;
}
__name(stripKernelExecutionDiagnostics, "stripKernelExecutionDiagnostics");
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
    idea_title_hash: String(row.idea_title_hash ?? ""),
    idea_source: String(row.idea_source ?? "")
  };
}
__name(rowToValidationResult, "rowToValidationResult");
function parseProfileKeys(options = {}) {
  const keys = [];
  if (Array.isArray(options.profile_keys)) {
    for (const item of options.profile_keys) {
      const key = String(item ?? "").trim();
      if (key) keys.push(key);
    }
  }
  const single = options.profile_key?.trim();
  if (single) {
    for (const part of single.split(",")) {
      const key = part.trim();
      if (key) keys.push(key);
    }
  }
  return [...new Set(keys)];
}
__name(parseProfileKeys, "parseProfileKeys");
function buildValidationResultsQuery(options) {
  const sortRaw = options.sort?.trim() || "updated_at";
  const sort = sortRaw in VALIDATION_SORT_FIELDS ? sortRaw : "updated_at";
  const order = options.order === "asc" ? "asc" : "desc";
  const abs = options.abs !== false;
  const limit = Math.min(Math.max(Number(options.limit ?? 30) || 30, 1), 200);
  const offset = Math.max(Number(options.offset ?? 0) || 0, 0);
  const status = options.status?.trim() || null;
  const profile_keys = parseProfileKeys(options);
  const source = options.source?.trim() || null;
  const whereParts = ["1 = 1"];
  const binds = [];
  if (status) {
    whereParts.push("iv.status = ?");
    binds.push(status);
  }
  if (profile_keys.length === 1) {
    whereParts.push("iv.profile_key = ?");
    binds.push(profile_keys[0]);
  } else if (profile_keys.length > 1) {
    whereParts.push(`iv.profile_key IN (${profile_keys.map(() => "?").join(", ")})`);
    binds.push(...profile_keys);
  }
  if (source) {
    whereParts.push("i.source = ?");
    binds.push(source);
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
    profile_keys,
    source
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
         i.title AS idea_title, i.title_hash AS idea_title_hash, i.source AS idea_source
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
    profile_keys: query.profile_keys,
    source: query.source
  };
}
__name(listValidationResults, "listValidationResults");
async function enqueueIdeaValidations(db, ideaId, profileKeys) {
  const ideaRow = await db.prepare("SELECT factor_sql FROM ideas WHERE id = ? LIMIT 1").bind(ideaId).first();
  if (!hasStoredFactorSql(parseJsonObject(ideaRow?.factor_sql))) {
    const listed = await listIdeaValidations(db, ideaId);
    return {
      created: 0,
      skipped: 0,
      ignored: true,
      reason: "idea has no factor_sql",
      items: listed.items
    };
  }
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
function normalizeWorkflowLabelKind(value) {
  if (value == null || value === "") {
    return null;
  }
  return value === "forward_volatility" ? "forward_volatility" : "forward_return";
}
__name(normalizeWorkflowLabelKind, "normalizeWorkflowLabelKind");
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
__name(normalizeWorkflowHorizonBars, "normalizeWorkflowHorizonBars");
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
    data_sources: parseJsonArray2(row.data_sources),
    factor_sql: parseJsonObject(row.factor_sql),
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
async function reclaimStaleValidationJobs(db, maxAgeMinutes = 120) {
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
      AND i.factor_sql IS NOT NULL
      AND TRIM(i.factor_sql) != ''
      AND TRIM(i.factor_sql) != 'null'
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
         i.data_sources,
         i.factor_sql
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
__name(claimValidationWorkflowJobs, "claimValidationWorkflowJobs");
async function reportValidationWorkflowResults(db, items) {
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
__name(reportValidationWorkflowResults, "reportValidationWorkflowResults");

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
        max_kernels:
          body.max_kernels === 0 || body.max_kernels === "0"
            ? null
            : body.max_kernels == null || body.max_kernels === ""
              ? 30
              : Number(body.max_kernels),
        sort_order: body.sort_order == null ? 0 : Number(body.sort_order),
        enabled: body.enabled !== false,
        temporary: body.temporary,
        expires_at: body.expires_at,
        expires_in_hours: body.expires_in_hours,
        expires_in_minutes: body.expires_in_minutes,
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
        max_kernels:
          body.max_kernels === void 0
            ? void 0
            : body.max_kernels == null || body.max_kernels === ""
              ? null
              : Number(body.max_kernels),
        sort_order: body.sort_order == null ? void 0 : Number(body.sort_order),
        enabled: body.enabled === void 0 ? void 0 : Boolean(body.enabled),
        temporary: body.temporary,
        expires_at: body.expires_at,
        expires_in_hours: body.expires_in_hours,
        expires_in_minutes: body.expires_in_minutes,
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
  if (pathname === "/api/ideas") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const result = await runImportIdeas(env, body);
      return wrap(env, request, jsonResponse({ ok: true, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return wrap(env, request, badRequest(message));
    }
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
    const cleanup = await cleanupExpiredJupyterServers(env.DB);
    const items = await listJupyterServers(env.DB, { includeDisabled, includeExpired: true });
    return wrap(env, request, jsonResponse({ items, total: items.length, cleanup }));
  }
  const jupyterMatch = pathname.match(/^\/api\/jupyter-servers\/([a-z][a-z0-9_-]*)$/);
  if (jupyterMatch) {
    const key = jupyterMatch[1];
    const item = await getJupyterServerByKey(env.DB, key, { includeExpired: true });
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
    const profileKeys = [
      ...url.searchParams.getAll("profile_key").map((value) => value.trim()).filter(Boolean),
      ...(url.searchParams.get("profile_keys")?.split(",") ?? []).map((value) => value.trim()).filter(Boolean)
    ];
    const profile_keys = [...new Set(profileKeys)];
    const sourceParam = url.searchParams.get("source");
    const source = sourceParam == null || sourceParam === "" ? null : sourceParam.trim() || null;
    const data = await listValidationResults(env.DB, {
      sort,
      order,
      abs,
      limit,
      offset,
      status,
      profile_keys,
      source
    });
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/workflow/validation-jobs") {
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 200);
    const data = await listPendingValidationWorkflowJobs(env.DB, limit);
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/workflow/jupyter-servers") {
    await cleanupExpiredJupyterServers(env.DB);
    const items = await listEnabledJupyterServers(env.DB);
    return wrap(env, request, jsonResponse({ items, total: items.length }));
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
  if (pathname === "/api/ideas/generation-prompt") {
    const maxIdeasParam = url.searchParams.get("max_ideas");
    const maxIdeas = maxIdeasParam ? parseMaxIdeasParam(maxIdeasParam, env) : void 0;
    const data = await resolveIdeaGenerationPrompt(env, maxIdeas);
    const format = url.searchParams.get("format")?.trim().toLowerCase();
    if (format === "text" || format === "plain") {
      return wrap(
        env,
        request,
        new Response(data.prompt, {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        })
      );
    }
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/ideas/sources") {
    const data = await listIdeaSources(env.DB);
    return wrap(env, request, jsonResponse(data));
  }
  if (pathname === "/api/ideas") {
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 100);
    const offset = parsePositiveInt(url.searchParams.get("offset"), 0);
    const sourceParam = url.searchParams.get("source");
    const source = sourceParam == null || sourceParam === "" ? null : sourceParam.trim() || null;
    const titleParam = url.searchParams.get("title");
    const title = titleParam == null || titleParam === "" ? null : titleParam.trim() || null;
    const data = await listIdeas(env.DB, { limit, offset, source, title });
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
  const context = await fetchText(`${base}/datasets/${dir}/prompt-context.md`);
  if (context) {
    return `### 数据集 \`${slug}\`\n\n${context.trim()}\n`;
  }
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
    parts.push("\n\uFF08\u65E0\u6CD5\u4ECE GitHub Raw \u62C9\u53D6\u6570\u636E\u8BF4\u660E\uFF09");
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
      "### 数据集 `yhydev97/quant-data`",
      "",
      "- **类型**：Binance USDT 永续合约 1h K 线（symbol × open_time）",
      "- **字段**：open, high, low, close, volume, quote_volume, count, taker_buy_volume, taker_buy_quote_volume, log_ret_1, ret_24h, vol_24h",
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
  const candidates = [];
  const fenced = trimmed.match(/^```(?:json|python)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(trimmed);
  const firstArray = trimmed.match(/\[[\s\S]*\]/);
  if (firstArray) {
    candidates.push(firstArray[0]);
  }
  const firstObject = trimmed.match(/\{[\s\S]*\}/);
  if (firstObject) {
    candidates.push(firstObject[0]);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("failed to parse JSON payload");
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
async function requestIdeas(apiKey, model, prompt, baseUrl, temperature = 0.2) {
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: "system",
          content: 'You output only valid JSON object: {"ideas":[...]}. Never output Python/Markdown. Each factor_expr must be valid DSL expression and must not contain ":" or Chinese punctuation.'
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
async function generateIdeasFromOpenAi(apiKey, model, prompt, env, temperature = 0.2, baseUrl) {
  if (apiKey === "mock-key-for-test") {
    return MOCK_IDEAS_FOR_TEST;
  }
  const mock = env?.MOCK_OPENAI_RESPONSE?.trim();
  if (mock) {
    return parseIdeasPayload(JSON.parse(mock));
  }
  const resolvedBaseUrl = baseUrl ?? env?.OPENAI_BASE_URL;
  try {
    return await requestIdeas(apiKey, model, prompt, resolvedBaseUrl, temperature);
  } catch (firstError) {
    try {
      return await requestIdeas(apiKey, model, prompt, resolvedBaseUrl, temperature);
    } catch {
      throw firstError;
    }
  }
}
__name(generateIdeasFromOpenAi, "generateIdeasFromOpenAi");

// src/prompt.ts — see idea-prompt.js + assets/generate-ideas-worker.txt

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
function readIdeaOpenAiModel(env) {
  return env.IDEA_OPENAI_MODEL?.trim() || readOpenAiModel(env);
}
__name(readIdeaOpenAiModel, "readIdeaOpenAiModel");

// src/generate.ts
var REQUIRED_FIELDS = [
  "title",
  "hypothesis",
  "data_sources",
  "formula_sketch",
  "expected_signal",
  "risks",
  "factor_expr",
  "factor_sql"
];
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
__name(isNonEmptyString, "isNonEmptyString");
function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isNonEmptyString(item));
}
__name(isStringArray, "isStringArray");
function normalizeTextField(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join("\n");
  }
  if (value == null) {
    return "";
  }
  return String(value).trim();
}
__name(normalizeTextField, "normalizeTextField");
function normalizeFactorExprFromCanonical(expr) {
  if (typeof expr !== "string") {
    return expr;
  }
  const trimmed = expr.trim();
  if (!trimmed.includes("field:") && !trimmed.includes("const:")) {
    return trimmed;
  }
  return trimmed.replace(/field:([a-zA-Z0-9_]+)/g, (_, name) => `$${name}`).replace(/const:([^,)]+)/g, "$1");
}
__name(normalizeFactorExprFromCanonical, "normalizeFactorExprFromCanonical");
function normalizeImportIdea(idea) {
  if (!idea || typeof idea !== "object" || Array.isArray(idea)) {
    return idea;
  }
  idea.hypothesis = normalizeTextField(idea.hypothesis);
  idea.formula_sketch = normalizeTextField(idea.formula_sketch);
  idea.expected_signal = normalizeTextField(idea.expected_signal);
  if (typeof idea.factor_expr === "string") {
    idea.factor_expr = normalizeFactorExprFromCanonical(idea.factor_expr);
  }
  return idea;
}
__name(normalizeImportIdea, "normalizeImportIdea");
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
    if (field === "factor_sql") {
      continue;
    }
    if (!isNonEmptyString(value)) {
      return `missing or invalid field: ${field}`;
    }
  }
  const factorSql = record.factor_sql;
  if (!factorSql || typeof factorSql !== "object" || Array.isArray(factorSql)) {
    return "missing or invalid field: factor_sql";
  }
  try {
    validateFactorSqlBasic(factorSql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid factor_sql: ${message}`;
  }
  const primarySource = record.data_sources[0];
  if (String(factorSql.data_source) !== String(primarySource)) {
    return `factor_sql.data_source must match data_sources[0] (${primarySource})`;
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
function autoRepairFactorExpr(expr) {
  let fixed = expr.trim();
  fixed = fixed.replace(/[`'"]/g, "");
  fixed = fixed.replace(/:/g, ",");
  fixed = fixed.replace(/\$([a-z_]+)_t\b/gi, (_m, field) => `$${field}`);
  fixed = fixed.replace(/\$open_time\b/gi, "$open");
  fixed = fixed.replace(/\$ret_24h_t\b/gi, "$ret_24h");
  fixed = fixed.replace(/\$vol_24h_t\b/gi, "$vol_24h");
  fixed = fixed.replace(/\$quote_volume_t\b/gi, "$quote_volume");
  fixed = fixed.replace(/\$taker_buy_quote_volume_t\b/gi, "$taker_buy_quote_volume");
  fixed = fixed.replace(/\bMean\(([^,()]+)\)/gi, "Mean($1,24)");
  fixed = fixed.replace(/\bStd\(([^,()]+)\)/gi, "Std($1,24)");
  fixed = fixed.replace(/\bCorr\(([^,()]+),([^,()]+)\)/gi, "Corr($1,$2,24)");
  return fixed;
}
__name(autoRepairFactorExpr, "autoRepairFactorExpr");
async function buildHashes(idea, activeCustomOps) {
  const title_hash = await titleHash(idea.title);
  let factorExpr = idea.factor_expr;
  if (hasUnregisteredCustomOps(factorExpr, activeCustomOps)) {
    return {
      title_hash,
      expr_hash: null,
      expr_canonical: null,
      dedup_tier: "custom_pending"
    };
  }
  let parsed = await parseAndHash(factorExpr);
  if ("error" in parsed) {
    const repaired = autoRepairFactorExpr(factorExpr);
    if (repaired !== factorExpr) {
      const repairedParsed = await parseAndHash(repaired);
      if (!("error" in repairedParsed)) {
        factorExpr = repaired;
        parsed = repairedParsed;
      }
    }
  }
  if ("error" in parsed) {
    return { error: parsed.error };
  }
  return {
    title_hash,
    expr_hash: parsed.hash,
    expr_canonical: parsed.canonical,
    dedup_tier: "builtin",
    repaired_expr: factorExpr
  };
}
__name(buildHashes, "buildHashes");
async function persistIdea(db, idea, hashes, source = "openai") {
  const ideaId = await insertIdea(db, idea, hashes, source);
  const customOps = idea.custom_ops ?? [];
  for (const op of customOps) {
    await insertPendingOperator(db, op, ideaId);
  }
  return ideaId;
}
__name(persistIdea, "persistIdea");
async function processIdeas(db, ideas, activeCustomOps, source = "openai") {
  let created = 0;
  let skipped = 0;
  const errors = [];
  const created_ids = [];
  for (const idea of ideas) {
    normalizeImportIdea(idea);
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
    if (hashes.repaired_expr && hashes.repaired_expr !== idea.factor_expr) {
      idea.factor_expr = hashes.repaired_expr;
    }
    if (await existsByHash(db, hashes.title_hash, hashes.expr_hash)) {
      skipped++;
      continue;
    }
    const ideaId = await persistIdea(db, idea, hashes, source);
    created_ids.push(ideaId);
    created++;
  }
  return { created, skipped, errors, created_ids };
}
__name(processIdeas, "processIdeas");
function normalizeImportIdeas(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: 'body must be {"ideas":[...]} or a single idea object' };
  }
  if (Array.isArray(body.ideas)) {
    if (body.ideas.length === 0) {
      return { error: "ideas array must not be empty" };
    }
    return { ideas: body.ideas, source: body.source };
  }
  if (isNonEmptyString(body.title) && isNonEmptyString(body.factor_expr)) {
    return { ideas: [body], source: body.source };
  }
  return { error: 'body must be {"ideas":[...]} or a single idea object' };
}
__name(normalizeImportIdeas, "normalizeImportIdeas");
async function runImportIdeas(env, body) {
  const normalized = normalizeImportIdeas(body);
  if ("error" in normalized) {
    throw new Error(normalized.error);
  }
  const source = isNonEmptyString(normalized.source) ? normalized.source.trim() : "manual";
  const activeOperators = await getActiveOperators(env.DB);
  const activeCustomOps = new Set(activeOperators.map((op) => op.name));
  return processIdeas(env.DB, normalized.ideas, activeCustomOps, source);
}
__name(runImportIdeas, "runImportIdeas");
function parseMaxIdeas(env, maxIdeas) {
  if (typeof maxIdeas === "number" && Number.isFinite(maxIdeas) && maxIdeas > 0) {
    return Math.floor(maxIdeas);
  }
  const fromEnv = Number(env.MAX_IDEAS ?? "3");
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 3;
}
__name(parseMaxIdeas, "parseMaxIdeas");
function buildFallbackFactorSql(signalSql, postprocess = "cs_rank") {
  return {
    version: "1",
    dialect: "duckdb-factor-v1",
    evaluation_type: postprocess === "none" ? "time_series" : "cross_sectional",
    data_source: "yhydev97/quant-data",
    signal_sql: signalSql,
    postprocess,
    universe: {
      dropna: ["open", "high", "low", "close"],
      min_symbol_bars: 168,
      cs_quantile_gte: { col: "quote_volume", q: 0.2 }
    }
  };
}
__name(buildFallbackFactorSql, "buildFallbackFactorSql");
function buildFallbackIdeas(count) {
  const nowTag = Date.now().toString().slice(-6);
  const templates = [
    {
      suffix: "VolAdjMom",
      hypothesis: "风险调整后的动量在横截面上具有持续性。",
      formula_sketch: "ret_24h / vol_24h 后做截面排序",
      expected_signal: "横截面：做多高分位，做空低分位",
      factor_expr: "CSRank(Div($ret_24h, Add($vol_24h, 1e-8)))",
      factor_sql: buildFallbackFactorSql("ret_24h / (vol_24h + 1e-8)")
    },
    {
      suffix: "TakerRatioAccel",
      hypothesis: "主动买入强度提升通常对应短期价格延续。",
      formula_sketch: "主动买入成交额占比的短长窗比值做截面排序",
      expected_signal: "横截面：做多主动买盘占比加速资产",
      factor_expr: "CSRank(Div(Mean(Div($taker_buy_quote_volume, Add($quote_volume, 1e-8)), 6), Add(Mean(Div($taker_buy_quote_volume, Add($quote_volume, 1e-8)), 24), 1e-8)))",
      factor_sql: buildFallbackFactorSql(
        "AVG(taker_buy_quote_volume / (quote_volume + 1e-8)) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 5 PRECEDING AND CURRENT ROW) / (AVG(taker_buy_quote_volume / (quote_volume + 1e-8)) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) + 1e-8)"
      )
    },
    {
      suffix: "VolumePerTradeMom",
      hypothesis: "单笔成交额上升反映资金质量提升。",
      formula_sketch: "quote_volume/count 的短窗均值与长窗均值比",
      expected_signal: "横截面：做多单笔成交额提升资产",
      factor_expr: "CSRank(Div(Mean(Div($quote_volume, Add($count, 1e-8)), 12), Add(Mean(Div($quote_volume, Add($count, 1e-8)), 48), 1e-8)))",
      factor_sql: buildFallbackFactorSql(
        "AVG(quote_volume / (count + 1e-8)) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) / (AVG(quote_volume / (count + 1e-8)) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 47 PRECEDING AND CURRENT ROW) + 1e-8)"
      )
    },
    {
      suffix: "RangeCompression",
      hypothesis: "波动收敛后更容易出现方向性突破。",
      formula_sketch: "高低振幅与近期均值比值做反向排序",
      expected_signal: "横截面：做多波动压缩资产",
      factor_expr: "CSRank(Neg(Div(Div(Sub($high, $low), Add($close, 1e-8)), Add(Mean(Div(Sub($high, $low), Add($close, 1e-8)), 24), 1e-8))))",
      factor_sql: buildFallbackFactorSql(
        "-((high - low) / (close + 1e-8)) / (AVG((high - low) / (close + 1e-8)) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) + 1e-8)"
      )
    },
    {
      suffix: "LiquidityShift",
      hypothesis: "成交额分位变化对短期收益有预测作用。",
      formula_sketch: "成交额短窗均值/长窗均值做截面排序",
      expected_signal: "横截面：做多流动性改善资产",
      factor_expr: "CSRank(Div(Mean($quote_volume, 6), Add(Mean($quote_volume, 24), 1e-8)))",
      factor_sql: buildFallbackFactorSql(
        "AVG(quote_volume) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 5 PRECEDING AND CURRENT ROW) / (AVG(quote_volume) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) + 1e-8)"
      )
    }
  ];
  const ideas = [];
  for (let i = 0; i < count; i++) {
    const base = templates[i % templates.length];
    const jitter = (i + 1) * 1e-6;
    ideas.push({
      title: `Fallback_${base.suffix}_${nowTag}_${i + 1}`,
      hypothesis: base.hypothesis,
      data_sources: ["yhydev97/quant-data"],
      formula_sketch: base.formula_sketch,
      expected_signal: base.expected_signal,
      risks: ["流动性分层", "极端行情失效", "交易成本冲击"],
      factor_expr: `Add(${base.factor_expr}, ${jitter})`,
      factor_sql: base.factor_sql
    });
  }
  return ideas;
}
__name(buildFallbackIdeas, "buildFallbackIdeas");
async function loadIdeaGenerationContext(env) {
  const [activeOperators, saturatedPatterns, datasetSection] = await Promise.all([
    getActiveOperators(env.DB),
    getSaturatedPatterns(env.DB),
    loadDatasetSection(env)
  ]);
  return { activeOperators, saturatedPatterns, datasetSection };
}
__name(loadIdeaGenerationContext, "loadIdeaGenerationContext");
async function resolveIdeaGenerationPrompt(env, maxIdeas) {
  const target = parseMaxIdeas(env, maxIdeas);
  const { activeOperators, saturatedPatterns, datasetSection } = await loadIdeaGenerationContext(env);
  const prompt = buildPrompt({
    datasetSection,
    activeOperators,
    saturatedPatterns,
    maxIdeas: target
  });
  return {
    prompt,
    max_ideas: target,
    bytes: new TextEncoder().encode(prompt).length,
    active_operators: activeOperators.length,
    saturated_patterns: saturatedPatterns.length
  };
}
__name(resolveIdeaGenerationPrompt, "resolveIdeaGenerationPrompt");
async function runGenerate(env, maxIdeas) {
  const target = parseMaxIdeas(env, maxIdeas);
  let created = 0;
  let skipped = 0;
  const errors = [];
  const { withLlmFallback } = await import("./llm-providers.js");
  const { activeOperators, saturatedPatterns, datasetSection } = await loadIdeaGenerationContext(env);
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
      const { result: ideas } = await withLlmFallback(
        env.DB,
        env,
        "idea_generation",
        async (config) => {
          const attemptTemperature =
            config.temperature ?? Math.min(0.5, 0.25 + attempt * 0.1);
          return generateIdeasFromOpenAi(
            config.api_key,
            config.model,
            attemptPrompt,
            env,
            attemptTemperature,
            config.base_url
          );
        }
      );
      const batch = await processIdeas(env.DB, ideas, activeCustomOps);
      created += batch.created;
      skipped += batch.skipped;
      errors.push(...batch.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`attempt ${attempt + 1}: ${message}`);
    }
  }
  if (created === 0) {
    const fallbackIdeas = buildFallbackIdeas(Math.min(target, 3));
    const fallbackBatch = await processIdeas(env.DB, fallbackIdeas, activeCustomOps);
    created += fallbackBatch.created;
    skipped += fallbackBatch.skipped;
    errors.push(...fallbackBatch.errors.map((item) => `fallback: ${item}`));
    if (fallbackBatch.created > 0) {
      errors.push(`fallback used: created ${fallbackBatch.created} ideas after model failures`);
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
