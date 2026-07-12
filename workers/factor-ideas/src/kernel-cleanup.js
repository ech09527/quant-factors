import { JupyterWorkerClient, selectWorkerJupyterServer } from "./jupyter-async.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { coordinatorTick } from "./jupyter-coordinator-client.js";
import {
  listActiveJupyterExecutionKernelBindings,
  listJupyterExecutionsNeedingCleanup
} from "./jupyter-execution-db.js";
import { finalizeJupyterExecution } from "./jupyter-execution-runtime.js";
import { runJupyterKernelReconcile } from "./jupyter-kernel-reconcile.js";
import { getKernelCleanupEnabled } from "./workflow-settings.js";
import {
  failMlTaskIfRunning,
  getMlTaskKernelCleanupTarget,
  listActiveMlTaskKernelIds,
  listMlTasksPendingKernelCleanup,
  listMlTasksWithUncleanedKernels,
  markMlTaskKernelCleaned,
  patchMlTaskDiagnostics
} from "./ml-task-db.js";
import {
  failValidationIfRunning,
  getJupyterServerByKey,
  getValidationKernelCleanupTarget,
  listActiveJupyterKernelIds,
  listEnabledJupyterServers,
  listValidationsPendingKernelCleanup,
  listValidationsWithUncleanedKernels,
  markValidationKernelCleaned,
  patchValidationDiagnostics
} from "./validation-db.js";

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

async function cleanupEnabled(db, env) {
  return getKernelCleanupEnabled(db, env);
}

