import { mountIcSeriesChart } from "./ic-series-chart.js";

const PAGE_SIZE = 20;
const AUTH_STORAGE_KEY = "qf_auth_token";

const IDEA_IMPORT_EXAMPLE = `{
  "ideas": [
    {
      "title": "示例横截面因子",
      "hypothesis": "风险调整动量在截面上具有持续性",
      "data_sources": ["yhydev97/quant-data"],
      "formula_sketch": "ret_24h / vol_24h，每个 open_time 横截面 rank",
      "expected_signal": "横截面：做多高分位、做空低分位",
      "risks": ["流动性分层", "极端行情失效"],
      "factor_expr": "CSRank($ret_24h / ($vol_24h + 1e-8))",
      "factor_sql": {
        "version": "1",
        "dialect": "duckdb-factor-v1",
        "evaluation_type": "cross_sectional",
        "data_source": "yhydev97/quant-data",
        "signal_sql": "ret_24h / (vol_24h + 1e-8)",
        "postprocess": "cs_rank",
        "universe": {
          "dropna": ["open", "high", "low", "close"],
          "min_symbol_bars": 168,
          "cs_quantile_gte": {"col": "quote_volume", "q": 0.20}
        }
      }
    }
  ]
}`;

/** API 前缀：默认跟随地址栏同源；?api= 可覆盖（本地调试） */
function apiPrefix() {
  const override = new URLSearchParams(window.location.search).get("api");
  if (override) {
    return override.replace(/\/$/, "");
  }
  return window.location.origin;
}

function apiUrl(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${apiPrefix()}${normalized}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tableActionButton(label, action, attrs = {}, { danger = false } = {}) {
  const variant = danger ? "danger" : "default";
  const attrText = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeHtml(String(value))}"`)
    .join(" ");
  return `<sl-button size="small" variant="${variant}" data-action="${escapeHtml(action)}"${attrText ? ` ${attrText}` : ""}>${escapeHtml(label)}</sl-button>`;
}

const IDEA_SOURCE_LABELS = {
  openai: "OpenAI 生成",
  manual: "手动导入",
};

const state = {
  validationById: {},
  tab: "ideas",
  ideas: { offset: 0, source: "" },
  ideaSources: [],
  operators: { offset: 0, status: "" },
  validations: {
    sort: "updated_at",
    order: "desc",
    abs: true,
    limit: 30,
    offset: 0,
    status: "",
    profile_keys: [],
    source: "",
  },
  factorValidations: {
    limit: 30,
    offset: 0,
    status: "",
    profile_keys: [],
  },
  factorValidationById: {},
  icSeriesChartDispose: null,
  validationProfiles: [],
  profileFormMode: "create",
  editingProfileKey: null,
  jupyterServers: [],
  jupyterKernelStatus: null,
  jupyterExecutionOverview: null,
  mlTaskKernelStatus: null,
  mlTaskKernelPollTimer: null,
  jupyterFormMode: "create",
  editingJupyterKey: null,
  llmProviders: [],
  llmRoutes: [],
  llmProviderModels: {},
  llmFormMode: "create",
  llmRouteFormMode: "create",
  editingLlmKey: null,
};

const els = {
  appLayout: document.getElementById("app-layout"),
  authGate: document.getElementById("auth-gate"),
  authForm: document.getElementById("auth-form"),
  authPassword: document.getElementById("auth-password"),
  authError: document.getElementById("auth-error"),
  statsIdeas: document.getElementById("stat-ideas"),
  statsOperators: document.getElementById("stat-operators"),
  statsActiveOps: document.getElementById("stat-active-ops"),
  ideasBody: document.getElementById("ideas-body"),
  operatorsBody: document.getElementById("operators-body"),
  ideasPager: document.getElementById("ideas-pager"),
  operatorsPager: document.getElementById("operators-pager"),
  validationsBody: document.getElementById("validations-body"),
  validationsPager: document.getElementById("validations-pager"),
  factorValidationsBody: document.getElementById("factor-validations-body"),
  factorValidationsPager: document.getElementById("factor-validations-pager"),
  factorValidationsHint: document.getElementById("factor-validations-hint"),
  factorValidationsLimit: document.getElementById("factor-validations-limit"),
  factorValidationsStatus: document.getElementById("factor-validations-status"),
  factorValidationsProfile: document.getElementById("factor-validations-profile"),
  validationsHint: document.getElementById("validations-hint"),
  validationsSort: document.getElementById("validations-sort"),
  validationsOrder: document.getElementById("validations-order"),
  validationsAbs: document.getElementById("validations-abs"),
  validationsLimit: document.getElementById("validations-limit"),
  validationsStatus: document.getElementById("validations-status"),
  validationsProfile: document.getElementById("validations-profile"),
  validationsSource: document.getElementById("validations-source"),
  settingsWorkflowBody: document.getElementById("settings-workflow-body"),
  settingsSchedulesBody: document.getElementById("settings-schedules-body"),
  settingsManualResult: document.getElementById("settings-manual-result"),
  settingsRunValidation: document.getElementById("settings-run-validation"),
  settingsRunCleanup: document.getElementById("settings-run-cleanup"),
  settingsRunForceCleanup: document.getElementById("settings-run-force-cleanup"),
  ideasSource: document.getElementById("ideas-source"),
  profilesBody: document.getElementById("profiles-body"),
  profileDialog: document.getElementById("profile-dialog"),
  profileForm: document.getElementById("profile-form"),
  profileFormTitle: document.getElementById("profile-form-title"),
  profileKeyInput: document.getElementById("profile-key"),
  profileNameInput: document.getElementById("profile-name"),
  profileLabelKindInput: document.getElementById("profile-label-kind"),
  profileHorizonInput: document.getElementById("profile-horizon"),
  profileSortOrderInput: document.getElementById("profile-sort-order"),
  profileDescriptionInput: document.getElementById("profile-description"),
  profileEnabledInput: document.getElementById("profile-enabled"),
  profileFormError: document.getElementById("profile-form-error"),
  jupyterBody: document.getElementById("jupyter-body"),
  jupyterServersKernelHint: document.getElementById("jupyter-servers-kernel-hint"),
  jupyterExecutionBody: document.getElementById("jupyter-execution-body"),
  jupyterExecutionHint: document.getElementById("jupyter-execution-hint"),
  mlTaskKernelsBody: document.getElementById("ml-task-kernels-body"),
  mlTaskKernelsHint: document.getElementById("ml-task-kernels-hint"),
  mlTaskKernelsAutoRefresh: document.getElementById("ml-task-kernels-auto-refresh"),
  mlTaskKernelsRefresh: document.getElementById("ml-task-kernels-refresh"),
  jupyterDialog: document.getElementById("jupyter-dialog"),
  jupyterForm: document.getElementById("jupyter-form"),
  jupyterFormTitle: document.getElementById("jupyter-form-title"),
  jupyterKeyInput: document.getElementById("jupyter-key"),
  jupyterNameInput: document.getElementById("jupyter-name"),
  jupyterBaseUrlInput: document.getElementById("jupyter-base-url"),
  jupyterWsBaseUrlInput: document.getElementById("jupyter-ws-base-url"),
  jupyterAuthTokenInput: document.getElementById("jupyter-auth-token"),
  jupyterAuthHeaderInput: document.getElementById("jupyter-auth-header"),
  jupyterAuthSchemeInput: document.getElementById("jupyter-auth-scheme"),
  jupyterProxyUrlInput: document.getElementById("jupyter-proxy-url"),
  jupyterKernelNameInput: document.getElementById("jupyter-kernel-name"),
  jupyterRuntimeConfigInput: document.getElementById("jupyter-runtime-config"),
  jupyterSortOrderInput: document.getElementById("jupyter-sort-order"),
  jupyterMaxKernelsInput: document.getElementById("jupyter-max-kernels"),
  jupyterEnabledInput: document.getElementById("jupyter-enabled"),
  jupyterFormError: document.getElementById("jupyter-form-error"),
  llmBody: document.getElementById("llm-body"),
  llmRoutesBody: document.getElementById("llm-routes-body"),
  llmDialog: document.getElementById("llm-dialog"),
  llmForm: document.getElementById("llm-form"),
  llmFormTitle: document.getElementById("llm-form-title"),
  llmKeyInput: document.getElementById("llm-key"),
  llmNameInput: document.getElementById("llm-name"),
  llmBaseUrlInput: document.getElementById("llm-base-url"),
  llmApiKeyInput: document.getElementById("llm-api-key"),
  llmModelsInput: document.getElementById("llm-models"),
  llmAuthHeaderInput: document.getElementById("llm-auth-header"),
  llmAuthSchemeInput: document.getElementById("llm-auth-scheme"),
  llmSortOrderInput: document.getElementById("llm-sort-order"),
  llmEnabledInput: document.getElementById("llm-enabled"),
  llmFormError: document.getElementById("llm-form-error"),
  llmRouteDialog: document.getElementById("llm-route-dialog"),
  llmRouteForm: document.getElementById("llm-route-form"),
  llmRouteFormTitle: document.getElementById("llm-route-form-title"),
  llmRouteIdInput: document.getElementById("llm-route-id"),
  llmRouteUsageSelect: document.getElementById("llm-route-usage"),
  llmRouteProviderSelect: document.getElementById("llm-route-provider"),
  llmRouteModelSelect: document.getElementById("llm-route-model"),
  llmRoutePriorityInput: document.getElementById("llm-route-priority"),
  llmRouteTemperatureInput: document.getElementById("llm-route-temperature"),
  llmRouteEnabledInput: document.getElementById("llm-route-enabled"),
  llmRouteFormError: document.getElementById("llm-route-form-error"),
  llmModelsDialog: document.getElementById("llm-models-dialog"),
  llmModelsForm: document.getElementById("llm-models-form"),
  llmModelsFormTitle: document.getElementById("llm-models-form-title"),
  llmModelsProviderKeyInput: document.getElementById("llm-models-provider-key"),
  llmModelsBody: document.getElementById("llm-models-body"),
  llmNewModelNameInput: document.getElementById("llm-new-model-name"),
  llmModelsFormError: document.getElementById("llm-models-form-error"),
  ideasGenerate: document.getElementById("ideas-generate"),
  ideasPromptPreview: document.getElementById("ideas-prompt-preview"),
  generateCount: document.getElementById("generate-count"),
  ideasImportOpen: document.getElementById("ideas-import-open"),
  ideaImportDialog: document.getElementById("idea-import-dialog"),
  ideaImportForm: document.getElementById("idea-import-form"),
  ideaImportJson: document.getElementById("idea-import-json"),
  ideaImportError: document.getElementById("idea-import-error"),
  ideaImportCancel: document.getElementById("idea-import-cancel"),
  operatorsStatus: document.getElementById("operators-status"),
  detailDialog: document.getElementById("detail-dialog"),
  detailContent: document.getElementById("detail-content"),
  factorSqlDialog: document.getElementById("factor-sql-dialog"),
  factorSqlDialogTitle: document.getElementById("factor-sql-dialog-title"),
  factorSqlMeta: document.getElementById("factor-sql-meta"),
  factorSqlSignal: document.getElementById("factor-sql-signal"),
  factorSqlJson: document.getElementById("factor-sql-json"),
  toast: document.getElementById("toast"),
};

function getAuthToken() {
  return sessionStorage.getItem(AUTH_STORAGE_KEY) || "";
}

function setAuthToken(token) {
  sessionStorage.setItem(AUTH_STORAGE_KEY, token);
}

function clearAuthToken() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showAuthGate(message = "") {
  els.appLayout.classList.add("locked");
  els.authGate.classList.remove("hidden");
  if (message) {
    els.authError.textContent = message;
    els.authError.classList.remove("hidden");
  } else {
    els.authError.classList.add("hidden");
  }
}

function hideAuthGate() {
  els.authGate.classList.add("hidden");
  els.appLayout.classList.remove("locked");
  els.authError.classList.add("hidden");
}

async function apiRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "User-Agent": "quant-factors-dashboard/1.0",
      ...authHeaders(),
      ...options.headers,
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};
  if (!contentType.includes("application/json") && response.ok) {
    clearAuthToken();
    showAuthGate("API 路由异常（返回了 HTML 而非 JSON），请刷新页面或联系管理员");
    throw new Error("API 返回非 JSON");
  }
  if (response.status === 401) {
    clearAuthToken();
    showAuthGate("密码错误或已过期，请重新登录");
    throw new Error("未授权");
  }
  if (!response.ok) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

async function apiGet(path) {
  return apiRequest(path);
}

