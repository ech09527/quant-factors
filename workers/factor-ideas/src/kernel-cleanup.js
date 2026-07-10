import { JupyterWorkerClient } from "./jupyter-async.js";
import {
  getJupyterServerByKey,
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

function cleanupEnabled(env) {
  const flag = env.KERNEL_CLEANUP_ENABLED?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return true;
}

function isKernelAlreadyGone(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message) || /not found/i.test(message);
}

export async function runKernelCleanup(env) {
  if (!cleanupEnabled(env)) {
    return { skipped: true, reason: "KERNEL_CLEANUP_ENABLED is off" };
  }

  const limit = parsePositiveInt(env.KERNEL_CLEANUP_LIMIT, 10, 50);
  const graceMinutes = parsePositiveInt(env.KERNEL_CLEANUP_GRACE_MINUTES, 2, 60);
  const pending = await listValidationsPendingKernelCleanup(env.DB, {
    limit,
    graceMinutes
  });

  if (pending.length === 0) {
    return { scanned: 0, deleted: 0, already_gone: 0, failed: 0, errors: [] };
  }

  const clientCache = new Map();
  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  const errors = [];

  for (const item of pending) {
    const serverKey = item.jupyter_server_key;
    const kernelId = item.kernel_id;
    if (!serverKey || !kernelId) {
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
      deleted += 1;
      await markValidationKernelCleaned(env.DB, item.validation_id, {
        kernel_cleanup_status: "deleted"
      });
    } catch (error) {
      if (isKernelAlreadyGone(error)) {
        alreadyGone += 1;
        await markValidationKernelCleaned(env.DB, item.validation_id, {
          kernel_cleanup_status: "already_gone"
        });
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
    errors
  };
}
