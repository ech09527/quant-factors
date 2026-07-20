const WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0";

export const LLM_USAGE_KEYS = {
  IDEA_GENERATION: "idea_generation",
  VALIDATION_TRANSLATION: "validation_translation",
  NEUTRALIZATION_SELECTION: "neutralization_selection",
};

const VALID_USAGE_KEYS = new Set(Object.values(LLM_USAGE_KEYS));

const DEFAULT_TEMPERATURE = {
  [LLM_USAGE_KEYS.IDEA_GENERATION]: null,
  [LLM_USAGE_KEYS.VALIDATION_TRANSLATION]: 0.1,
  [LLM_USAGE_KEYS.NEUTRALIZATION_SELECTION]: 0.1,
};

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

export function chatCompletionsUrl(baseUrl) {
  const base = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function validateKey(key) {
  if (!KEY_PATTERN.test(key)) {
    return "key 须为小写字母开头，仅含小写字母、数字、下划线、连字符";
  }
  return null;
}

function validateModelName(modelName) {
  const name = String(modelName ?? "").trim();
  if (!name) {
    return "model_name 不能为空";
  }
  if (name.length > 128) {
    return "model_name 过长";
  }
  return null;
}

function validateProviderFields(input) {
  if (input.name !== undefined && !String(input.name).trim()) {
    return "name 不能为空";
  }
  if (input.base_url !== undefined && !String(input.base_url).trim()) {
    return "base_url 不能为空";
  }
  if (input.api_key !== undefined && !String(input.api_key).trim()) {
    return "api_key 不能为空";
  }
  return null;
}

function rowToProvider(row) {
  return {
    key: String(row.key),
    name: String(row.name),
    base_url: String(row.base_url),
    api_key: String(row.api_key),
    auth_header: String(row.auth_header ?? "Authorization"),
    auth_scheme: String(row.auth_scheme ?? "Bearer"),
    enabled: Number(row.enabled ?? 1) === 1,
    sort_order: Number(row.sort_order ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToModel(row) {
  return {
    id: Number(row.id),
    provider_key: String(row.provider_key),
    model_name: String(row.model_name),
    enabled: Number(row.enabled ?? 1) === 1,
    sort_order: Number(row.sort_order ?? 0),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToRoute(row) {
  return {
    id: Number(row.id),
    usage_key: String(row.usage_key),
    provider_key: String(row.provider_key),
    model_name: String(row.model_name),
    priority: Number(row.priority ?? 0),
    temperature: row.temperature == null ? null : Number(row.temperature),
    enabled: Number(row.enabled ?? 1) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function buildAuthHeader(config) {
  const header = config.auth_header || "Authorization";
  const scheme = (config.auth_scheme || "Bearer").trim();
  const token = config.api_key;
  if (scheme.toLowerCase() === "bearer") {
    return { [header]: `Bearer ${token}` };
  }
  if (scheme.toLowerCase() === "token") {
    return { [header]: `token ${token}` };
  }
  return { [header]: `${scheme} ${token}` };
}

function buildUsageConfig(provider, route) {
  const usageKey = route.usage_key;
  const temperature =
    route.temperature ??
    DEFAULT_TEMPERATURE[usageKey] ??
    (usageKey === LLM_USAGE_KEYS.IDEA_GENERATION ? 0.2 : 0.1);
  return {
    route_id: route.id,
    usage_key: usageKey,
    provider_key: provider.key,
    base_url: provider.base_url,
    api_key: provider.api_key,
    model: route.model_name,
    auth_header: provider.auth_header,
    auth_scheme: provider.auth_scheme,
    temperature,
    priority: route.priority,
    source: "d1",
  };
}

function resolveFromEnv(env, usageKey) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const isIdea = usageKey === LLM_USAGE_KEYS.IDEA_GENERATION;
  return {
    route_id: null,
    usage_key: usageKey,
    provider_key: null,
    base_url: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    api_key: apiKey,
    model: isIdea
      ? env.IDEA_OPENAI_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-4o-mini"
      : env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    auth_header: "Authorization",
    auth_scheme: "Bearer",
    temperature: DEFAULT_TEMPERATURE[usageKey] ?? 0.2,
    priority: 0,
    source: "env",
  };
}

export async function getLlmProviderByKey(db, key, options = {}) {
  const row = await db
    .prepare(
      `SELECT key, name, base_url, api_key, auth_header, auth_scheme,
              enabled, sort_order, last_used_at, created_at, updated_at
         FROM llm_providers
         WHERE key = ?
         LIMIT 1`,
    )
    .bind(key)
    .first();
  if (!row) {
    return null;
  }
  const provider = rowToProvider(row);
  if (options.requireEnabled && !provider.enabled) {
    return null;
  }
  return provider;
}

export async function listLlmProviders(db, options = {}) {
  const where = options.includeDisabled ? "" : "WHERE enabled = 1";
  const result = await db
    .prepare(
      `SELECT key, name, base_url, api_key, auth_header, auth_scheme,
              enabled, sort_order, last_used_at, created_at, updated_at
         FROM llm_providers
         ${where}
         ORDER BY sort_order ASC, key ASC`,
    )
    .all();
  const items = (result.results ?? []).map(rowToProvider);
  return { items, total: items.length };
}

export async function createLlmProvider(db, input) {
  const key = input.key.trim();
  const keyError = validateKey(key);
  if (keyError) {
    throw new Error(keyError);
  }
  const fieldError = validateProviderFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const existing = await getLlmProviderByKey(db, key);
  if (existing) {
    throw new Error(`LLM Provider 已存在: ${key}`);
  }
  await db
    .prepare(
      `INSERT INTO llm_providers
         (key, name, base_url, api_key, default_model, auth_header, auth_scheme, enabled, sort_order)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    )
    .bind(
      key,
      input.name.trim(),
      input.base_url.trim().replace(/\/$/, ""),
      input.api_key.trim(),
      String(input.auth_header ?? "Authorization").trim() || "Authorization",
      String(input.auth_scheme ?? "Bearer").trim() || "Bearer",
      input.enabled === false ? 0 : 1,
      Math.floor(input.sort_order ?? 0),
    )
    .run();

  const models = Array.isArray(input.models)
    ? input.models.map((item) => String(item).trim()).filter(Boolean)
    : input.default_model
      ? [String(input.default_model).trim()].filter(Boolean)
      : [];
  for (let index = 0; index < models.length; index += 1) {
    await createProviderModel(db, key, {
      model_name: models[index],
      sort_order: index,
      enabled: true,
    });
  }

  const created = await getLlmProviderByKey(db, key);
  if (!created) {
    throw new Error("创建 LLM Provider 失败");
  }

  const routes = await listUsageRoutes(db, { includeDisabled: true });
  if (routes.total === 0 && models.length > 0) {
    await createUsageRoute(db, {
      usage_key: LLM_USAGE_KEYS.IDEA_GENERATION,
      provider_key: key,
      model_name: models[0],
      priority: 0,
      temperature: 0.2,
      enabled: true,
    });
    await createUsageRoute(db, {
      usage_key: LLM_USAGE_KEYS.VALIDATION_TRANSLATION,
      provider_key: key,
      model_name: models[0],
      priority: 0,
      temperature: 0.1,
      enabled: true,
    });
    await createUsageRoute(db, {
      usage_key: LLM_USAGE_KEYS.NEUTRALIZATION_SELECTION,
      provider_key: key,
      model_name: models[0],
      priority: 0,
      temperature: 0.1,
      enabled: true,
    });
  }
  return created;
}

export async function updateLlmProvider(db, key, input) {
  const existing = await getLlmProviderByKey(db, key);
  if (!existing) {
    throw new Error("LLM Provider 不存在");
  }
  const fieldError = validateProviderFields(input);
  if (fieldError) {
    throw new Error(fieldError);
  }
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const base_url =
    input.base_url !== undefined ? input.base_url.trim().replace(/\/$/, "") : existing.base_url;
  const api_key = input.api_key !== undefined ? input.api_key.trim() : existing.api_key;
  const auth_header =
    input.auth_header !== undefined
      ? String(input.auth_header).trim() || "Authorization"
      : existing.auth_header;
  const auth_scheme =
    input.auth_scheme !== undefined
      ? String(input.auth_scheme).trim() || "Bearer"
      : existing.auth_scheme;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
  const sort_order = input.sort_order !== undefined ? Math.floor(input.sort_order) : existing.sort_order;

  await db
    .prepare(
      `UPDATE llm_providers
         SET name = ?, base_url = ?, api_key = ?,
             auth_header = ?, auth_scheme = ?, enabled = ?, sort_order = ?,
             updated_at = datetime('now')
         WHERE key = ?`,
    )
    .bind(name, base_url, api_key, auth_header, auth_scheme, enabled, sort_order, key)
    .run();

  const updated = await getLlmProviderByKey(db, key);
  if (!updated) {
    throw new Error("更新 LLM Provider 失败");
  }
  return updated;
}

export async function deleteLlmProvider(db, key) {
  const existing = await getLlmProviderByKey(db, key);
  if (!existing) {
    throw new Error("LLM Provider 不存在");
  }
  const route = await db
    .prepare("SELECT id FROM llm_usage_routes WHERE provider_key = ? LIMIT 1")
    .bind(key)
    .first();
  if (route) {
    throw new Error(`Provider 仍被用途路由引用，请先删除相关路由`);
  }
  await db.prepare("DELETE FROM llm_provider_models WHERE provider_key = ?").bind(key).run();
  await db.prepare("DELETE FROM llm_providers WHERE key = ?").bind(key).run();
  return { deleted: true, key };
}

export async function listProviderModels(db, providerKey, options = {}) {
  const provider = await getLlmProviderByKey(db, providerKey);
  if (!provider) {
    throw new Error("LLM Provider 不存在");
  }
  const where = options.includeDisabled ? "provider_key = ?" : "provider_key = ? AND enabled = 1";
  const result = await db
    .prepare(
      `SELECT id, provider_key, model_name, enabled, sort_order, last_used_at, created_at, updated_at
         FROM llm_provider_models
         WHERE ${where}
         ORDER BY sort_order ASC, model_name ASC`,
    )
    .bind(providerKey)
    .all();
  const items = (result.results ?? []).map(rowToModel);
  return { items, total: items.length };
}

export async function getProviderModel(db, providerKey, modelName, options = {}) {
  const row = await db
    .prepare(
      `SELECT id, provider_key, model_name, enabled, sort_order, last_used_at, created_at, updated_at
         FROM llm_provider_models
         WHERE provider_key = ? AND model_name = ?
         LIMIT 1`,
    )
    .bind(providerKey, modelName)
    .first();
  if (!row) {
    return null;
  }
  const model = rowToModel(row);
  if (options.requireEnabled && !model.enabled) {
    return null;
  }
  return model;
}

export async function createProviderModel(db, providerKey, input) {
  const provider = await getLlmProviderByKey(db, providerKey);
  if (!provider) {
    throw new Error("LLM Provider 不存在");
  }
  const modelName = String(input.model_name ?? "").trim();
  const modelError = validateModelName(modelName);
  if (modelError) {
    throw new Error(modelError);
  }
  const existing = await getProviderModel(db, providerKey, modelName);
  if (existing) {
    throw new Error(`模型已存在: ${modelName}`);
  }
  await db
    .prepare(
      `INSERT INTO llm_provider_models (provider_key, model_name, enabled, sort_order)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      providerKey,
      modelName,
      input.enabled === false ? 0 : 1,
      Math.floor(input.sort_order ?? 0),
    )
    .run();
  const created = await getProviderModel(db, providerKey, modelName);
  if (!created) {
    throw new Error("创建模型失败");
  }
  return created;
}

export async function updateProviderModel(db, providerKey, modelName, input) {
  const existing = await getProviderModel(db, providerKey, modelName);
  if (!existing) {
    throw new Error("模型不存在");
  }
  const nextName =
    input.model_name !== undefined ? String(input.model_name).trim() : existing.model_name;
  const modelError = validateModelName(nextName);
  if (modelError) {
    throw new Error(modelError);
  }
  if (nextName !== existing.model_name) {
    const duplicate = await getProviderModel(db, providerKey, nextName);
    if (duplicate) {
      throw new Error(`模型已存在: ${nextName}`);
    }
    await db
      .prepare(
        `UPDATE llm_usage_routes
           SET model_name = ?, updated_at = datetime('now')
           WHERE provider_key = ? AND model_name = ?`,
      )
      .bind(nextName, providerKey, existing.model_name)
      .run();
  }
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled ? 1 : 0;
  const sort_order = input.sort_order !== undefined ? Math.floor(input.sort_order) : existing.sort_order;
  await db
    .prepare(
      `UPDATE llm_provider_models
         SET model_name = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
         WHERE provider_key = ? AND model_name = ?`,
    )
    .bind(nextName, enabled, sort_order, providerKey, existing.model_name)
    .run();
  return getProviderModel(db, providerKey, nextName);
}

export async function deleteProviderModel(db, providerKey, modelName) {
  const existing = await getProviderModel(db, providerKey, modelName);
  if (!existing) {
    throw new Error("模型不存在");
  }
  const route = await db
    .prepare(
      `SELECT id FROM llm_usage_routes
         WHERE provider_key = ? AND model_name = ?
         LIMIT 1`,
    )
    .bind(providerKey, modelName)
    .first();
  if (route) {
    throw new Error("模型仍被用途路由引用，请先删除相关路由");
  }
  await db
    .prepare("DELETE FROM llm_provider_models WHERE provider_key = ? AND model_name = ?")
    .bind(providerKey, modelName)
    .run();
  return { deleted: true, provider_key: providerKey, model_name: modelName };
}

export async function listUsageRoutes(db, options = {}) {
  const clauses = [];
  const binds = [];
  if (options.usageKey) {
    clauses.push("r.usage_key = ?");
    binds.push(options.usageKey);
  }
  if (!options.includeDisabled) {
    clauses.push("r.enabled = 1");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT r.id, r.usage_key, r.provider_key, r.model_name, r.priority, r.temperature,
              r.enabled, r.created_at, r.updated_at,
              p.name AS provider_name, p.enabled AS provider_enabled,
              m.enabled AS model_enabled
         FROM llm_usage_routes r
         LEFT JOIN llm_providers p ON p.key = r.provider_key
         LEFT JOIN llm_provider_models m ON m.provider_key = r.provider_key AND m.model_name = r.model_name
         ${where}
         ORDER BY r.usage_key ASC, r.priority ASC, r.id ASC`,
    )
    .bind(...binds)
    .all();
  const items = (result.results ?? []).map((row) => ({
    ...rowToRoute(row),
    provider_name: row.provider_name == null ? null : String(row.provider_name),
    provider_enabled: row.provider_enabled == null ? null : Number(row.provider_enabled) === 1,
    model_enabled: row.model_enabled == null ? null : Number(row.model_enabled) === 1,
  }));
  return { items, total: items.length };
}

export async function createUsageRoute(db, input) {
  const usageKey = String(input.usage_key ?? "").trim();
  if (!VALID_USAGE_KEYS.has(usageKey)) {
    throw new Error(`无效的 usage_key: ${usageKey}`);
  }
  const providerKey = String(input.provider_key ?? "").trim();
  const modelName = String(input.model_name ?? "").trim();
  if (!providerKey) {
    throw new Error("provider_key 不能为空");
  }
  const modelError = validateModelName(modelName);
  if (modelError) {
    throw new Error(modelError);
  }
  const provider = await getLlmProviderByKey(db, providerKey);
  if (!provider) {
    throw new Error(`LLM Provider 不存在: ${providerKey}`);
  }
  const model = await getProviderModel(db, providerKey, modelName);
  if (!model) {
    throw new Error(`模型不存在: ${providerKey}/${modelName}`);
  }
  const temperature =
    input.temperature === undefined || input.temperature === null
      ? null
      : Number(input.temperature);
  const result = await db
    .prepare(
      `INSERT INTO llm_usage_routes (usage_key, provider_key, model_name, priority, temperature, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      usageKey,
      providerKey,
      modelName,
      Math.floor(input.priority ?? 0),
      temperature,
      input.enabled === false ? 0 : 1,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  const row = await db
    .prepare(
      `SELECT id, usage_key, provider_key, model_name, priority, temperature, enabled, created_at, updated_at
         FROM llm_usage_routes WHERE id = ?`,
    )
    .bind(id)
    .first();
  return rowToRoute(row);
}

export async function updateUsageRoute(db, id, input) {
  const existing = await db
    .prepare(
      `SELECT id, usage_key, provider_key, model_name, priority, temperature, enabled, created_at, updated_at
         FROM llm_usage_routes WHERE id = ?`,
    )
    .bind(id)
    .first();
  if (!existing) {
    throw new Error("用途路由不存在");
  }
  const route = rowToRoute(existing);
  const providerKey =
    input.provider_key !== undefined ? String(input.provider_key).trim() : route.provider_key;
  const modelName =
    input.model_name !== undefined ? String(input.model_name).trim() : route.model_name;
  const modelError = validateModelName(modelName);
  if (modelError) {
    throw new Error(modelError);
  }
  const provider = await getLlmProviderByKey(db, providerKey);
  if (!provider) {
    throw new Error(`LLM Provider 不存在: ${providerKey}`);
  }
  const model = await getProviderModel(db, providerKey, modelName);
  if (!model) {
    throw new Error(`模型不存在: ${providerKey}/${modelName}`);
  }
  const priority = input.priority !== undefined ? Math.floor(input.priority) : route.priority;
  const temperature =
    input.temperature === undefined
      ? route.temperature
      : input.temperature === null
        ? null
        : Number(input.temperature);
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : route.enabled ? 1 : 0;
  await db
    .prepare(
      `UPDATE llm_usage_routes
         SET provider_key = ?, model_name = ?, priority = ?, temperature = ?, enabled = ?,
             updated_at = datetime('now')
         WHERE id = ?`,
    )
    .bind(providerKey, modelName, priority, temperature, enabled, id)
    .run();
  const row = await db
    .prepare(
      `SELECT id, usage_key, provider_key, model_name, priority, temperature, enabled, created_at, updated_at
         FROM llm_usage_routes WHERE id = ?`,
    )
    .bind(id)
    .first();
  return rowToRoute(row);
}

export async function deleteUsageRoute(db, id) {
  const existing = await db
    .prepare("SELECT id FROM llm_usage_routes WHERE id = ?")
    .bind(id)
    .first();
  if (!existing) {
    throw new Error("用途路由不存在");
  }
  await db.prepare("DELETE FROM llm_usage_routes WHERE id = ?").bind(id).run();
  return { deleted: true, id };
}

async function listResolvableRoutes(db, usageKey) {
  const result = await db
    .prepare(
      `SELECT r.id, r.usage_key, r.provider_key, r.model_name, r.priority, r.temperature,
              r.enabled, r.created_at, r.updated_at
         FROM llm_usage_routes r
         JOIN llm_providers p ON p.key = r.provider_key AND p.enabled = 1
         JOIN llm_provider_models m ON m.provider_key = r.provider_key AND m.model_name = r.model_name AND m.enabled = 1
         WHERE r.usage_key = ? AND r.enabled = 1
         ORDER BY r.priority ASC, r.id ASC`,
    )
    .bind(usageKey)
    .all();
  return (result.results ?? []).map(rowToRoute);
}

export async function resolveLlmUsageRouteConfigs(db, env, usageKey) {
  if (!VALID_USAGE_KEYS.has(usageKey)) {
    throw new Error(`无效的 usage_key: ${usageKey}`);
  }
  const routes = await listResolvableRoutes(db, usageKey);
  const configs = [];
  for (const route of routes) {
    const provider = await getLlmProviderByKey(db, route.provider_key, { requireEnabled: true });
    if (!provider) {
      continue;
    }
    configs.push(buildUsageConfig(provider, route));
  }
  if (configs.length === 0) {
    const fromEnv = resolveFromEnv(env, usageKey);
    if (fromEnv) {
      return [fromEnv];
    }
    throw new Error(
      "未配置 LLM：请添加 Provider/模型/用途路由，或设置 OPENAI_API_KEY 环境变量",
    );
  }
  return configs;
}

/** @deprecated 使用 resolveLlmUsageRouteConfigs / withLlmFallback */
export async function resolveLlmUsage(db, env, usageKey) {
  const configs = await resolveLlmUsageRouteConfigs(db, env, usageKey);
  return configs[0];
}

export async function withLlmFallback(db, env, usageKey, callback) {
  const configs = await resolveLlmUsageRouteConfigs(db, env, usageKey);
  let lastError = null;
  for (const config of configs) {
    try {
      const result = await callback(config);
      if (config.provider_key) {
        await markLlmProviderUsed(db, config.provider_key);
        await markLlmModelUsed(db, config.provider_key, config.model);
      }
      return { result, config };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "所有 LLM 路由均失败"));
}

export async function markLlmProviderUsed(db, key) {
  const result = await db
    .prepare(
      `UPDATE llm_providers
         SET last_used_at = datetime('now'), updated_at = datetime('now')
         WHERE key = ?`,
    )
    .bind(key)
    .run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function markLlmModelUsed(db, providerKey, modelName) {
  const result = await db
    .prepare(
      `UPDATE llm_provider_models
         SET last_used_at = datetime('now'), updated_at = datetime('now')
         WHERE provider_key = ? AND model_name = ?`,
    )
    .bind(providerKey, modelName)
    .run();
  return { updated: Number(result.meta.changes ?? 0) };
}

export async function chatCompletion(config, messages, options = {}) {
  const response = await fetch(chatCompletionsUrl(config.base_url), {
    method: "POST",
    headers: {
      ...buildAuthHeader(config),
      "Content-Type": "application/json",
      "User-Agent": options.userAgent || WORKFLOW_HTTP_USER_AGENT,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: options.temperature ?? config.temperature ?? 0.2,
      messages,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`模型接口失败 HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`模型接口返回非 JSON: ${raw.slice(0, 200)}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error("模型接口返回空 content");
  }
  return String(content);
}

export async function chatCompletionWithFallback(db, env, usageKey, messages, options = {}) {
  const { result } = await withLlmFallback(db, env, usageKey, async (config) =>
    chatCompletion(config, messages, {
      ...options,
      temperature: options.temperature ?? config.temperature,
    }),
  );
  return result;
}
