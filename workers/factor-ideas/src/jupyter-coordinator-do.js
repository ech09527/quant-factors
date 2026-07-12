import { JupyterWorkerClient, readMaxKernels } from "./jupyter-async.js";
import {
  coordinatorInternalToken,
  readJupyterExecutionTimeoutMinutes,
  readJupyterWebSocketListenTimeoutMs
} from "./jupyter-execution-config.js";
import { buildCompletionEvent } from "./jupyter-execution-completion.js";
import { reportJupyterExecutionBusinessFailure } from "./jupyter-execution-business-handlers.js";
import {
  getJupyterExecutionById,
  listActiveJupyterExecutionsForServer,
  listOrphanedRunningExecutions,
  listStaleSubmittingExecutions,
  listTimedOutRunningExecutions,
  listZombieRunningExecutions,
  updateJupyterExecution
} from "./jupyter-execution-db.js";
import { loadExecutionJob } from "./jupyter-execution-jobs.js";
import { invokeCompletionHandler, registerDefaultHandlers } from "./jupyter-executor.js";
import {
  finalizeJupyterExecution,
  getJupyterExecutionCapacity
} from "./jupyter-execution-runtime.js";
import { reconcileJupyterKernelLedger } from "./jupyter-kernel-reconcile.js";
import { parseKernelLastActivityMs } from "./jupyter-kernel-ledger-audit.js";
import { failMlTaskIfRunning, getMlTaskById, isMlValidationBusinessType } from "./ml-task-db.js";
import { getJupyterServerByKey } from "./validation-db.js";

const ALARM_INTERVAL_MS = 30_000;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function isAuthorized(request, env) {
  const expected = coordinatorInternalToken(env);
  if (!expected) {
    return false;
  }
  return request.headers.get("X-Coordinator-Token") === expected;
}

function isExecutionAlreadyFinalized(execution) {
  if (!execution) {
    return true;
  }
  if (execution.cleanup_at) {
    return true;
  }
  return ["succeeded", "failed", "skipped", "timed_out"].includes(String(execution.status ?? ""));
}

function mapTaskStatusToExecutionStatus(taskStatus) {
  const status = String(taskStatus ?? "").trim();
  if (status === "success") {
    return "succeeded";
  }
  if (status === "failed" || status === "skipped") {
    return status;
  }
  return null;
}

