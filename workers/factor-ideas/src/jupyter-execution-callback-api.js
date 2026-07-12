import {
  handleJupyterExecutionCallback,
  handleJupyterExecutionHeartbeat
} from "./jupyter-execution-runtime.js";

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
  return match[1] === expected;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleJupyterExecutionCallbackApiRequest(request, env, url) {
  if (request.method !== "POST") {
    return null;
  }

  const isCallbackPath = url.pathname === "/api/jupyter-executions/callback";
  const isHeartbeatPath = url.pathname === "/api/jupyter-executions/heartbeat";
  if (!isCallbackPath && !isHeartbeatPath) {
    return null;
  }

  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await readJsonBody(request);
  if (body == null) {
    return jsonResponse({ ok: false, error: "invalid json body" }, 400);
  }

  try {
    if (isHeartbeatPath) {
      const result = await handleJupyterExecutionHeartbeat(env, body);
      const status = result.ok ? 200 : 400;
      return jsonResponse(result, status);
    }

    const result = await handleJupyterExecutionCallback(env, body);
    const status = result.ok ? 200 : 400;
    return jsonResponse(result, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
}
