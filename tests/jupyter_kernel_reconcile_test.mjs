import { computeKernelLedgerDiscrepancies } from "../workers/factor-ideas/src/jupyter-kernel-ledger-audit.js";

const NOW = Date.parse("2026-07-11T08:00:00.000Z");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const ghost = computeKernelLedgerDiscrepancies({
  jupyterKernels: [{ id: "k-live", execution_state: "busy" }],
  executions: [
    {
      id: "exec-1",
      business_id: "10",
      status: "running",
      kernel_id: "k-dead",
      task_status: "running",
      updated_at: "2026-07-11T00:00:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW
});
assert(
  ghost.discrepancies.some((item) => item.type === "ghost_execution"),
  "expected ghost_execution"
);

const orphan = computeKernelLedgerDiscrepancies({
  jupyterKernels: [],
  executions: [
    {
      id: "exec-2",
      business_id: "11",
      status: "running",
      kernel_id: "k1",
      task_status: "failed",
      updated_at: "2026-07-11T00:00:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW
});
assert(orphan.discrepancies[0]?.type === "orphan_execution", "expected orphan_execution");

const orphanKernel = computeKernelLedgerDiscrepancies({
  jupyterKernels: [
    {
      id: "k-orphan",
      execution_state: "idle",
      last_activity: "2026-07-10T00:00:00.000Z"
    }
  ],
  executions: [],
  bindingsByKernelId: new Map(),
  nowMs: NOW
});
assert(orphanKernel.orphan_kernels[0]?.kernel_id === "k-orphan", "expected orphan kernel");

const staleIdle = computeKernelLedgerDiscrepancies({
  jupyterKernels: [
    {
      id: "k-stuck",
      execution_state: "idle",
      last_activity: "2026-07-11T07:30:00.000Z"
    }
  ],
  executions: [
    {
      id: "exec-stuck",
      business_id: "12",
      status: "running",
      kernel_id: "k-stuck",
      task_status: "running",
      updated_at: "2026-07-11T07:30:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW,
  staleIdleRunningMinutes: 15
});
assert(
  staleIdle.discrepancies.some((item) => item.type === "stale_idle_running"),
  "expected stale_idle_running"
);

const staleIdleWithHeartbeat = computeKernelLedgerDiscrepancies({
  jupyterKernels: [
    {
      id: "k-busy-io",
      execution_state: "idle",
      last_activity: "2026-07-11T07:30:00.000Z"
    }
  ],
  executions: [
    {
      id: "exec-io",
      business_id: "16",
      status: "running",
      kernel_id: "k-busy-io",
      task_status: "running",
      updated_at: "2026-07-11T07:30:00.000Z",
      heartbeat_at: "2026-07-11T07:59:30.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW,
  staleIdleRunningMinutes: 15
});
assert(
  !staleIdleWithHeartbeat.discrepancies.some((item) => item.type === "stale_idle_running"),
  "fresh heartbeat should prevent stale_idle_running during long eval"
);

const pendingActiveOk = computeKernelLedgerDiscrepancies({
  jupyterKernels: [{ id: "k-live", execution_state: "busy" }],
  executions: [
    {
      id: "exec-pending",
      business_id: "13",
      status: "running",
      kernel_id: "k-live",
      task_status: "pending",
      created_at: "2026-07-11T07:50:00.000Z",
      submitted_at: "2026-07-11T07:50:00.000Z",
      updated_at: "2026-07-11T07:50:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW,
  pendingExecutionStaleMinutes: 45
});
assert(
  !pendingActiveOk.discrepancies.some((item) => item.type === "stale_task_pending_execution"),
  "pending + active execution within timeout should not be flagged"
);

const pendingActiveStale = computeKernelLedgerDiscrepancies({
  jupyterKernels: [{ id: "k-live", execution_state: "idle" }],
  executions: [
    {
      id: "exec-pending-stale",
      business_id: "14",
      status: "running",
      kernel_id: "k-live",
      task_status: "pending",
      created_at: "2026-07-11T06:00:00.000Z",
      submitted_at: "2026-07-11T06:00:00.000Z",
      updated_at: "2026-07-11T06:00:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW,
  pendingExecutionStaleMinutes: 45
});
assert(
  pendingActiveStale.discrepancies.some((item) => item.type === "stale_task_pending_execution"),
  "expected stale_task_pending_execution after timeout"
);

const pendingWithHeartbeat = computeKernelLedgerDiscrepancies({
  jupyterKernels: [{ id: "k-live", execution_state: "busy" }],
  executions: [
    {
      id: "exec-heartbeat",
      business_id: "15",
      status: "running",
      kernel_id: "k-live",
      task_status: "running",
      created_at: "2026-07-11T06:00:00.000Z",
      submitted_at: "2026-07-11T06:00:00.000Z",
      heartbeat_at: "2026-07-11T07:55:00.000Z",
      updated_at: "2026-07-11T07:55:00.000Z"
    }
  ],
  bindingsByKernelId: new Map(),
  nowMs: NOW,
  pendingExecutionStaleMinutes: 45
});
assert(
  !pendingWithHeartbeat.discrepancies.some((item) => item.type === "stale_task_pending_execution"),
  "recent heartbeat should prevent stale pending execution"
);

console.log("jupyter_kernel_reconcile_test.mjs OK");
