import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import { buildFactorValidationEvalCode } from "./factor-validation-kernel-builder.js";
import {
  getJupyterKernelCapacity,
  JupyterWorkerClient,
  selectWorkerJupyterServer
} from "./jupyter-async.js";
import { hasStoredFactorSql, validateFactorSqlBasic } from "./factor-sql-validate.js";
import {
  claimFactorValidationJobs,
  listPendingFactorValidationJobs,
  mergeClaimedFactorValidationJobs,
  releaseFactorValidationClaims,
  reportFactorValidationResults,
  updateFactorValidationTaskDiagnostics
} from "./factor-validation-db.js";
import {
  listEnabledJupyterServers,
  markJupyterServerUsed
} from "./validation-db.js";
import {
  getFactorValidationBatchEnabled,
  getValidationBatchLimit
} from "./workflow-settings.js";

const KERNEL_CAPACITY_REASON = "jupyter kernel capacity reached";
const FACTOR_VALIDATION_EXPERIMENT = "factor-validation";

function readMlflowConfig(env) {
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

function buildIdeaForEval(job) {
  return {
    title: job.title,
    title_hash: job.title_hash,
    formula_sketch: job.formula_sketch,
    data_sources: job.data_sources
  };
}

function emptyBatchResult(overrides = {}) {
  return {
    claimed: 0,
    submitted: 0,
    failed: 0,
    ignored: 0,
    deferred: 0,
    errors: [],
    ...overrides
  };
}

function reportFactorValidationFailure(db, item, { message, stage, factorSql = null }) {
  const errorReason = stage === "factor_sql_validation" ? `factor_sql 无效: ${message}` : message;
  const status = resolveFactorValidationTerminalStatus("failed", errorReason);
  return reportFactorValidationResults(db, [
    {
      task_id: item.task_id,
      factor_validation_id: item.factor_validation_id,
      status,
      factor_sql: factorSql ?? item.factor_sql ?? null,
      diagnostics: { error: message, stage },
      error_reason: errorReason
    }
  ]);
}

export async function runFactorValidationBatch(env, options = {}) {
  const ignoreScheduleEnabled = options.ignoreScheduleEnabled === true;
  if (!ignoreScheduleEnabled && !(await getFactorValidationBatchEnabled(env.DB, env))) {
    return { skipped: true, reason: "factor_validation_batch_disabled" };
  }

  const limit = await getValidationBatchLimit(env.DB, env);
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
  const mlflowConfig = readMlflowConfig(env);

  const pending = await listPendingFactorValidationJobs(env.DB, limit, env);
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
  const claimResult = await claimFactorValidationJobs(env.DB, claimPayload, env);
  const jobs = mergeClaimedFactorValidationJobs(itemsToProcess, claimResult.jobs);
  if (jobs.length === 0) {
    return emptyBatchResult({ deferred: deferredBeforeClaim });
  }

  const errors = [];
  let submitted = 0;
  let failed = 0;
  let ignored = 0;
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

    if (!hasStoredFactorSql(job.factor_sql)) {
      await reportFactorValidationResults(env.DB, [
        {
          task_id: taskId,
          factor_validation_id: job.factor_validation_id,
          status: "skipped",
          factor_sql: null,
          diagnostics: { stage: "preflight", reason: "idea has no factor_sql" },
          error_reason: "idea has no factor_sql"
        }
      ]);
      ignored += 1;
      continue;
    }

    let factorSql;
    try {
      validateFactorSqlBasic(job.factor_sql);
      factorSql = job.factor_sql;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reportFactorValidationFailure(env.DB, job, {
        message,
        stage: "factor_sql_validation",
        factorSql: job.factor_sql
      });
      if (resolveFactorValidationTerminalStatus("failed", `factor_sql 无效: ${message}`) === "skipped") {
        ignored += 1;
      } else {
        failed += 1;
      }
      errors.push({ task_id: taskId, error: message });
      continue;
    }

    const evalJob = {
      task_id: taskId,
      factor_validation_id: job.factor_validation_id,
      idea_id: job.idea_id,
      idea: buildIdeaForEval(job),
      factor_sql: factorSql,
      profile_key: profileKey,
      validation_profile_key: profileKey,
      label_kind: job.label_kind,
      horizon_bars: job.horizon_bars
    };

    const payload = {
      sample_start: sampleStart,
      jobs: [evalJob],
      runtime_config: runtimeConfig,
      mlflow_config: mlflowConfig
    };

    try {
      const code = buildFactorValidationEvalCode(payload);
      const submitInfo = await jupyter.submitExecuteAsync(code);
      const submittedAt = new Date().toISOString();
      await updateFactorValidationTaskDiagnostics(env.DB, taskId, {
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
      await reportFactorValidationResults(env.DB, [
        {
          task_id: taskId,
          factor_validation_id: job.factor_validation_id,
          status: terminalStatus,
          factor_sql: factorSql,
          diagnostics: { error: message, stage: "jupyter_submit" },
          error_reason: message
        }
      ]);
      if (terminalStatus === "skipped") {
        ignored += 1;
      } else {
        failed += 1;
      }
      errors.push({ task_id: taskId, error: message });
    }
  }

  if (deferredTaskIds.length > 0) {
    await releaseFactorValidationClaims(env.DB, deferredTaskIds, KERNEL_CAPACITY_REASON);
  }

  if (submitted > 0) {
    await markJupyterServerUsed(env.DB, server.key);
  }

  return {
    claimed: jobs.length,
    submitted,
    failed,
    ignored,
    deferred,
    jupyter_server_key: server.key,
    jupyter_server_fallback_from: fallbackFrom,
    kernel_capacity: capacity.limited
      ? { current: capacity.current, limit: capacity.limit, available: capacity.available }
      : null,
    errors
  };
}
