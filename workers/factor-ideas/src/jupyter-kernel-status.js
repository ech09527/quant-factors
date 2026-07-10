import {
  getJupyterKernelCapacity,
  JupyterWorkerClient,
  readMaxKernels
} from "./jupyter-async.js";
import {
  getJupyterServerByKey,
  listJupyterKernelValidationBindings,
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

function formatKernelRow(kernel, binding) {
  const kernelId = String(kernel?.id ?? "").trim();
  const lastActivityMs = parseKernelLastActivityMs(kernel);
  const cleaned = Boolean(binding?.kernel_cleaned_at);
  const linked = Boolean(binding) && !cleaned;
  return {
    kernel_id: kernelId,
    name: String(kernel?.name ?? ""),
    execution_state: String(kernel?.execution_state ?? "unknown"),
    last_activity: kernel?.last_activity ?? null,
    last_activity_ms: lastActivityMs,
    linked,
    orphan: !linked,
    validation: linked
      ? {
          validation_id: binding.validation_id,
          idea_id: binding.idea_id,
          title: binding.title,
          profile_key: binding.profile_key,
          status: binding.status,
          updated_at: binding.updated_at,
        }
      : binding && cleaned
        ? {
            validation_id: binding.validation_id,
            idea_id: binding.idea_id,
            title: binding.title,
            profile_key: binding.profile_key,
            status: binding.status,
            kernel_cleaned_at: binding.kernel_cleaned_at,
          }
        : null,
  };
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

async function fetchServerKernelStatus(server, bindingsByKernelId) {
  const query = serverQueryable(server);
  const limit = readMaxKernels(server);
  const base = {
    key: server.key,
    name: server.name,
    enabled: server.enabled !== false,
    max_kernels: limit,
    queryable: query.ok,
    query_reason: query.ok ? null : query.reason,
  };

  if (!query.ok) {
    return {
      ...base,
      capacity: {
        limited: limit != null,
        current: null,
        limit,
        available: null,
        at_limit: false,
      },
      kernels: [],
      error: null,
    };
  }

  const client = new JupyterWorkerClient(server);
  try {
    const [kernels, capacity] = await Promise.all([
      client.listKernels(),
      getJupyterKernelCapacity(client, server),
    ]);

    const items = kernels
      .map((kernel) => formatKernelRow(kernel, bindingsByKernelId.get(String(kernel?.id ?? "").trim())))
      .sort((a, b) => {
        const stateOrder = { busy: 0, starting: 1, idle: 2 };
        const aOrder = stateOrder[a.execution_state] ?? 3;
        const bOrder = stateOrder[b.execution_state] ?? 3;
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        return (b.last_activity_ms ?? 0) - (a.last_activity_ms ?? 0);
      });

    const linkedCount = items.filter((item) => item.linked).length;
    const orphanCount = items.filter((item) => item.orphan).length;

    return {
      ...base,
      capacity,
      summary: {
        total: items.length,
        linked: linkedCount,
        orphan: orphanCount,
        idle: items.filter((item) => item.execution_state === "idle").length,
        busy: items.filter((item) => item.execution_state === "busy").length,
      },
      kernels: items,
      error: null,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      capacity: {
        limited: limit != null,
        current: null,
        limit,
        available: null,
        at_limit: false,
      },
      kernels: [],
      summary: { total: 0, linked: 0, orphan: 0, idle: 0, busy: 0 },
      error: message,
      fetched_at: new Date().toISOString(),
    };
  }
}

export async function getJupyterKernelStatus(db, options = {}) {
  const serverKey = String(options.serverKey ?? "").trim();
  const includeDisabled = options.includeDisabled === true;
  const bindingsByKernelId = await listJupyterKernelValidationBindings(db);

  let servers;
  if (serverKey) {
    const server = await getJupyterServerByKey(db, serverKey);
    servers = server ? [server] : [];
  } else {
    servers = await listJupyterServers(db, { includeDisabled });
  }

  const items = [];
  for (const server of servers) {
    items.push(await fetchServerKernelStatus(server, bindingsByKernelId));
  }

  return {
    items,
    server_key: serverKey || null,
    fetched_at: new Date().toISOString(),
  };
}
