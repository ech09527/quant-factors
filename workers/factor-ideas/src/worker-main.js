import { dispatchFactorValidationViaCoordinator } from "./jupyter-execution-dispatch.js";
import { dispatchTestFactorValidationViaCoordinator } from "./test-factor-validation-dispatch.js";
import { dispatchFactorValidationViaPrefect } from "./prefect-execution-dispatch.js";
import { dispatchTestFactorValidationViaPrefect } from "./test-prefect-execution-dispatch.js";
import { handleJupyterExecutionCallbackApiRequest } from "./jupyter-execution-callback-api.js";
import {
  processJupyterExecutionQueueBatch,
  reconcileQueuedExecutionsToQueue
} from "./jupyter-execution-queue.js";
import { registerDefaultHandlers } from "./jupyter-executor.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { prefectExecutionEnabled } from "./prefect-execution-config.js";
import { coordinatorGetStatus } from "./jupyter-coordinator-client.js";
import { getJupyterExecutionOverview } from "./jupyter-execution-overview.js";
import { getPrefectExecutionOverview } from "./prefect-execution-overview.js";
import { getJupyterKernelStatus } from "./jupyter-kernel-status.js";
import { getMlTaskKernelStatus } from "./ml-task-kernel-status.js";
import worker from "./index.js";
import { handleFactorValidationApiRequest } from "./factor-validation-api.js";
import { handleTestFactorValidationApiRequest } from "./test-factor-validation-api.js";
import { runFactorValidationBatch } from "./factor-validation-batch.js";
import { runTestFactorValidationBatch } from "./test-factor-validation-batch.js";
import { resetTestFactorValidationWorkflow } from "./test-factor-validation-db.js";
import { runKernelCleanup } from "./kernel-cleanup.js";
import { cleanupExpiredJupyterServers } from "./jupyter-server-db.js";
import { handleLlmApiRequest } from "./llm-api-routes.js";
import {
  getSystemSettings,
  getValidationScheduleSettings,
  patchSystemSettings,
  setValidationBatchEnabled,
  VALIDATION_SCHEDULE_CRON
} from "./workflow-settings.js";

function resolveFactorValidationDispatch(env, options = {}) {
  if (prefectExecutionEnabled(env)) {
    return dispatchFactorValidationViaPrefect(env, options);
  }
  if (jupyterExecutionViaDoEnabled(env)) {
    return dispatchFactorValidationViaCoordinator(env, options);
  }
  return runFactorValidationBatch(env, options);
}

function resolveTestFactorValidationDispatch(env, options = {}) {
  if (prefectExecutionEnabled(env)) {
    return dispatchTestFactorValidationViaPrefect(env, options);
  }
  if (jupyterExecutionViaDoEnabled(env)) {
    return dispatchTestFactorValidationViaCoordinator(env, options);
  }
  return runTestFactorValidationBatch(env, options);
}