async function apiPost(path, body) {
  return apiRequest(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiPatch(path, body) {
  return apiRequest(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function apiDelete(path) {
  return apiRequest(path, { method: "DELETE" });
}

const LABEL_KIND_LABELS = {
  forward_return: "前向收益",
  forward_volatility: "前向波动",
};

function showToast(message, type = "error") {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "success");
  if (type === "success") {
    els.toast.classList.add("success");
  }
  window.setTimeout(() => els.toast.classList.add("hidden"), 5000);
}

function formatTime(value) {
  if (!value) return "-";
  return value.replace("T", " ").slice(0, 19);
}

function formatRelativeTime(value) {
  if (value == null || value === "") return "-";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "-";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 48) return `${diffHour} 小时前`;
  return formatTime(new Date(ms).toISOString());
}

const JUPYTER_QUERY_REASON_LABELS = {
  server_disabled: "服务器已禁用",
  proxy_not_supported: "配置了 HTTP 代理，Worker 无法直连查询",
  connect_mode_not_supported: "连接模式不支持实时查询",
};

const JUPYTER_ISSUE_LABELS = {
  zombie_running: "僵尸 execution（running + cleanup_at）",
  ghost_execution: "幽灵 execution（kernel 已不存在）",
  orphan_task: "任务已终态但 execution 仍活跃",
  orphan_kernel: "未关联任务的孤儿 kernel",
  slot_drift: "D1 running 与 Jupyter kernel 数偏差",
  coordinator_over_capacity: "Coordinator 超容量"
};

function getJupyterExecutionOverviewItem(serverKey) {
  return (state.jupyterExecutionOverview?.items || []).find((item) => item.key === serverKey) || null;
}

function renderCoordinatorCell(serverKey) {
  const overview = getJupyterExecutionOverviewItem(serverKey);
  if (!overview) {
    return '<span class="muted jupyter-kernel-pending">待查询</span>';
  }
  const coord = overview.coordinator || {};
  if (!coord.available) {
    const err = coord.error ? ` title="${escapeHtml(coord.error)}"` : "";
    return `<span class="muted jupyter-coordinator-unavailable"${err}>不可用</span>`;
  }
  const max = coord.max_slots ?? overview.max_kernels ?? "?";
  const running = coord.running_count ?? 0;
  const queued = coord.queue_length ?? 0;
  const atLimit = max > 0 && running >= max ? " at-limit" : "";
  return `<span class="jupyter-coordinator-cell"><span class="jupyter-capacity${atLimit}">${running} / ${max}</span><span class="muted jupyter-kernel-count-detail">队列 ${queued}</span></span>`;
}

function renderExecutionIssueBadge(issue) {
  const label = JUPYTER_ISSUE_LABELS[issue.type] || issue.type;
  const cls = issue.severity === "error" ? "pending" : "";
  const extra = issue.drift != null ? ` (${issue.drift > 0 ? "+" : ""}${issue.drift})` : "";
  return `<span class="badge ${cls}" title="${escapeHtml(label)}">${escapeHtml(issue.type)}${extra} ×${issue.count}</span>`;
}

function renderBusinessTypeLabel(value) {
  const text = String(value || "");
  if (text === "test_factor_validation") return "test";
  if (text === "factor_validation") return "factor";
  return text || "-";
}

function renderJupyterExecutionPanels(data) {
  const items = data?.items || [];
  if (!els.jupyterExecutionBody) {
    return;
  }
  if (!items.length) {
    els.jupyterExecutionBody.innerHTML = `<p class="muted">暂无 Jupyter Server 配置。</p>`;
    return;
  }

  els.jupyterExecutionBody.innerHTML = items
    .map((server) => {
      const coord = server.coordinator || {};
      const exec = server.executions || {};
      const reconcile = server.reconcile || {};
      const kernels = server.kernels || {};
      const issues = reconcile.issues || [];
      const issueHtml = issues.length
        ? `<div class="jupyter-execution-issues">${issues.map((issue) => renderExecutionIssueBadge(issue)).join(" ")}</div>`
        : `<span class="muted">无对账异常</span>`;

      const activeRows = (server.active || [])
        .map((row) => {
          const issueTags = (row.issues || [])
            .map((type) => `<span class="badge pending">${escapeHtml(type)}</span>`)
            .join(" ");
          const kernelCell = row.kernel_id
            ? `<code title="${escapeHtml(row.kernel_id)}">${escapeHtml(row.kernel_id.slice(0, 12))}${row.kernel_id.length > 12 ? "…" : ""}</code>${row.kernel_live === false ? ' <span class="badge pending">gone</span>' : ""}`
            : '<span class="muted">-</span>';
          return `
            <tr>
              <td><code title="${escapeHtml(row.execution_id)}">${escapeHtml(row.execution_id.slice(0, 8))}…</code></td>
              <td>${escapeHtml(renderBusinessTypeLabel(row.business_type))}</td>
              <td>${escapeHtml(row.business_id)}</td>
              <td><span class="badge active">${escapeHtml(row.status)}</span></td>
              <td>${kernelCell}</td>
              <td>${escapeHtml(row.task_status || "-")}${row.task_stage ? ` <span class="muted">· ${escapeHtml(row.task_stage)}</span>` : ""}</td>
              <td title="${escapeHtml(row.submitted_at || "")}">${formatRelativeTime(row.submitted_at)}</td>
              <td>${issueTags || '<span class="muted">-</span>'}</td>
            </tr>
          `;
        })
        .join("");

      const queuedRows = (server.queued || [])
        .map(
          (row) => `
          <tr>
            <td><code title="${escapeHtml(row.execution_id)}">${escapeHtml(row.execution_id.slice(0, 8))}…</code></td>
            <td>${escapeHtml(renderBusinessTypeLabel(row.business_type))}</td>
            <td>${escapeHtml(row.business_id)}</td>
            <td>${row.priority}</td>
            <td>${escapeHtml(row.task_status || "-")}</td>
            <td title="${escapeHtml(row.created_at || "")}">${formatRelativeTime(row.created_at)}</td>
          </tr>
        `,
        )
        .join("");

      const coordLabel = coord.available
        ? `${coord.running_count ?? 0} / ${coord.max_slots ?? "?"} · 队列 ${coord.queue_length ?? 0}`
        : coord.error || "不可用";
      const drift =
        reconcile.slot_drift == null
          ? "-"
          : `${reconcile.d1_running ?? 0} / ${reconcile.jupyter_kernels ?? 0}${reconcile.slot_drift !== 0 ? ` (${reconcile.slot_drift > 0 ? "+" : ""}${reconcile.slot_drift})` : ""}`;

      return `
        <div class="jupyter-execution-server">
          <div class="jupyter-kernels-server-header">
            <div class="jupyter-kernels-server-title">
              <strong>${escapeHtml(server.name || server.key)}</strong>
              <code>${escapeHtml(server.key)}</code>
            </div>
            <div class="jupyter-kernels-capacity">
              <span class="jupyter-execution-metric">Coordinator ${escapeHtml(String(coordLabel))}</span>
              <span class="muted">queued ${exec.queued ?? 0} · running ${exec.running ?? 0} · 近1分钟成功 ${exec.succeeded_1m ?? 0}</span>
            </div>
          </div>
          <div class="jupyter-execution-summary">
            <span>D1 running / Jupyter kernel：${escapeHtml(String(drift))}</span>
            <span>zombie ${exec.zombie ?? 0} · 孤儿 kernel ${kernels.orphan ?? 0}</span>
            ${issueHtml}
          </div>
          ${
            activeRows
              ? `<div class="table-wrap">
            <table class="validation-table jupyter-execution-table">
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>业务</th>
                  <th>Task ID</th>
                  <th>状态</th>
                  <th>Kernel</th>
                  <th>ML Task</th>
                  <th>提交</th>
                  <th>异常</th>
                </tr>
              </thead>
              <tbody>${activeRows}</tbody>
            </table>
          </div>`
              : `<p class="muted">当前无活跃 execution。</p>`
          }
          ${
            queuedRows
              ? `<details class="jupyter-execution-queued">
            <summary>排队中 (${(server.queued || []).length})</summary>
            <div class="table-wrap">
              <table class="validation-table jupyter-execution-table">
                <thead>
                  <tr>
                    <th>Execution</th>
                    <th>业务</th>
                    <th>Task ID</th>
                    <th>优先级</th>
                    <th>ML Task</th>
                    <th>入队</th>
                  </tr>
                </thead>
                <tbody>${queuedRows}</tbody>
              </table>
            </div>
          </details>`
              : ""
          }
        </div>
      `;
    })
    .join("");
}

async function loadJupyterExecutionOverview() {
  const data = await apiGet("/api/jupyter-servers/execution-overview?include_disabled=1");
  state.jupyterExecutionOverview = data;
  renderJupyterExecutionPanels(data);
  if (els.jupyterExecutionHint) {
    const issueCount = (data.items || []).reduce(
      (sum, item) => sum + (item.reconcile?.issues?.length || 0),
      0,
    );
    els.jupyterExecutionHint.textContent = data.fetched_at
      ? `最近更新：${formatTime(data.fetched_at)}（${formatRelativeTime(data.fetched_at)}）${issueCount ? ` · ${issueCount} 项对账异常` : ""}`
      : "";
  }
  if (state.jupyterServers.length) {
    renderJupyterTable(state.jupyterServers);
  }
  return data;
}

function kernelExecutionBadge(state) {
  const normalized = String(state || "unknown");
  const cls =
    normalized === "busy" ? "active" : normalized === "starting" ? "pending" : normalized === "idle" ? "" : "";
  return `<span class="badge ${cls}">${escapeHtml(normalized)}</span>`;
}

function getJupyterKernelStatusItem(serverKey) {
  return (state.jupyterKernelStatus?.items || []).find((item) => item.key === serverKey) || null;
}

function renderJupyterKernelFetchedAt(fetchedAt) {
  if (!fetchedAt) {
    return "";
  }
  const absolute = formatTime(fetchedAt);
  const relative = formatRelativeTime(fetchedAt);
  return `<span class="jupyter-fetched-at" title="${escapeHtml(absolute)}">${relative}</span>`;
}

function renderJupyterKernelCountCell(serverKey) {
  const status = getJupyterKernelStatusItem(serverKey);
  if (!status) {
    return '<span class="muted jupyter-kernel-pending">待查询</span>';
  }
  if (!status.queryable) {
    const reason = JUPYTER_QUERY_REASON_LABELS[status.query_reason] || status.query_reason || "";
    return `<span class="muted" title="${escapeHtml(reason)}">不可查</span>`;
  }
  if (status.error) {
    return `<span class="badge pending jupyter-kernel-error" title="${escapeHtml(status.error)}">查询失败</span>`;
  }
  const capacity = status.capacity || {};
  const total = capacity.current ?? status.summary?.total ?? 0;
  if (!capacity.limited) {
    return `<span class="jupyter-capacity" title="当前 kernel 总数">${total}</span>`;
  }
  const limit = capacity.limit ?? "?";
  const atLimit = capacity.at_limit ? " at-limit" : "";
  const summary = status.summary || {};
  const detail = `idle ${summary.idle ?? 0} · busy ${summary.busy ?? 0} · 孤儿 ${summary.orphan ?? 0}`;
  return `<span class="jupyter-kernel-count-cell"><span class="jupyter-capacity${atLimit}">${total} / ${limit}</span><span class="muted jupyter-kernel-count-detail">${detail}</span></span>`;
}

function renderJupyterKernelFetchedAtCell(serverKey) {
  const status = getJupyterKernelStatusItem(serverKey);
  if (!status?.fetched_at) {
    return '<span class="muted">-</span>';
  }
  return renderJupyterKernelFetchedAt(status.fetched_at);
}

function updateJupyterServersKernelHint(data) {
  if (!els.jupyterServersKernelHint) {
    return;
  }
  const items = data?.items || [];
  if (!items.length) {
    els.jupyterServersKernelHint.textContent = "";
    return;
  }
  const queried = items.filter((item) => item.fetched_at);
  const failed = items.filter((item) => item.error);
  const totalKernels = items.reduce((sum, item) => {
    if (item.error || !item.queryable) {
      return sum;
    }
    const count = item.capacity?.current ?? item.summary?.total ?? 0;
    return sum + count;
  }, 0);
  const parts = [`当前共 ${totalKernels} 个 kernel`];
  if (data.fetched_at) {
    parts.push(`批量采集于 ${formatTime(data.fetched_at)}（${formatRelativeTime(data.fetched_at)}）`);
  }
  if (failed.length) {
    parts.push(`${failed.length} 台查询失败`);
  } else if (queried.length < items.length) {
    parts.push(`${items.length - queried.length} 台未采集`);
  }
  els.jupyterServersKernelHint.textContent = parts.join(" · ");
}

function renderMlTaskLabel(task) {
  if (!task) {
    return "";
  }
  const parts = [`#${task.task_id}`];
  if (task.factor_validation_id) {
    parts.push(`fv:${task.factor_validation_id}`);
  }
  if (task.idea_id) {
    parts.push(`idea:${task.idea_id}`);
  }
  if (task.profile_key) {
    parts.push(task.profile_key);
  }
  return parts.join(" · ");
}

function renderMlTaskKernelPanels(data) {
  const items = data?.items || [];
  if (!els.mlTaskKernelsBody) {
    return;
  }
  if (!items.length) {
    els.mlTaskKernelsBody.innerHTML = `<p class="muted">暂无 Jupyter Server 配置。</p>`;
    return;
  }

  els.mlTaskKernelsBody.innerHTML = items
    .map((server) => {
      const capacity = server.capacity || {};
      const summary = server.summary || {};
      const capacityLabel = capacity.limited
        ? `${capacity.current ?? "?"} / ${capacity.limit}`
        : `${summary.total ?? capacity.current ?? 0} / 不限`;
      const atLimitClass = capacity.at_limit ? " at-limit" : "";
      const fetchedLabel = server.fetched_at
        ? `<span class="jupyter-kernels-fetched muted">采集 ${formatRelativeTime(server.fetched_at)}</span>`
        : "";

      if (!server.queryable) {
        const reason = JUPYTER_QUERY_REASON_LABELS[server.query_reason] || server.query_reason || "无法查询";
        return `
          <div class="jupyter-kernels-server">
            <div class="jupyter-kernels-server-header">
              <div class="jupyter-kernels-server-title">
                <strong>${escapeHtml(server.name || server.key)}</strong>
                <code>${escapeHtml(server.key)}</code>
              </div>
              ${fetchedLabel}
            </div>
            <p class="muted">${escapeHtml(reason)}</p>
          </div>
        `;
      }

      if (server.error) {
        return `
          <div class="jupyter-kernels-server">
            <div class="jupyter-kernels-server-header">
              <div class="jupyter-kernels-server-title">
                <strong>${escapeHtml(server.name || server.key)}</strong>
                <code>${escapeHtml(server.key)}</code>
              </div>
              <div class="jupyter-kernels-capacity">
                <span class="badge pending">查询失败</span>
                ${fetchedLabel}
              </div>
            </div>
            <p class="auth-error">${escapeHtml(server.error)}</p>
          </div>
        `;
      }

      const kernelRows = (server.kernels || [])
        .map((kernel) => {
          const task = kernel.ml_task;
          const execution = kernel.execution;
          let taskCell = "";
          if (execution) {
            taskCell = `<span class="jupyter-kernel-exec"><code title="${escapeHtml(execution.execution_id)}">${escapeHtml(execution.execution_id.slice(0, 8))}…</code> · ${escapeHtml(renderBusinessTypeLabel(execution.business_type))} #${escapeHtml(execution.business_id)} <span class="muted">(${escapeHtml(execution.execution_status)}${execution.task_status ? ` · task ${escapeHtml(execution.task_status)}` : ""})</span></span>`;
          } else if (kernel.linked) {
            taskCell = `<a href="#" data-action="view-ml-task-kernel" data-task-id="${task.task_id}">${escapeHtml(renderMlTaskLabel(task))}</a> · ${escapeHtml(task.title || "-")} <span class="muted">(${escapeHtml(task.status)}${task.stage ? ` · ${escapeHtml(task.stage)}` : ""})</span>`;
          } else if (task?.kernel_cleaned_at) {
            taskCell = `<span class="muted">已清理 · ${escapeHtml(renderMlTaskLabel(task))}</span>`;
          } else {
            taskCell = `<span class="muted">未关联 execution / ML 任务</span>`;
          }
          return `
            <tr>
              <td><code title="${escapeHtml(kernel.kernel_id)}">${escapeHtml(kernel.kernel_id.slice(0, 12))}${kernel.kernel_id.length > 12 ? "…" : ""}</code></td>
              <td>${kernelExecutionBadge(kernel.execution_state)}</td>
              <td title="${escapeHtml(kernel.last_activity || "")}">${formatRelativeTime(kernel.last_activity_ms ?? kernel.last_activity)}</td>
              <td>${taskCell}</td>
            </tr>
          `;
        })
        .join("");

      return `
        <div class="jupyter-kernels-server">
          <div class="jupyter-kernels-server-header">
            <div class="jupyter-kernels-server-title">
              <strong>${escapeHtml(server.name || server.key)}</strong>
              <code>${escapeHtml(server.key)}</code>
            </div>
            <div class="jupyter-kernels-capacity">
              <span class="jupyter-kernels-count${atLimitClass}">${capacityLabel}</span>
              ${fetchedLabel}
              <span class="muted">idle ${summary.idle ?? 0} · busy ${summary.busy ?? 0} · 孤儿 ${summary.orphan ?? 0}</span>
            </div>
          </div>
          ${
            kernelRows
              ? `<div class="table-wrap">
            <table class="validation-table jupyter-kernels-table">
              <thead>
                <tr>
                  <th>Kernel ID</th>
                  <th>状态</th>
                  <th>最后活动</th>
                  <th>关联 Execution / ML 任务</th>
                </tr>
              </thead>
              <tbody>${kernelRows}</tbody>
            </table>
          </div>`
              : `<p class="muted">当前无 kernel 占用。</p>`
          }
        </div>
      `;
    })
    .join("");
}

async function loadJupyterKernelStatus() {
  const data = await apiGet("/api/jupyter-servers/kernel-status?include_disabled=1");
  state.jupyterKernelStatus = data;
  updateJupyterServersKernelHint(data);
  if (state.jupyterServers.length) {
    renderJupyterTable(state.jupyterServers);
  }
  return data;
}

async function loadMlTaskKernelStatus() {
  const data = await apiGet("/api/ml-tasks/kernel-status?include_disabled=1");
  state.mlTaskKernelStatus = data;
  renderMlTaskKernelPanels(data);
  if (els.mlTaskKernelsHint) {
    els.mlTaskKernelsHint.textContent = data.fetched_at
      ? `最近更新：${formatTime(data.fetched_at)}（${formatRelativeTime(data.fetched_at)}） · 共 ${(data.items || []).length} 台服务器`
      : "";
  }
  return data;
}

function stopMlTaskKernelPolling() {
  if (state.mlTaskKernelPollTimer) {
    clearInterval(state.mlTaskKernelPollTimer);
    state.mlTaskKernelPollTimer = null;
  }
}

function startMlTaskKernelPolling() {
  stopMlTaskKernelPolling();
  if (!els.mlTaskKernelsAutoRefresh?.checked) {
    return;
  }
  state.mlTaskKernelPollTimer = window.setInterval(() => {
    if (state.tab === "jupyter") {
      Promise.all([
        loadJupyterExecutionOverview(),
        loadMlTaskKernelStatus(),
        loadJupyterKernelStatus(),
      ]).catch(() => {});
    }
  }, 30000);
}

async function loadJupyterAdmin() {
  await loadJupyterServersAdmin();
  await Promise.all([
    loadJupyterExecutionOverview(),
    loadJupyterKernelStatus(),
    loadMlTaskKernelStatus(),
  ]);
  startMlTaskKernelPolling();
}

function badge(status) {
  const cls = status === "active" ? "active" : status === "pending" ? "pending" : "";
  return `<span class="badge ${cls}">${status}</span>`;
}

function renderPager(container, { total, offset, limit }, onPage) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  container.innerHTML = `
    <span>第 ${page} / ${pages} 页，共 ${total} 条</span>
    <span class="pager-actions">
      <sl-button size="small" data-dir="prev" ${offset <= 0 ? "disabled" : ""}>上一页</sl-button>
      <sl-button size="small" data-dir="next" ${offset + limit >= total ? "disabled" : ""}>下一页</sl-button>
    </span>
  `;
  container.querySelectorAll("[data-dir]").forEach((button) => {
    button.addEventListener("click", () => {
      const dir = button.getAttribute("data-dir");
      const nextOffset = dir === "prev" ? Math.max(0, offset - limit) : offset + limit;
      onPage(nextOffset);
    });
  });
}

function validationStatusBadge(status) {
  const cls =
    status === "success"
      ? "active"
      : status === "failed"
        ? "danger"
      : status === "pending" || status === "running"
        ? "pending"
        : "";
  return `<span class="badge ${cls}">${status}</span>`;
}

function cacheValidationRows(items) {
  for (const row of items || []) {
    if (row?.id != null) {
      state.validationById[row.id] = row;
    }
  }
}

function factorSqlSummary(factorSql) {
  if (!factorSql || typeof factorSql !== "object") {
    return null;
  }
  const signal = factorSql.signal_sql;
  if (typeof signal === "string" && signal.trim()) {
    return signal.trim();
  }
  return null;
}

function renderFactorSqlCell(row) {
  const sql = factorSqlSummary(row.factor_sql);
  if (!sql) {
    return '<span class="muted">—</span>';
  }
  const preview = sql.length > 48 ? `${sql.slice(0, 47)}…` : sql;
  return `
    <sl-button
      size="small"
      variant="text"
      class="factor-sql-preview"
      data-action="view-factor-sql"
      data-validation-id="${row.id}"
      title="${escapeHtml(sql)}"
    >${escapeHtml(preview)}</sl-button>
  `;
}

function openFactorSqlDialog(validation) {
  if (!validation) {
    showToast("未找到验证记录");
    return;
  }
  const title = validation.idea_title || `想法 #${validation.idea_id}`;
  els.factorSqlDialogTitle.textContent = `翻译 SQL · 验证 #${validation.id}`;
  els.factorSqlMeta.innerHTML = `
    <dt>因子</dt><dd>${escapeHtml(title)}</dd>
    <dt>验证配置</dt><dd>${escapeHtml(validation.profile_name || validation.profile_key || "-")}</dd>
    <dt>状态</dt><dd>${validationStatusBadge(validation.status)}</dd>
    <dt>评估时间</dt><dd>${validation.evaluated_at ? formatTime(validation.evaluated_at) : "-"}</dd>
  `;
  const sql = factorSqlSummary(validation.factor_sql);
  els.factorSqlSignal.textContent = sql || "（暂无 signal_sql，可能尚未完成翻译）";
  els.factorSqlJson.textContent = validation.factor_sql
    ? JSON.stringify(validation.factor_sql, null, 2)
    : "（尚未翻译）";
  els.factorSqlDialog.showModal();
}

function openFactorSqlDialogById(validationId) {
  const row = state.validationById[validationId];
  if (row) {
    openFactorSqlDialog(row);
    return;
  }
  showToast("请刷新列表后重试");
}

function formatMetric(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "number") return value.toFixed(4);
  return String(value);
}

