import { getJupyterKernelStatus } from "./jupyter-kernel-status.js";
import worker from "./index.js";
import { runKernelCleanup } from "./kernel-cleanup.js";
import { runValidationBatch } from "./validation-batch.js";
import { handleLlmApiRequest } from "./llm-api-routes.js";
import {
  getSystemSettings,
  getValidationScheduleSettings,
  patchSystemSettings,
  setValidationBatchEnabled,
  VALIDATION_SCHEDULE_CRON
} from "./workflow-settings.js";

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

    const [validationResult, cleanupResult] = await Promise.allSettled([
      runValidationBatch(env),
      runKernelCleanup(env)
    ]);
    if (validationResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, validation: validationResult.value }));
    } else {
      console.error("validation cron failed:", validationResult.reason);
    }
    if (cleanupResult.status === "fulfilled") {
      console.log(JSON.stringify({ cron, kernel_cleanup: cleanupResult.value }));
    } else {
      console.error("kernel cleanup cron failed:", cleanupResult.reason);
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const llmResponse = await handleLlmApiRequest(request, env);
    if (llmResponse) {
      return llmResponse;
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
    if (request.method === "POST" && url.pathname === "/run-validation-batch") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await runValidationBatch(env, { ignoreScheduleEnabled: true });
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/run-kernel-cleanup") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await runKernelCleanup(env);
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    return worker.fetch(request, env, ctx);
  }
};
