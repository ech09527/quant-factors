import { coordinatorReport } from "./jupyter-coordinator-client.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { resolveFactorValidationTerminalStatus } from "./factor-validation-errors.js";
import {
  ensureFactorValidationRecords,
  listPendingFactorValidationJobs,
  reportFactorValidationResults
} from "./factor-validation-db.js";
import { getJupyterExecutionByBusiness } from "./jupyter-execution-db.js";
import { submit as submitJupyterExecution } from "./jupyter-executor.js";
import { getFactorValidationBatchEnabled } from "./workflow-settings.js";
import { selectWorkerJupyterServer } from "./jupyter-async.js";
import { listEnabledJupyterServers } from "./validation-db.js";
import { hasStoredFactorSql, validateFactorSqlBasic } from "./factor-sql-validate.js";

function executionPriority(job) {
  const status = String(job.status ?? "queued");
  if (status === "failed") {
    return 10;
  }
  if (status === "queued" || status === "pending") {
    return 0;
  }
  return 5;
}

function buildFactorValidationPayload(job, record) {
  return {
    task_id: record.task_id,
    factor_validation_id: record.factor_validation_id,
    idea_id: job.idea_id,
    profile_key: job.profile_key
  };
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

export async function dispatchFactorValidationViaCoordinator(env, options = {}) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true, reason: "jupyter_execution_via_do_disabled" };
  }
  if (
    !options.ignoreScheduleEnabled &&
    !(await getFactorValidationBatchEnabled(env.DB, env))
  ) {
    return { skipped: true, reason: "factor_validation_batch_disabled" };
  }

  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
  const servers = await listEnabledJupyterServers(env.DB);
  const { server } = selectWorkerJupyterServer(servers, preferredServerKey);
  const serverKey = server.key;

  const maxEnqueue =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : null;
  const pendingLimit = maxEnqueue == null ? null : Math.max(maxEnqueue * 20, maxEnqueue);
  const pending = await listPendingFactorValidationJobs(env.DB, pendingLimit, env);
  if (pending.items.length === 0) {
    return { enqueued: 0, created: 0, requeued: 0, skipped_existing: 0 };
  }

  let enqueued = 0;
  let created = 0;
  let requeued = 0;
  let skippedExisting = 0;
  let skippedPreflight = 0;
  const errors = [];

  for (const job of pending.items) {
    if (maxEnqueue != null && enqueued >= maxEnqueue) {
      break;
    }
    try {
      const record = await ensureFactorValidationRecords(env.DB, job.idea_id, job.profile_key);
      const preflight = await preflightFactorValidationJob(env, job, record);
      if (!preflight.ok) {
        skippedPreflight += 1;
        continue;
      }

      const businessId = String(record.task_id);
      const existing = await getJupyterExecutionByBusiness(env.DB, "factor_validation", businessId);
      if (existing && ["queued", "submitting", "running"].includes(existing.status)) {
        skippedExisting += 1;
        continue;
      }

      const submitResult = await submitJupyterExecution(env, {
        serverKey,
        businessType: "factor_validation",
        businessId,
        priority: executionPriority(job),
        payload: buildFactorValidationPayload(job, record)
      });

      if (submitResult.skipped) {
        skippedExisting += 1;
        continue;
      }
      if (submitResult.created) {
        created += 1;
      }
      if (submitResult.requeued) {
        requeued += 1;
      }

      enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ idea_id: job.idea_id, profile_key: job.profile_key, error: message });
    }
  }

  return {
    enqueued,
    created,
    requeued,
    skipped_existing: skippedExisting,
    skipped_preflight: skippedPreflight,
    pending: pending.items.length,
    limit: maxEnqueue,
    server_key: serverKey,
    errors
  };
}

export async function notifyCoordinatorExecutionReported(env, {
  businessType,
  businessId,
  terminalStatus,
  errorReason = null,
  errorCode = null
}) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true };
  }

  const execution = await getJupyterExecutionByBusiness(env.DB, businessType, String(businessId));
  if (!execution) {
    return { skipped: true, reason: "execution_not_found" };
  }
  if (["succeeded", "failed", "skipped", "timed_out"].includes(execution.status) && execution.cleanup_at) {
    return { skipped: true, reason: "already_finalized" };
  }

  return coordinatorReport(env, execution.server_key, {
    execution_id: execution.id,
    terminal_status: terminalStatus,
    error_reason: errorReason,
    error_code: errorCode
  });
}
