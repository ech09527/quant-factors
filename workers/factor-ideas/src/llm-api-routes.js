import {
  LLM_USAGE_KEYS,
  createLlmProvider,
  createProviderModel,
  createUsageRoute,
  deleteLlmProvider,
  deleteProviderModel,
  deleteUsageRoute,
  getLlmProviderByKey,
  listLlmProviders,
  listProviderModels,
  listUsageRoutes,
  resolveLlmUsageRouteConfigs,
  updateLlmProvider,
  updateProviderModel,
  updateUsageRoute,
} from "./llm-providers.js";

function corsOrigin(env, request) {
  const configured = env.API_CORS_ORIGIN?.trim();
  if (configured) {
    return configured;
  }
  const origin = request.headers.get("Origin");
  return origin ?? "*";
}

function withCors(response, env, request) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", corsOrigin(env, request));
  headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function wrap(env, request, response) {
  return withCors(response, env, request);
}

function badRequest(message) {
  return jsonResponse({ ok: false, error: message }, 400);
}

function notFound(message) {
  return jsonResponse({ ok: false, error: message }, 404);
}

function conflict(message) {
  return jsonResponse({ ok: false, error: message }, 409);
}

function unauthorized() {
  return jsonResponse({ ok: false, error: "unauthorized" }, 401);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isAuthorized(request, env) {
  const expected = env.AUTH_PASSWORD?.trim();
  if (!expected) {
    return false;
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return timingSafeEqual(match[1], expected);
}

async function parseJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

const USAGE_LABELS = {
  [LLM_USAGE_KEYS.IDEA_GENERATION]: "因子想法生成",
  [LLM_USAGE_KEYS.VALIDATION_TRANSLATION]: "验证 SQL 翻译",
  [LLM_USAGE_KEYS.NEUTRALIZATION_SELECTION]: "中性化暴露选择",
};

function flattenWorkflowConfig(usage, routes) {
  const first = routes[0] ?? null;
  return {
    usage,
    routes,
    route_id: first?.route_id ?? null,
    provider_key: first?.provider_key ?? null,
    base_url: first?.base_url ?? null,
    api_key: first?.api_key ?? null,
    model: first?.model ?? null,
    auth_header: first?.auth_header ?? null,
    auth_scheme: first?.auth_scheme ?? null,
    temperature: first?.temperature ?? null,
    priority: first?.priority ?? null,
    source: first?.source ?? null,
  };
}

export async function handleLlmApiRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (!pathname.startsWith("/api/llm-") && pathname !== "/api/workflow/llm-config") {
    return null;
  }

  if (method === "OPTIONS") {
    return wrap(env, request, new Response(null, { status: 204 }));
  }

  if (!isAuthorized(request, env)) {
    return wrap(env, request, unauthorized());
  }

  if (pathname === "/api/workflow/llm-config" && method === "GET") {
    const usage = url.searchParams.get("usage")?.trim() || LLM_USAGE_KEYS.VALIDATION_TRANSLATION;
    try {
      const routes = await resolveLlmUsageRouteConfigs(env.DB, env, usage);
      return wrap(env, request, jsonResponse(flattenWorkflowConfig(usage, routes)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return wrap(env, request, badRequest(message));
    }
  }

  if (pathname === "/api/llm-providers" && method === "GET") {
    const includeDisabled =
      url.searchParams.get("include_disabled") === "1" ||
      url.searchParams.get("include_disabled")?.toLowerCase() === "true";
    const data = await listLlmProviders(env.DB, { includeDisabled });
    return wrap(env, request, jsonResponse(data));
  }

  if (pathname === "/api/llm-usage-routes" && method === "GET") {
    const usageKey = url.searchParams.get("usage_key")?.trim() || undefined;
    const includeDisabled =
      url.searchParams.get("include_disabled") === "1" ||
      url.searchParams.get("include_disabled")?.toLowerCase() === "true";
    const data = await listUsageRoutes(env.DB, { usageKey, includeDisabled });
    const items = data.items.map((item) => ({
      ...item,
      usage_label: USAGE_LABELS[item.usage_key] ?? item.usage_key,
    }));
    return wrap(env, request, jsonResponse({ items, total: items.length }));
  }

  const providerMatch = pathname.match(/^\/api\/llm-providers\/([a-z][a-z0-9_-]*)$/);
  const providerModelsMatch = pathname.match(
    /^\/api\/llm-providers\/([a-z][a-z0-9_-]*)\/models$/,
  );
  const providerModelMatch = pathname.match(
    /^\/api\/llm-providers\/([a-z][a-z0-9_-]*)\/models\/(.+)$/,
  );
  const routeMatch = pathname.match(/^\/api\/llm-usage-routes\/(\d+)$/);

  if (providerModelsMatch && method === "GET") {
    const providerKey = providerModelsMatch[1];
    const includeDisabled =
      url.searchParams.get("include_disabled") === "1" ||
      url.searchParams.get("include_disabled")?.toLowerCase() === "true";
    try {
      const data = await listProviderModels(env.DB, providerKey, { includeDisabled });
      return wrap(env, request, jsonResponse(data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerModelsMatch && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await createProviderModel(env.DB, providerModelsMatch[1], {
        model_name: String(body.model_name ?? ""),
        sort_order: body.sort_order == null ? 0 : Number(body.sort_order),
        enabled: body.enabled !== false,
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("已存在")) {
        return wrap(env, request, conflict(message));
      }
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerModelMatch && method === "PATCH") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    const providerKey = providerModelMatch[1];
    const modelName = decodeURIComponent(providerModelMatch[2]);
    try {
      const item = await updateProviderModel(env.DB, providerKey, modelName, {
        model_name: body.model_name == null ? undefined : String(body.model_name),
        sort_order: body.sort_order == null ? undefined : Number(body.sort_order),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      if (message.includes("已存在")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerModelMatch && method === "DELETE") {
    const providerKey = providerModelMatch[1];
    const modelName = decodeURIComponent(providerModelMatch[2]);
    try {
      const result = await deleteProviderModel(env.DB, providerKey, modelName);
      return wrap(env, request, jsonResponse(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      if (message.includes("仍被用途路由引用")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerMatch && method === "GET") {
    const item = await getLlmProviderByKey(env.DB, providerMatch[1]);
    if (!item) {
      return wrap(env, request, notFound("llm provider not found"));
    }
    const models = await listProviderModels(env.DB, providerMatch[1], { includeDisabled: true });
    return wrap(env, request, jsonResponse({ item, models: models.items }));
  }

  if (pathname === "/api/llm-usage-routes" && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await createUsageRoute(env.DB, {
        usage_key: String(body.usage_key ?? ""),
        provider_key: String(body.provider_key ?? ""),
        model_name: String(body.model_name ?? ""),
        priority: body.priority == null ? 0 : Number(body.priority),
        temperature: body.temperature,
        enabled: body.enabled !== false,
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") || message.includes("已存在")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (routeMatch && method === "PATCH") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await updateUsageRoute(env.DB, Number(routeMatch[1]), {
        provider_key: body.provider_key == null ? undefined : String(body.provider_key),
        model_name: body.model_name == null ? undefined : String(body.model_name),
        priority: body.priority == null ? undefined : Number(body.priority),
        temperature: body.temperature,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (routeMatch && method === "DELETE") {
    try {
      const result = await deleteUsageRoute(env.DB, Number(routeMatch[1]));
      return wrap(env, request, jsonResponse(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (pathname === "/api/llm-providers" && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const models = Array.isArray(body.models)
        ? body.models.map(String)
        : body.default_model
          ? [String(body.default_model)]
          : [];
      const item = await createLlmProvider(env.DB, {
        key: String(body.key ?? ""),
        name: String(body.name ?? ""),
        base_url: String(body.base_url ?? ""),
        api_key: String(body.api_key ?? ""),
        models,
        auth_header: body.auth_header == null ? undefined : String(body.auth_header),
        auth_scheme: body.auth_scheme == null ? undefined : String(body.auth_scheme),
        sort_order: body.sort_order == null ? 0 : Number(body.sort_order),
        enabled: body.enabled !== false,
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("已存在")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerMatch && method === "PATCH") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid json body"));
    }
    try {
      const item = await updateLlmProvider(env.DB, providerMatch[1], {
        name: body.name == null ? undefined : String(body.name),
        base_url: body.base_url == null ? undefined : String(body.base_url),
        api_key: body.api_key == null ? undefined : String(body.api_key),
        auth_header: body.auth_header == null ? undefined : String(body.auth_header),
        auth_scheme: body.auth_scheme == null ? undefined : String(body.auth_scheme),
        sort_order: body.sort_order == null ? undefined : Number(body.sort_order),
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      return wrap(env, request, jsonResponse({ item }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  if (providerMatch && method === "DELETE") {
    try {
      const result = await deleteLlmProvider(env.DB, providerMatch[1]);
      return wrap(env, request, jsonResponse(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不存在")) {
        return wrap(env, request, notFound(message));
      }
      if (message.includes("仍被用途路由引用")) {
        return wrap(env, request, conflict(message));
      }
      return wrap(env, request, badRequest(message));
    }
  }

  return wrap(env, request, jsonResponse({ ok: false, error: "method not allowed" }, 405));
}
