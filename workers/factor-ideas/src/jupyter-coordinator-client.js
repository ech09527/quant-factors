import { coordinatorInternalToken } from "./jupyter-execution-config.js";

export function getJupyterCoordinatorStub(env, serverKey) {
  if (!env.JUPYTER_COORDINATOR) {
    throw new Error("JUPYTER_COORDINATOR binding 未配置");
  }
  const name = String(serverKey ?? "").trim() || "default";
  const id = env.JUPYTER_COORDINATOR.idFromName(name);
  return env.JUPYTER_COORDINATOR.get(id);
}

function internalHeaders(env, extra = {}) {
  const token = coordinatorInternalToken(env);
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Coordinator-Token": token } : {}),
    ...extra
  };
}

async function parseCoordinatorResponse(response) {
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const message = json?.error || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json ?? { ok: true };
}

export async function coordinatorEnqueue(env, serverKey, executionId) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/enqueue", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify({ execution_id: String(executionId) })
  });
  return parseCoordinatorResponse(response);
}

export async function coordinatorReport(env, serverKey, body) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/report", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify(body ?? {})
  });
  return parseCoordinatorResponse(response);
}

export async function coordinatorTick(env, serverKey) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/tick", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify({})
  });
  return parseCoordinatorResponse(response);
}

export async function coordinatorReconcile(env, serverKey, body = {}) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/reconcile", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify(body ?? {})
  });
  return parseCoordinatorResponse(response);
}

export async function coordinatorSubmitOne(env, serverKey, executionId) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/submit", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify({ execution_id: String(executionId) })
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: text.slice(0, 500) };
    }
  }
  if (response.status === 429 || json?.reason === "capacity_full") {
    return { ok: false, ...(json ?? {}), reason: json?.reason ?? "capacity_full" };
  }
  if (response.status === 503 || json?.reason === "kernel_list_failed") {
    return { ok: false, ...(json ?? {}), reason: json?.reason ?? "kernel_list_failed" };
  }
  if (!response.ok) {
    const message = json?.error || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json ?? { ok: true };
}

export async function coordinatorFill(env, serverKey) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/fill", {
    method: "POST",
    headers: internalHeaders(env),
    body: JSON.stringify({})
  });
  return parseCoordinatorResponse(response);
}

export async function coordinatorGetStatus(env, serverKey) {
  const stub = getJupyterCoordinatorStub(env, serverKey);
  const response = await stub.fetch("https://coordinator/status", {
    method: "GET",
    headers: internalHeaders(env)
  });
  return parseCoordinatorResponse(response);
}