function formatPercent(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "number") return `${(value * 100).toFixed(1)}%`;
  return String(value);
}

function formatIdeaSourceLabel(source) {
  if (!source) return "全部";
  return IDEA_SOURCE_LABELS[source] || source;
}

function renderIdeaSourceOptions(selectEl, currentValue) {
  const options = state.ideaSources
    .map(
      (source) =>
        `<sl-option value="${escapeHtml(source)}">${escapeHtml(formatIdeaSourceLabel(source))}</sl-option>`,
    )
    .join("");
  selectEl.innerHTML = `<sl-option value="">全部</sl-option>${options}`;
  selectEl.value = currentValue || "";
}

async function loadIdeaSourceOptions() {
  const data = await apiGet("/api/ideas/sources");
  state.ideaSources = data.items || [];
  renderIdeaSourceOptions(els.ideasSource, state.ideas.source);
  renderIdeaSourceOptions(els.validationsSource, state.validations.source);
}

function readMultiSelectValues(selectEl) {
  const raw = selectEl.value;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (raw) return [raw];
  return [];
}

function formatProfileKeysLabel(keys) {
  if (!keys?.length) return "";
  return keys
    .map((key) => {
      const profile = state.validationProfiles.find((item) => item.key === key);
      return profile?.name || key;
    })
    .join("、");
}

function syncValidationControlsFromState() {
  els.validationsSort.value = state.validations.sort;
  els.validationsOrder.value = state.validations.order;
  els.validationsAbs.checked = state.validations.abs;
  els.validationsLimit.value = String(state.validations.limit);
  els.validationsStatus.value = state.validations.status;
  els.validationsProfile.value = state.validations.profile_keys;
  els.validationsSource.value = state.validations.source;
}

function readValidationControlsIntoState() {
  state.validations.sort = els.validationsSort.value;
  state.validations.order = els.validationsOrder.value;
  state.validations.abs = els.validationsAbs.checked;
  state.validations.limit = Math.min(
    200,
    Math.max(1, Number(els.validationsLimit.value) || 30),
  );
  state.validations.status = els.validationsStatus.value;
  state.validations.profile_keys = readMultiSelectValues(els.validationsProfile);
  state.validations.source = els.validationsSource.value;
}

function buildValidationQueryParams() {
  const { sort, order, abs, limit, offset, status, profile_keys, source } = state.validations;
  const params = new URLSearchParams({
    sort,
    order,
    abs: abs ? "1" : "0",
    limit: String(limit),
    offset: String(offset),
  });
  if (status) params.set("status", status);
  for (const profileKey of profile_keys) {
    params.append("profile_key", profileKey);
  }
  if (source) params.set("source", source);
  return params;
}

function updateValidationSortHeaders() {
  document.querySelectorAll("#panel-validations th[data-sort]").forEach((header) => {
    const field = header.getAttribute("data-sort");
    const active = field === state.validations.sort;
    header.classList.toggle("sort-active", active);
    header.classList.toggle("sort-desc", active && state.validations.order === "desc");
    header.classList.toggle("sort-asc", active && state.validations.order === "asc");
  });
}

function validationQueryHint(data) {
  const metricLabel = {
    mean_ic: "Mean IC",
    mean_rank_ic: "Mean Rank IC",
    ic_ir: "IC IR",
    rank_ic_ir: "Rank IC IR",
    n_periods: "期数",
    evaluated_at: "评估时间",
  }[data.sort] || data.sort;
  const absLabel = data.abs && data.sort !== "evaluated_at" && data.sort !== "n_periods" ? "绝对值 " : "";
  const statusLabel = data.status ? `，状态=${data.status}` : "，全部状态";
  const profileKeys = data.profile_keys?.length
    ? data.profile_keys
    : data.profile_key
      ? [data.profile_key]
      : [];
  const profileLabel = profileKeys.length ? `，配置=${formatProfileKeysLabel(profileKeys)}` : "";
  const sourceLabel = data.source ? `，来源=${formatIdeaSourceLabel(data.source)}` : "";
  return `${absLabel}${metricLabel} ${data.order === "desc" ? "降序" : "升序"} Top ${data.limit}${statusLabel}${profileLabel}${sourceLabel}，共 ${data.total} 条`;
}

async function loadValidationProfiles(includeDisabled = false) {
  const query = includeDisabled ? "?include_disabled=1" : "";
  const data = await apiGet(`/api/validation-profiles${query}`);
  state.validationProfiles = data.items || [];
  return data;
}

async function loadSystemSettings() {
  const data = await apiGet("/api/workflow/system-settings");
  renderSystemSettings(data);
  return data;
}

