import {
  parseDeploymentName,
  readPrefectApiKey,
  readPrefectApiUrl
} from "./prefect-execution-config.js";

function prefectHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Prefect API 非 JSON 响应: ${text.slice(0, 200)}`);
  }
}

export async function prefectRequest(env, path, { method = "GET", body = null } = {}) {
  const apiUrl = readPrefectApiUrl(env);
  if (!apiUrl) {
    throw new Error("缺少 PREFECT_API_URL");
  }
  const apiKey = readPrefectApiKey(env);
  const url = `${apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    method,
    headers: prefectHeaders(apiKey),
    body: body == null ? undefined : JSON.stringify(body)
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const detail =
      data?.detail != null
        ? JSON.stringify(data.detail).slice(0, 300)
        : JSON.stringify(data ?? {}).slice(0, 300);
    throw new Error(`Prefect API ${response.status}: ${detail}`);
  }
  return data;
}

export async function getPrefectDeploymentByName(env, deploymentRef) {
  const { flowName, deploymentName } = parseDeploymentName(deploymentRef);
  const encodedFlow = encodeURIComponent(flowName);
  const encodedDeployment = encodeURIComponent(deploymentName);
  return prefectRequest(
    env,
    `/api/deployments/name/${encodedFlow}/${encodedDeployment}`
  );
}

export async function createPrefectFlowRun(env, deploymentRef, parameters = {}, options = {}) {
  const deployment = await getPrefectDeploymentByName(env, deploymentRef);
  const deploymentId = deployment?.id;
  if (!deploymentId) {
    throw new Error(`Prefect deployment 未找到: ${deploymentRef}`);
  }
  const body = {
    parameters,
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {})
  };
  const result = await prefectRequest(env, `/api/deployments/${deploymentId}/create_flow_run`, {
    method: "POST",
    body
  });
  return {
    deployment_id: deploymentId,
    deployment_name: deploymentRef,
    flow_run_id: String(result?.id ?? ""),
    flow_run: result
  };
}

export async function getPrefectFlowRun(env, flowRunId) {
  const id = String(flowRunId ?? "").trim();
  if (!id) {
    throw new Error("flow_run_id required");
  }
  return prefectRequest(env, `/api/flow_runs/${id}`);
}

export async function getPrefectWorkPool(env, workPoolName) {
  const name = String(workPoolName ?? "").trim();
  if (!name) {
    throw new Error("work_pool name required");
  }
  return prefectRequest(env, `/api/work_pools/${encodeURIComponent(name)}`);
}