function isKernelAlreadyGone(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

function orphanSweepEnabled(env) {
  const flag = env.KERNEL_ORPHAN_SWEEP_ENABLED?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return true;
}

function parseKernelLastActivityMs(kernel) {
  const raw = String(kernel?.last_activity ?? "").trim();
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function collectActiveKernelIds(db) {
  const activeKernelIds = await listActiveJupyterKernelIds(db);
  for (const kernelId of await listActiveMlTaskKernelIds(db)) {
    activeKernelIds.add(kernelId);
  }
  const executionBindings = await listActiveJupyterExecutionKernelBindings(db, null);
  for (const kernelId of executionBindings.keys()) {
    activeKernelIds.add(kernelId);
  }
  return activeKernelIds;
}

async function cleanupStaleJupyterExecutions(env, { limit, graceMinutes, force }) {
  const stale = await listJupyterExecutionsNeedingCleanup(env.DB, {
    limit,
    graceMinutes: force ? 0 : graceMinutes
  });
  let finalized = 0;
  for (const execution of stale) {
    const result = await finalizeJupyterExecution(env, execution.id, String(execution.status ?? "failed"), {
      error_code: execution.error_code,
      error_reason: execution.error_reason
    });
    if (result.finalized) {
      finalized += 1;
    }
  }
  return { scanned: stale.length, finalized };
}

async function sweepOrphanIdleKernels(env, { limit, idleMinutes }) {
  if (!orphanSweepEnabled(env)) {
    return { scanned: 0, deleted: 0, already_gone: 0, failed: 0, skipped: 0, errors: [] };
  }

  const servers = await listEnabledJupyterServers(env.DB);
  const { server } = selectWorkerJupyterServer(
    servers,
    env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub"
  );
  const activeKernelIds = await collectActiveKernelIds(env.DB);
  const client = new JupyterWorkerClient(server);
  const idleCutoffMs = Date.now() - idleMinutes * 60_000;

  let kernels;
  try {
    kernels = await client.listKernels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { scanned: 0, deleted: 0, already_gone: 0, failed: 1, skipped: 0, errors: [{ error: message }] };
  }

  const candidates = kernels
    .filter((kernel) => {
      const kernelId = String(kernel?.id ?? "").trim();
      if (!kernelId || activeKernelIds.has(kernelId)) {
        return false;
      }
      const state = String(kernel?.execution_state ?? "");
      if (state === "busy") {
        return false;
      }
      if (state === "starting") {
        return true;
      }
      if (state !== "idle") {
        return false;
      }
      const lastActivityMs = parseKernelLastActivityMs(kernel);
      return lastActivityMs > 0 && lastActivityMs < idleCutoffMs;
    })
    .sort((a, b) => parseKernelLastActivityMs(a) - parseKernelLastActivityMs(b))
    .slice(0, limit);

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  const errors = [];

  for (const kernel of candidates) {
    const kernelId = String(kernel.id);
    try {
      await client.shutdownKernel(kernelId);
      deleted += 1;
    } catch (error) {
      if (isKernelAlreadyGone(error)) {
        alreadyGone += 1;
        continue;
      }
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (errors.length < 10) {
        errors.push({ kernel_id: kernelId, error: message });
      }
    }
  }

  return {
    scanned: candidates.length,
    deleted,
    already_gone: alreadyGone,
    failed,
    skipped: 0,
    errors
  };
}

async function shutdownUncleanedKernelTargets(env, items, clientCache, errors) {
  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.kind === "ml_task" && item.status === "running") {
      await failMlTaskIfRunning(env.DB, item.task_id);
    } else if (item.kind === "legacy_validation" && item.status === "running") {
      await failValidationIfRunning(env.DB, item.validation_id);
    }

    const target =
      item.kind === "ml_task"
        ? await getMlTaskKernelCleanupTarget(env.DB, item.task_id, item.kernel_id)
        : await getValidationKernelCleanupTarget(env.DB, item.validation_id, item.kernel_id);
    if (!target) {
      skipped += 1;
      continue;
    }

    const serverKey = target.jupyter_server_key;
    const kernelId = target.kernel_id;
    if (!serverKey || !kernelId) {
      skipped += 1;
      continue;
    }

    let client = clientCache.get(serverKey);
    if (!client) {
      const server = await getJupyterServerByKey(env.DB, serverKey);
      if (!server) {
        failed += 1;
        errors.push({
          task_id: item.task_id,
          validation_id: item.validation_id,
          kernel_id: kernelId,
          error: `jupyter server not found: ${serverKey}`
        });
        const patch = {
          kernel_cleanup_status: "failed",
          kernel_cleanup_error: `jupyter server not found: ${serverKey}`
        };
        if (item.kind === "ml_task") {
          await patchMlTaskDiagnostics(env.DB, item.task_id, patch);
        } else {
          await patchValidationDiagnostics(env.DB, item.validation_id, patch);
        }
        continue;
      }
      client = new JupyterWorkerClient(server);
      clientCache.set(serverKey, client);
    }

    try {
      await client.shutdownKernel(kernelId);
      const marked =
        item.kind === "ml_task"
          ? await markMlTaskKernelCleaned(env.DB, item.task_id, kernelId, {
              kernel_cleanup_status: "deleted"
            })
          : await markValidationKernelCleaned(env.DB, item.validation_id, kernelId, {
              kernel_cleanup_status: "deleted"
            });
      if (marked.updated > 0) {
        deleted += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      if (isKernelAlreadyGone(error)) {
        const marked =
          item.kind === "ml_task"
            ? await markMlTaskKernelCleaned(env.DB, item.task_id, kernelId, {
                kernel_cleanup_status: "already_gone"
              })
            : await markValidationKernelCleaned(env.DB, item.validation_id, kernelId, {
                kernel_cleanup_status: "already_gone"
              });
        if (marked.updated > 0) {
          alreadyGone += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        task_id: item.task_id,
        validation_id: item.validation_id,
        kernel_id: kernelId,
        error: message
      });
      const patch = {
        kernel_cleanup_status: "failed",
        kernel_cleanup_error: message,
        kernel_cleanup_attempted_at: new Date().toISOString()
      };
      if (item.kind === "ml_task") {
        await patchMlTaskDiagnostics(env.DB, item.task_id, patch);
      } else {
        await patchValidationDiagnostics(env.DB, item.validation_id, patch);
      }
    }
  }

  return { deleted, alreadyGone, failed, skipped };
}

export async function runKernelCleanup(env, options = {}) {
  if (!(await cleanupEnabled(env.DB, env))) {
    return { skipped: true, reason: "kernel_cleanup_disabled" };
  }

  const force = options.force === true;
  const limit = parsePositiveInt(env.KERNEL_CLEANUP_LIMIT, 30, 100);
  const graceMinutes = force ? 0 : parsePositiveInt(env.KERNEL_CLEANUP_GRACE_MINUTES, 2, 60);
  const pendingValidations = force
    ? await listValidationsWithUncleanedKernels(env.DB, { limit })
    : await listValidationsPendingKernelCleanup(env.DB, {
        limit,
        graceMinutes
      });
  const pendingMlTasks = force
    ? await listMlTasksWithUncleanedKernels(env.DB, { limit })
    : await listMlTasksPendingKernelCleanup(env.DB, {
        limit,
        graceMinutes
      });
  const pending = [
    ...pendingValidations.map((item) => ({ kind: "legacy_validation", ...item })),
    ...pendingMlTasks.map((item) => ({ kind: "ml_task", ...item }))
  ];

  const clientCache = new Map();
  const errors = [];
  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  let skipped = 0;

  const staleExecutions = await cleanupStaleJupyterExecutions(env, {
    limit,
    graceMinutes,
    force
  });

  if (pending.length > 0) {
    const shutdownResult = await shutdownUncleanedKernelTargets(env, pending, clientCache, errors);
    deleted = shutdownResult.deleted;
    alreadyGone = shutdownResult.alreadyGone;
    failed = shutdownResult.failed;
    skipped = shutdownResult.skipped;
  }

  const orphanSweep = await sweepOrphanIdleKernels(env, {
    limit: parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_LIMIT, 30, 100),
    idleMinutes: force ? 0 : parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_IDLE_MINUTES, 5, 60)
  });

  let kernelReconcile = { skipped: true, reason: "not_do_mode" };
  let coordinatorTickResult = { skipped: true, reason: "not_do_mode" };
  if (jupyterExecutionViaDoEnabled(env)) {
    kernelReconcile = await runJupyterKernelReconcile(env);
    const serverKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
    try {
      coordinatorTickResult = await coordinatorTick(env, serverKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      coordinatorTickResult = { ok: false, error: message };
    }
  }

  if (
    pending.length === 0 &&
    staleExecutions.finalized === 0 &&
    orphanSweep.deleted === 0 &&
    orphanSweep.already_gone === 0 &&
    kernelReconcile.skipped
  ) {
    return {
      force,
      scanned: 0,
      deleted,
      already_gone: alreadyGone,
      failed,
      skipped,
      errors,
      stale_executions: staleExecutions,
      orphan_sweep: orphanSweep,
      kernel_reconcile: kernelReconcile,
      coordinator_tick: coordinatorTickResult
    };
  }

  return {
    force,
    scanned: pending.length,
    deleted,
    already_gone: alreadyGone,
    failed,
    skipped,
    errors,
    stale_executions: staleExecutions,
    orphan_sweep: orphanSweep,
    kernel_reconcile: kernelReconcile,
    coordinator_tick: coordinatorTickResult
  };
}
