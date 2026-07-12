import { JupyterWorkerClient, readMaxKernels } from "./jupyter-async.js";
import { coordinatorReport } from "./jupyter-coordinator-client.js";
import {
  jupyterExecutionViaDoEnabled,
  readJupyterExecutionTimeoutMinutes,
  readKernelStaleIdleRunningMinutes
} from "./jupyter-execution-config.js";
import { computeKernelLedgerDiscrepancies, parseKernelLastActivityMs } from "./jupyter-kernel-ledger-audit.js";
import { listActiveExecutionsWithTaskStatus } from "./jupyter-execution-db.js";
import { failMlTaskIfRunning, listJupyterMlTaskKernelBindings, getMlTaskById, failMlTaskIfActive } from "./ml-task-db.js";
import { getJupyterServerByKey } from "./validation-db.js";

export { computeKernelLedgerDiscrepancies } from "./jupyter-kernel-ledger-audit.js";

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function isKernelAlreadyGone(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

function reconcileEnabled(env) {
  const flag = String(env.KERNEL_RECONCILE_ENABLED ?? "1").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

function serverQueryable(server) {
  if (!server || server.enabled === false) {
    return { ok: false, reason: "server_disabled" };
  }
  if (server.proxy_url) {
    return { ok: false, reason: "proxy_not_supported" };
  }
  if (String(server.connect_mode ?? "") !== "kernel_channels") {
    return { ok: false, reason: "connect_mode_not_supported" };
  }
  return { ok: true };
}

async function finalizeViaCoordinator(env, serverKey, discrepancy, finalizeExecution) {
  const payload = {
    error_code: `reconcile_${discrepancy.type}`,
    error_reason: `kernel reconcile: ${discrepancy.type}`
  };

  if (discrepancy.type === "orphan_execution") {
    const task = await getMlTaskById(env.DB, Number(discrepancy.business_id));
    const taskStatus = String(task?.status ?? discrepancy.task_status ?? "").trim();
    if (task && !["success", "failed", "skipped"].includes(taskStatus)) {
      return { skipped: true, reason: "task_no_longer_terminal" };
    }
  }

  let finalizeResult = { finalized: true };
  if (finalizeExecution) {
    finalizeResult = await finalizeExecution(discrepancy.execution_id, discrepancy.terminal_status, payload);
  } else {
    finalizeResult = await coordinatorReport(env, serverKey, {
      execution_id: discrepancy.execution_id,
      terminal_status: discrepancy.terminal_status,
      ...payload
    });
  }

  if (finalizeResult?.finalized === false || finalizeResult?.skipped) {
    return finalizeResult;
  }

  const syncTaskTypes = new Set([
    "ghost_execution",
    "stale_idle_running",
    "stale_task_pending_execution"
  ]);
  if (syncTaskTypes.has(discrepancy.type)) {
    const taskId = Number(discrepancy.business_id);
    if (Number.isFinite(taskId) && taskId > 0) {
      if (discrepancy.type === "stale_task_pending_execution") {
        await failMlTaskIfActive(env.DB, taskId, payload.error_reason);
      } else {
        await failMlTaskIfRunning(env.DB, taskId, payload.error_reason);
      }
    }
  }

  return { finalized: true };
}

export async function reconcileJupyterKernelLedger(env, serverKey, options = {}) {
  if (!reconcileEnabled(env)) {
    return { skipped: true, reason: "kernel_reconcile_disabled" };
  }

  const dryRun = options.dryRun === true;
  const finalizeExecution = options.finalizeExecution ?? null;
  const orphanIdleMinutes = parsePositiveInt(
    options.orphanIdleMinutes ?? env.KERNEL_ORPHAN_SWEEP_IDLE_MINUTES,
    5,
    120
  );
  const submittingStaleMinutes = parsePositiveInt(options.submittingStaleMinutes, 10, 120);
  const staleIdleRunningMinutes = parsePositiveInt(
    options.staleIdleRunningMinutes ?? readKernelStaleIdleRunningMinutes(env, 5),
    readKernelStaleIdleRunningMinutes(env, 5),
    180
  );
  const orphanDeleteLimit = parsePositiveInt(options.orphanDeleteLimit, 30, 100);
  const pendingExecutionStaleMinutes = parsePositiveInt(
    options.pendingExecutionStaleMinutes ?? readJupyterExecutionTimeoutMinutes(env, 45),
    readJupyterExecutionTimeoutMinutes(env, 45),
    180
  );

  const server = await getJupyterServerByKey(env.DB, serverKey);
  const query = serverQueryable(server);
  if (!query.ok) {
    return { skipped: true, reason: query.reason, server_key: serverKey };
  }

  const client = new JupyterWorkerClient(server);
  let jupyterKernels = [];
  try {
    jupyterKernels = await client.listKernels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: true, reason: "jupyter_unreachable", error: message, server_key: serverKey };
  }

  const executions = await listActiveExecutionsWithTaskStatus(env.DB, serverKey);
  const bindingsByKernelId = await listJupyterMlTaskKernelBindings(env.DB);
  const audit = computeKernelLedgerDiscrepancies({
    jupyterKernels,
    executions,
    bindingsByKernelId,
    nowMs: Date.now(),
    submittingStaleMinutes,
    staleIdleRunningMinutes,
    pendingExecutionStaleMinutes
  });

  const maxSlots = readMaxKernels(server) ?? 30;
  const stats = {
    server_key: serverKey,
    dry_run: dryRun,
    jupyter_kernel_count: audit.jupyter_kernel_count,
    execution_active_count: audit.execution_active_count,
    max_slots: maxSlots,
    slot_pressure: audit.execution_active_count >= maxSlots,
    orphan_executions_finalized: 0,
    ghost_executions_finalized: 0,
    stale_submitting_finalized: 0,
    stale_idle_running_finalized: 0,
    stale_task_pending_execution_finalized: 0,
    orphan_kernels_deleted: 0,
    orphan_kernels_already_gone: 0,
    orphan_kernels_failed: 0,
    errors: []
  };

  if (dryRun) {
    return { ...stats, audit };
  }

  for (const discrepancy of audit.discrepancies) {
    try {
      const finalizeResult = await finalizeViaCoordinator(env, serverKey, discrepancy, finalizeExecution);
      if (finalizeResult?.skipped || finalizeResult?.finalized === false) {
        continue;
      }
      if (discrepancy.type === "orphan_execution") {
        stats.orphan_executions_finalized += 1;
      } else if (discrepancy.type === "ghost_execution") {
        stats.ghost_executions_finalized += 1;
      } else if (discrepancy.type === "stale_submitting") {
        stats.stale_submitting_finalized += 1;
      } else if (discrepancy.type === "stale_idle_running") {
        stats.stale_idle_running_finalized += 1;
      } else if (discrepancy.type === "stale_task_pending_execution") {
        stats.stale_task_pending_execution_finalized += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stats.errors.length < 10) {
        stats.errors.push({
          type: discrepancy.type,
          execution_id: discrepancy.execution_id,
          error: message
        });
      }
    }
  }

  const idleCutoffMs = Date.now() - orphanIdleMinutes * 60_000;
  const orphanCandidates = audit.orphan_kernels
    .filter((kernel) => {
      if (kernel.execution_state === "starting") {
        return true;
      }
      if (kernel.execution_state !== "idle") {
        return false;
      }
      return kernel.last_activity_ms > 0 && kernel.last_activity_ms < idleCutoffMs;
    })
    .slice(0, orphanDeleteLimit);

  for (const kernel of orphanCandidates) {
    try {
      await client.shutdownKernel(kernel.kernel_id);
      stats.orphan_kernels_deleted += 1;
    } catch (error) {
      if (isKernelAlreadyGone(error)) {
        stats.orphan_kernels_already_gone += 1;
        continue;
      }
      stats.orphan_kernels_failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (stats.errors.length < 10) {
        stats.errors.push({
          type: "orphan_kernel_delete",
          kernel_id: kernel.kernel_id,
          error: message
        });
      }
    }
  }

  return {
    ...stats,
    audit_summary: {
      discrepancy_count: audit.discrepancies.length,
      orphan_kernel_candidates: audit.orphan_kernels.length,
      orphan_idle_deleted: orphanCandidates.length
    }
  };
}

export async function runJupyterKernelReconcile(env, options = {}) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true, reason: "jupyter_execution_via_do_disabled" };
  }
  const serverKey =
    options.serverKey?.trim() ||
    env.VALIDATION_JUPYTER_SERVER_KEY?.trim() ||
    "lynas-pub";
  return reconcileJupyterKernelLedger(env, serverKey, options);
}
