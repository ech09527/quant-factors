const FACTOR_VALIDATION_EXPERIMENT = "factor-validation";
export const TEST_FACTOR_VALIDATION_EXPERIMENT = "test-factor-validation";

export function jupyterExecutionViaDoEnabled(env) {
  const flag = String(env?.JUPYTER_EXECUTION_VIA_DO ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

export function readJupyterExecutionTimeoutMinutes(env, fallback = 45) {
  const parsed = Number(env?.JUPYTER_EXECUTION_TIMEOUT_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 180);
}

export function readJupyterWebSocketListenTimeoutMs(env, businessType = null) {
  const type = String(businessType ?? "").trim();
  const testMinutesRaw = env?.JUPYTER_WS_LISTEN_TIMEOUT_TEST_MINUTES;
  if (type === "test_factor_validation" && testMinutesRaw != null && String(testMinutesRaw).trim() !== "") {
    const testMinutes = Number(testMinutesRaw);
    if (Number.isFinite(testMinutes) && testMinutes > 0) {
      return Math.min(Math.floor(testMinutes), 180) * 60_000;
    }
  }

  const minutesRaw = env?.JUPYTER_WS_LISTEN_TIMEOUT_MINUTES;
  if (minutesRaw != null && String(minutesRaw).trim() !== "") {
    const minutes = Number(minutesRaw);
    if (Number.isFinite(minutes) && minutes > 0) {
      return Math.min(Math.floor(minutes), 180) * 60_000;
    }
  }

  return readJupyterExecutionTimeoutMinutes(env, 45) * 60_000;
}

export function readKernelStaleIdleRunningMinutes(env, fallback = 5) {
  const parsed = Number(env?.KERNEL_STALE_IDLE_RUNNING_MINUTES ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 120);
}

export function readJupyterExecutionHeartbeatIntervalSeconds(env, fallback = 5) {
  const parsed = Number(env?.JUPYTER_EXECUTION_HEARTBEAT_INTERVAL_SECONDS ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 120);
}

export function readReportConfig(env, runtimeConfig) {
  const apiBaseUrl = (
    runtimeConfig?.report_api_base_url ||
    env.FACTOR_API_BASE_URL?.trim() ||
    env.VALIDATION_API_BASE_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  const apiToken = env.AUTH_PASSWORD?.trim() || env.FACTOR_API_TOKEN?.trim() || "";
  if (!apiBaseUrl || !apiToken) {
    throw new Error("缺少 FACTOR_API_BASE_URL 或 AUTH_PASSWORD（report 回调凭证）");
  }
  return { api_base_url: apiBaseUrl, api_token: apiToken };
}

export function readMlflowConfig(env) {
  const trackingUri = (
    env.MLFLOW_TRACKING_URI?.trim() ||
    env.MLFLOW_TRACKING_URL?.trim() ||
    ""
  );
  const username = (
    env.MLFLOW_TRACKING_USERNAME?.trim() ||
    env.DAGSHUB_USER?.trim() ||
    ""
  );
  const password = (
    env.MLFLOW_TRACKING_PASSWORD?.trim() ||
    env.DAGSHUB_TOKEN?.trim() ||
    ""
  );
  return {
    tracking_uri: trackingUri,
    username,
    password,
    experiment: env.MLFLOW_EXPERIMENT_FACTOR_VALIDATION?.trim() || FACTOR_VALIDATION_EXPERIMENT
  };
}

export function readTestMlflowConfig(env) {
  const base = readMlflowConfig(env);
  return {
    ...base,
    experiment:
      env.MLFLOW_EXPERIMENT_TEST_FACTOR_VALIDATION?.trim() ||
      TEST_FACTOR_VALIDATION_EXPERIMENT
  };
}

export function readTestFactorValidationSkipMlflow(env) {
  const flag = String(env?.TEST_FACTOR_VALIDATION_SKIP_MLFLOW ?? "1").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

export function coordinatorInternalToken(env) {
  return (
    env.COORDINATOR_INTERNAL_SECRET?.trim() ||
    env.AUTH_PASSWORD?.trim() ||
    ""
  );
}
