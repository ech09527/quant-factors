import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import { readReportConfig } from "./jupyter-execution-config.js";
import {
  resolveActiveMlflowConfig,
  touchMlflowTrackingConfigUsed
} from "./mlflow-tracking-config-db.js";
import {
  prefectExecutionEnabled,
  readPrefectDeploymentNeutralValidation
} from "./prefect-execution-config.js";
import { createPrefectFlowRun } from "./prefect-client.js";
import {
  getPrefectFlowRunByBusiness,
  isActivePrefectFlowRun,
  upsertPrefectFlowRun
} from "./prefect-execution-db.js";
import { reconcilePrefectFlowRunsFromApi } from "./prefect-execution-reconcile.js";
import {
  BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION,
  buildFactorValidationPrefectJobPayload,
  listPendingFactorNeutralValidationJobsForPrefect,
  markFactorValidationRunningAfterPrefect,
  mergeReservedFactorValidationJobs,
  reportFactorValidationResults,
  reserveFactorNeutralValidationJobsForPrefect
} from "./factor-validation-db.js";
import { resolveNeutralizationForJob } from "./select-neutralization.js";
import { updateMlTaskDiagnostics } from "./ml-task-db.js";
import {
  getNeutralValidationBatchEnabled,
  getNeutralValidationBatchLimit,
  getNeutralValidationKey,
  getNeutralValidationMinAbsMeanRankIc
} from "./workflow-settings.js";
import { hasStoredFactorSql, validateFactorSqlBasic } from "./factor-sql-validate.js";
import { listEnabledJupyterServers } from "./validation-db.js";
import { selectWorkerJupyterServer } from "./jupyter-async.js";

async function resolveRuntimeConfig(env) {
  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
  const servers = await listEnabledJupyterServers(env.DB);
  const { server } = selectWorkerJupyterServer(servers, preferredServerKey);
  if (server?.runtime_config && typeof server.runtime_config === "object") {
    return server.runtime_config;
  }
  if (typeof server?.runtime_config === "string" && server.runtime_config.trim()) {
    try {
      return JSON.parse(server.runtime_config);
    } catch {
      return {};
    }
  }
  return { target_file: "futures/um/klines/1h.parquet" };
}

