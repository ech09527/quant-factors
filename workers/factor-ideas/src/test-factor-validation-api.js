import { ML_TASK_STATUSES } from "./ml-task-db.js";
import { shouldNotifyCoordinatorForReport } from "./factor-validation-api.js";
import {
  enqueueTestFactorValidations,
  getTestFactorValidationById,
  listTestFactorValidations,
  reportTestFactorValidationResults
} from "./test-factor-validation-db.js";
import { notifyCoordinatorExecutionReported } from "./jupyter-execution-dispatch.js";

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

const LEGACY_REPORT_HEADERS = {
  Deprecation: "true",
  Link: '</api/workflow/test-ml-tasks/report>; rel="deprecation"'
};

export async function handleTestFactorValidationApiRequest(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === "POST" && pathname === "/api/workflow/test-ml-tasks/report") {
    try {
      const body = await request.json();
      const items = Array.isArray(body.items) ? body.items : [];
      const parsed = items
        .map((item) => ({
          task_id: Number(item.task_id),
          test_factor_validation_id: Number(item.test_factor_validation_id),
          status: String(item.status),
          factor_sql: item.factor_sql && typeof item.factor_sql === "object" ? item.factor_sql : null,
          diagnostics: item.diagnostics && typeof item.diagnostics === "object" ? item.diagnostics : null,
          error_reason: item.error_reason == null ? null : String(item.error_reason),
          mlflow_run_id: item.mlflow_run_id == null ? null : String(item.mlflow_run_id),
          mlflow_experiment: item.mlflow_experiment == null ? null : String(item.mlflow_experiment),
          mlflow_run_url: item.mlflow_run_url == null ? null : String(item.mlflow_run_url),
          evaluated_at: item.evaluated_at == null ? null : String(item.evaluated_at),
          completed_at: item.completed_at == null ? null : String(item.completed_at)
        }))
        .filter(
          (item) =>
            Number.isFinite(item.task_id) &&
            item.task_id > 0 &&
            ML_TASK_STATUSES.has(item.status)
        );
      const result = await reportTestFactorValidationResults(env.DB, parsed);
      for (const report of result.reports ?? []) {
        if (report.updated <= 0) {
          continue;
        }
        const item = report.normalized;
        if (!shouldNotifyCoordinatorForReport(item)) {
          continue;
        }
        const terminalStatus =
          item.status === "success" && String(item.diagnostics?.report_phase ?? "") === "eval"
            ? "failed"
            : item.status === "success"
              ? "succeeded"
              : item.status;
        try {
          await notifyCoordinatorExecutionReported(env, {
            businessType: "test_factor_validation",
            businessId: String(item.task_id),
            terminalStatus,
            errorReason:
              item.status === "success" && String(item.diagnostics?.report_phase ?? "") === "eval"
                ? item.error_reason ?? "eval success without mlflow phase"
                : item.error_reason,
            errorCode:
              terminalStatus === "failed" || item.status === "skipped"
                ? "jupyter_report_failed"
                : null
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              test_coordinator_report_notify_failed: true,
              task_id: item.task_id,
              error: error instanceof Error ? error.message : String(error)
            })
          );
        }
      }
      return jsonResponse(
        {
          ...result,
          deprecated: true,
          preferred_completion: "websocket_result_marker"
        },
        200,
        LEGACY_REPORT_HEADERS
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: "report_failed", detail: message }, 500);
    }
  }

  if (method === "GET" && pathname === "/api/test-factor-validations") {
    const ideaIdParam = url.searchParams.get("idea_id");
    const ideaId = ideaIdParam == null || ideaIdParam === "" ? null : Number(ideaIdParam);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam == null || statusParam === "" ? null : String(statusParam).trim();
    const profileKeys = (url.searchParams.get("profile_keys") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const limit = parsePositiveInt(url.searchParams.get("limit"), 30, 200);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const data = await listTestFactorValidations(env.DB, {
      ideaId: Number.isFinite(ideaId) && ideaId > 0 ? ideaId : null,
      status,
      profileKeys: profileKeys.length > 0 ? profileKeys : null,
      limit,
      offset
    });
    return jsonResponse(data);
  }

  const testMatch = pathname.match(/^\/api\/test-factor-validations\/(\d+)$/);
  if (method === "GET" && testMatch) {
    const id = Number(testMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return jsonResponse({ error: "invalid test factor validation id" }, 400);
    }
    const item = await getTestFactorValidationById(env.DB, id);
    if (!item) {
      return jsonResponse({ error: "test factor validation not found" }, 404);
    }
    return jsonResponse({ item });
  }

  const ideaMatch = pathname.match(/^\/api\/ideas\/(\d+)\/test-factor-validations$/);
  if (ideaMatch) {
    const ideaId = Number(ideaMatch[1]);
    if (!Number.isFinite(ideaId) || ideaId <= 0) {
      return jsonResponse({ error: "invalid idea id" }, 400);
    }
    if (method === "GET") {
      const data = await listTestFactorValidations(env.DB, { ideaId, limit: 100, offset: 0 });
      return jsonResponse(data);
    }
    if (method === "POST") {
      let profileKeys = [];
      const contentType = request.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const body = await request.json();
          if (Array.isArray(body.profile_keys)) {
            profileKeys = body.profile_keys.map(String).filter(Boolean);
          }
        } catch {
          return jsonResponse({ error: "invalid json body" }, 400);
        }
      }
      if (profileKeys.length === 0) {
        const profiles = await env.DB.prepare(
          `SELECT key FROM validation_profiles WHERE enabled = 1 ORDER BY sort_order ASC, key ASC`
        ).all();
        profileKeys = (profiles.results ?? []).map((row) => String(row.key));
      }
      if (profileKeys.length === 0) {
        return jsonResponse({ error: "no enabled validation profile" }, 400);
      }
      const result = await enqueueTestFactorValidations(env.DB, ideaId, profileKeys);
      return jsonResponse(result);
    }
  }

  return null;
}
