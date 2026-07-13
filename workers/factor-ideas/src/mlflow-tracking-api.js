import {
  createMlflowTrackingConfig,
  deleteMlflowTrackingConfig,
  getMlflowTrackingConfigByKey,
  listMlflowTrackingConfigs,
  resolveActiveMlflowConfig,
  backfillSuccessfulMlTasksMlflowTracking,
  updateMlflowTrackingConfig
} from "./mlflow-tracking-config-db.js";

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
    headers
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
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

function activeConfigSummary(config) {
  if (!config) {
    return {
      configured: false,
      source: null,
      key: null,
      tracking_uri: null,
      username: null,
      experiment: null
    };
  }
  return {
    configured: Boolean(config.tracking_uri && config.username && config.password),
    source: config.source ?? null,
    key: config.key ?? null,
    tracking_uri: config.tracking_uri ?? null,
    username: config.username ?? null,
    experiment: config.experiment ?? null
  };
}

export async function handleMlflowTrackingApiRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (
    !pathname.startsWith("/api/mlflow-tracking-configs") &&
    !pathname.startsWith("/api/workflow/mlflow-config")
  ) {
    return null;
  }

  if (method === "OPTIONS") {
    return wrap(env, request, new Response(null, { status: 204 }));
  }

  if (!isAuthorized(request, env)) {
    return wrap(env, request, unauthorized());
  }

  if (pathname === "/api/workflow/mlflow-config" && method === "GET") {
    const active = await resolveActiveMlflowConfig(env.DB, env);
    return wrap(
      env,
      request,
      jsonResponse({ ok: true, active: activeConfigSummary(active) })
    );
  }

  if (pathname === "/api/workflow/mlflow-config/backfill" && method === "POST") {
    try {
      const data = await backfillSuccessfulMlTasksMlflowTracking(env.DB, env);
      return wrap(env, request, jsonResponse({ ok: true, ...data }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return wrap(env, request, badRequest(message));
    }
  }

  if (pathname === "/api/mlflow-tracking-configs" && method === "GET") {
    const includeDisabled =
      url.searchParams.get("include_disabled") !== "0" &&
      url.searchParams.get("include_disabled")?.toLowerCase() !== "false";
    const data = await listMlflowTrackingConfigs(env.DB, { includeDisabled });
    return wrap(env, request, jsonResponse({ ok: true, ...data }));
  }

  if (pathname === "/api/mlflow-tracking-configs" && method === "POST") {
    const body = await parseJsonBody(request);
    if (!body) {
      return wrap(env, request, badRequest("invalid JSON body"));
    }
    try {
      const item = await createMlflowTrackingConfig(env.DB, body);
      return wrap(env, request, jsonResponse({ ok: true, item }, 201));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return wrap(env, request, badRequest(message));
    }
  }

  const keyMatch = pathname.match(/^\/api\/mlflow-tracking-configs\/([a-z][a-z0-9_-]*)$/);
  if (keyMatch) {
    const key = keyMatch[1];
    if (method === "GET") {
      const item = await getMlflowTrackingConfigByKey(env.DB, key, { includeSecret: false });
      if (!item) {
        return wrap(env, request, notFound("mlflow tracking config not found"));
      }
      return wrap(env, request, jsonResponse({ ok: true, item }));
    }
    if (method === "PATCH") {
      const body = await parseJsonBody(request);
      if (!body) {
        return wrap(env, request, badRequest("invalid JSON body"));
      }
      try {
        const item = await updateMlflowTrackingConfig(env.DB, key, body);
        if (!item) {
          return wrap(env, request, notFound("mlflow tracking config not found"));
        }
        return wrap(env, request, jsonResponse({ ok: true, item }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return wrap(env, request, badRequest(message));
      }
    }
    if (method === "DELETE") {
      const deleted = await deleteMlflowTrackingConfig(env.DB, key);
      if (!deleted) {
        return wrap(env, request, notFound("mlflow tracking config not found"));
      }
      return wrap(env, request, jsonResponse({ ok: true, deleted: true }));
    }
  }

  return wrap(env, request, jsonResponse({ ok: false, error: "not found" }, 404));
}
