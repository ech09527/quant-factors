const TERMINAL_TASK_STATUSES = new Set(["failed", "success", "skipped"]);

export function parseKernelLastActivityMs(kernel) {
  const raw = String(kernel?.last_activity ?? "").trim();
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 对比 Jupyter 实数与 D1 账本，返回需修复项（纯函数）。
 */
export function computeKernelLedgerDiscrepancies({
  jupyterKernels = [],
  executions = [],
  bindingsByKernelId = new Map(),
  nowMs = Date.now(),
  submittingStaleMinutes = 10,
  staleIdleRunningMinutes = 15,
  pendingExecutionStaleMinutes = 45
}) {
  const jupyterKernelIds = new Set(
    jupyterKernels.map((kernel) => String(kernel?.id ?? "").trim()).filter(Boolean)
  );
  const jupyterKernelById = new Map(
    jupyterKernels
      .map((kernel) => [String(kernel?.id ?? "").trim(), kernel])
      .filter(([kernelId]) => Boolean(kernelId))
  );
  const submittingStaleMs = submittingStaleMinutes * 60_000;
  const staleIdleRunningMs = staleIdleRunningMinutes * 60_000;
  const pendingExecutionStaleMs = pendingExecutionStaleMinutes * 60_000;

  const claimedKernelIds = new Set();
  for (const execution of executions) {
    const kernelId = String(execution.kernel_id ?? "").trim();
    if (kernelId) {
      claimedKernelIds.add(kernelId);
    }
  }

  const boundKernelIds = new Set();
  for (const [kernelId, binding] of bindingsByKernelId.entries()) {
    if (binding?.kernel_cleaned_at) {
      continue;
    }
    if (String(binding?.status ?? "") === "running" || claimedKernelIds.has(String(kernelId))) {
      boundKernelIds.add(String(kernelId));
    }
  }

  const discrepancies = [];

  for (const execution of executions) {
    const executionId = String(execution.id);
    const kernelId = String(execution.kernel_id ?? "").trim();
    const taskStatus = String(execution.task_status ?? "").trim();
    const executionStatus = String(execution.status ?? "").trim();
    const updatedMs = Date.parse(String(execution.updated_at ?? "")) || 0;

    if (taskStatus && TERMINAL_TASK_STATUSES.has(taskStatus)) {
      discrepancies.push({
        type: "orphan_execution",
        execution_id: executionId,
        business_id: String(execution.business_id ?? ""),
        kernel_id: kernelId || null,
        task_status: taskStatus,
        terminal_status: taskStatus === "success" ? "succeeded" : taskStatus
      });
      continue;
    }

    // callback 模式下 pending + active execution 是正常态；仅超时未回调才判失败
    if (
      taskStatus === "pending" &&
      ["queued", "submitting", "running"].includes(executionStatus)
    ) {
      const anchorRaw =
        execution.heartbeat_at ??
        execution.submitted_at ??
        execution.created_at ??
        execution.updated_at ??
        "";
      const anchorMs = Date.parse(String(anchorRaw)) || updatedMs;
      const activeMs = anchorMs > 0 ? Math.max(0, nowMs - anchorMs) : 0;
      if (activeMs >= pendingExecutionStaleMs) {
        discrepancies.push({
          type: "stale_task_pending_execution",
          execution_id: executionId,
          business_id: String(execution.business_id ?? ""),
          kernel_id: kernelId || null,
          active_ms: activeMs,
          terminal_status: "failed"
        });
      }
      continue;
    }

    if (kernelId && !jupyterKernelIds.has(kernelId)) {
      discrepancies.push({
        type: "ghost_execution",
        execution_id: executionId,
        business_id: String(execution.business_id ?? ""),
        kernel_id: kernelId,
        terminal_status: "failed"
      });
      continue;
    }

    const linkedKernel = kernelId ? jupyterKernelById.get(kernelId) : null;
    const kernelLastActivityMs = linkedKernel ? parseKernelLastActivityMs(linkedKernel) : 0;
    const kernelIdleMs =
      kernelLastActivityMs > 0 ? Math.max(0, nowMs - kernelLastActivityMs) : 0;
    const taskUpdatedMs = Date.parse(String(execution.task_updated_at ?? "")) || 0;
    const taskStaleMs = taskUpdatedMs > 0 ? Math.max(0, nowMs - taskUpdatedMs) : Number.POSITIVE_INFINITY;
    const heartbeatMs = Date.parse(String(execution.heartbeat_at ?? "")) || 0;
    const heartbeatAgeMs = heartbeatMs > 0 ? Math.max(0, nowMs - heartbeatMs) : Number.POSITIVE_INFINITY;

    if (
      executionStatus === "running" &&
      taskStatus === "running" &&
      linkedKernel &&
      String(linkedKernel.execution_state ?? "") === "idle" &&
      kernelIdleMs >= staleIdleRunningMs &&
      taskStaleMs >= staleIdleRunningMs &&
      heartbeatAgeMs >= staleIdleRunningMs
    ) {
      discrepancies.push({
        type: "stale_idle_running",
        execution_id: executionId,
        business_id: String(execution.business_id ?? ""),
        kernel_id: kernelId,
        kernel_idle_ms: kernelIdleMs,
        terminal_status: "failed"
      });
      continue;
    }
  }

  const orphanKernels = [];
  for (const kernel of jupyterKernels) {
    const kernelId = String(kernel?.id ?? "").trim();
    if (!kernelId) {
      continue;
    }
    if (claimedKernelIds.has(kernelId) || boundKernelIds.has(kernelId)) {
      continue;
    }
    orphanKernels.push({
      kernel_id: kernelId,
      execution_state: String(kernel?.execution_state ?? "unknown"),
      last_activity_ms: parseKernelLastActivityMs(kernel)
    });
  }

  return {
    jupyter_kernel_count: jupyterKernelIds.size,
    execution_active_count: executions.length,
    bound_kernel_count: boundKernelIds.size,
    claimed_kernel_count: claimedKernelIds.size,
    discrepancies,
    orphan_kernels: orphanKernels
  };
}
