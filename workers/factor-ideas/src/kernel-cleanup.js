import { JupyterWorkerClient, selectWorkerJupyterServer } from "./jupyter-async.js";
import { getKernelCleanupEnabled } from "./workflow-settings.js";
import {
  getJupyterServerByKey,
  getValidationKernelCleanupTarget,
  listActiveJupyterKernelIds,
  listEnabledJupyterServers,
  listValidationsPendingKernelCleanup,
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

async function sweepOrphanIdleKernels(env, { limit, idleMinutes }) {
  if (!orphanSweepEnabled(env)) {
    return { scanned: 0, deleted: 0, already_gone: 0, failed: 0, skipped: 0, errors: [] };
  }

  const servers = await listEnabledJupyterServers(env.DB);
  const { server } = selectWorkerJupyterServer(
    servers,
    env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub"
  );
  const activeKernelIds = await listActiveJupyterKernelIds(env.DB);
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
    .filter((kernel) => String(kernel?.execution_state ?? "") === "idle")
    .filter((kernel) => {
      const kernelId = String(kernel?.id ?? "").trim();
      return kernelId && !activeKernelIds.has(kernelId);
    })
    .filter((kernel) => {
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

export async function runKernelCleanup(env) {
  if (!(await cleanupEnabled(env.DB, env))) {
    return { skipped: true, reason: "kernel_cleanup_disabled" };
  }

  const limit = parsePositiveInt(env.KERNEL_CLEANUP_LIMIT, 30, 100);
  const graceMinutes = parsePositiveInt(env.KERNEL_CLEANUP_GRACE_MINUTES, 2, 60);
  const pending = await listValidationsPendingKernelCleanup(env.DB, {
    limit,
    graceMinutes
  });

  if (pending.length === 0) {
    const orphanSweep = await sweepOrphanIdleKernels(env, {
      limit: parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_LIMIT, 30, 100),
      idleMinutes: parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_IDLE_MINUTES, 5, 60)
    });
    return { scanned: 0, deleted: 0, already_gone: 0, failed: 0, skipped: 0, errors: [], orphan_sweep: orphanSweep };
  }

  const clientCache = new Map();
  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  for (const item of pending) {
    const target = await getValidationKernelCleanupTarget(
      env.DB,
      item.validation_id,
      item.kernel_id
    );
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
          validation_id: item.validation_id,
          kernel_id: kernelId,
          error: `jupyter server not found: ${serverKey}`
        });
        await patchValidationDiagnostics(env.DB, item.validation_id, {
          kernel_cleanup_status: "failed",
          kernel_cleanup_error: `jupyter server not found: ${serverKey}`
        });
        continue;
      }
      client = new JupyterWorkerClient(server);
      clientCache.set(serverKey, client);
    }

    try {
      await client.shutdownKernel(kernelId);
      const marked = await markValidationKernelCleaned(env.DB, item.validation_id, kernelId, {
        kernel_cleanup_status: "deleted"
      });
      if (marked.updated > 0) {
        deleted += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      if (isKernelAlreadyGone(error)) {
        const marked = await markValidationKernelCleaned(env.DB, item.validation_id, kernelId, {
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
        validation_id: item.validation_id,
        kernel_id: kernelId,
        error: message
      });
      await patchValidationDiagnostics(env.DB, item.validation_id, {
        kernel_cleanup_status: "failed",
        kernel_cleanup_error: message,
        kernel_cleanup_attempted_at: new Date().toISOString()
      });
    }
  }

  return {
    scanned: pending.length,
    deleted,
    already_gone: alreadyGone,
    failed,
    skipped,
    errors,
    orphan_sweep: await sweepOrphanIdleKernels(env, {
      limit: parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_LIMIT, 30, 100),
      idleMinutes: parsePositiveInt(env.KERNEL_ORPHAN_SWEEP_IDLE_MINUTES, 5, 60)
    })
  };
}
