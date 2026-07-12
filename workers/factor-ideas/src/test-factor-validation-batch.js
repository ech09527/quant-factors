import { buildTestFactorValidationEvalCode } from "./test-factor-validation-kernel-builder.js";
import {
  getJupyterKernelCapacity,
  JupyterWorkerClient,
  selectWorkerJupyterServer
} from "./jupyter-async.js";
import {
  claimTestFactorValidationJobs,
  listPendingTestFactorValidationJobs,
  mergeClaimedTestFactorValidationJobs,
  releaseTestFactorValidationClaims,
  reportTestFactorValidationResults,
  updateTestFactorValidationTaskDiagnostics
} from "./test-factor-validation-db.js";
import { listEnabledJupyterServers, markJupyterServerUsed } from "./validation-db.js";
import {
  getTestFactorValidationBatchEnabled,
  getValidationBatchLimit
} from "./workflow-settings.js";
import { readTestMlflowConfig } from "./jupyter-execution-config.js";
import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";

const KERNEL_CAPACITY_REASON = "jupyter kernel capacity reached";

function emptyBatchResult(overrides = {}) {
  return {
    claimed: 0,
    submitted: 0,
    failed: 0,
    deferred: 0,
    errors: [],
    ...overrides
  };
}

function buildIdeaForEval(job) {
  return {
    title: job.title,
    title_hash: job.title_hash,
    formula_sketch: job.formula_sketch,
    data_sources: job.data_sources
  };
}

export async function runTestFactorValidationBatch(env, options = {}) {
  const ignoreScheduleEnabled = options.ignoreScheduleEnabled === true;
  if (!ignoreScheduleEnabled && !(await getTestFactorValidationBatchEnabled(env.DB, env))) {
    return { skipped: true, reason: "test_factor_validation_batch_disabled" };
  }

  const limit = await getValidationBatchLimit(env.DB, env);
  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";

  const pending = await listPendingTestFactorValidationJobs(env.DB, limit, env);
  if (pending.items.length === 0) {
    return emptyBatchResult();
  }

  const servers = await listEnabledJupyterServers(env.DB);
  const { server, fallbackFrom } = selectWorkerJupyterServer(servers, preferredServerKey);
  const jupyter = new JupyterWorkerClient(server);
  const runtimeConfig = server.runtime_config ?? { target_file: "futures/um/klines/1h.parquet" };

  await jupyter.warmupSession();

  let capacity;
  try {
    capacity = await getJupyterKernelCapacity(jupyter, server);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyBatchResult({
      skipped: true,
      reason: "kernel_capacity_check_failed",
      error: message,
      pending: pending.items.length,
      deferred: pending.items.length,
      jupyter_server_key: server.key
    });
  }

  if (capacity.limited && capacity.available <= 0) {
    return emptyBatchResult({
      skipped: true,
      reason: "kernel_capacity",
      kernel_capacity: { current: capacity.current, limit: capacity.limit },
      pending: pending.items.length,
      deferred: pending.items.length,
      jupyter_server_key: server.key,
      jupyter_server_fallback_from: fallbackFrom
    });
  }

  const slotLimit = capacity.limited ? Math.min(limit, capacity.available) : limit;
  const itemsToProcess = pending.items.slice(0, slotLimit);
  const deferredBeforeClaim = pending.items.length - itemsToProcess.length;

  const claimPayload = itemsToProcess.map((job) => ({
    idea_id: job.idea_id,
    profile_key: job.profile_key
  }));
  const claimResult = await claimTestFactorValidationJobs(env.DB, claimPayload, env);
  const jobs = mergeClaimedTestFactorValidationJobs(itemsToProcess, claimResult.jobs);
  if (jobs.length === 0) {
    return emptyBatchResult({ deferred: deferredBeforeClaim });
  }

  const errors = [];
  let submitted = 0;
  let failed = 0;
  let deferred = deferredBeforeClaim;
  const deferredTaskIds = [];

  for (const job of jobs) {
    const taskId = Number(job.task_id);
    const profileKey = String(job.profile_key);

    if (capacity.limited) {
      const liveCapacity = await getJupyterKernelCapacity(jupyter, server);
      if (liveCapacity.limited && liveCapacity.available <= 0) {
        deferredTaskIds.push(taskId);
        deferred += 1;
        continue;
      }
      capacity = liveCapacity;
    }

    const evalJob = {
      task_id: taskId,
      test_factor_validation_id: job.test_factor_validation_id,
      idea_id: job.idea_id,
      idea: buildIdeaForEval(job),
      factor_sql: job.factor_sql,
      profile_key: profileKey,
      validation_profile_key: profileKey,
      label_kind: job.label_kind,
      horizon_bars: job.horizon_bars
    };

    const payload = {
      jobs: [evalJob],
      runtime_config: runtimeConfig,
      mlflow_config: readTestMlflowConfig(env),
      mlflow_slim: runtimeConfig?.mlflow_slim !== false,
      mlflow_preinstalled: runtimeConfig?.mlflow_preinstalled !== false
    };

    try {
      const code = buildTestFactorValidationEvalCode(payload);
      const submitInfo = await jupyter.submitExecuteAsync(code);
      const submittedAt = new Date().toISOString();
      await updateTestFactorValidationTaskDiagnostics(env.DB, taskId, {
        async: true,
        stage: "jupyter_submitted",
        jupyter_server_key: server.key,
        ...(fallbackFrom
          ? { jupyter_server_fallback_from: fallbackFrom, jupyter_server_fallback_reason: "disabled_or_unavailable" }
          : {}),
        kernel_id: submitInfo.kernel_id,
        session_id: submitInfo.session_id,
        msg_id: submitInfo.msg_id,
        submitted_at: submittedAt
      });
      submitted += 1;
      if (capacity.limited) {
        capacity = {
          ...capacity,
          current: (capacity.current ?? 0) + 1,
          available: Math.max(0, (capacity.available ?? 0) - 1),
          at_limit: (capacity.current ?? 0) + 1 >= (capacity.limit ?? 0)
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminalStatus = resolveFactorValidationTerminalStatus("failed", message);
      await reportTestFactorValidationResults(env.DB, [
        {
          task_id: taskId,
          test_factor_validation_id: job.test_factor_validation_id,
          status: terminalStatus,
          factor_sql: job.factor_sql ?? null,
          diagnostics: { error: message, stage: "jupyter_submit", mock_validation: true },
          error_reason: message
        }
      ]);
      failed += 1;
      errors.push({ task_id: taskId, error: message });
    }
  }

  if (deferredTaskIds.length > 0) {
    await releaseTestFactorValidationClaims(env.DB, deferredTaskIds, KERNEL_CAPACITY_REASON);
  }

  if (submitted > 0) {
    await markJupyterServerUsed(env.DB, server.key);
  }

  return {
    claimed: jobs.length,
    submitted,
    failed,
    deferred,
    jupyter_server_key: server.key,
    jupyter_server_fallback_from: fallbackFrom,
    kernel_capacity: capacity.limited
      ? { current: capacity.current, limit: capacity.limit, available: capacity.available }
      : null,
    errors
  };
}
