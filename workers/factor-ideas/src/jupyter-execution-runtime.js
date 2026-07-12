import { JupyterWorkerClient, readMaxKernels } from "./jupyter-async.js";
import {
  buildCompletionEvent,
  mapBusinessStatusToExecutionStatus
} from "./jupyter-execution-completion.js";
import { buildJupyterExecutionCode } from "./jupyter-execution-code.js";
import { reportJupyterExecutionBusinessFailure } from "./jupyter-execution-business-handlers.js";
import {
  compareAndSetJupyterExecutionStatus,
  countActiveJupyterExecutionsForServer,
  getJupyterExecutionById,
  updateJupyterExecution
} from "./jupyter-execution-db.js";
import { invokeCompletionHandler, registerDefaultHandlers } from "./jupyter-executor.js";
import { loadExecutionJob } from "./jupyter-execution-jobs.js";
import {
  collectMlTaskKernelIdsForCleanup,
  isMlValidationBusinessType,
  markMlTaskKernelCleanedForTask,
  markMlTaskRunningIfPending
} from "./ml-task-db.js";
import { getJupyterServerByKey, markJupyterServerUsed } from "./validation-db.js";

function isExecutionTerminal(execution) {
  if (!execution) {
    return true;
  }
  if (execution.cleanup_at) {
    return true;
  }
  return ["succeeded", "failed", "skipped", "timed_out"].includes(String(execution.status ?? ""));
}

function isKernelAlreadyGone(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

export async function getJupyterExecutionCapacity(env, serverKey) {
  const server = await getJupyterServerByKey(env.DB, serverKey);
  if (!server) {
    return { available: 0, used: 0, reason: "server_not_found" };
  }

  const maxSlots = readMaxKernels(server) ?? 40;
  let jupyterKernelCount = 0;
  try {
    const kernels = await new JupyterWorkerClient(server).listKernels();
    jupyterKernelCount = kernels.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: 0, used: 0, reason: "kernel_list_failed", error: message, max_slots: maxSlots };
  }

  const activeCount = await countActiveJupyterExecutionsForServer(env.DB, serverKey);
  const used = Math.max(jupyterKernelCount, activeCount);
  const available = Math.max(0, maxSlots - used);
  return {
    available,
    used,
    jupyter_kernel_count: jupyterKernelCount,
    active_execution_count: activeCount,
    max_slots: maxSlots
  };
}

/**
 * 短 WS 触发执行：createKernel + execute_request 后立即断开，结果由 Jupyter HTTP 回调。
 */
