import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import {
  claimTestFactorValidationJobs,
  listPendingTestFactorValidationJobs,
  mergeClaimedTestFactorValidationJobs
} from "./test-factor-validation-db.js";
import { getJupyterExecutionByBusiness } from "./jupyter-execution-db.js";
import { submit as submitJupyterExecution } from "./jupyter-executor.js";
import { getTestFactorValidationBatchEnabled, getValidationBatchLimit } from "./workflow-settings.js";
import { selectWorkerJupyterServer } from "./jupyter-async.js";
import { listEnabledJupyterServers } from "./validation-db.js";

function executionPriority(job) {
  const status = String(job.status ?? "queued");
  if (status === "failed") {
    return 10;
  }
  if (status === "pending") {
    return 0;
  }
  return 5;
}

function buildTestFactorValidationPayload(job, record) {
  return {
    task_id: record.task_id,
    test_factor_validation_id: record.test_factor_validation_id,
    idea_id: job.idea_id,
    profile_key: job.profile_key
  };
}

export async function dispatchTestFactorValidationViaCoordinator(env, options = {}) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true, reason: "jupyter_execution_via_do_disabled" };
  }
  if (
    !options.ignoreScheduleEnabled &&
    !(await getTestFactorValidationBatchEnabled(env.DB, env))
  ) {
    return { skipped: true, reason: "test_factor_validation_batch_disabled" };
  }

  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
  const servers = await listEnabledJupyterServers(env.DB);
  const { server } = selectWorkerJupyterServer(servers, preferredServerKey);
  const serverKey = server.key;

  const maxEnqueue =
    options.limit != null && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : await getValidationBatchLimit(env.DB, env);
  const pendingLimit = Math.max(maxEnqueue * 20, maxEnqueue);
  const pending = await listPendingTestFactorValidationJobs(env.DB, pendingLimit, env);
  if (pending.items.length === 0) {
    return { enqueued: 0, created: 0, requeued: 0, skipped_existing: 0, claimed: 0 };
  }

  const claimResult = await claimTestFactorValidationJobs(
    env.DB,
    pending.items.slice(0, pendingLimit).map((job) => ({
      idea_id: job.idea_id,
      profile_key: job.profile_key
    })),
    env
  );
  const jobs = mergeClaimedTestFactorValidationJobs(pending.items, claimResult.jobs);

  let enqueued = 0;
  let created = 0;
  let requeued = 0;
  let skippedExisting = 0;
  let skippedUnclaimed = pending.items.length - jobs.length;
  const errors = [];

  for (const job of jobs) {
    if (enqueued >= maxEnqueue) {
      break;
    }
    try {
      const record = {
        task_id: job.task_id,
        test_factor_validation_id: job.test_factor_validation_id
      };
      const businessId = String(record.task_id);
      const existing = await getJupyterExecutionByBusiness(
        env.DB,
        "test_factor_validation",
        businessId
      );
      if (existing && ["submitting", "running"].includes(existing.status)) {
        skippedExisting += 1;
        continue;
      }

      const submitResult = await submitJupyterExecution(env, {
        serverKey,
        businessType: "test_factor_validation",
        businessId,
        priority: executionPriority(job),
        payload: buildTestFactorValidationPayload(job, record)
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
    claimed: claimResult.claimed,
    skipped_existing: skippedExisting,
    skipped_unclaimed: skippedUnclaimed,
    pending: pending.items.length,
    limit: maxEnqueue,
    server_key: serverKey,
    errors
  };
}