function renderSystemSettings(data) {
  const items = data.items || [];
  if (els.settingsWorkflowBody) {
    els.settingsWorkflowBody.innerHTML = items
      .map((item) => {
        if (item.type === "boolean") {
          return `
            <div class="settings-row" data-setting-key="${escapeHtml(item.key)}">
              <div class="settings-row-main">
                <div class="settings-row-label">${escapeHtml(item.label)}</div>
                <div class="settings-row-desc muted">${escapeHtml(item.description || "")}</div>
              </div>
              <sl-switch class="settings-switch" data-setting-key="${escapeHtml(item.key)}" ${item.value ? "checked" : ""}>
                ${escapeHtml(item.value ? "已开启" : "已关闭")}
              </sl-switch>
            </div>
          `;
        }
        return `
          <div class="settings-row" data-setting-key="${escapeHtml(item.key)}">
            <div class="settings-row-main">
              <div class="settings-row-label">${escapeHtml(item.label)}</div>
              <div class="settings-row-desc muted">${escapeHtml(item.description || "")}</div>
            </div>
            <sl-input
              class="settings-number"
              type="number"
              size="small"
              data-setting-key="${escapeHtml(item.key)}"
              min="${item.min ?? 1}"
              max="${item.max ?? 30}"
              value="${escapeHtml(String(item.value))}"
            ></sl-input>
          </div>
        `;
      })
      .join("");
  }

  const schedules = data.schedules || [];
  if (els.settingsSchedulesBody) {
    els.settingsSchedulesBody.innerHTML = schedules
      .map(
        (schedule) => `
        <div class="settings-row settings-row--readonly">
          <div class="settings-row-main">
            <div class="settings-row-label">${escapeHtml(schedule.label)}</div>
            <div class="settings-row-desc muted"><code>${escapeHtml(schedule.cron)}</code></div>
          </div>
          <span class="settings-badge">${escapeHtml(schedule.cron_label || schedule.cron)}</span>
        </div>
      `,
      )
      .join("");
  }
}

async function patchSystemSetting(key, value) {
  const data = await apiPatch("/api/workflow/system-settings", { [key]: value });
  renderSystemSettings(data);
  return data;
}

function showManualActionResult(payload) {
  if (!els.settingsManualResult) return;
  els.settingsManualResult.textContent = JSON.stringify(payload, null, 2);
  els.settingsManualResult.classList.remove("hidden");
}

async function runValidationBatchNow() {
  const button = els.settingsRunValidation;
  const originalText = button.textContent;
  button.disabled = true;
  button.loading = true;
  button.textContent = "运行中…";
  try {
    const result = await apiPost("/run-validation-batch");
    showManualActionResult(result);
    showToast("验证批处理已执行", "success");
    return result;
  } finally {
    button.disabled = false;
    button.loading = false;
    button.textContent = originalText;
  }
}

async function runKernelCleanupNow({ force = false } = {}) {
  const button = force ? els.settingsRunForceCleanup : els.settingsRunCleanup;
  const originalText = button.textContent;
  button.disabled = true;
  button.loading = true;
  button.textContent = "运行中…";
  try {
    const result = await apiPost(force ? "/run-kernel-cleanup?force=1" : "/run-kernel-cleanup");
    showManualActionResult(result);
    showToast(force ? "Kernel 强制清理已执行" : "Kernel 清理已执行", "success");
    return result;
  } finally {
    button.disabled = false;
    button.loading = false;
    button.textContent = originalText;
  }
}

async function loadEnabledProfileOptionsForFactorValidations() {
  await loadValidationProfiles(false);
  const current = state.factorValidations.profile_keys;
  els.factorValidationsProfile.innerHTML = state.validationProfiles
    .map(
      (profile) =>
        `<sl-option value="${escapeHtml(profile.key)}">${escapeHtml(profile.name || profile.key)}</sl-option>`,
    )
    .join("");
  els.factorValidationsProfile.value = current;
}

async function loadEnabledProfileOptions() {
  const data = await loadValidationProfiles(false);
  const current = state.validations.profile_keys;
  els.validationsProfile.innerHTML = state.validationProfiles
    .map(
      (profile) =>
        `<sl-option value="${escapeHtml(profile.key)}">${escapeHtml(profile.name || profile.key)}</sl-option>`,
    )
    .join("");
  els.validationsProfile.value = current;
  return data;
}

function labelKindLabel(kind) {
  return LABEL_KIND_LABELS[kind] || kind || "-";
}

function renderProfilesTable(items) {
  if (!items.length) {
    els.profilesBody.innerHTML = `<tr><td colspan="8" class="muted">暂无验证配置。</td></tr>`;
    return;
  }
  els.profilesBody.innerHTML = items
    .map(
      (profile) => `
      <tr data-profile-key="${profile.key}">
        <td><code>${profile.key}</code></td>
        <td>${profile.name}</td>
        <td>${labelKindLabel(profile.label_kind)}</td>
        <td>${profile.horizon_bars}</td>
        <td>${profile.sort_order ?? 0}</td>
        <td>${profile.enabled ? '<span class="badge active">enabled</span>' : '<span class="badge">disabled</span>'}</td>
        <td>${profile.description || "-"}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton("编辑", "edit-profile", { "data-key": profile.key })}
            ${tableActionButton(profile.enabled ? "禁用" : "启用", "toggle-profile", { "data-key": profile.key })}
            ${tableActionButton("删除", "delete-profile", { "data-key": profile.key }, { danger: true })}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");
}

async function loadValidationProfilesAdmin() {
  const data = await loadValidationProfiles(true);
  renderProfilesTable(data.items || []);
}

function showProfileFormError(message) {
  if (!message) {
    els.profileFormError.classList.add("hidden");
    els.profileFormError.textContent = "";
    return;
  }
  els.profileFormError.textContent = message;
  els.profileFormError.classList.remove("hidden");
}

function openProfileDialog(mode, profile = null) {
  state.profileFormMode = mode;
  state.editingProfileKey = profile?.key ?? null;
  showProfileFormError("");
  els.profileFormTitle.textContent = mode === "create" ? "新建验证配置" : "编辑验证配置";
  els.profileKeyInput.disabled = mode === "edit";
  els.profileKeyInput.value = profile?.key ?? "";
  els.profileNameInput.value = profile?.name ?? "";
  els.profileLabelKindInput.value = profile?.label_kind ?? "forward_return";
  els.profileHorizonInput.value = String(profile?.horizon_bars ?? 1);
  els.profileSortOrderInput.value = String(profile?.sort_order ?? 0);
  els.profileDescriptionInput.value = profile?.description ?? "";
  els.profileEnabledInput.checked = profile?.enabled !== false;
  if (mode === "edit") {
    els.profileLabelKindInput.disabled = true;
    els.profileHorizonInput.disabled = true;
  } else {
    els.profileLabelKindInput.disabled = false;
    els.profileHorizonInput.disabled = false;
  }
  els.profileDialog.showModal();
}

async function saveProfileFromForm(event) {
  event.preventDefault();
  showProfileFormError("");
  const payload = {
    name: els.profileNameInput.value.trim(),
    label_kind: els.profileLabelKindInput.value,
    horizon_bars: Number(els.profileHorizonInput.value),
    description: els.profileDescriptionInput.value.trim(),
    sort_order: Number(els.profileSortOrderInput.value) || 0,
    enabled: els.profileEnabledInput.checked,
  };
  try {
    if (state.profileFormMode === "create") {
      payload.key = els.profileKeyInput.value.trim();
      await apiPost("/api/validation-profiles", payload);
      showToast("验证配置已创建", "success");
    } else {
      await apiPatch(`/api/validation-profiles/${state.editingProfileKey}`, payload);
      showToast("验证配置已更新", "success");
    }
    els.profileDialog.close();
    await Promise.all([loadValidationProfilesAdmin(), loadEnabledProfileOptions()]);
  } catch (error) {
    showProfileFormError(error instanceof Error ? error.message : String(error));
  }
}

async function toggleProfileEnabled(key, enabled) {
  await apiPatch(`/api/validation-profiles/${key}`, { enabled });
  showToast(enabled ? "已启用" : "已禁用", "success");
  await Promise.all([loadValidationProfilesAdmin(), loadEnabledProfileOptions()]);
}

async function deleteProfile(key) {
  const result = await apiDelete(`/api/validation-profiles/${key}`);
  if (result.disabled) {
    showToast("该配置已有验证任务，已改为禁用", "success");
  } else if (result.deleted) {
    showToast("验证配置已删除", "success");
  }
  await Promise.all([loadValidationProfilesAdmin(), loadEnabledProfileOptions()]);
}

const JUPYTER_CONNECT_MODE = "kernel_channels";
const DEFAULT_RUNTIME_CONFIG = {
  target_file: "futures/um/klines/1h.parquet",
};

function formatRuntimeConfig(config) {
  const value =
    config && typeof config === "object" && !Array.isArray(config) ? config : DEFAULT_RUNTIME_CONFIG;
  return JSON.stringify(value, null, 2);
}

function parseRuntimeConfigInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { ...DEFAULT_RUNTIME_CONFIG };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("运行时配置必须是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("运行时配置必须是 JSON 对象");
  }
  return parsed;
}

function truncateUrl(url, max = 48) {
  const text = String(url || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

async function loadJupyterServers(includeDisabled = true) {
  const query = includeDisabled ? "?include_disabled=1" : "";
  const data = await apiGet(`/api/jupyter-servers${query}`);
  state.jupyterServers = data.items || [];
  return data;
}

function renderJupyterTable(items) {
  if (!items.length) {
    els.jupyterBody.innerHTML = `<tr><td colspan="11" class="muted">暂无 Jupyter Server 配置。</td></tr>`;
    return;
  }
  els.jupyterBody.innerHTML = items
    .map(
      (server) => `
      <tr data-jupyter-key="${server.key}">
        <td><code>${server.key}</code></td>
        <td>${server.name}</td>
        <td title="${server.base_url}"><code>${truncateUrl(server.base_url)}</code></td>
        <td>${server.max_kernels == null ? "不限" : server.max_kernels}</td>
        <td>${renderCoordinatorCell(server.key)}</td>
        <td>${renderJupyterKernelCountCell(server.key)}</td>
        <td>${renderJupyterKernelFetchedAtCell(server.key)}</td>
        <td>${server.sort_order ?? 0}</td>
        <td>${server.enabled ? '<span class="badge active">enabled</span>' : '<span class="badge">disabled</span>'}</td>
        <td>${server.last_used_at ? formatTime(server.last_used_at) : "-"}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton("编辑", "edit-jupyter", { "data-key": server.key })}
            ${tableActionButton(server.enabled ? "禁用" : "启用", "toggle-jupyter", { "data-key": server.key })}
            ${tableActionButton("删除", "delete-jupyter", { "data-key": server.key }, { danger: true })}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");
}

async function loadJupyterServersAdmin() {
  const data = await loadJupyterServers(true);
  renderJupyterTable(data.items || []);
}

function showJupyterFormError(message) {
  if (!message) {
    els.jupyterFormError.classList.add("hidden");
    els.jupyterFormError.textContent = "";
    return;
  }
  els.jupyterFormError.textContent = message;
  els.jupyterFormError.classList.remove("hidden");
}

function suggestWsBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim();
  if (!value.startsWith("https://")) return "";
  return `wss://${value.slice("https://".length)}`.replace(/\/$/, "");
}

function openJupyterDialog(mode, server = null) {
  state.jupyterFormMode = mode;
  state.editingJupyterKey = server?.key ?? null;
  showJupyterFormError("");
  els.jupyterFormTitle.textContent = mode === "create" ? "新建 Jupyter Server" : "编辑 Jupyter Server";
  els.jupyterKeyInput.disabled = mode === "edit";
  els.jupyterKeyInput.value = server?.key ?? "";
  els.jupyterNameInput.value = server?.name ?? "";
  els.jupyterBaseUrlInput.value = server?.base_url ?? "";
  els.jupyterWsBaseUrlInput.value = server?.ws_base_url ?? "";
  els.jupyterAuthTokenInput.value = server?.auth_token ?? "";
  els.jupyterAuthHeaderInput.value = server?.auth_header ?? "Authorization";
  els.jupyterAuthSchemeInput.value = server?.auth_scheme ?? "token";
  els.jupyterProxyUrlInput.value = server?.proxy_url ?? "";
  els.jupyterKernelNameInput.value = server?.kernel_name ?? "python3";
  els.jupyterRuntimeConfigInput.value = formatRuntimeConfig(server?.runtime_config);
  els.jupyterMaxKernelsInput.value =
    server?.max_kernels == null ? "" : String(server.max_kernels ?? 30);
  els.jupyterSortOrderInput.value = String(server?.sort_order ?? 0);
  els.jupyterEnabledInput.checked = server?.enabled !== false;
  els.jupyterDialog.showModal();
}

async function saveJupyterFromForm(event) {
  event.preventDefault();
  showJupyterFormError("");
  let runtimeConfig;
  try {
    runtimeConfig = parseRuntimeConfigInput(els.jupyterRuntimeConfigInput.value);
  } catch (error) {
    showJupyterFormError(error instanceof Error ? error.message : String(error));
    return;
  }
  const baseUrl = els.jupyterBaseUrlInput.value.trim().replace(/\/$/, "");
  let wsBaseUrl = els.jupyterWsBaseUrlInput.value.trim().replace(/\/$/, "");
  if (!wsBaseUrl) {
    wsBaseUrl = suggestWsBaseUrl(baseUrl);
  }
  const payload = {
    name: els.jupyterNameInput.value.trim(),
    base_url: baseUrl,
    ws_base_url: wsBaseUrl || null,
    connect_mode: JUPYTER_CONNECT_MODE,
    auth_token: els.jupyterAuthTokenInput.value.trim(),
    auth_header: els.jupyterAuthHeaderInput.value.trim() || "Authorization",
    auth_scheme: els.jupyterAuthSchemeInput.value.trim() || "token",
    proxy_url: els.jupyterProxyUrlInput.value.trim() || null,
    kernel_name: els.jupyterKernelNameInput.value.trim() || "python3",
    runtime_config: runtimeConfig,
    max_kernels: (() => {
      const raw = els.jupyterMaxKernelsInput.value.trim();
      if (!raw) {
        return 30;
      }
      const parsed = Number(raw);
      return parsed === 0 ? 0 : parsed;
    })(),
    sort_order: Number(els.jupyterSortOrderInput.value) || 0,
    enabled: els.jupyterEnabledInput.checked,
  };
  try {
    if (state.jupyterFormMode === "create") {
      payload.key = els.jupyterKeyInput.value.trim();
      await apiPost("/api/jupyter-servers", payload);
      showToast("Jupyter Server 已创建", "success");
    } else {
      await apiPatch(`/api/jupyter-servers/${state.editingJupyterKey}`, payload);
      showToast("Jupyter Server 已更新", "success");
    }
    els.jupyterDialog.close();
    await loadJupyterServersAdmin();
  } catch (error) {
    showJupyterFormError(error instanceof Error ? error.message : String(error));
  }
}