function isAuthorized(request, env) {
  const expected = env.AUTH_PASSWORD?.trim();
  if (!expected) {
    return false;
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return match[1] === expected;
}

function isIdeaGenerationCron(cron) {
  return cron === "*/5 * * * *";
}

function isValidationMaintenanceCron(cron) {
  return cron === VALIDATION_SCHEDULE_CRON;
}

export default {
  async scheduled(controller, env) {
    registerDefaultHandlers();
    const cron = String(controller.cron ?? "").trim();

    if (isIdeaGenerationCron(cron)) {
      try {
        const result = await worker.scheduled(controller, env);
        console.log(JSON.stringify({ cron, generate: result }));
      } catch (error) {
        console.error("generate cron failed:", error);
      }
      return;
    }

    if (!isValidationMaintenanceCron(cron)) {
      console.warn(JSON.stringify({ cron, skipped: true, reason: "unknown cron trigger" }));
      return;
    }

    let queueReconcileBefore = null;
    if (!prefectExecutionEnabled(env) && jupyterExecutionViaDoEnabled(env)) {
      try {
        queueReconcileBefore = await reconcileQueuedExecutionsToQueue(env);
      } catch (error) {
        console.error("jupyter execution queue reconcile (before) failed:", error);
      }
    }

    const factorValidationRunner = resolveFactorValidationDispatch(env);
    const testFactorValidationRunner = resolveTestFactorValidationDispatch(env);

    const maintenanceTasks = [factorValidationRunner, testFactorValidationRunner];
    if (!prefectExecutionEnabled(env)) {
      maintenanceTasks.push(runKernelCleanup(env));
    }
    maintenanceTasks.push(cleanupExpiredJupyterServers(env.DB));

    const maintenanceResults = await Promise.allSettled(maintenanceTasks);
    const [
      factorValidationResult,
      testFactorValidationResult,
      cleanupResult,
      jupyterServerCleanupResult
    ] =
      prefectExecutionEnabled(env)
        ? [
            maintenanceResults[0],
            maintenanceResults[1],
            { status: "fulfilled", value: { skipped: true, reason: "prefect_backend" } },
            maintenanceResults[2]
          ]
        : [
            maintenanceResults[0],
            maintenanceResults[1],
            maintenanceResults[2],
            maintenanceResults[3]
          ];
    if (factorValidationResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, factor_validation: factorValidationResult.value }));
    } else {
      console.error("factor validation cron failed:", factorValidationResult.reason);
    }
    if (testFactorValidationResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, test_factor_validation: testFactorValidationResult.value }));
    } else {
      console.error("test factor validation cron failed:", testFactorValidationResult.reason);
    }
    if (cleanupResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, kernel_cleanup: cleanupResult.value }));
    } else {
      console.error("kernel cleanup cron failed:", cleanupResult.reason);
    }
    if (jupyterServerCleanupResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, jupyter_server_cleanup: jupyterServerCleanupResult.value }));
    } else {
      console.error("jupyter server cleanup cron failed:", jupyterServerCleanupResult.reason);
    }

    if (!prefectExecutionEnabled(env) && jupyterExecutionViaDoEnabled(env)) {
      let queueReconcileAfter = null;
      try {
        queueReconcileAfter = await reconcileQueuedExecutionsToQueue(env);
      } catch (error) {
        console.error("jupyter execution queue reconcile (after) failed:", error);
      }
      console.log(
        JSON.stringify({
          cron,
          jupyter_execution_queue_reconcile: {
            before: queueReconcileBefore,
            after: queueReconcileAfter
          }
        })
      );
    }
  },

  async queue(batch, env) {
    if (prefectExecutionEnabled(env)) {
      console.log(JSON.stringify({ jupyter_execution_queue_batch: 0, skipped: "prefect_backend" }));
      for (const message of batch.messages ?? []) {
        message.ack();
      }
      return;
    }
    registerDefaultHandlers();
    const outcomes = await processJupyterExecutionQueueBatch(batch, env);
    console.log(JSON.stringify({ jupyter_execution_queue_batch: outcomes.length, outcomes }));
  },

  async fetch(request, env, ctx) {
    registerDefaultHandlers();
    const url = new URL(request.url);
    const llmResponse = await handleLlmApiRequest(request, env);
    if (llmResponse) {
      return llmResponse;
    }
    const jupyterCallbackResponse = await handleJupyterExecutionCallbackApiRequest(request, env, url);
    if (jupyterCallbackResponse) {
      return jupyterCallbackResponse;
    }
    const kernelStatusMatch = url.pathname.match(/^\/api\/jupyter-servers\/([a-z][a-z0-9_-]*)\/kernel-status$/);
    if (kernelStatusMatch && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const data = await getJupyterKernelStatus(env.DB, {
          serverKey: kernelStatusMatch[1],
        });
        return Response.json({ ok: true, ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/ml-tasks/kernel-status" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const includeDisabled =
          url.searchParams.get("include_disabled") === "1" ||
          url.searchParams.get("include_disabled")?.toLowerCase() === "true";
        const serverKey = url.searchParams.get("key")?.trim() || "";
        const data = await getMlTaskKernelStatus(env.DB, {
          serverKey: serverKey || undefined,
          includeDisabled,
        });
        return Response.json({ ok: true, ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/jupyter-servers/kernel-status" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const includeDisabled =
          url.searchParams.get("include_disabled") === "1" ||
          url.searchParams.get("include_disabled")?.toLowerCase() === "true";
        const serverKey = url.searchParams.get("key")?.trim() || "";
        const data = await getJupyterKernelStatus(env.DB, {
          serverKey: serverKey || undefined,
          includeDisabled,
        });
        return Response.json({ ok: true, ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/workflow/system-settings") {
      if (request.method === "GET") {
        try {
          const settings = await getSystemSettings(env.DB, env);
          return Response.json({ ok: true, ...settings });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      }
      if (request.method === "PATCH") {
        if (!isAuthorized(request, env)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
        }
        try {
          const result = await patchSystemSettings(env.DB, env, body);
          const settings = await getSystemSettings(env.DB, env);
          return Response.json({ ok: true, ...result, ...settings });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 400 });
        }
      }
    }
    if (url.pathname === "/api/workflow/validation-schedule") {
      if (request.method === "GET") {
        try {
          const settings = await getValidationScheduleSettings(env.DB, env);
          return Response.json({ ok: true, ...settings });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      }
      if (request.method === "PATCH") {
        if (!isAuthorized(request, env)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
        }
        if (typeof body.enabled !== "boolean") {
          return Response.json({ ok: false, error: "enabled must be boolean" }, { status: 400 });
        }
        try {
          await setValidationBatchEnabled(env.DB, body.enabled);
          const settings = await getValidationScheduleSettings(env.DB, env);
          return Response.json({ ok: true, ...settings });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      }
    }
    if (request.method === "POST" && url.pathname === "/run-kernel-cleanup") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const force =
          url.searchParams.get("force") === "1" ||
          url.searchParams.get("force")?.toLowerCase() === "true";
        const result = await runKernelCleanup(env, { force });
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/reset-test-factor-validation") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const reset = await resetTestFactorValidationWorkflow(env.DB);
        const reconcile = prefectExecutionEnabled(env)
          ? { skipped: true, reason: "prefect_backend" }
          : await reconcileQueuedExecutionsToQueue(env);
        return Response.json({ ok: true, reset, reconcile });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/run-test-factor-validation-batch") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const runDispatch = async () => {
          const result = await resolveTestFactorValidationDispatch(env, {
            ignoreScheduleEnabled: true
          });
          console.log(JSON.stringify({ run_test_factor_validation_batch: result }));
          return result;
        };
        const background =
          url.searchParams.get("background") !== "0" &&
          url.searchParams.get("background")?.toLowerCase() !== "false";
        if (background && typeof ctx?.waitUntil === "function") {
          ctx.waitUntil(runDispatch());
          return Response.json({ ok: true, accepted: true, mode: "background" });
        }
        const result = await runDispatch();
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/run-jupyter-execution-queue-reconcile") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await reconcileQueuedExecutionsToQueue(env);
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/run-jupyter-execution-fill") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await reconcileQueuedExecutionsToQueue(env);
        return Response.json({
          ok: true,
          deprecated: true,
          reason: "renamed_to_run_jupyter_execution_queue_reconcile",
          ...result
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/run-factor-validation-batch") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam == null || limitParam === "" ? null : Number(limitParam);
        const limit =
          parsedLimit != null && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.floor(parsedLimit)
            : null;
        const runDispatch = async () => {
          const dispatchOptions = { ignoreScheduleEnabled: true, ...(limit != null ? { limit } : {}) };
          const result = await resolveFactorValidationDispatch(env, dispatchOptions);
          console.log(JSON.stringify({ run_factor_validation_batch: result }));
          return result;
        };
        const background =
          url.searchParams.get("background") !== "0" &&
          url.searchParams.get("background")?.toLowerCase() !== "false";
        if (background && typeof ctx?.waitUntil === "function") {
          ctx.waitUntil(runDispatch());
          return Response.json({ ok: true, accepted: true, mode: "background" });
        }
        const result = await runDispatch();
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/jupyter-coordinator/status" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const serverKey =
          url.searchParams.get("key")?.trim() ||
          env.VALIDATION_JUPYTER_SERVER_KEY?.trim() ||
          "lynas-pub";
        const data = await coordinatorGetStatus(env, serverKey);
        return Response.json({ ok: true, server_key: serverKey, ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/jupyter-servers/execution-overview" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        if (prefectExecutionEnabled(env)) {
          const prefect = await getPrefectExecutionOverview(env);
          return Response.json({
            ok: true,
            execution_backend: "prefect",
            fetched_at: new Date().toISOString(),
            prefect
          });
        }
        const includeDisabled =
          url.searchParams.get("include_disabled") === "1" ||
          url.searchParams.get("include_disabled")?.toLowerCase() === "true";
        const serverKey = url.searchParams.get("key")?.trim() || "";
        const data = await getJupyterExecutionOverview(env, { includeDisabled, serverKey });
        return Response.json({ ok: true, execution_backend: "jupyter", ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/prefect/execution-overview" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const data = await getPrefectExecutionOverview(env);
        return Response.json({ ok: true, execution_backend: "prefect", ...data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    const factorValidationPaths = [
      "/api/workflow/ml-tasks/report",
      "/api/workflow/test-ml-tasks/report",
      "/api/factor-validations",
      "/api/test-factor-validations",
      "/api/mlflow/runs/",
      "/api/ml-tasks/",
    ];
    const isFactorValidationApi =
      factorValidationPaths.some(
        (prefix) => url.pathname === prefix || url.pathname.startsWith(prefix),
      ) ||
      /^\/api\/ideas\/\d+\/factor-validations$/.test(url.pathname) ||
      /^\/api\/ideas\/\d+\/test-factor-validations$/.test(url.pathname) ||
      /^\/api\/factor-validations\/\d+$/.test(url.pathname) ||
      /^\/api\/test-factor-validations\/\d+$/.test(url.pathname);
    if (isFactorValidationApi) {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const testResponse = await handleTestFactorValidationApiRequest(request, env, url);
      if (testResponse) {
        return testResponse;
      }
      const factorResponse = await handleFactorValidationApiRequest(request, env, url);
      if (factorResponse) {
        return factorResponse;
      }
    }
    return worker.fetch(request, env, ctx);
  },
};