export class JupyterServerCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.serverKey = null;
    this.maxSlots = 30;
    this.queue = [];
    this.running = new Map();
    this.hydrated = false;
  }

  async fetch(request) {
    registerDefaultHandlers();

    if (!isAuthorized(request, this.env)) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    await this.ensureHydrated();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "POST" && path === "/submit") {
        const body = await request.json();
        const executionId = String(body.execution_id ?? "").trim();
        if (!executionId) {
          return jsonResponse({ ok: false, error: "execution_id required" }, 400);
        }
        const { dispatchJupyterExecution } = await import("./jupyter-execution-runtime.js");
        const result = await dispatchJupyterExecution(this.env, {
          executionId,
          serverKey: this.serverKey
        });
        const status =
          result.reason === "capacity_full"
            ? 429
            : result.reason === "kernel_list_failed"
              ? 503
              : result.ok === false && result.failed
                ? 500
                : 200;
        return jsonResponse({ ok: Boolean(result.ok ?? result.submitted), ...result }, status);
      }

      if (request.method === "POST" && path === "/fill") {
        return jsonResponse({
          ok: true,
          deprecated: true,
          reason: "use_jupyter_execution_queue_instead_of_fill"
        });
      }

      if (request.method === "POST" && path === "/enqueue") {
        return jsonResponse({
          ok: true,
          deprecated: true,
          reason: "in_memory_enqueue_disabled_use_d1_queued_and_fill"
        });
      }

      if (request.method === "POST" && path === "/report") {
        const body = await request.json();
        const executionId = String(body.execution_id ?? "").trim();
        if (!executionId) {
          return jsonResponse({ ok: false, error: "execution_id required" }, 400);
        }
        const existing = await getJupyterExecutionById(this.env.DB, executionId);
        if (isExecutionAlreadyFinalized(existing)) {
          return jsonResponse({ ok: true, skipped: true, reason: "already_finalized" });
        }
        const terminalStatus = String(body.terminal_status ?? "succeeded");
        const result = await this.finalizeWithCompletionHandler(
          executionId,
          existing,
          terminalStatus,
          {
            errorCode: body.error_code ?? "legacy_http_report",
            errorReason: body.error_reason ?? null
          }
        );
        return jsonResponse({ ok: true, legacy_report: true, ...result });
      }

      if (request.method === "POST" && path === "/tick") {
        const tick = await this.tickInternal();
        return jsonResponse({ ok: true, ...tick });
      }

      if (request.method === "POST" && path === "/reconcile") {
        const body = await request.json().catch(() => ({}));
        const reconcile = await reconcileJupyterKernelLedger(this.env, this.serverKey, {
          dryRun: body.dry_run === true,
          finalizeExecution: async (executionId, terminalStatus, patch) => {
            const execution = await getJupyterExecutionById(this.env.DB, executionId);
            if (!execution) {
              return { finalized: false, reason: "not_found" };
            }
            return this.finalizeWithCompletionHandler(executionId, execution, terminalStatus, {
              errorCode: patch?.error_code ?? null,
              errorReason: patch?.error_reason ?? null
            });
          }
        });
        const tick = body.tick_after === false ? null : await this.tickInternal({ skipReconcile: true });
        return jsonResponse({ ok: true, reconcile, tick });
      }

      if (request.method === "GET" && path === "/status") {
        await this.refreshMaxSlotsFromDb();
        const capacity = await this.getExecutionCapacity();
        return jsonResponse({
          ok: true,
          server_key: this.serverKey,
          max_slots: this.maxSlots,
          queue_length: this.queue.length,
          running_count: this.running.size,
          queue: [...this.queue],
          running: [...this.running.keys()],
          capacity
        });
      }

      return jsonResponse({ ok: false, error: "not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message }, 500);
    }
  }

  async alarm() {
    await this.ensureHydrated();
    await this.tickInternal();
    const activeRunning = await listActiveJupyterExecutionsForServer(this.env.DB, this.serverKey);
    if (activeRunning.some((item) => item.status === "running")) {
      await this.scheduleAlarm();
    }
  }

  async ensureHydrated() {
    if (this.hydrated) {
      return;
    }
    const stored = await this.ctx.storage.get("coordinator_state");
    if (stored && typeof stored === "object") {
      this.serverKey = stored.server_key ?? null;
      this.maxSlots = Number(stored.max_slots ?? 30);
      this.queue = Array.isArray(stored.queue) ? stored.queue.map(String) : [];
      this.running = new Map(
        Object.entries(stored.running ?? {}).map(([id, value]) => [String(id), value])
      );
    }

    if (!this.serverKey) {
      const preferred = this.env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
      this.serverKey = preferred;
    }

    const server = await getJupyterServerByKey(this.env.DB, this.serverKey);
    if (server) {
      this.maxSlots = readMaxKernels(server) ?? 30;
    }

    const active = await listActiveJupyterExecutionsForServer(this.env.DB, this.serverKey);
    const activeIds = new Set(active.map((item) => item.id));
    const runningFromDb = new Map();
    const queuedFromDb = [];
    for (const item of active) {
      if (item.status === "running") {
        runningFromDb.set(item.id, {
          kernel_id: item.kernel_id,
          submitted_at: item.submitted_at
        });
      } else if (item.status === "queued") {
        queuedFromDb.push(item.id);
      }
    }
    this.running = runningFromDb;
    const mergedQueue = [];
    for (const id of this.queue) {
      if (activeIds.has(id) && !this.running.has(id) && !mergedQueue.includes(id)) {
        mergedQueue.push(id);
      }
    }
    for (const id of queuedFromDb) {
      if (!this.running.has(id) && !mergedQueue.includes(id)) {
        mergedQueue.push(id);
      }
    }
    this.queue = mergedQueue;

    this.hydrated = true;
    await this.persistState();
  }

  async persistState() {
    await this.ctx.storage.put("coordinator_state", {
      server_key: this.serverKey,
      max_slots: this.maxSlots,
      queue: this.queue,
      running: Object.fromEntries(this.running.entries())
    });
  }

  async scheduleAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async refreshMaxSlotsFromDb() {
    const server = await getJupyterServerByKey(this.env.DB, this.serverKey);
    if (!server) {
      return;
    }
    const next = readMaxKernels(server) ?? 30;
    if (next !== this.maxSlots) {
      this.maxSlots = next;
      await this.persistState();
    }
  }

  async tickInternal(options = {}) {
    await this.refreshMaxSlotsFromDb();
    let reconcile = { skipped: true, reason: "skipped_in_tick" };
    if (!options.skipReconcile) {
      reconcile = await reconcileJupyterKernelLedger(this.env, this.serverKey, {
        finalizeExecution: async (executionId, terminalStatus, patch) => {
          const execution = await getJupyterExecutionById(this.env.DB, executionId);
          if (!execution) {
            return { finalized: false, reason: "not_found" };
          }
          return this.finalizeWithCompletionHandler(executionId, execution, terminalStatus, {
            errorCode: patch?.error_code ?? null,
            errorReason: patch?.error_reason ?? null
          });
        }
      });
    }
    const timedOut = await this.failTimedOutExecutions();
    const idleSweep = await this.sweepIdleRunningExecutions();
    return { reconcile, timed_out: timedOut, idle_sweep: idleSweep };
  }

  async getExecutionCapacity() {
    return getJupyterExecutionCapacity(this.env, this.serverKey);
  }

  async failTimedOutExecutions() {
    const timeoutMinutes = readJupyterExecutionTimeoutMinutes(this.env);
    let count = 0;

    const zombies = await listZombieRunningExecutions(this.env.DB, this.serverKey);
    for (const item of zombies) {
      const taskId = Number(item.business_id);
      const task =
        Number.isFinite(taskId) && taskId > 0 ? await getMlTaskById(this.env.DB, taskId) : null;
      const mappedTaskStatus = mapTaskStatusToExecutionStatus(task?.status);
      const terminalStatus = mappedTaskStatus ?? "failed";
      await updateJupyterExecution(this.env.DB, item.id, {
        status: terminalStatus,
        error_code: item.error_code ?? "zombie_running_execution",
        error_reason:
          item.error_reason ??
          "execution status running after cleanup_at (submit/finalize race repaired)"
      });
      this.running.delete(item.id);
      count += 1;
    }

    const orphaned = await listOrphanedRunningExecutions(this.env.DB, this.serverKey);
    for (const item of orphaned) {
      const taskId = Number(item.business_id);
      const task =
        Number.isFinite(taskId) && taskId > 0 ? await getMlTaskById(this.env.DB, taskId) : null;
      const mappedTaskStatus = mapTaskStatusToExecutionStatus(task?.status);
      const terminalStatus = mappedTaskStatus ?? "failed";
      await this.finalizeWithCompletionHandler(item.id, item, terminalStatus, {
        errorCode: "orphan_execution",
        errorReason: "ml_task already terminal while execution still running"
      });
      count += 1;
    }

    const items = await listTimedOutRunningExecutions(this.env.DB, timeoutMinutes);
    for (const item of items) {
      const reason = `jupyter execution timed out after ${timeoutMinutes} minutes`;
      if (isMlValidationBusinessType(item.business_type)) {
        const taskId = Number(item.business_id);
        if (Number.isFinite(taskId) && taskId > 0) {
          await failMlTaskIfRunning(this.env.DB, taskId, reason);
        }
      }
      await this.finalizeWithCompletionHandler(item.id, item, "timed_out", {
        errorCode: "timeout",
        errorReason: reason
      });
      count += 1;
    }

    const staleSubmitting = await listStaleSubmittingExecutions(this.env.DB, 10);
    for (const item of staleSubmitting) {
      await updateJupyterExecution(this.env.DB, item.id, { status: "queued" });
      count += 1;
    }
    return count;
  }

  /** Callback 模式下：kernel 已 idle 但未收到 HTTP 回调时的兜底清扫 */
  async sweepIdleRunningExecutions({ minIdleMs = 15_000 } = {}) {
    const server = await getJupyterServerByKey(this.env.DB, this.serverKey);
    if (!server) {
      return { swept: 0 };
    }

    const runningExecutions = (
      await listActiveJupyterExecutionsForServer(this.env.DB, this.serverKey)
    ).filter((execution) => execution.status === "running");
    if (runningExecutions.length === 0) {
      return { swept: 0 };
    }

    let kernels = [];
    try {
      kernels = await new JupyterWorkerClient(server).listKernels();
    } catch {
      return { swept: 0 };
    }

    const kernelById = new Map(kernels.map((kernel) => [kernel.id, kernel]));
    let swept = 0;

    for (const execution of runningExecutions) {
      const executionId = execution.id;
      const kernelId = execution.kernel_id;
      if (!kernelId) {
        continue;
      }

      const kernel = kernelById.get(kernelId);
      if (!kernel || kernel.execution_state !== "idle") {
        continue;
      }

      const lastActivityMs = parseKernelLastActivityMs(kernel);
      if (lastActivityMs > 0 && Date.now() - lastActivityMs < minIdleMs) {
        continue;
      }

      const heartbeatMs = execution.heartbeat_at ? Date.parse(String(execution.heartbeat_at)) : 0;
      if (heartbeatMs > 0 && Date.now() - heartbeatMs < minIdleMs) {
        continue;
      }

      const listenTimeoutMs = readJupyterWebSocketListenTimeoutMs(
        this.env,
        execution.business_type
      );
      const submittedMs = execution.submitted_at ? Date.parse(String(execution.submitted_at)) : 0;
      if (submittedMs > 0 && Date.now() - submittedMs < listenTimeoutMs) {
        continue;
      }

      const job = await loadExecutionJob(this.env.DB, execution);
      if (!job) {
        continue;
      }

      const taskId = Number(execution.business_id);
      const task =
        Number.isFinite(taskId) && taskId > 0 ? await getMlTaskById(this.env.DB, taskId) : null;
      const mappedTaskStatus = mapTaskStatusToExecutionStatus(task?.status);
      if (mappedTaskStatus) {
        await this.finalizeWithCompletionHandler(executionId, execution, mappedTaskStatus, {
          errorReason: mappedTaskStatus === "failed" ? task?.error_reason ?? null : null
        });
        swept += 1;
        continue;
      }

      const reason = "kernel idle without execution callback";
      await reportJupyterExecutionBusinessFailure(
        this.env,
        execution,
        job,
        reason,
        "kernel_idle_no_callback"
      );
      await this.finalizeWithCompletionHandler(executionId, execution, "failed", {
        errorCode: "idle_no_callback",
        errorReason: reason
      });
      swept += 1;
    }

    return { swept };
  }

  async finalizeWithCompletionHandler(
    executionId,
    execution,
    terminalStatus,
    { errorCode = null, errorReason = null, parsed = null } = {}
  ) {
    const executionNow = await getJupyterExecutionById(this.env.DB, executionId);
    if (isExecutionAlreadyFinalized(executionNow)) {
      return { skipped: true, reason: "already_finalized" };
    }

    if (parsed) {
      const event = buildCompletionEvent(execution, terminalStatus, parsed, errorCode, errorReason);
      await invokeCompletionHandler(this.env, event);
    }

    this.running.delete(executionId);
    this.queue = this.queue.filter((id) => id !== executionId);
    await this.persistState();

    return finalizeJupyterExecution(this.env, executionId, terminalStatus, {
      error_code: errorCode,
      error_reason: errorReason
    });
  }
}