async function toggleJupyterEnabled(key, enabled) {
  await apiPatch(`/api/jupyter-servers/${key}`, { enabled });
  showToast(enabled ? "已启用" : "已禁用", "success");
  await loadJupyterServersAdmin();
}

async function deleteJupyterServer(key) {
  await apiDelete(`/api/jupyter-servers/${key}`);
  showToast("Jupyter Server 已删除", "success");
  await loadJupyterServersAdmin();
}

async function loadLlmProviders(includeDisabled = true) {
  const query = includeDisabled ? "?include_disabled=1" : "";
  const data = await apiGet(`/api/llm-providers${query}`);
  state.llmProviders = data.items || [];
  return data;
}

async function loadLlmRoutes(includeDisabled = true) {
  const query = includeDisabled ? "?include_disabled=1" : "";
  const data = await apiGet(`/api/llm-usage-routes${query}`);
  state.llmRoutes = data.items || [];
  return data;
}

async function loadProviderModels(providerKey) {
  const data = await apiGet(`/api/llm-providers/${providerKey}/models?include_disabled=1`);
  state.llmProviderModels[providerKey] = data.items || [];
  return data.items || [];
}

async function ensureProviderModels(providerKeys) {
  const keys = [...new Set(providerKeys.filter(Boolean))];
  await Promise.all(keys.map((key) => loadProviderModels(key)));
}

