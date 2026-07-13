import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import {
  readMlflowConfig,
  readReportConfig,
  readTestFactorValidationSkipMlflow,
  readTestMlflowConfig
} from "./jupyter-execution-config.js";
import { prefectExecutionEnabled, readPrefectDeploymentFactorValidation } from "./prefect-execution-config.js";
import { createPrefectFlowRun } from "./prefect-client.js";
import {
  getPrefectFlowRunByBusiness,
  isActivePrefectFlowRun,
  upsertPrefectFlowRun
} from "./prefect-execution-db.js";
import {
  buildFactorValidationPrefectJobPayload,
  listPendingFactorValidationJobsForPrefect,
  markFactorValidationRunningAfterPrefect,
  mergeReservedFactorValidationJobs,
  reportFactorValidationResults,
  reserveFactorValidationJobsForPrefect
} from "./factor-validation-db.js";
import { getFactorValidationBatchEnabled, getValidationBatchLimit } from "./workflow-settings.js";
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

export async function dispatchFactorValidationViaPrefect(env, options = {}) {
  if (!prefectExecutionEnabled(env)) {
    return { skipped: true, reason: "prefect_execution_disabled" };
  }
  if (
    !options.ignoreScheduleEnabled &&
    !(await getFactorValidationBatchEnabled(env.DB, env))
  ) {
    return { skipped: true, reason: "factor_validation_batch_disabled" };
  }

  const deploymentRef = readPrefectDeploymentFactorValidation(env);
  const maxSubmit =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : await getValidationBatchLimit(env.DB, env);
  const pendingLimit = Math.max(maxSubmit * 20, maxSubmit);
  const pending = await listPendingFactorValidationJobsForPrefect(env.DB, pendingLimit, env);
  if (pending.items.length === 0) {
    return { submitted: 0, reserved: 0, skipped_existing: 0, pending: 0, limit: maxSubmit };
  }

  const reserveResult = await reserveFactorValidationJobsForPrefect(
    env.DB,
    pending.items.slice(0, pendingLimit).map((job) => ({
      idea_id: job.idea_id,
      profile_key: job.profile_key
    }))
  );
  const jobs = mergeReservedFactorValidationJobs(pending.items, reserveResult.jobs);

  const runtimeConfig = await resolveRuntimeConfig(env);
  const callbackBaseUrl = readReportConfig(env, runtimeConfig).api_base_url;
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const mlflowConfig = readMlflowConfig(env);

  let submitted = 0;
  let skippedExisting = 0;
  let skippedPreflight = 0;
  let skippedUnreserved = pending.items.length - jobs.length;
  const errors = [];

  for (const job of jobs) {
    if (submitted >= maxSubmit) {
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
        "factor_validation",
        businessId
      );
      if (isActivePrefectFlowRun(existing)) {
        skippedExisting += 1;
        continue;
      }

      const prefectJob = buildFactorValidationPrefectJobPayload(job);
      const flowParameters = {
        business_type: "factor_validation",
        task_id: record.task_id,
        validation_id: record.factor_validation_id,
        job: prefectJob,
        sample_start: sampleStart,
        runtime_config: runtimeConfig,
        callback_base_url: callbackBaseUrl,
        skip_mlflow: false
      };

      const created = await createPrefectFlowRun(env, deploymentRef, flowParameters, {
        idempotencyKey: `factor_validation:${businessId}`,
        tags: ["quant-factors", "factor_validation", `task:${businessId}`]
      });

      await upsertPrefectFlowRun(env.DB, {
        flowRunId: created.flow_run_id,
        businessType: "factor_validation",
        businessId,
        deploymentName: deploymentRef,
        status: "scheduled"
      });
      await markFactorValidationRunningAfterPrefect(env.DB, record.task_id, {
        flowRunId: created.flow_run_id,
        deploymentName: deploymentRef
      });

      submitted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ idea_id: job.idea_id, profile_key: job.profile_key, error: message });
    }
  }

  return {
    submitted,
    reserved: reserveResult.reserved,
    skipped_existing: skippedExisting,
    skipped_preflight: skippedPreflight,
    skipped_unreserved: skippedUnreserved,
    pending: pending.items.length,
    limit: maxSubmit,
    deployment: deploymentRef,
    mlflow_config_present: Boolean(mlflowConfig?.tracking_uri),
    errors
  };
}
