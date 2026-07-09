import worker from "./index.js";
import { runValidationBatch } from "./validation-batch.js";
import { handleLlmApiRequest } from "./llm-api-routes.js";

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

export default {
  async scheduled(controller, env) {
    const [generateResult, validationResult] = await Promise.allSettled([
      worker.scheduled(controller, env),
      runValidationBatch(env)
    ]);
    if (generateResult.status === "fulfilled") {
      console.log(JSON.stringify({ generate: generateResult.value }));
    } else {
      console.error("generate cron failed:", generateResult.reason);
    }
    if (validationResult.status === "fulfilled") {
      console.log(JSON.stringify({ validation: validationResult.value }));
    } else {
      console.error("validation cron failed:", validationResult.reason);
    }
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const llmResponse = await handleLlmApiRequest(request, env);
    if (llmResponse) {
      return llmResponse;
    }
    if (request.method === "POST" && url.pathname === "/run-validation-batch") {
      if (!isAuthorized(request, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      try {
        const result = await runValidationBatch(env);
        return Response.json({ ok: true, ...result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 500 });
      }
    }
    return worker.fetch(request, env, ctx);
  }
};