function parseModelsTextarea(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderLlmRoutesTable(items) {
  if (!items.length) {
    els.llmRoutesBody.innerHTML = `<tr><td colspan="7" class="muted">暂无用途路由。请先创建 Provider 与模型，再添加路由。</td></tr>`;
    return;
  }
  els.llmRoutesBody.innerHTML = items
    .map(
      (route) => `
      <tr data-route-id="${route.id}">
        <td>${route.usage_label || route.usage_key}</td>
        <td>${route.priority ?? 0}</td>
        <td><code>${route.provider_key}</code>${route.provider_name ? ` (${route.provider_name})` : ""}</td>
        <td><code>${route.model_name}</code></td>
        <td>${route.temperature == null ? "-" : route.temperature}</td>
        <td>${route.enabled ? '<span class="badge active">enabled</span>' : '<span class="badge">disabled</span>'}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton("编辑", "edit-llm-route", { "data-id": route.id })}
            ${tableActionButton(route.enabled ? "禁用" : "启用", "toggle-llm-route", { "data-id": route.id })}
            ${tableActionButton("删除", "delete-llm-route", { "data-id": route.id }, { danger: true })}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");
}

function renderLlmTable(items) {
  if (!items.length) {
    els.llmBody.innerHTML = `<tr><td colspan="8" class="muted">暂无 LLM Provider。点击「新建 Provider」添加。</td></tr>`;
    return;
  }
  els.llmBody.innerHTML = items
    .map((provider) => {
      const modelCount = state.llmProviderModels[provider.key]?.length ?? "-";
      return `
      <tr data-llm-key="${provider.key}">
        <td><code>${provider.key}</code></td>
        <td>${provider.name}</td>
        <td title="${provider.base_url}"><code>${truncateUrl(provider.base_url)}</code></td>
        <td>${modelCount}</td>
        <td>${provider.sort_order ?? 0}</td>
        <td>${provider.enabled ? '<span class="badge active">enabled</span>' : '<span class="badge">disabled</span>'}</td>
        <td>${provider.last_used_at ? formatTime(provider.last_used_at) : "-"}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton("管理模型", "manage-llm-models", { "data-key": provider.key })}
            ${tableActionButton("编辑", "edit-llm", { "data-key": provider.key })}
            ${tableActionButton(provider.enabled ? "禁用" : "启用", "toggle-llm", { "data-key": provider.key })}
            ${tableActionButton("删除", "delete-llm", { "data-key": provider.key }, { danger: true })}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

async function loadLlmAdmin() {
  const [providers, routes] = await Promise.all([loadLlmProviders(true), loadLlmRoutes(true)]);
  await ensureProviderModels(providers.items?.map((item) => item.key) ?? []);
  renderLlmTable(providers.items || []);
  renderLlmRoutesTable(routes.items || []);
}

function showLlmFormError(message) {
  if (!message) {
    els.llmFormError.classList.add("hidden");
    els.llmFormError.textContent = "";
    return;
  }
  els.llmFormError.textContent = message;
  els.llmFormError.classList.remove("hidden");
}

function showLlmRouteFormError(message) {
  if (!message) {
    els.llmRouteFormError.classList.add("hidden");
    els.llmRouteFormError.textContent = "";
    return;
  }
  els.llmRouteFormError.textContent = message;
  els.llmRouteFormError.classList.remove("hidden");
}

function showLlmModelsFormError(message) {
  if (!message) {
    els.llmModelsFormError.classList.add("hidden");
    els.llmModelsFormError.textContent = "";
    return;
  }
  els.llmModelsFormError.textContent = message;
  els.llmModelsFormError.classList.remove("hidden");
}

function openLlmDialog(mode, provider = null) {
  state.llmFormMode = mode;
  state.editingLlmKey = provider?.key ?? null;
  showLlmFormError("");
  els.llmFormTitle.textContent = mode === "create" ? "新建 LLM Provider" : "编辑 LLM Provider";
  els.llmKeyInput.disabled = mode === "edit";
  els.llmKeyInput.value = provider?.key ?? "";
  els.llmNameInput.value = provider?.name ?? "";
  els.llmBaseUrlInput.value = provider?.base_url ?? "";
  els.llmApiKeyInput.value = provider?.api_key ?? "";
  els.llmApiKeyInput.required = mode === "create";
  els.llmModelsInput.value = "";
  els.llmModelsInput.required = mode === "create";
  els.llmModelsInput.disabled = mode === "edit";
  els.llmAuthHeaderInput.value = provider?.auth_header ?? "Authorization";
  els.llmAuthSchemeInput.value = provider?.auth_scheme ?? "Bearer";
  els.llmSortOrderInput.value = String(provider?.sort_order ?? 0);
  els.llmEnabledInput.checked = provider?.enabled !== false;
  els.llmDialog.showModal();
}

function populateRouteProviderSelect(selectedKey) {
  const enabled = state.llmProviders.filter((item) => item.enabled);
  const options = (enabled.length ? enabled : state.llmProviders)
    .map(
      (provider) =>
        `<sl-option value="${escapeHtml(provider.key)}"${provider.key === selectedKey ? " selected" : ""}>${escapeHtml(provider.name)} (${escapeHtml(provider.key)})</sl-option>`,
    )
    .join("");
  els.llmRouteProviderSelect.innerHTML = options || '<sl-option value="">请先创建 Provider</sl-option>';
}

function populateRouteModelSelect(providerKey, selectedModel) {
  const models = state.llmProviderModels[providerKey] || [];
  const enabled = models.filter((item) => item.enabled);
  const options = (enabled.length ? enabled : models)
    .map(
      (model) =>
        `<sl-option value="${escapeHtml(model.model_name)}"${model.model_name === selectedModel ? " selected" : ""}>${escapeHtml(model.model_name)}</sl-option>`,
    )
    .join("");
  els.llmRouteModelSelect.innerHTML = options || '<sl-option value="">请先添加模型</sl-option>';
}

async function openLlmRouteDialog(mode, route = null) {
  state.llmRouteFormMode = mode;
  showLlmRouteFormError("");
  if (!state.llmProviders.length) {
    await loadLlmProviders(true);
  }
  els.llmRouteFormTitle.textContent = mode === "create" ? "新建用途路由" : "编辑用途路由";
  els.llmRouteIdInput.value = route?.id ? String(route.id) : "";
  els.llmRouteUsageSelect.value = route?.usage_key ?? "validation_translation";
  els.llmRouteUsageSelect.disabled = mode === "edit";
  populateRouteProviderSelect(route?.provider_key ?? state.llmProviders[0]?.key ?? "");
  const providerKey = route?.provider_key ?? els.llmRouteProviderSelect.value;
  if (providerKey && !state.llmProviderModels[providerKey]) {
    await loadProviderModels(providerKey);
  }
  populateRouteModelSelect(providerKey, route?.model_name ?? "");
  els.llmRoutePriorityInput.value = String(route?.priority ?? 0);
  els.llmRouteTemperatureInput.value = route?.temperature == null ? "" : String(route.temperature);
  els.llmRouteEnabledInput.checked = route?.enabled !== false;
  els.llmRouteDialog.showModal();
}

async function openLlmModelsDialog(providerKey) {
  showLlmModelsFormError("");
  els.llmModelsProviderKeyInput.value = providerKey;
  const provider = state.llmProviders.find((item) => item.key === providerKey);
  els.llmModelsFormTitle.textContent = `管理模型 · ${provider?.name || providerKey}`;
  els.llmNewModelNameInput.value = "";
  await loadProviderModels(providerKey);
  renderLlmModelsTable(providerKey);
  els.llmModelsDialog.showModal();
}

function renderLlmModelsTable(providerKey) {
  const models = state.llmProviderModels[providerKey] || [];
  if (!models.length) {
    els.llmModelsBody.innerHTML = `<tr><td colspan="4" class="muted">暂无模型。</td></tr>`;
    return;
  }
  els.llmModelsBody.innerHTML = models
    .map(
      (model) => `
      <tr>
        <td><code>${model.model_name}</code></td>
        <td>${model.sort_order ?? 0}</td>
        <td>${model.enabled ? '<span class="badge active">enabled</span>' : '<span class="badge">disabled</span>'}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton(model.enabled ? "禁用" : "启用", "toggle-llm-model", {
              "data-provider": providerKey,
              "data-model": model.model_name,
            })}
            ${tableActionButton("删除", "delete-llm-model", {
              "data-provider": providerKey,
              "data-model": model.model_name,
            }, { danger: true })}
          </div>
        </td>
      </tr>
    `,
    )
    .join("");
}

async function saveLlmFromForm(event) {
  event.preventDefault();
  showLlmFormError("");
  const payload = {
    name: els.llmNameInput.value.trim(),
    base_url: els.llmBaseUrlInput.value.trim().replace(/\/$/, ""),
    auth_header: els.llmAuthHeaderInput.value.trim() || "Authorization",
    auth_scheme: els.llmAuthSchemeInput.value.trim() || "Bearer",
    sort_order: Number(els.llmSortOrderInput.value) || 0,
    enabled: els.llmEnabledInput.checked,
  };
  const apiKey = els.llmApiKeyInput.value.trim();
  if (apiKey) {
    payload.api_key = apiKey;
  } else if (state.llmFormMode === "create") {
    showLlmFormError("API Key 不能为空");
    return;
  }
  if (state.llmFormMode === "create") {
    const models = parseModelsTextarea(els.llmModelsInput.value);
    if (!models.length) {
      showLlmFormError("请至少填写一个模型");
      return;
    }
    payload.models = models;
  }
  try {
    if (state.llmFormMode === "create") {
      payload.key = els.llmKeyInput.value.trim();
      await apiPost("/api/llm-providers", payload);
      showToast("LLM Provider 已创建", "success");
    } else {
      await apiPatch(`/api/llm-providers/${state.editingLlmKey}`, payload);
      showToast("LLM Provider 已更新", "success");
    }
    els.llmDialog.close();
    await loadLlmAdmin();
  } catch (error) {
    showLlmFormError(error instanceof Error ? error.message : String(error));
  }
}

async function saveLlmRouteFromForm(event) {
  event.preventDefault();
  showLlmRouteFormError("");
  const providerKey = els.llmRouteProviderSelect.value.trim();
  const modelName = els.llmRouteModelSelect.value.trim();
  if (!providerKey || !modelName) {
    showLlmRouteFormError("请选择 Provider 与模型");
    return;
  }
  const temperatureRaw = els.llmRouteTemperatureInput.value.trim();
  const payload = {
    usage_key: els.llmRouteUsageSelect.value,
    provider_key: providerKey,
    model_name: modelName,
    priority: Number(els.llmRoutePriorityInput.value) || 0,
    enabled: els.llmRouteEnabledInput.checked,
  };
  if (temperatureRaw) {
    payload.temperature = Number(temperatureRaw);
  } else {
    payload.temperature = null;
  }
  try {
    if (state.llmRouteFormMode === "create") {
      await apiPost("/api/llm-usage-routes", payload);
      showToast("用途路由已创建", "success");
    } else {
      const routeId = els.llmRouteIdInput.value;
      await apiPatch(`/api/llm-usage-routes/${routeId}`, payload);
      showToast("用途路由已更新", "success");
    }
    els.llmRouteDialog.close();
    await loadLlmAdmin();
  } catch (error) {
    showLlmRouteFormError(error instanceof Error ? error.message : String(error));
  }
}

async function toggleLlmEnabled(key, enabled) {
  await apiPatch(`/api/llm-providers/${key}`, { enabled });
  showToast(enabled ? "已启用" : "已禁用", "success");
  await loadLlmAdmin();
}

async function deleteLlmProvider(key) {
  await apiDelete(`/api/llm-providers/${key}`);
  showToast("LLM Provider 已删除", "success");
  await loadLlmAdmin();
}

async function toggleLlmRouteEnabled(routeId, enabled) {
  await apiPatch(`/api/llm-usage-routes/${routeId}`, { enabled });
  showToast(enabled ? "路由已启用" : "路由已禁用", "success");
  await loadLlmAdmin();
}

async function deleteLlmRoute(routeId) {
  await apiDelete(`/api/llm-usage-routes/${routeId}`);
  showToast("用途路由已删除", "success");
  await loadLlmAdmin();
}

async function addLlmModel() {
  const providerKey = els.llmModelsProviderKeyInput.value.trim();
  const modelName = els.llmNewModelNameInput.value.trim();
  if (!modelName) {
    showLlmModelsFormError("模型名称不能为空");
    return;
  }
  showLlmModelsFormError("");
  try {
    await apiPost(`/api/llm-providers/${providerKey}/models`, { model_name: modelName });
    els.llmNewModelNameInput.value = "";
    await loadProviderModels(providerKey);
    renderLlmModelsTable(providerKey);
    await loadLlmAdmin();
    showToast("模型已添加", "success");
  } catch (error) {
    showLlmModelsFormError(error instanceof Error ? error.message : String(error));
  }
}

async function toggleLlmModel(providerKey, modelName, enabled) {
  await apiPatch(`/api/llm-providers/${providerKey}/models/${encodeURIComponent(modelName)}`, {
    enabled,
  });
  await loadProviderModels(providerKey);
  renderLlmModelsTable(providerKey);
  await loadLlmAdmin();
}

async function deleteLlmModel(providerKey, modelName) {
  await apiDelete(`/api/llm-providers/${providerKey}/models/${encodeURIComponent(modelName)}`);
  await loadProviderModels(providerKey);
  renderLlmModelsTable(providerKey);
  await loadLlmAdmin();
  showToast("模型已删除", "success");
}

async function loadValidationResults() {
  syncValidationControlsFromState();
  const params = buildValidationQueryParams();
  const data = await apiGet(`/api/validations?${params}`);
  els.validationsHint.textContent = validationQueryHint(data);
  updateValidationSortHeaders();
  cacheValidationRows(data.items);

  els.validationsBody.innerHTML = data.items
    .map((row) => {
      const metrics = row.metrics || {};
      const err = row.error_reason ? `<div class="muted validation-error" title="${escapeHtml(row.error_reason)}">${escapeHtml(row.error_reason.slice(0, 80))}${row.error_reason.length > 80 ? "…" : ""}</div>` : "";
      return `
        <tr data-id="${row.idea_id}" data-kind="idea" data-validation-id="${row.id}">
          <td>${row.id}</td>
          <td>
            <sl-button size="small" variant="text" class="idea-link" data-id="${row.idea_id}" data-kind="idea">${escapeHtml(row.idea_title || `#${row.idea_id}`)}</sl-button>
            ${err}
          </td>
          <td>${row.profile_name || row.profile_key}</td>
          <td>${formatMetric(metrics.mean_ic)}</td>
          <td>${formatMetric(metrics.mean_rank_ic)}</td>
          <td>${formatMetric(metrics.ic_ir)}</td>
          <td>${formatMetric(metrics.rank_ic_ir)}</td>
          <td>${metrics.n_periods ?? "-"}</td>
          <td>${formatPercent(metrics.ic_positive_ratio)}</td>
          <td>${formatTime(row.evaluated_at)}</td>
          <td>${validationStatusBadge(row.status)}</td>
        </tr>
      `;
    })
    .join("");

  if (!data.items.length) {
    els.validationsBody.innerHTML = `<tr><td colspan="11" class="muted">暂无符合条件的验证结果。</td></tr>`;
  }

  renderPager(els.validationsPager, data, (nextOffset) => {
    state.validations.offset = nextOffset;
    loadValidationResults().catch(handleError);
  });
}

function buildFactorValidationQueryParams() {
  const params = new URLSearchParams();
  params.set("limit", String(state.factorValidations.limit));
  params.set("offset", String(state.factorValidations.offset));
  if (state.factorValidations.status) {
    params.set("status", state.factorValidations.status);
  }
  if (state.factorValidations.profile_keys.length) {
    params.set("profile_keys", state.factorValidations.profile_keys.join(","));
  }
  return params.toString();
}

function syncFactorValidationControlsFromState() {
  if (els.factorValidationsLimit) {
    els.factorValidationsLimit.value = String(state.factorValidations.limit);
  }
  if (els.factorValidationsStatus) {
    els.factorValidationsStatus.value = state.factorValidations.status;
  }
  if (els.factorValidationsProfile) {
    els.factorValidationsProfile.value = state.factorValidations.profile_keys;
  }
}

function readFactorValidationControlsToState() {
  state.factorValidations.limit = Math.min(
    200,
    Math.max(1, Number(els.factorValidationsLimit?.value ?? 30) || 30),
  );
  state.factorValidations.status = String(els.factorValidationsStatus?.value ?? "").trim();
  state.factorValidations.profile_keys = Array.isArray(els.factorValidationsProfile?.value)
    ? els.factorValidationsProfile.value.map(String).filter(Boolean)
    : [];
}

function parseMlflowRunMetrics(payload) {
  const metricsList = payload?.run?.data?.metrics;
  if (!Array.isArray(metricsList)) {
    return {};
  }
  const metrics = {};
  for (const item of metricsList) {
    const key = String(item?.key ?? "").trim();
    if (!key) {
      continue;
    }
    const value = Number(item?.value);
    if (Number.isFinite(value)) {
      metrics[key] = value;
    }
  }
  return metrics;
}

function factorValidationMetricsFromRow(row) {
  if (row?.metrics && typeof row.metrics === "object") {
    return row.metrics;
  }
  const cached = row?.diagnostics?.metrics;
  if (cached && typeof cached === "object") {
    return cached;
  }
  return {};
}

async function fetchMlflowMetricsMap(items) {
  const runIds = [
    ...new Set(
      items
        .filter((row) => {
          if (!row?.mlflow_run_id) {
            return false;
          }
          const cached = factorValidationMetricsFromRow(row);
          return !Number.isFinite(Number(cached.mean_ic)) && !Number.isFinite(Number(cached.mean_rank_ic));
        })
        .map((row) => String(row.mlflow_run_id).trim())
        .filter(Boolean),
    ),
  ];
  if (!runIds.length) {
    return new Map();
  }
  const entries = await Promise.all(
    runIds.map(async (runId) => {
      try {
        const data = await apiGet(`/api/mlflow/runs/${encodeURIComponent(runId)}`);
        return [runId, parseMlflowRunMetrics(data)];
      } catch {
        return [runId, null];
      }
    }),
  );
  return new Map(entries);
}

function factorValidationMlflowCell(row) {
  if (row.mlflow_run_url) {
    return `<a href="${escapeHtml(row.mlflow_run_url)}" target="_blank" rel="noopener noreferrer">打开</a>`;
  }
  if (row.mlflow_run_id) {
    return `<code title="${escapeHtml(row.mlflow_run_id)}">${escapeHtml(row.mlflow_run_id.slice(0, 8))}…</code>`;
  }
  return `<span class="muted">-</span>`;
}

async function loadFactorValidations() {
  syncFactorValidationControlsFromState();
  const params = buildFactorValidationQueryParams();
  const data = await apiGet(`/api/factor-validations?${params}`);
  const metricsMap = await fetchMlflowMetricsMap(data.items || []);

  for (const row of data.items || []) {
    state.factorValidationById[row.id] = row;
  }

  if (els.factorValidationsHint) {
    const successCount = (data.items || []).filter((row) => row.status === "success").length;
    const mlflowFallbackCount = (data.items || []).filter((row) => {
      if (!row.mlflow_run_id) {
        return false;
      }
      const cached = factorValidationMetricsFromRow(row);
      return !Number.isFinite(Number(cached.mean_ic)) && !Number.isFinite(Number(cached.mean_rank_ic));
    }).length;
    const metricsNote =
      mlflowFallbackCount > 0
        ? ` · ${mlflowFallbackCount} 条旧记录回退 MLflow`
        : "";
    els.factorValidationsHint.textContent = `共 ${data.total ?? 0} 条 · 本页 ${(data.items || []).length} 条 · 成功 ${successCount} 条（指标优先读 D1）${metricsNote}`;
  }

  els.factorValidationsBody.innerHTML = (data.items || [])
    .map((row) => {
      const cachedMetrics = factorValidationMetricsFromRow(row);
      const metrics =
        Number.isFinite(Number(cachedMetrics.mean_ic)) ||
        Number.isFinite(Number(cachedMetrics.mean_rank_ic))
          ? cachedMetrics
          : row.mlflow_run_id
            ? metricsMap.get(row.mlflow_run_id) || {}
            : {};
      const err = row.error_reason
        ? `<div class="muted validation-error" title="${escapeHtml(row.error_reason)}">${escapeHtml(row.error_reason.slice(0, 80))}${row.error_reason.length > 80 ? "…" : ""}</div>`
        : "";
      return `
        <tr data-factor-validation-id="${row.id}" data-task-id="${row.task_id}">
          <td>${row.id}</td>
          <td><code title="task #${row.task_id}">#${row.task_id}</code></td>
          <td>
            <sl-button size="small" variant="text" class="idea-link" data-id="${row.idea_id}" data-kind="idea">${escapeHtml(row.idea_title || `#${row.idea_id}`)}</sl-button>
            ${err}
          </td>
          <td>${escapeHtml(row.profile_name || row.profile_key)}</td>
          <td>${formatMetric(metrics.mean_ic)}</td>
          <td>${formatMetric(metrics.mean_rank_ic)}</td>
          <td>${formatMetric(metrics.ic_ir)}</td>
          <td>${metrics.n_periods ?? "-"}</td>
          <td>${formatTime(row.evaluated_at || row.updated_at)}</td>
          <td>${validationStatusBadge(row.status)}</td>
          <td>${factorValidationMlflowCell(row)}</td>
        </tr>
      `;
    })
    .join("");

  if (!(data.items || []).length) {
    els.factorValidationsBody.innerHTML = `<tr><td colspan="11" class="muted">暂无因子验证记录。</td></tr>`;
  }

  renderPager(els.factorValidationsPager, data, (nextOffset) => {
    state.factorValidations.offset = nextOffset;
    loadFactorValidations().catch(handleError);
  });
}

async function showFactorValidationDetail(factorValidationId) {
  if (state.icSeriesChartDispose) {
    state.icSeriesChartDispose();
    state.icSeriesChartDispose = null;
  }

  const cached = state.factorValidationById[factorValidationId];
  let item = cached;
  if (!item) {
    const data = await apiGet(`/api/factor-validations/${factorValidationId}`);
    item = data.item;
    state.factorValidationById[factorValidationId] = item;
  }
  if (!item) {
    showToast("未找到因子验证记录");
    return;
  }

  let metrics = factorValidationMetricsFromRow(item);
  let mlflowNote = "";
  const needsMlflowMetrics =
    item.mlflow_run_id &&
    !Number.isFinite(Number(metrics.mean_ic)) &&
    !Number.isFinite(Number(metrics.mean_rank_ic));
  if (needsMlflowMetrics) {
    try {
      const mlflow = await apiGet(`/api/mlflow/runs/${encodeURIComponent(item.mlflow_run_id)}`);
      metrics = parseMlflowRunMetrics(mlflow);
    } catch (error) {
      mlflowNote = `<p class="auth-error">MLflow 读取失败：${escapeHtml(String(error.message || error))}</p>`;
    }
  }

  const showChart = item.status === "success" && Boolean(item.mlflow_run_id);
  els.detailDialog.classList.toggle("detail-dialog--wide", showChart);

  els.detailContent.innerHTML = `
    <h2>因子验证 #${item.id}</h2>
    <dl>
      <dt>ML 任务</dt><dd>#${item.task_id}</dd>
      <dt>因子想法</dt><dd>#${item.idea_id} ${escapeHtml(item.idea_title || "")}</dd>
      <dt>验证配置</dt><dd>${escapeHtml(item.profile_name || item.profile_key)}</dd>
      <dt>状态</dt><dd>${validationStatusBadge(item.status)}</dd>
      <dt>评估时间</dt><dd>${formatTime(item.evaluated_at)}</dd>
      <dt>MLflow</dt><dd>${item.mlflow_run_url ? `<a href="${escapeHtml(item.mlflow_run_url)}" target="_blank" rel="noopener noreferrer">打开 Run</a>` : item.mlflow_run_id || "-"}</dd>
    </dl>
    ${item.error_reason ? `<p class="auth-error">${escapeHtml(item.error_reason)}</p>` : ""}
    ${mlflowNote}
    <h3>指标（MLflow）</h3>
    <dl>
      <dt>Mean IC</dt><dd>${formatMetric(metrics.mean_ic)}</dd>
      <dt>Mean Rank IC</dt><dd>${formatMetric(metrics.mean_rank_ic)}</dd>
      <dt>IC IR</dt><dd>${formatMetric(metrics.ic_ir)}</dd>
      <dt>Rank IC IR</dt><dd>${formatMetric(metrics.rank_ic_ir)}</dd>
      <dt>期数</dt><dd>${metrics.n_periods ?? "-"}</dd>
      <dt>IC 胜率</dt><dd>${formatPercent(metrics.ic_positive_ratio)}</dd>
    </dl>
    ${
      showChart
        ? `<h3>IC 序列（按日）</h3><div id="fv-ic-series-chart" class="ic-series-chart-host"><p class="muted">加载 IC 序列…</p></div>`
        : ""
    }
    ${
      item.factor_sql
        ? `<h3>factor_sql</h3><pre><code>${escapeHtml(JSON.stringify(item.factor_sql, null, 2))}</code></pre>`
        : ""
    }
  `;
  els.detailDialog.showModal();

  if (!showChart) {
    return;
  }

  const chartHost = document.getElementById("fv-ic-series-chart");
  if (!chartHost) {
    return;
  }
  try {
    const series = await apiGet(`/api/mlflow/runs/${encodeURIComponent(item.mlflow_run_id)}/ic-series`);
    state.icSeriesChartDispose = mountIcSeriesChart(chartHost, series);
  } catch (error) {
    chartHost.innerHTML = `<p class="auth-error">IC 序列加载失败：${escapeHtml(String(error.message || error))}</p>`;
  }
}

function applyValidationPreset({ sort, abs = true, limit = 30, order = "desc", status = "success" }) {
  state.validations.sort = sort;
  state.validations.abs = abs;
  state.validations.limit = limit;
  state.validations.order = order;
  state.validations.status = status;
  state.validations.offset = 0;
  syncValidationControlsFromState();
  loadValidationResults().catch(handleError);
}

function renderValidationsTable(validations) {
  cacheValidationRows(validations.items);
  if (!validations.items.length) {
    return `<p class="muted">尚未创建验证任务。</p>`;
  }
  return `
    <table class="validation-table">
      <thead>
        <tr>
          <th>验证配置</th>
          <th>状态</th>
          <th>Mean IC</th>
          <th>IC IR</th>
          <th>期数</th>
          <th>评估时间</th>
        </tr>
      </thead>
      <tbody>
        ${validations.items
          .map((row) => {
            const metrics = row.metrics || {};
            return `
              <tr>
                <td>${row.profile_name || row.profile_key}</td>
                <td>${validationStatusBadge(row.status)}</td>
                <td>${formatMetric(metrics.mean_ic)}</td>
                <td>${formatMetric(metrics.ic_ir)}</td>
                <td>${metrics.n_periods ?? "-"}</td>
                <td>${formatTime(row.evaluated_at)}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

async function renderIdeaDetail(idea) {
  const validations = await apiGet(`/api/ideas/${idea.id}/validations`);
  cacheValidationRows(validations.items);
  els.detailContent.innerHTML = `
    <h2>${idea.title}</h2>
    <dl>
      <dt>ID</dt><dd>${idea.id}</dd>
      <dt>来源</dt><dd>${idea.source}</dd>
      <dt>去重层级</dt><dd>${idea.dedup_tier}</dd>
      <dt>更新时间</dt><dd>${formatTime(idea.updated_at)}</dd>
    </dl>
    <h3>factor_expr</h3>
    <pre><code>${idea.factor_expr}</code></pre>
    ${idea.expr_canonical ? `<h3>canonical</h3><pre><code>${idea.expr_canonical}</code></pre>` : ""}
    <h3>假设</h3>
    <p>${idea.hypothesis}</p>
    <h3>公式草图</h3>
    <p>${idea.formula_sketch}</p>
    <h3>预期信号</h3>
    <p>${idea.expected_signal}</p>
    <h3>风险</h3>
    <ul>${idea.risks.map((item) => `<li>${item}</li>`).join("")}</ul>
    <h3>数据源</h3>
    <ul>${idea.data_sources.map((item) => `<li>${item}</li>`).join("")}</ul>
    <div class="detail-section">
      <div class="detail-section-header">
        <h3>因子验证</h3>
        <sl-button id="enqueue-validations" variant="primary" size="small">创建全部验证任务</sl-button>
      </div>
      <div id="validations-panel">${renderValidationsTable(validations)}</div>
    </div>
  `;
  const enqueueButton = document.getElementById("enqueue-validations");
  enqueueButton?.addEventListener("click", async () => {
    enqueueButton.disabled = true;
    enqueueButton.loading = true;
    const originalText = enqueueButton.textContent;
    enqueueButton.textContent = "创建中…";
    try {
      const result = await apiPost(`/api/ideas/${idea.id}/validations`, {});
      showToast(`新增 ${result.created} 条，跳过 ${result.skipped} 条`, "success");
      document.getElementById("validations-panel").innerHTML = renderValidationsTable({
        items: result.items,
      });
      cacheValidationRows(result.items);
    } catch (error) {
      handleError(error);
    } finally {
      enqueueButton.disabled = false;
      enqueueButton.loading = false;
      enqueueButton.textContent = originalText;
    }
  });
  els.detailDialog.showModal();
}

function renderOperatorDetail(operator) {
  els.detailContent.innerHTML = `
    <h2>${operator.name}</h2>
    <dl>
      <dt>ID</dt><dd>${operator.id}</dd>
      <dt>状态</dt><dd>${badge(operator.status)}</dd>
      <dt>签名</dt><dd><code>${operator.signature}</code></dd>
      <dt>来源想法</dt><dd>${operator.source_idea_id ?? "-"}</dd>
      <dt>创建时间</dt><dd>${formatTime(operator.created_at)}</dd>
    </dl>
    <h3>描述</h3>
    <p>${operator.description}</p>
    ${operator.example ? `<h3>示例</h3><pre><code>${operator.example}</code></pre>` : ""}
  `;
  els.detailDialog.showModal();
}

async function loadStats() {
  const stats = await apiGet("/api/stats");
  els.statsIdeas.textContent = String(stats.ideas_total);
  els.statsOperators.textContent = String(stats.operators_total);
  els.statsActiveOps.textContent = String(stats.operators_active);
}

async function loadIdeas() {
  const { offset, source } = state.ideas;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (source) params.set("source", source);
  els.ideasSource.value = source || "";

  const data = await apiGet(`/api/ideas?${params}`);
  els.ideasBody.innerHTML = data.items
    .map(
      (idea) => `
      <tr data-id="${idea.id}" data-kind="idea">
        <td>${idea.id}</td>
        <td>${idea.title}</td>
        <td>${formatIdeaSourceLabel(idea.source)}</td>
        <td>${formatTime(idea.updated_at)}</td>
      </tr>
    `,
    )
    .join("");

  renderPager(els.ideasPager, data, (nextOffset) => {
    state.ideas.offset = nextOffset;
    loadIdeas().catch(handleError);
  });
}

async function loadOperators() {
  const { offset, status } = state.operators;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status) params.set("status", status);

  const data = await apiGet(`/api/operators?${params}`);
  els.operatorsBody.innerHTML = data.items
    .map(
      (operator) => `
      <tr data-id="${operator.id}" data-kind="operator">
        <td>${operator.id}</td>
        <td>${operator.name}</td>
        <td><code>${operator.signature}</code></td>
        <td>${badge(operator.status)}</td>
        <td>${formatTime(operator.created_at)}</td>
      </tr>
    `,
    )
    .join("");

  renderPager(els.operatorsPager, data, (nextOffset) => {
    state.operators.offset = nextOffset;
    loadOperators().catch(handleError);
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.getElementById("panel-ideas").classList.toggle("hidden", tab !== "ideas");
  document.getElementById("panel-validations").classList.toggle("hidden", tab !== "validations");
  document.getElementById("panel-factor-validations").classList.toggle("hidden", tab !== "factor-validations");
  document.getElementById("panel-profiles").classList.toggle("hidden", tab !== "profiles");
  document.getElementById("panel-jupyter").classList.toggle("hidden", tab !== "jupyter");
  document.getElementById("panel-llm").classList.toggle("hidden", tab !== "llm");
  document.getElementById("panel-operators").classList.toggle("hidden", tab !== "operators");
  document.getElementById("panel-settings").classList.toggle("hidden", tab !== "settings");
  els.appLayout.classList.toggle(
    "layout-wide",
    tab === "validations" ||
      tab === "factor-validations" ||
      tab === "profiles" || tab === "jupyter" || tab === "llm" || tab === "settings",
  );
  if (tab === "validations") {
    loadIdeaSourceOptions()
      .then(() => loadEnabledProfileOptions())
      .then(() => loadValidationResults())
      .catch(handleError);
  } else if (tab === "factor-validations") {
    loadEnabledProfileOptionsForFactorValidations()
      .then(() => loadFactorValidations())
      .catch(handleError);
  } else if (tab === "profiles") {
    loadValidationProfilesAdmin().catch(handleError);
  } else if (tab === "jupyter") {
    loadJupyterAdmin().catch(handleError);
  } else if (tab === "llm") {
    loadLlmAdmin().catch(handleError);
  } else if (tab === "settings") {
    loadSystemSettings().catch(handleError);
  }
  if (tab !== "jupyter") {
    stopMlTaskKernelPolling();
  }
}

function handleError(error) {
  showToast(error instanceof Error ? error.message : String(error));
}

function parseGenerateCount() {
  const value = Number(els.generateCount.value);
  if (!Number.isFinite(value) || value <= 0) {
    return 3;
  }
  return Math.min(5, Math.floor(value));
}

async function triggerGenerate() {
  const count = parseGenerateCount();
  const button = els.ideasGenerate;
  const originalText = button.textContent;

  button.disabled = true;
  button.loading = true;
  button.textContent = "生成中…";

  try {
    const result = await apiPost(`/generate?max_ideas=${count}`);
    const parts = [`新增 ${result.created} 条`];
    if (result.skipped > 0) {
      parts.push(`跳过 ${result.skipped} 条`);
    }
    if (result.errors?.length) {
      parts.push(`${result.errors.length} 条失败`);
    }
    showToast(parts.join("，"), "success");

    state.ideas.offset = 0;
    await Promise.all([loadStats(), loadIdeas()]);
  } finally {
    button.disabled = false;
    button.loading = false;
    button.textContent = originalText;
  }
}

async function previewIdeaPrompt() {
  const count = parseGenerateCount();
  const button = els.ideasPromptPreview;
  const originalText = button.textContent;
  button.disabled = true;
  button.loading = true;
  button.textContent = "加载中…";
  try {
    const data = await apiGet(`/api/ideas/generation-prompt?max_ideas=${count}`);
    els.detailContent.innerHTML = `
      <h2>当前生成提示词</h2>
      <p class="muted">max_ideas=${data.max_ideas}，长度=${data.bytes} bytes，活跃算子=${data.active_operators}，饱和模式=${data.saturated_patterns}</p>
      <pre><code>${escapeHtml(data.prompt || "")}</code></pre>
    `;
    els.detailDialog.showModal();
  } finally {
    button.disabled = false;
    button.loading = false;
    button.textContent = originalText;
  }
}

function showIdeaImportError(message) {
  if (!message) {
    els.ideaImportError.textContent = "";
    els.ideaImportError.classList.add("hidden");
    return;
  }
  els.ideaImportError.textContent = message;
  els.ideaImportError.classList.remove("hidden");
}

function openIdeaImportDialog() {
  if (!els.ideaImportJson.value.trim()) {
    els.ideaImportJson.value = IDEA_IMPORT_EXAMPLE;
  }
  showIdeaImportError("");
  els.ideaImportDialog.showModal();
}

function parseIdeaImportPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("JSON 不能为空");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("ideas 数组不能为空");
    }
    return { ideas: parsed };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.ideas)) {
    if (parsed.ideas.length === 0) {
      throw new Error("ideas 数组不能为空");
    }
    return parsed;
  }
  if (parsed && typeof parsed === "object" && parsed.title && parsed.factor_expr) {
    return parsed;
  }
  throw new Error('格式须为 {"ideas":[...]} 或单个 idea 对象');
}

async function submitIdeaImport(event) {
  event.preventDefault();
  showIdeaImportError("");

  let payload;
  try {
    payload = parseIdeaImportPayload(els.ideaImportJson.value);
  } catch (error) {
    showIdeaImportError(error instanceof Error ? error.message : String(error));
    return;
  }

  const submitButton = els.ideaImportForm.querySelector('sl-button[type="submit"]');
  const originalText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.loading = true;
  submitButton.textContent = "提交中…";

  try {
    const result = await apiPost("/api/ideas", payload);
    const parts = [`新增 ${result.created} 条`];
    if (result.skipped > 0) {
      parts.push(`跳过重复 ${result.skipped} 条`);
    }
    if (result.created_ids?.length) {
      parts.push(`ID: ${result.created_ids.join(", ")}`);
    }
    if (result.errors?.length) {
      parts.push(`失败 ${result.errors.length} 条`);
      showIdeaImportError(result.errors.join("\n"));
    }
    showToast(parts.join("，"), result.created > 0 ? "success" : "error");
    if (result.created > 0) {
      els.ideaImportDialog.close();
      state.ideas.offset = 0;
      await Promise.all([loadStats(), loadIdeas()]);
    }
  } catch (error) {
    showIdeaImportError(error instanceof Error ? error.message : String(error));
  } finally {
    submitButton.disabled = false;
    submitButton.loading = false;
    submitButton.textContent = originalText;
  }
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

document.getElementById("ideas-refresh").addEventListener("click", () => {
  state.ideas.offset = 0;
  Promise.all([loadStats(), loadIdeas()]).catch(handleError);
});

document.getElementById("ideas-apply").addEventListener("click", () => {
  state.ideas.source = els.ideasSource.value;
  state.ideas.offset = 0;
  loadIdeas().catch(handleError);
});

els.ideasGenerate.addEventListener("click", () => {
  triggerGenerate().catch(handleError);
});

els.ideasPromptPreview.addEventListener("click", () => {
  previewIdeaPrompt().catch(handleError);
});

els.ideasImportOpen.addEventListener("click", () => {
  openIdeaImportDialog();
});

els.ideaImportForm.addEventListener("submit", (event) => {
  submitIdeaImport(event).catch(handleError);
});

els.ideaImportCancel.addEventListener("click", () => {
  els.ideaImportDialog.close();
});

document.getElementById("operators-refresh").addEventListener("click", () => {
  state.operators.offset = 0;
  Promise.all([loadStats(), loadOperators()]).catch(handleError);
});

document.getElementById("validations-apply").addEventListener("click", () => {
  readValidationControlsIntoState();
  state.validations.offset = 0;
  loadValidationResults().catch(handleError);
});

document.getElementById("validations-refresh").addEventListener("click", () => {
  readValidationControlsIntoState();
  loadValidationResults().catch(handleError);
});

document.getElementById("factor-validations-apply")?.addEventListener("click", () => {
  readFactorValidationControlsToState();
  state.factorValidations.offset = 0;
  loadFactorValidations().catch(handleError);
});

document.getElementById("factor-validations-refresh")?.addEventListener("click", () => {
  readFactorValidationControlsToState();
  loadFactorValidations().catch(handleError);
});

document.getElementById("factor-validations-preset-success")?.addEventListener("click", () => {
  state.factorValidations.status = "success";
  state.factorValidations.limit = 30;
  state.factorValidations.offset = 0;
  syncFactorValidationControlsFromState();
  loadFactorValidations().catch(handleError);
});

document.getElementById("settings-refresh").addEventListener("click", () => {
  loadSystemSettings().catch(handleError);
});

els.settingsWorkflowBody?.addEventListener("sl-change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(".settings-switch")) {
    return;
  }
  const key = target.dataset.settingKey;
  const enabled = target.checked;
  try {
    await patchSystemSetting(key, enabled);
    showToast("已保存", "success");
  } catch (error) {
    target.checked = !enabled;
    handleError(error);
  }
});

els.settingsWorkflowBody?.addEventListener("sl-change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(".settings-number")) {
    return;
  }
  const key = target.dataset.settingKey;
  const value = Number(target.value);
  const previous = target.getAttribute("data-last-value");
  try {
    await patchSystemSetting(key, value);
    target.setAttribute("data-last-value", String(value));
    showToast("已保存", "success");
  } catch (error) {
    if (previous != null) {
      target.value = previous;
    }
    handleError(error);
  }
});

els.settingsWorkflowBody?.addEventListener("focusin", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.matches(".settings-number")) {
    target.setAttribute("data-last-value", target.value);
  }
});

els.settingsRunValidation?.addEventListener("click", () => {
  runValidationBatchNow().catch(handleError);
});

els.settingsRunCleanup?.addEventListener("click", () => {
  runKernelCleanupNow().catch(handleError);
});

els.settingsRunForceCleanup?.addEventListener("click", () => {
  if (!window.confirm("将立即关闭所有未清理的 Kernel（含 running 任务），并标记为 failed。确定继续？")) {
    return;
  }
  runKernelCleanupNow({ force: true }).catch(handleError);
});

document.getElementById("validations-preset-rank-ic").addEventListener("click", () => {
  applyValidationPreset({ sort: "mean_rank_ic" });
});

document.getElementById("validations-preset-mean-ic").addEventListener("click", () => {
  applyValidationPreset({ sort: "mean_ic" });
});

document.getElementById("profiles-create").addEventListener("click", () => {
  openProfileDialog("create");
});

document.getElementById("profiles-refresh").addEventListener("click", () => {
  loadValidationProfilesAdmin().catch(handleError);
});

els.profileForm.addEventListener("submit", (event) => {
  saveProfileFromForm(event).catch((error) => showProfileFormError(String(error.message || error)));
});

document.getElementById("profile-form-cancel").addEventListener("click", () => {
  els.profileDialog.close();
});

els.profilesBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const key = button.getAttribute("data-key");
  const action = button.getAttribute("data-action");
  try {
    if (action === "edit-profile") {
      const profile = state.validationProfiles.find((item) => item.key === key);
      if (profile) openProfileDialog("edit", profile);
      return;
    }
    if (action === "toggle-profile") {
      const profile = state.validationProfiles.find((item) => item.key === key);
      if (profile) await toggleProfileEnabled(key, !profile.enabled);
      return;
    }
    if (action === "delete-profile") {
      if (!window.confirm(`确定删除验证配置 ${key}？若已有验证任务将改为禁用。`)) return;
      await deleteProfile(key);
    }
  } catch (error) {
    handleError(error);
  }
});

document.getElementById("jupyter-create").addEventListener("click", () => {
  openJupyterDialog("create");
});

document.getElementById("jupyter-refresh").addEventListener("click", () => {
  loadJupyterAdmin().catch(handleError);
});

els.mlTaskKernelsRefresh?.addEventListener("click", () => {
  Promise.all([loadMlTaskKernelStatus(), loadJupyterKernelStatus()]).catch(handleError);
});

els.mlTaskKernelsAutoRefresh?.addEventListener("sl-change", () => {
  if (state.tab === "jupyter") {
    startMlTaskKernelPolling();
  }
});

els.mlTaskKernelsBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='view-ml-task-kernel']");
  if (!button) return;
  event.preventDefault();
  const taskId = button.getAttribute("data-task-id");
  if (!taskId) return;
  switchTab("factor-validations");
  showToast(`已切换到因子验证页，任务 #${taskId}`, "success");
});

els.jupyterForm.addEventListener("submit", (event) => {
  saveJupyterFromForm(event).catch((error) => showJupyterFormError(String(error.message || error)));
});

document.getElementById("jupyter-form-cancel").addEventListener("click", () => {
  els.jupyterDialog.close();
});

els.jupyterBaseUrlInput.addEventListener("change", () => {
  if (!els.jupyterWsBaseUrlInput.value.trim()) {
    els.jupyterWsBaseUrlInput.value = suggestWsBaseUrl(els.jupyterBaseUrlInput.value);
  }
});

els.jupyterBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const key = button.getAttribute("data-key");
  const action = button.getAttribute("data-action");
  try {
    if (action === "edit-jupyter") {
      const server = state.jupyterServers.find((item) => item.key === key);
      if (server) openJupyterDialog("edit", server);
      return;
    }
    if (action === "toggle-jupyter") {
      const server = state.jupyterServers.find((item) => item.key === key);
      if (server) await toggleJupyterEnabled(key, !server.enabled);
      return;
    }
    if (action === "delete-jupyter") {
      if (!window.confirm(`确定删除 Jupyter Server ${key}？`)) return;
      await deleteJupyterServer(key);
    }
  } catch (error) {
    handleError(error);
  }
});

document.getElementById("llm-route-create").addEventListener("click", () => {
  openLlmRouteDialog("create").catch(handleError);
});

document.getElementById("llm-create").addEventListener("click", () => {
  openLlmDialog("create");
});

document.getElementById("llm-refresh").addEventListener("click", () => {
  loadLlmAdmin().catch(handleError);
});

els.llmForm.addEventListener("submit", (event) => {
  saveLlmFromForm(event).catch((error) => showLlmFormError(String(error.message || error)));
});

document.getElementById("llm-form-cancel").addEventListener("click", () => {
  els.llmDialog.close();
});

els.llmRouteForm.addEventListener("submit", (event) => {
  saveLlmRouteFromForm(event).catch((error) =>
    showLlmRouteFormError(String(error.message || error)),
  );
});

document.getElementById("llm-route-form-cancel").addEventListener("click", () => {
  els.llmRouteDialog.close();
});

els.llmRouteProviderSelect.addEventListener("change", async () => {
  const providerKey = els.llmRouteProviderSelect.value;
  if (!providerKey) return;
  await loadProviderModels(providerKey);
  populateRouteModelSelect(providerKey, "");
});

document.getElementById("llm-add-model").addEventListener("click", () => {
  addLlmModel().catch((error) => showLlmModelsFormError(String(error.message || error)));
});

document.getElementById("llm-models-form-close").addEventListener("click", () => {
  els.llmModelsDialog.close();
});

els.llmModelsBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const providerKey = button.getAttribute("data-provider");
  const modelName = button.getAttribute("data-model");
  const action = button.getAttribute("data-action");
  try {
    if (action === "toggle-llm-model") {
      const models = state.llmProviderModels[providerKey] || [];
      const model = models.find((item) => item.model_name === modelName);
      if (model) await toggleLlmModel(providerKey, modelName, !model.enabled);
      return;
    }
    if (action === "delete-llm-model") {
      if (!window.confirm(`确定删除模型 ${modelName}？`)) return;
      await deleteLlmModel(providerKey, modelName);
    }
  } catch (error) {
    handleError(error);
  }
});

els.llmRoutesBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const routeId = Number(button.getAttribute("data-id"));
  const action = button.getAttribute("data-action");
  try {
    const route = state.llmRoutes.find((item) => item.id === routeId);
    if (action === "edit-llm-route" && route) {
      await openLlmRouteDialog("edit", route);
      return;
    }
    if (action === "toggle-llm-route" && route) {
      await toggleLlmRouteEnabled(routeId, !route.enabled);
      return;
    }
    if (action === "delete-llm-route") {
      if (!window.confirm(`确定删除用途路由 #${routeId}？`)) return;
      await deleteLlmRoute(routeId);
    }
  } catch (error) {
    handleError(error);
  }
});

