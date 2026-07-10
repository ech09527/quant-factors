import { buildAsyncEvalCode } from "./eval-kernel-builder.js";
import {
  getJupyterKernelCapacity,
  JupyterWorkerClient,
  selectWorkerJupyterServer
} from "./jupyter-async.js";
import { hasStoredFactorSql, validateFactorSqlBasic } from "./factor-sql-validate.js";
import {
  claimValidationWorkflowJobs,
  listEnabledJupyterServers,
  listPendingValidationWorkflowJobs,
  markJupyterServerUsed,
  mergeClaimedJobs,
  releaseValidationWorkflowClaims,
  reportValidationWorkflowResults,
  updateValidationDiagnostics
} from "./validation-db.js";
import { getValidationBatchLimit, isValidationBatchEnabled } from "./workflow-settings.js";

const KERNEL_CAPACITY_REASON = "jupyter kernel capacity reached";

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function readReportConfig(env, runtimeConfig) {
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

async function validationScheduleEnabled(db, env) {
  return isValidationBatchEnabled(db, env);
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

export async function runValidationBatch(env, options = {}) {
  const ignoreScheduleEnabled = options.ignoreScheduleEnabled === true;
  if (!ignoreScheduleEnabled && !(await validationScheduleEnabled(env.DB, env))) {
    return { skipped: true, reason: "validation_batch_disabled" };
  }

  const limit = await getValidationBatchLimit(env.DB, env);
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";

  const pending = await listPendingValidationWorkflowJobs(env.DB, limit, env);
  if (pending.items.length === 0) {
    return emptyBatchResult();
  }

  const servers = await listEnabledJupyterServers(env.DB);
  const { server, fallbackFrom } = selectWorkerJupyterServer(servers, preferredServerKey);
  const jupyter = new JupyterWorkerClient(server);
  const runtimeConfig = server.runtime_config ?? { target_file: "futures/um/klines/1h.parquet" };
  const reportConfig = readReportConfig(env, runtimeConfig);

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
  const claimResult = await claimValidationWorkflowJobs(env.DB, claimPayload);
  const jobs = mergeClaimedJobs(itemsToProcess, claimResult.jobs);
  if (jobs.length === 0) {
    return emptyBatchResult({ deferred: deferredBeforeClaim });
  }

  const errors = [];
  let submitted = 0;
  let failed = 0;
  let ignored = 0;
  let deferred = deferredBeforeClaim;
  const deferredValidationIds = [];

  for (const job of jobs) {
    const validationId = Number(job.validation_id);
    const profileKey = String(job.profile_key);

    if (capacity.limited) {
      const liveCapacity = await getJupyterKernelCapacity(jupyter, server);
      if (liveCapacity.limited && liveCapacity.available <= 0) {
        deferredValidationIds.push(validationId);
        deferred += 1;
        continue;
      }
      capacity = liveCapacity;
    }

    if (!hasStoredFactorSql(job.factor_sql)) {
      await reportValidationWorkflowResults(env.DB, [
        {
          validation_id: validationId,
          status: "skipped",
          factor_sql: null,
          metrics: null,
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
      await reportValidationWorkflowResults(env.DB, [
        {
          validation_id: validationId,
          status: "failed",
          factor_sql: job.factor_sql,
          metrics: null,
          diagnostics: { error: message, stage: "factor_sql_validation" },
          error_reason: `factor_sql 无效: ${message}`
        }
      ]);
      failed += 1;
      errors.push({ validation_id: validationId, error: message });
      continue;
    }

    const evalJob = {
      validation_id: validationId,
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
      runtime_config: runtimeConfig
    };

    try {
      const code = buildAsyncEvalCode(payload, reportConfig);
      const submitInfo = await jupyter.submitExecuteAsync(code);
      const submittedAt = new Date().toISOString();
      await updateValidationDiagnostics(env.DB, validationId, {
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
      await reportValidationWorkflowResults(env.DB, [
        {
          validation_id: validationId,
          status: "failed",
          factor_sql: factorSql,
          metrics: null,
          diagnostics: { error: message, stage: "jupyter_submit" },
          error_reason: message
        }
      ]);
      failed += 1;
      errors.push({ validation_id: validationId, error: message });
    }
  }

  if (deferredValidationIds.length > 0) {
    await releaseValidationWorkflowClaims(env.DB, deferredValidationIds, KERNEL_CAPACITY_REASON);
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
