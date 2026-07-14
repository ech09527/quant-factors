import { ML_TASK_STATUSES, getMlTaskById } from "./ml-task-db.js";
import { getMlflowIcSeriesDaily } from "./mlflow-ic-series.js";
import {
  enqueueFactorValidations,
  getFactorValidationById,
  listFactorValidations,
  reportFactorValidationResults
} from "./factor-validation-db.js";
import { notifyCoordinatorExecutionReported } from "./jupyter-execution-dispatch.js";
import { jupyterExecutionViaDoEnabled } from "./jupyter-execution-config.js";
import { syncPrefectFlowRunsAfterReports } from "./prefect-execution-sync.js";
import { resolveActiveMlflowConfig, resolveMlflowConfigForTask } from "./mlflow-tracking-config-db.js";

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
  Link: '</api/workflow/ml-tasks/report>; rel="deprecation"'
};

/** eval 阶段 running 仅写 D1；mlflow 阶段或终态 eval 才释放 Coordinator slot。 */
export function shouldNotifyCoordinatorForReport(item) {
  const reportPhase = String(item.diagnostics?.report_phase ?? "").trim();
  const status = String(item.status ?? "").trim();

  if (reportPhase === "mlflow") {
    return status !== "running";
  }
  if (reportPhase === "eval") {
    if (status === "running") {
      return false;
    }
    if (status === "success") {
      return true;
    }
    return status === "failed" || status === "skipped";
  }
  return status !== "running";
}

async function proxyMlflowRun(env, runId, taskId = null) {
  const config =
    taskId != null && Number.isFinite(Number(taskId)) && Number(taskId) > 0
      ? await resolveMlflowConfigForTask(env.DB, env, Number(taskId))
      : await resolveActiveMlflowConfig(env.DB, env);
  const trackingUri = String(config?.tracking_uri ?? "").replace(/\/$/, "");
  const username = String(config?.username ?? "").trim();
  const password = String(config?.password ?? "").trim();
  if (!trackingUri || !username || !password) {
    throw new Error("缺少 MLflow 代理凭证（MLFLOW_TRACKING_URI/USERNAME/PASSWORD）");
  }
  const url = `${trackingUri}/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(runId)}`;
  const auth = btoa(`${username}:${password}`);
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MLflow API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

export async function handleFactorValidationApiRequest(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === "POST" && pathname === "/api/workflow/ml-tasks/report") {
    try {
      const body = await request.json();
      const items = Array.isArray(body.items) ? body.items : [];
      const parsed = items
        .map((item) => ({
          task_id: Number(item.task_id),
          factor_validation_id: Number(item.factor_validation_id),
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
      const result = await reportFactorValidationResults(env.DB, parsed, env);
      await syncPrefectFlowRunsAfterReports(env, "factor_validation", result.reports ?? []);
      for (const report of result.reports ?? []) {
        if (report.updated <= 0) {
          continue;
        }
        const item = report.normalized;
        if (!jupyterExecutionViaDoEnabled(env) || !shouldNotifyCoordinatorForReport(item)) {
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
            businessType: "factor_validation",
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
          console.error("coordinator report notify failed:", error);
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
    } catch {
      return jsonResponse({ error: "invalid json body" }, 400);
    }
  }

  if (method === "GET" && pathname === "/api/factor-validations") {
    const ideaIdParam = url.searchParams.get("idea_id");
    const ideaId = ideaIdParam == null || ideaIdParam === "" ? null : Number(ideaIdParam);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam == null || statusParam === "" ? null : String(statusParam).trim();
    const profileKeys = (url.searchParams.get("profile_keys") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const titleParam = url.searchParams.get("title");
    const title = titleParam == null || titleParam === "" ? null : titleParam.trim() || null;
    const sort = url.searchParams.get("sort")?.trim() || void 0;
    const orderParam = url.searchParams.get("order")?.trim().toLowerCase();
    const order = orderParam === "asc" || orderParam === "desc" ? orderParam : void 0;
    const absParam = url.searchParams.get("abs");
    const abs = absParam == null ? void 0 : absParam === "1" || absParam.toLowerCase() === "true";
    const limit = parsePositiveInt(url.searchParams.get("limit"), 30, 200);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const data = await listFactorValidations(env.DB, {
      ideaId: Number.isFinite(ideaId) && ideaId > 0 ? ideaId : null,
      status,
      profileKeys: profileKeys.length > 0 ? profileKeys : null,
      title,
      sort,
      order,
      abs,
      limit,
      offset
    });
    return jsonResponse(data);
  }

  const factorValidationMatch = pathname.match(/^\/api\/factor-validations\/(\d+)$/);
  if (method === "GET" && factorValidationMatch) {
    const id = Number(factorValidationMatch[1]);
    if (!Number.isFinite(id) || id <= 0) {
      return jsonResponse({ error: "invalid factor validation id" }, 400);
    }
    const item = await getFactorValidationById(env.DB, id);
    if (!item) {
      return jsonResponse({ error: "factor validation not found" }, 404);
    }
    return jsonResponse({ item });
  }

  const ideaFactorValidationsMatch = pathname.match(/^\/api\/ideas\/(\d+)\/factor-validations$/);
  if (ideaFactorValidationsMatch) {
    const ideaId = Number(ideaFactorValidationsMatch[1]);
    if (!Number.isFinite(ideaId) || ideaId <= 0) {
      return jsonResponse({ error: "invalid idea id" }, 400);
    }
    if (method === "GET") {
      const data = await listFactorValidations(env.DB, { ideaId, limit: 100, offset: 0 });
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
      const result = await enqueueFactorValidations(env.DB, ideaId, profileKeys);
      return jsonResponse(result);
    }
  }

  const mlflowRunMatch = pathname.match(/^\/api\/mlflow\/runs\/([a-zA-Z0-9-]+)$/);
  if (method === "GET" && mlflowRunMatch) {
    try {
      const taskIdParam = url.searchParams.get("task_id");
      const taskId =
        taskIdParam == null || taskIdParam === "" ? null : Number(taskIdParam);
      const data = await proxyMlflowRun(env, mlflowRunMatch[1], taskId);
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, 502);
    }
  }

  const mlflowIcSeriesMatch = pathname.match(/^\/api\/mlflow\/runs\/([a-zA-Z0-9-]+)\/ic-series$/);
  if (method === "GET" && mlflowIcSeriesMatch) {
    try {
      const taskIdParam = url.searchParams.get("task_id");
      const taskId =
        taskIdParam == null || taskIdParam === "" ? null : Number(taskIdParam);
      const data = await getMlflowIcSeriesDaily(env, mlflowIcSeriesMatch[1], taskId);
      return jsonResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, 502);
    }
  }

  const mlTaskMatch = pathname.match(/^\/api\/ml-tasks\/(\d+)$/);
  if (method === "GET" && mlTaskMatch) {
    const taskId = Number(mlTaskMatch[1]);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return jsonResponse({ error: "invalid task id" }, 400);
    }
    const item = await getMlTaskById(env.DB, taskId);
    if (!item) {
      return jsonResponse({ error: "ml task not found" }, 404);
    }
    return jsonResponse({ item });
  }

  return null;
}