export async function dispatchJupyterExecution(env, { executionId, serverKey }) {
  registerDefaultHandlers();

  const execution = await getJupyterExecutionById(env.DB, executionId);
  if (!execution || execution.server_key !== serverKey) {
    return { ok: false, reason: "execution_not_found" };
  }
  if (execution.status !== "queued") {
    if (execution.status === "running" || execution.status === "submitting") {
      return { ok: true, skipped: true, reason: "already_active" };
    }
    return { ok: false, reason: "invalid_status", status: execution.status };
  }

  const capacity = await getJupyterExecutionCapacity(env, serverKey);
  if (capacity.reason === "kernel_list_failed") {
    return { ok: false, reason: "kernel_list_failed", ...capacity };
  }
  if (capacity.available <= 0) {
    return { ok: false, reason: "capacity_full", ...capacity };
  }

  const claimed = await compareAndSetJupyterExecutionStatus(
    env.DB,
    executionId,
    "queued",
    "submitting"
  );
  if (claimed.updated === 0) {
    return { ok: false, deferred: true, reason: "claim_failed" };
  }

  const server = await getJupyterServerByKey(env.DB, serverKey);
  if (!server) {
    await finalizeJupyterExecution(env, executionId, "failed", {
      error_code: "server_not_found",
      error_reason: `jupyter server not found: ${serverKey}`
    });
    return { ok: false, failed: true, reason: "server_not_found" };
  }

  const runtimeConfig = server.runtime_config ?? { target_file: "futures/um/klines/1h.parquet" };
  const job = await loadExecutionJob(env.DB, execution);
  if (!job) {
    await finalizeJupyterExecution(env, executionId, "failed", {
      error_code: "job_not_found",
      error_reason: "execution job not found"
    });
    return { ok: false, failed: true, reason: "job_not_found" };
  }

  const jupyter = new JupyterWorkerClient(server);
  try {
    const code = buildJupyterExecutionCode(env, execution, job, runtimeConfig);
    const submitInfo = await jupyter.submitExecuteAsync(code);
    const submittedAt = new Date().toISOString();

    const claimedRunning = await compareAndSetJupyterExecutionStatus(
      env.DB,
      executionId,
      "submitting",
      "running",
      {
        kernel_id: submitInfo.kernel_id,
        session_id: submitInfo.session_id,
        msg_id: submitInfo.msg_id,
        submitted_at: submittedAt,
        heartbeat_at: submittedAt,
        error_code: null,
        error_reason: null
      }
    );
    if (claimedRunning.updated === 0) {
      try {
        await jupyter.shutdownKernel(submitInfo.kernel_id);
      } catch {
        // ignore cleanup race
      }
      return { ok: false, deferred: true, reason: "running_claim_failed" };
    }

    if (isMlValidationBusinessType(execution.business_type)) {
      const taskId = Number(execution.business_id);
      if (Number.isFinite(taskId) && taskId > 0) {
        await markMlTaskRunningIfPending(env.DB, taskId, {
          stage: "jupyter_submitted",
          jupyter_server_key: server.key,
          jupyter_execution_id: executionId,
          kernel_id: submitInfo.kernel_id,
          session_id: submitInfo.session_id,
          msg_id: submitInfo.msg_id,
          submitted_at: submittedAt,
          dispatch_mode: "ws_dispatch_http_callback"
        });
      }
    }

    await markJupyterServerUsed(env.DB, server.key);
    return {
      ok: true,
      submitted: true,
      mode: "ws_dispatch_http_callback",
      kernel_id: submitInfo.kernel_id,
      ...capacity
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeJupyterExecution(env, executionId, "failed", {
      error_code: "jupyter_dispatch",
      error_reason: message
    });
    return { ok: false, failed: true, reason: "jupyter_dispatch", error: message };
  }
}

function pickTerminalStatusFromCallback(body, parsed) {
  const topError = body?.error == null ? null : String(body.error).trim();
  if (topError) {
    return "failed";
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  if (results.length === 0) {
    return "failed";
  }
  return mapBusinessStatusToExecutionStatus(results[0]?.status);
}

export async function handleJupyterExecutionHeartbeat(env, body) {
  const executionId = String(body?.execution_id ?? "").trim();
  if (!executionId) {
    return { ok: false, error: "execution_id required" };
  }

  const execution = await getJupyterExecutionById(env.DB, executionId);
  if (!execution) {
    return { ok: false, error: "execution_not_found" };
  }
  if (isExecutionTerminal(execution)) {
    return { ok: true, skipped: true, reason: "already_finalized", status: execution.status };
  }
  if (!["queued", "submitting", "running"].includes(String(execution.status ?? ""))) {
    return { ok: true, skipped: true, reason: "not_active", status: execution.status };
  }

  const heartbeatAt = new Date().toISOString();
  await updateJupyterExecution(env.DB, executionId, { heartbeat_at: heartbeatAt });
  return {
    ok: true,
    execution_id: executionId,
    heartbeat_at: heartbeatAt,
    phase: body?.phase == null ? null : String(body.phase)
  };
}

export async function handleJupyterExecutionCallback(env, body) {
  registerDefaultHandlers();

  const executionId = String(body?.execution_id ?? "").trim();
  if (!executionId) {
    return { ok: false, error: "execution_id required" };
  }

  const execution = await getJupyterExecutionById(env.DB, executionId);
  if (!execution) {
    return { ok: false, error: "execution_not_found" };
  }
  if (isExecutionTerminal(execution)) {
    return { ok: true, skipped: true, reason: "already_finalized", status: execution.status };
  }

  const job = await loadExecutionJob(env.DB, execution);
  if (!job) {
    await finalizeJupyterExecution(env, executionId, "failed", {
      error_code: "job_not_found",
      error_reason: "execution job not found on callback"
    });
    return { ok: false, error: "job_not_found" };
  }

  const parsed = body?.results && typeof body.results === "object" ? body.results : {};
  const topError = body?.error == null ? null : String(body.error).trim();
  let terminalStatus = pickTerminalStatusFromCallback(body, parsed);
  let errorCode = null;
  let errorReason = topError;

  if (topError) {
    terminalStatus = "failed";
    errorCode = "kernel_callback_error";
    errorReason = topError;
    await reportJupyterExecutionBusinessFailure(
      env,
      execution,
      job,
      topError,
      "kernel_callback"
    );
  } else if (!Array.isArray(parsed?.results) || parsed.results.length === 0) {
    terminalStatus = "failed";
    errorCode = "kernel_callback_empty";
    errorReason = "callback delivered empty results";
    await reportJupyterExecutionBusinessFailure(
      env,
      execution,
      job,
      errorReason,
      "kernel_callback_empty"
    );
  } else {
    terminalStatus = pickTerminalStatusFromCallback(body, parsed);
    const event = buildCompletionEvent(execution, terminalStatus, parsed, errorCode, errorReason);
    const handlerResult = await invokeCompletionHandler(env, event);
    if (Number(handlerResult?.updated ?? 0) <= 0) {
      terminalStatus = "failed";
      errorCode = "marker_report_rejected";
      errorReason = "callback parsed but business report did not update";
    }
  }

  const finalized = await finalizeJupyterExecution(env, executionId, terminalStatus, {
    error_code: errorCode,
    error_reason: errorReason
  });

  return {
    ok: true,
    execution_id: executionId,
    terminal_status: terminalStatus,
    ...finalized
  };
}

export async function finalizeJupyterExecution(
  env,
  executionId,
  terminalStatus,
  { error_code = null, error_reason = null } = {}
) {
  const execution = await getJupyterExecutionById(env.DB, executionId);
  if (!execution) {
    return { finalized: false, reason: "not_found" };
  }
  if (isExecutionTerminal(execution) && execution.cleanup_at) {
    return { finalized: false, reason: "already_finalized", status: execution.status };
  }

  const finalStatus = ["succeeded", "failed", "skipped", "timed_out"].includes(terminalStatus)
    ? terminalStatus
    : "failed";
  const kernelId = execution.kernel_id == null ? null : String(execution.kernel_id).trim();
  const server = await getJupyterServerByKey(env.DB, execution.server_key);
  let cleanupError = null;
  let mlTaskCleanupStatus = "deleted";

  const kernelIdsToShutdown = new Set();
  if (kernelId) {
    kernelIdsToShutdown.add(kernelId);
  }
  let mlTaskId = null;
  if (isMlValidationBusinessType(execution.business_type)) {
    mlTaskId = Number(execution.business_id);
    if (Number.isFinite(mlTaskId) && mlTaskId > 0) {
      const cleanupTargets = await collectMlTaskKernelIdsForCleanup(env.DB, mlTaskId, kernelId);
      for (const kid of cleanupTargets.kernel_ids) {
        kernelIdsToShutdown.add(kid);
      }
    }
  }

  if (kernelIdsToShutdown.size > 0 && server) {
    const client = new JupyterWorkerClient(server);
    for (const kid of kernelIdsToShutdown) {
      try {
        await client.shutdownKernel(kid);
      } catch (error) {
        if (isKernelAlreadyGone(error)) {
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        cleanupError = cleanupError ? `${cleanupError}; ${kid}: ${message}` : `${kid}: ${message}`;
        mlTaskCleanupStatus = "failed";
      }
    }
  }

  if (mlTaskId != null && Number.isFinite(mlTaskId) && mlTaskId > 0) {
    await markMlTaskKernelCleanedForTask(env.DB, mlTaskId, {
      kernel_cleanup_status: cleanupError ? mlTaskCleanupStatus : "deleted",
      ...(cleanupError ? { kernel_cleanup_error: cleanupError.slice(0, 500) } : {})
    });
  }

  await updateJupyterExecution(env.DB, executionId, {
    status: finalStatus,
    completed_at: execution.completed_at ?? new Date().toISOString(),
    cleanup_at: new Date().toISOString(),
    error_code,
    error_reason: cleanupError
      ? [error_reason, `cleanup: ${cleanupError}`].filter(Boolean).join("; ")
      : error_reason
  });

  return { finalized: true, status: finalStatus, kernel_id: kernelId ?? null };
}
