import {
  readReportConfig,
  readTestFactorValidationSkipMlflow
} from "./jupyter-execution-config.js";
import { prefectExecutionEnabled, readPrefectDeploymentTestFactorValidation } from "./prefect-execution-config.js";
import { createPrefectFlowRun } from "./prefect-client.js";
import {
  getPrefectFlowRunByBusiness,
  isActivePrefectFlowRun,
  upsertPrefectFlowRun
} from "./prefect-execution-db.js";
import {
  buildTestFactorValidationPrefectJobPayload,
  listPendingTestFactorValidationJobsForPrefect,
  markTestFactorValidationRunningAfterPrefect,
  mergeReservedTestFactorValidationJobs,
  reserveTestFactorValidationJobsForPrefect
} from "./test-factor-validation-db.js";
import { getTestFactorValidationBatchEnabled, getValidationBatchLimit } from "./workflow-settings.js";
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
  return {};
}

export async function dispatchTestFactorValidationViaPrefect(env, options = {}) {
  if (!prefectExecutionEnabled(env)) {
    return { skipped: true, reason: "prefect_execution_disabled" };
  }
  if (
    !options.ignoreScheduleEnabled &&
    !(await getTestFactorValidationBatchEnabled(env.DB, env))
  ) {
    return { skipped: true, reason: "test_factor_validation_batch_disabled" };
  }

  const deploymentRef = readPrefectDeploymentTestFactorValidation(env);
  const maxSubmit =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : await getValidationBatchLimit(env.DB, env);
  const pendingLimit = Math.max(maxSubmit * 20, maxSubmit);
  const pending = await listPendingTestFactorValidationJobsForPrefect(env.DB, pendingLimit, env);
  if (pending.items.length === 0) {
    return { submitted: 0, reserved: 0, skipped_existing: 0, pending: 0, limit: maxSubmit };
  }

  const reserveResult = await reserveTestFactorValidationJobsForPrefect(
    env.DB,
    pending.items.slice(0, pendingLimit).map((job) => ({
      idea_id: job.idea_id,
      profile_key: job.profile_key
    }))
  );
  const jobs = mergeReservedTestFactorValidationJobs(pending.items, reserveResult.jobs);

  const runtimeConfig = await resolveRuntimeConfig(env);
  const callbackBaseUrl = readReportConfig(env, runtimeConfig).api_base_url;
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const skipMlflow = readTestFactorValidationSkipMlflow(env);

  let submitted = 0;
  let skippedExisting = 0;
  let skippedUnreserved = pending.items.length - jobs.length;
  const errors = [];

  for (const job of jobs) {
    if (submitted >= maxSubmit) {
      break;
    }
    try {
      const record = {
        task_id: job.task_id,
        test_factor_validation_id: job.test_factor_validation_id
      };
      const businessId = String(record.task_id);
      const existing = await getPrefectFlowRunByBusiness(
        env.DB,
        "test_factor_validation",
        businessId
      );
      if (isActivePrefectFlowRun(existing)) {
        skippedExisting += 1;
        continue;
      }

      const prefectJob = buildTestFactorValidationPrefectJobPayload(job);
      const flowParameters = {
        business_type: "test_factor_validation",
        task_id: record.task_id,
        validation_id: record.test_factor_validation_id,
        job: prefectJob,
        sample_start: sampleStart,
        runtime_config: runtimeConfig,
        callback_base_url: callbackBaseUrl,
        skip_mlflow: skipMlflow
      };

      const created = await createPrefectFlowRun(env, deploymentRef, flowParameters, {
        idempotencyKey: `test_factor_validation:${businessId}`,
        tags: ["quant-factors", "test_factor_validation", `task:${businessId}`]
      });

      await upsertPrefectFlowRun(env.DB, {
        flowRunId: created.flow_run_id,
        businessType: "test_factor_validation",
        businessId,
        deploymentName: deploymentRef,
        status: "scheduled"
      });
      await markTestFactorValidationRunningAfterPrefect(env.DB, record.task_id, {
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
    skipped_unreserved: skippedUnreserved,
    pending: pending.items.length,
    limit: maxSubmit,
    deployment: deploymentRef,
    skip_mlflow: skipMlflow,
    errors
  };
}
