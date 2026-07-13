const PREFECT_FLOW_RUN_STATUSES = new Set([
  "scheduled",
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "crashed"
]);

const PREFECT_ACTIVE_STATUSES = new Set(["scheduled", "pending", "running"]);

export function prefectExecutionEnabled(env) {
  const backend = String(env?.EXECUTION_BACKEND ?? "").trim().toLowerCase();
  if (backend === "prefect") {
    return true;
  }
  if (backend === "jupyter") {
    return false;
  }
  const flag = String(env?.PREFECT_EXECUTION_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

export function readPrefectApiUrl(env) {
  return String(env?.PREFECT_API_URL ?? "").trim().replace(/\/$/, "");
}

export function readPrefectApiKey(env) {
  return String(env?.PREFECT_API_KEY ?? env?.PREFECT_API_TOKEN ?? "").trim();
}

export function readPrefectDeploymentFactorValidation(env) {
  return (
    env?.PREFECT_DEPLOYMENT_FACTOR_VALIDATION?.trim() ||
    "factor-validation/production"
  );
}

export function readPrefectStaleMinutes(env, fallback = 45) {
  const parsed = Number(env?.PREFECT_FLOW_RUN_STALE_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 180);
}

export function parseDeploymentName(deploymentRef) {
  const text = String(deploymentRef ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash >= text.length - 1) {
    throw new Error(`无效的 Prefect deployment 引用: ${text}`);
  }
  return {
    flowName: text.slice(0, slash),
    deploymentName: text.slice(slash + 1)
  };
}

export { PREFECT_FLOW_RUN_STATUSES, PREFECT_ACTIVE_STATUSES };
