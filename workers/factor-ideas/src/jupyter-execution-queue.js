import { dispatchJupyterExecution } from "./jupyter-execution-runtime.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { listQueuedJupyterExecutionsForServer } from "./jupyter-execution-db.js";

const DEFAULT_RETRY_DELAY_SECONDS = 5;
const CAPACITY_RETRY_MIN_SECONDS = 2;
const CAPACITY_RETRY_MAX_SECONDS = 8;

function queueBindingAvailable(env) {
  return Boolean(env?.JUPYTER_EXECUTION_QUEUE?.send);
}

function defaultServerKey(env) {
  return env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";
}

function capacityRetryDelaySeconds() {
  const span = CAPACITY_RETRY_MAX_SECONDS - CAPACITY_RETRY_MIN_SECONDS + 1;
  return CAPACITY_RETRY_MIN_SECONDS + Math.floor(Math.random() * span);
}

export function buildJupyterExecutionQueueBody({ executionId, serverKey, env = null }) {
  return {
    execution_id: String(executionId),
    server_key: String(serverKey ?? "").trim() || (env ? defaultServerKey(env) : "lynas-pub")
  };
}

/**
 * 将 execution 投递到 Cloudflare Queue；本地无 Queue binding 时直调 DO /submit。
 */
export async function enqueueJupyterExecution(env, { executionId, serverKey }) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true, reason: "jupyter_execution_via_do_disabled" };
  }

  const body = buildJupyterExecutionQueueBody({
    executionId,
    serverKey: serverKey ?? defaultServerKey(env),
    env
  });

  if (!queueBindingAvailable(env)) {
    const direct = await dispatchJupyterExecution(env, {
      executionId: body.execution_id,
      serverKey: body.server_key
    });
    return { direct: true, ...direct };
  }

  await env.JUPYTER_EXECUTION_QUEUE.send(body);
  return { queued: true, execution_id: body.execution_id, server_key: body.server_key };
}

/** 将 D1 中 queued 的 execution 补投 Queue（幂等，重复消息由 DO CAS 消化） */
export async function reconcileQueuedExecutionsToQueue(env, options = {}) {
  if (!jupyterExecutionViaDoEnabled(env)) {
    return { skipped: true, reason: "jupyter_execution_via_do_disabled" };
  }
  if (!queueBindingAvailable(env)) {
    return { skipped: true, reason: "queue_binding_unavailable" };
  }

  const serverKey = options.serverKey?.trim() || defaultServerKey(env);
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 2000);
  const queued = await listQueuedJupyterExecutionsForServer(env.DB, serverKey, limit);

  let enqueued = 0;
  const errors = [];
  for (const execution of queued) {
    try {
      await env.JUPYTER_EXECUTION_QUEUE.send(
        buildJupyterExecutionQueueBody({
          executionId: execution.id,
          serverKey: execution.server_key || serverKey,
          env
        })
      );
      enqueued += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ execution_id: execution.id, error: message });
    }
  }

  return {
    server_key: serverKey,
    scanned: queued.length,
    enqueued,
    errors
  };
}

function shouldRetryQueueMessage(result) {
  const reason = String(result?.reason ?? "");
  if (reason === "capacity_full" || reason === "kernel_list_failed") {
    return true;
  }
  if (result?.deferred) {
    return true;
  }
  if (result?.failed && reason === "jupyter_dispatch") {
    return true;
  }
  return false;
}

/** Cloudflare Queue consumer：经 DO 闸门占槽并 submit，满负荷则 retry */
export async function processJupyterExecutionQueueMessage(message, env) {
  const body = message.body ?? {};
  const executionId = String(body.execution_id ?? "").trim();
  const serverKey = String(body.server_key ?? "").trim() || defaultServerKey(env);

  if (!executionId) {
    message.ack();
    return { ack: true, reason: "missing_execution_id" };
  }

  const result = await dispatchJupyterExecution(env, { executionId, serverKey });

  if (shouldRetryQueueMessage(result)) {
    message.retry({ delaySeconds: capacityRetryDelaySeconds() });
    return { retry: true, reason: result.reason ?? "deferred", result };
  }

  message.ack();
  return { ack: true, result };
}

export async function processJupyterExecutionQueueBatch(batch, env) {
  const outcomes = [];
  for (const message of batch.messages) {
    try {
      outcomes.push(await processJupyterExecutionQueueMessage(message, env));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ jupyter_execution_queue_error: messageText }));
      message.retry({ delaySeconds: DEFAULT_RETRY_DELAY_SECONDS });
      outcomes.push({ retry: true, error: messageText });
    }
  }
  return outcomes;
}