async function preflightFactorValidationJob(env, job, record) {
  if (!hasStoredFactorSql(job.factor_sql)) {
    await reportFactorValidationResults(env.DB, [
      {
        task_id: record.task_id,
        factor_validation_id: record.factor_validation_id,
        status: "skipped",
        factor_sql: null,
        diagnostics: { stage: "preflight", reason: "idea has no factor_sql" },
        error_reason: "idea has no factor_sql"
      }
    ]);
    return { ok: false, skipped: true };
  }

  try {
    validateFactorSqlBasic(job.factor_sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = resolveFactorValidationTerminalStatus("failed", `factor_sql 无效: ${message}`);
    await reportFactorValidationResults(env.DB, [
      {
        task_id: record.task_id,
        factor_validation_id: record.factor_validation_id,
        status,
        factor_sql: job.factor_sql,
        diagnostics: { error: message, stage: "factor_sql_validation" },
        error_reason: `factor_sql 无效: ${message}`
      }
    ]);
    return { ok: false, skipped: status === "skipped" };
  }

  return { ok: true };
}

function buildMlflowFlowParameters(mlflowConfig) {
  const trackingUri = String(mlflowConfig?.tracking_uri ?? "").trim();
  const username = String(mlflowConfig?.username ?? "").trim();
  const password = String(mlflowConfig?.password ?? "").trim();
  const configured = Boolean(trackingUri && username && password);
  return {
    skip_mlflow: !configured,
    mlflow_config: configured
      ? {
          tracking_uri: trackingUri,
          username,
          password
        }
      : null
  };
}

/**
 * 筛优秀因子 + AI 暴露选型 + reserve，返回待提交的 flow_parameters。
 * 不创建 Prefect flow run（由 Prefect orchestrator 或手动 dispatch 创建）。
 */
export async function claimFactorNeutralValidationBatch(env, options = {}) {
  if (
    !options.ignoreScheduleEnabled &&
    !(await getNeutralValidationBatchEnabled(env.DB, env))
  ) {
    return { skipped: true, reason: "neutral_validation_batch_disabled", items: [] };
  }

  const deploymentRef = readPrefectDeploymentNeutralValidation(env);
  const neutralizationKey = await getNeutralValidationKey(env.DB, env);
  const minAbsMeanRankIc = await getNeutralValidationMinAbsMeanRankIc(env.DB, env);
  const maxSubmit =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : await getNeutralValidationBatchLimit(env.DB, env);
  const pendingLimit = Math.max(maxSubmit * 20, maxSubmit);
  const reconcile = await reconcilePrefectFlowRunsFromApi(env, {
    businessType: BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION,
    limit: pendingLimit
  });
  const pending = await listPendingFactorNeutralValidationJobsForPrefect(
    env.DB,
    pendingLimit,
    env,
    { neutralizationKey, minAbsMeanRankIc }
  );
  if (pending.items.length === 0) {
    return {
      skipped: false,
      claimed: 0,
      reserved: 0,
      pending: 0,
      limit: maxSubmit,
      neutralization_key: neutralizationKey,
      min_abs_mean_rank_ic: minAbsMeanRankIc,
      deployment: deploymentRef,
      reconcile,
      items: []
    };
  }

  const enrichedPending = [];
  // 只对本批实际上限做 AI 选型，避免对 pendingLimit 全量串行调 LLM
  for (const job of pending.items.slice(0, maxSubmit)) {
    const resolved = await resolveNeutralizationForJob(env, job, neutralizationKey);
    enrichedPending.push({
      ...job,
      neutralization_key: resolved.neutralization_key,
      neutralization_spec: resolved.neutralization_spec,
      neutralization_source: resolved.source,
      neutralization_reason: resolved.reason
    });
  }

  const reserveResult = await reserveFactorNeutralValidationJobsForPrefect(
    env.DB,
    enrichedPending.map((job) => ({
      idea_id: job.idea_id,
      profile_key: job.profile_key,
      neutralization_key: job.neutralization_key,
      neutralization_spec: job.neutralization_spec
    })),
    neutralizationKey
  );
  const jobs = mergeReservedFactorValidationJobs(enrichedPending, reserveResult.jobs);

  const runtimeConfig = await resolveRuntimeConfig(env);
  const callbackBaseUrl = readReportConfig(env, runtimeConfig).api_base_url;
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const mlflowConfig = await resolveActiveMlflowConfig(env.DB, env);
  const mlflowFlow = buildMlflowFlowParameters(mlflowConfig);
  if (mlflowConfig?.key) {
    await touchMlflowTrackingConfigUsed(env.DB, mlflowConfig.key);
  }

  const items = [];
  let skippedPreflight = 0;
  let skippedExisting = 0;
  const errors = [];

  for (const job of jobs) {
    if (items.length >= maxSubmit) {
      break;
    }
    try {
      const record = {
        task_id: job.task_id,
        factor_validation_id: job.factor_validation_id
      };
      const preflight = await preflightFactorValidationJob(env, job, record);
      if (!preflight.ok) {
        skippedPreflight += 1;
        continue;
      }

      const businessId = String(record.task_id);
      const existing = await getPrefectFlowRunByBusiness(
        env.DB,
        BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION,
        businessId
      );
      if (isActivePrefectFlowRun(existing)) {
        skippedExisting += 1;
        continue;
      }

      const prefectJob = buildFactorValidationPrefectJobPayload(job);
      const flowParameters = {
        business_type: BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION,
        task_id: record.task_id,
        validation_id: record.factor_validation_id,
        job: prefectJob,
        sample_start: sampleStart,
        runtime_config: runtimeConfig,
        callback_base_url: callbackBaseUrl,
        mlflow_config: mlflowFlow.mlflow_config,
        skip_mlflow: mlflowFlow.skip_mlflow
      };

      await updateMlTaskDiagnostics(
        env.DB,
        record.task_id,
        {
          dispatch_mode: "prefect",
          prefect_reserved: true,
          neutralization_key: job.neutralization_key,
          neutralization_spec: job.neutralization_spec ?? null,
          neutralization_source: job.neutralization_source ?? null,
          neutralization_reason: job.neutralization_reason ?? null
        },
        { allowPending: true }
      );

      items.push({
        task_id: record.task_id,
        factor_validation_id: record.factor_validation_id,
        idea_id: job.idea_id,
        profile_key: job.profile_key,
        neutralization_key: job.neutralization_key,
        neutralization_source: job.neutralization_source ?? null,
        deployment: deploymentRef,
        idempotency_key: `factor_neutral_validation:${businessId}`,
        tags: [
          "quant-factors",
          "factor_neutral_validation",
          `neutral:${job.neutralization_key}`,
          `task:${businessId}`
        ],
        flow_parameters: flowParameters
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        idea_id: job.idea_id,
        profile_key: job.profile_key,
        neutralization_key: job.neutralization_key,
        error: message
      });
    }
  }

  return {
    skipped: false,
    claimed: items.length,
    reserved: reserveResult.reserved,
    skipped_existing: skippedExisting,
    skipped_preflight: skippedPreflight,
    skipped_unreserved: pending.items.length - jobs.length,
    pending: pending.items.length,
    limit: maxSubmit,
    neutralization_key: neutralizationKey,
    min_abs_mean_rank_ic: minAbsMeanRankIc,
    deployment: deploymentRef,
    mlflow_config_present: Boolean(mlflowFlow.mlflow_config?.tracking_uri),
    reconcile,
    items,
    errors
  };
}

/**
 * Prefect orchestrator 创建子 flow 后回写 flow_run_id，并将 ml_task 标为 running。
 */
export async function attachFactorNeutralValidationFlowRun(
  env,
  { taskId, flowRunId, deploymentName = null }
) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) {
    return { updated: 0, reason: "invalid_task_id" };
  }
  const deploymentRef =
    String(deploymentName ?? "").trim() || readPrefectDeploymentNeutralValidation(env);
  const marked = await markFactorValidationRunningAfterPrefect(env.DB, id, {
    flowRunId: String(flowRunId ?? ""),
    deploymentName: deploymentRef
  });
  if (Number(marked.updated ?? 0) <= 0) {
    return { updated: 0, reason: marked.reason ?? "not_pending" };
  }
  await updateMlTaskDiagnostics(env.DB, id, {
    prefect_flow_run_id: String(flowRunId ?? ""),
    prefect_deployment: deploymentRef,
    dispatch_mode: "prefect"
  });
  await upsertPrefectFlowRun(env.DB, {
    flowRunId: String(flowRunId ?? ""),
    businessType: BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION,
    businessId: String(id),
    deploymentName: deploymentRef,
    status: "scheduled"
  });
  return { updated: 1, task_id: id, flow_run_id: String(flowRunId ?? "") };
}

/**
 * 手动触发：只创建 neutral_validation/production flow run。
 * claim / LLM / 评估 / report 均在该 flow 内完成（不再复用 factor-validation）。
 */
export async function dispatchFactorNeutralValidationViaPrefect(env, options = {}) {
  if (!prefectExecutionEnabled(env)) {
    return { skipped: true, reason: "prefect_execution_disabled" };
  }

  const deploymentRef = readPrefectDeploymentNeutralValidation(env);
  const limit =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : null;
  const parameters = {
    ignore_schedule_enabled: true,
    ...(limit != null ? { limit } : {})
  };

  const created = await createPrefectFlowRun(env, deploymentRef, parameters, {
    tags: ["quant-factors", "factor_neutral_validation", "manual"]
  });

  return {
    skipped: false,
    submitted: 1,
    deployment: deploymentRef,
    flow_run_id: created.flow_run_id ?? null,
    parameters,
    mode: "trigger_neutral_validation_deployment"
  };
}