els.llmBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const key = button.getAttribute("data-key");
  const action = button.getAttribute("data-action");
  try {
    if (action === "manage-llm-models") {
      await openLlmModelsDialog(key);
      return;
    }
    if (action === "edit-llm") {
      const provider = state.llmProviders.find((item) => item.key === key);
      if (provider) openLlmDialog("edit", provider);
      return;
    }
    if (action === "toggle-llm") {
      const provider = state.llmProviders.find((item) => item.key === key);
      if (provider) await toggleLlmEnabled(key, !provider.enabled);
      return;
    }
    if (action === "delete-llm") {
      if (!window.confirm(`确定删除 LLM Provider ${key}？`)) return;
      await deleteLlmProvider(key);
    }
  } catch (error) {
    handleError(error);
  }
});

document.querySelector("#panel-validations thead").addEventListener("click", (event) => {
  const header = event.target.closest("th[data-sort]");
  if (!header) return;
  const sort = header.getAttribute("data-sort");
  if (state.validations.sort === sort) {
    state.validations.order = state.validations.order === "desc" ? "asc" : "desc";
  } else {
    state.validations.sort = sort;
    state.validations.order = sort === "evaluated_at" ? "desc" : "desc";
  }
  state.validations.offset = 0;
  syncValidationControlsFromState();
  loadValidationResults().catch(handleError);
});

