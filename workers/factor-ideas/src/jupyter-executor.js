import { createOrRequeueJupyterExecution } from "./jupyter-execution-db.js";
import { dispatchJupyterExecution } from "./jupyter-execution-runtime.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { handleJupyterExecutionBusinessCompletion } from "./jupyter-execution-business-handlers.js";

const completionHandlers = new Map();

export function registerHandler(businessType, handler) {
  completionHandlers.set(String(businessType), handler);
}

export function registerDefaultHandlers() {
  for (const businessType of ["test_factor_validation", "factor_validation"]) {
    if (!completionHandlers.has(businessType)) {
      registerHandler(businessType, handleJupyterExecutionBusinessCompletion);
    }
  }
}

export async function submit(env, { serverKey, businessType, businessId, payload, priority = 0 }) {
  const { execution, created, requeued, skipped } = await createOrRequeueJupyterExecution(env.DB, {
    serverKey,
    businessType,
    businessId: String(businessId),
    priority,
    payload
  });

  if (skipped) {
    return {
      executionId: execution.id,
      status: execution.status,
      skipped: true,
      created: false,
      requeued: false
    };
  }

  let dispatchResult = null;
  if (jupyterExecutionViaDoEnabled(env)) {
    dispatchResult = await dispatchJupyterExecution(env, {
      executionId: execution.id,
      serverKey
    });
  }

  return {
    executionId: execution.id,
    status: "queued",
    skipped: false,
    created: Boolean(created),
    requeued: Boolean(requeued),
    dispatch: dispatchResult
  };
}

export async function invokeCompletionHandler(env, event) {
  const handler = completionHandlers.get(String(event?.businessType ?? ""));
  if (!handler) {
    return { invoked: false, reason: "no_handler", updated: 0 };
  }
  const result = await handler(env, event);
  return { invoked: true, ...(result ?? {}) };
}
