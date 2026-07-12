import { coordinatorGetStatus } from "./jupyter-coordinator-client.js";
import {
  getJupyterKernelCapacity,
  JupyterWorkerClient,
  readMaxKernels
} from "./jupyter-async.js";
import {
  listActiveExecutionsWithTaskStatus,
  listZombieRunningExecutions
} from "./jupyter-execution-db.js";
import {
  getJupyterServerByKey,
  listJupyterServers
} from "./validation-db.js";

function parseKernelLastActivityMs(kernel) {
  const raw = String(kernel?.last_activity ?? "").trim();
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function serverQueryable(server) {
  if (server.enabled === false) {
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

async function countExecutionsByStatus(db, serverKey) {
  const result = await db.prepare(
    `SELECT status, COUNT(*) AS n
       FROM jupyter_executions
       WHERE server_key = ?
         AND status IN ('queued', 'submitting', 'running')
       GROUP BY status`
  ).bind(String(serverKey)).all();

  const counts = { queued: 0, submitting: 0, running: 0 };
  for (const row of result.results ?? []) {
    const status = String(row.status ?? "");
    if (status in counts) {
      counts[status] = Number(row.n ?? 0);
    }
  }
  return counts;
}

async function countSucceededRecently(db, serverKey, minutes = 1) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM jupyter_executions
       WHERE server_key = ?
         AND status = 'succeeded'
         AND completed_at > datetime('now', ?)`
  )
    .bind(String(serverKey), `-${minutes} minutes`)
    .first();
  return Number(row?.n ?? 0);
}

async function listQueuedExecutions(db, serverKey, limit = 20) {
  const result = await db.prepare(
    `SELECT
         je.id,
         je.business_type,
         je.business_id,
         je.status,
         je.priority,
         je.created_at,
         mt.status AS task_status
       FROM jupyter_executions je
       LEFT JOIN ml_tasks mt
         ON je.business_id = CAST(mt.id AS TEXT)
        AND je.business_type = mt.business_type
       WHERE je.server_key = ?
         AND je.status = 'queued'
       ORDER BY je.priority ASC, je.created_at ASC
       LIMIT ?`
  )
    .bind(String(serverKey), limit)
    .all();

  return (result.results ?? []).map((row) => ({
    execution_id: String(row.id),
    business_type: String(row.business_type ?? ""),
    business_id: String(row.business_id ?? ""),
    status: String(row.status ?? ""),
    priority: Number(row.priority ?? 0),
    task_status: row.task_status == null ? null : String(row.task_status),
    created_at: row.created_at == null ? null : String(row.created_at)
  }));
}

function parseTaskStage(diagnosticsRaw) {
  if (!diagnosticsRaw) {
    return null;
  }
  try {
    const parsed = typeof diagnosticsRaw === "string" ? JSON.parse(diagnosticsRaw) : diagnosticsRaw;
    const stage = String(parsed?.stage ?? "").trim();
    return stage || null;
  } catch {
    return null;
  }
}

function buildActiveExecutionRow(row, liveKernelIds) {
  const kernelId = row.kernel_id == null ? null : String(row.kernel_id);
  const taskStatus = row.task_status == null ? null : String(row.task_status);
  const issues = [];
  if (row.cleanup_at) {
    issues.push("zombie_running");
  }
  if (kernelId && !liveKernelIds.has(kernelId)) {
    issues.push("ghost_kernel");
  }
  if (taskStatus && ["success", "failed", "skipped"].includes(taskStatus)) {
    issues.push("orphan_task");
  }
  return {
    execution_id: String(row.id),
    business_type: String(row.business_type ?? ""),
    business_id: String(row.business_id ?? ""),
    status: String(row.status ?? ""),
    kernel_id: kernelId,
    kernel_live: kernelId ? liveKernelIds.has(kernelId) : null,
    task_status: taskStatus,
    task_stage: parseTaskStage(row.task_diagnostics),
    submitted_at: row.submitted_at == null ? null : String(row.submitted_at),
    cleanup_at: row.cleanup_at == null ? null : String(row.cleanup_at),
    issues
  };
}

async function fetchServerExecutionOverview(env, server) {
  const db = env.DB;
  const limit = readMaxKernels(server);
  const query = serverQueryable(server);
  const base = {
    key: server.key,
    name: server.name,
    enabled: server.enabled !== false,
    max_kernels: limit,
    queryable: query.ok,
    query_reason: query.ok ? null : query.reason
  };

  const [statusCounts, succeeded1m, zombies, queuedRows] = await Promise.all([
    countExecutionsByStatus(db, server.key),
    countSucceededRecently(db, server.key, 1),
    listZombieRunningExecutions(db, server.key),
    listQueuedExecutions(db, server.key)
  ]);

  let coordinator = {
    available: false,
    max_slots: limit ?? 30,
    running_count: null,
    queue_length: null,
    do_queue: [],
    do_running: [],
    error: null
  };
  try {
    const status = await coordinatorGetStatus(env, server.key);
    coordinator = {
      available: true,
      max_slots: Number(status?.max_slots ?? limit ?? 30),
      running_count: Number(status?.running_count ?? 0),
      queue_length: Number(status?.queue_length ?? 0),
      do_queue: Array.isArray(status?.queue) ? status.queue.map(String) : [],
      do_running: Array.isArray(status?.running) ? status.running.map(String) : [],
      error: null
    };
  } catch (error) {
    coordinator.error = error instanceof Error ? error.message : String(error);
  }

  const activeRows = await listActiveExecutionsWithTaskStatus(db, server.key);

  let kernels = [];
  let capacity = {
    limited: limit != null,
    current: null,
    limit,
    available: null,
    at_limit: false
  };
  let kernelSummary = { total: 0, idle: 0, busy: 0, starting: 0, orphan: 0 };
  let liveKernelIds = new Set();
  let kernelError = null;

  if (query.ok) {
    const client = new JupyterWorkerClient(server);
    try {
      const [kernelList, kernelCapacity] = await Promise.all([
        client.listKernels(),
        getJupyterKernelCapacity(client, server)
      ]);
      kernels = kernelList;
      capacity = kernelCapacity;
      liveKernelIds = new Set(
        kernels.map((kernel) => String(kernel?.id ?? "").trim()).filter(Boolean)
      );
      const claimedKernelIds = new Set(
        activeRows
          .map((row) => String(row.kernel_id ?? "").trim())
          .filter(Boolean)
      );
      kernelSummary = {
        total: kernels.length,
        idle: kernels.filter((k) => k.execution_state === "idle").length,
        busy: kernels.filter((k) => k.execution_state === "busy").length,
        starting: kernels.filter((k) => k.execution_state === "starting").length,
        orphan: kernels.filter((k) => !claimedKernelIds.has(String(k?.id ?? "").trim())).length
      };
    } catch (error) {
      kernelError = error instanceof Error ? error.message : String(error);
    }
  }

  const active = activeRows.map((row) => buildActiveExecutionRow(row, liveKernelIds));

  const ghostExecutions = active.filter((row) => row.issues.includes("ghost_kernel")).length;
  const orphanTaskExecutions = active.filter((row) => row.issues.includes("orphan_task")).length;

  const d1Running = statusCounts.running;
  const slotDrift =
    query.ok && capacity.current != null ? d1Running - Number(capacity.current) : null;

  const issues = [];
  if (zombies.length > 0) {
    issues.push({ type: "zombie_running", count: zombies.length, severity: "error" });
  }
  if (ghostExecutions > 0) {
    issues.push({ type: "ghost_execution", count: ghostExecutions, severity: "error" });
  }
  if (orphanTaskExecutions > 0) {
    issues.push({ type: "orphan_task", count: orphanTaskExecutions, severity: "warn" });
  }
  if (kernelSummary.orphan > 0) {
    issues.push({ type: "orphan_kernel", count: kernelSummary.orphan, severity: "warn" });
  }
  if (slotDrift != null && Math.abs(slotDrift) >= 3) {
    issues.push({ type: "slot_drift", count: Math.abs(slotDrift), severity: "warn", drift: slotDrift });
  }
  if (coordinator.available && coordinator.max_slots > 0) {
    const doSlots = coordinator.running_count + coordinator.queue_length;
    if (doSlots > coordinator.max_slots) {
      issues.push({
        type: "coordinator_over_capacity",
        count: doSlots - coordinator.max_slots,
        severity: "warn"
      });
    }
  }

  return {
    ...base,
    coordinator,
    executions: {
      queued: statusCounts.queued,
      submitting: statusCounts.submitting,
      running: statusCounts.running,
      succeeded_1m: succeeded1m,
      zombie: zombies.length
    },
    kernels: {
      ...kernelSummary,
      capacity,
      ghost_executions: ghostExecutions,
      error: kernelError
    },
    reconcile: {
      d1_running: d1Running,
      jupyter_kernels: kernelSummary.total,
      slot_drift: slotDrift,
      issues
    },
    queued: queuedRows,
    active,
    fetched_at: new Date().toISOString()
  };
}

export async function getJupyterExecutionOverview(env, options = {}) {
  const serverKey = String(options.serverKey ?? "").trim();
  const includeDisabled = options.includeDisabled === true;

  let servers;
  if (serverKey) {
    const server = await getJupyterServerByKey(env.DB, serverKey);
    servers = server ? [server] : [];
  } else {
    servers = await listJupyterServers(env.DB, { includeDisabled });
  }

  const items = [];
  for (const server of servers) {
    items.push(await fetchServerExecutionOverview(env, server));
  }

  return {
    items,
    server_key: serverKey || null,
    fetched_at: new Date().toISOString()
  };
}