els.operatorsStatus.addEventListener("change", () => {
  state.operators.status = els.operatorsStatus.value;
  state.operators.offset = 0;
  loadOperators().catch(handleError);
});

document.body.addEventListener("click", async (event) => {
  const sqlButton = event.target.closest("[data-action='view-factor-sql']");
  if (sqlButton) {
    event.stopPropagation();
    openFactorSqlDialogById(Number(sqlButton.getAttribute("data-validation-id")));
    return;
  }

  const linkButton = event.target.closest(".idea-link[data-id]");
  if (linkButton) {
    event.stopPropagation();
    const id = linkButton.getAttribute("data-id");
    try {
      const data = await apiGet(`/api/ideas/${id}`);
      await renderIdeaDetail(data.item);
    } catch (error) {
      handleError(error);
    }
    return;
  }

  const factorValidationRow = event.target.closest("tr[data-factor-validation-id]");
  if (factorValidationRow) {
    const factorValidationId = Number(factorValidationRow.getAttribute("data-factor-validation-id"));
    if (Number.isFinite(factorValidationId) && factorValidationId > 0) {
      showFactorValidationDetail(factorValidationId).catch(handleError);
    }
    return;
  }

  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  const id = row.getAttribute("data-id");
  const kind = row.getAttribute("data-kind");
  try {
    if (kind === "idea") {
      const data = await apiGet(`/api/ideas/${id}`);
      await renderIdeaDetail(data.item);
    } else {
      const data = await apiGet(`/api/operators/${id}`);
      renderOperatorDetail(data.item);
    }
  } catch (error) {
    handleError(error);
  }
});

async function verifyAuthAndBoot() {
  const token = getAuthToken();
  if (!token) {
    showAuthGate();
    return;
  }
  try {
    await apiGet("/api/auth/check");
    hideAuthGate();
    await Promise.all([loadStats(), loadIdeaSourceOptions(), loadIdeas(), loadOperators()]);
  } catch {
    showAuthGate();
  }
}

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = els.authPassword.value.trim();
  if (!password) {
    showAuthGate("请输入密码");
    return;
  }
  setAuthToken(password);
  els.authPassword.value = "";
  try {
    await apiGet("/api/auth/check");
    hideAuthGate();
    await Promise.all([loadStats(), loadIdeaSourceOptions(), loadIdeas(), loadOperators()]);
  } catch (err) {
    clearAuthToken();
    const msg = err?.message || "";
    if (msg.includes("非 JSON") || msg.includes("Failed to fetch")) {
      showAuthGate(msg.includes("Failed to fetch") ? "网络错误，请检查访问地址或稍后重试" : msg);
    } else {
      showAuthGate("密码错误");
    }
  }
});

els.detailDialog?.addEventListener("close", () => {
  if (state.icSeriesChartDispose) {
    state.icSeriesChartDispose();
    state.icSeriesChartDispose = null;
  }
  els.detailDialog.classList.remove("detail-dialog--wide");
});

verifyAuthAndBoot();
