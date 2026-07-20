import { mountIcSeriesChart } from "./ic-series-chart.js";
import { mountMetricSummaryCharts } from "./metric-summary-charts.js";
import { mountIcDensityChart } from "./ic-density-chart.js";

const DENSITY_CHART_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 13.5 C4.5 6.5 6.5 12 8 9 C9.5 6 11.5 10.5 14.5 13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const IC_SERIES_CHART_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 12.5 L5 7.5 L8.5 9.5 L11.5 4.5 L14.5 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const MLFLOW_LINK_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v8a1.5 1.5 0 0 0 1.5 1.5H11.5A1.5 1.5 0 0 0 13 12V6.5M9 2.5H13V6.5M9 2.5 13 6.5M7 8.5H10M7 11H9.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const DENSITY_CHART_CONFIG = {
  mean_rank_ic: {
    title: "Mean Rank IC 密度图",
    subtitle: "按日 Mean Rank IC 分布",
    color: "#f0a05a",
  },
  rank_ic: {
    title: "Rank IC 密度图",
    subtitle: "全样本 Rank IC 分布",
    color: "#5b9cff",
  },
};

const PAGE_SIZE = 20;
const AUTH_STORAGE_KEY = "qf_auth_token";
const DASHBOARD_TABS = [
  "ideas",
  "factor-validations",
  "profiles",
  "llm",
  "mlflow",
  "operators",
  "settings",
];
const DASHBOARD_TAB_SET = new Set(DASHBOARD_TABS);
const DEFAULT_DASHBOARD_TAB = "ideas";

const DASHBOARD_TAB_TITLES = {
  ideas: "因子想法",
  "factor-validations": "验证结果",
  profiles: "验证配置",
  llm: "LLM API",
  mlflow: "MLflow",
  operators: "自定义算子",
  settings: "系统配置",
};

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

function normalizeDashboardTab(tab) {
  const value = String(tab ?? "").trim();
  return DASHBOARD_TAB_SET.has(value) ? value : DEFAULT_DASHBOARD_TAB;
}

function readDashboardTabFromUrl() {
  const hash = window.location.hash.replace(/^#\/?/, "").trim();
  if (!hash) {
    return DEFAULT_DASHBOARD_TAB;
  }
  if (hash.startsWith("tab=")) {
    return normalizeDashboardTab(decodeURIComponent(hash.slice(4)));
  }
  return normalizeDashboardTab(decodeURIComponent(hash));
}

function syncDashboardTabToUrl(tab, { replace = false } = {}) {
  const normalized = normalizeDashboardTab(tab);
  const nextHash = normalized === DEFAULT_DASHBOARD_TAB ? "" : `#${normalized}`;
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) {
    return;
  }
  if (replace) {
    history.replaceState({ tab: normalized }, "", nextUrl);
    return;
  }
  history.pushState({ tab: normalized }, "", nextUrl);
}

function updateDashboardDocumentTitle(tab) {
  const label = DASHBOARD_TAB_TITLES[normalizeDashboardTab(tab)] ?? "控制台";
  document.title = tab === DEFAULT_DASHBOARD_TAB
    ? "Quant Factors 控制台"
    : `${label} · Quant Factors`;
}
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

const NEUTRALIZATION_LABELS = {
  none: "原始",
  liq_mom: "中性化",
  auto: "中性化(自动)",
  liquidity: "仅流动性",
  short_term_return: "仅短收益",
  liquidity_volatility: "流动性+波动",
};

const state = {
  validationById: {},
  tab: "ideas",
  ideas: { offset: 0, source: "", title: "" },
  ideaSources: [],
  operators: { offset: 0, status: "" },
  factorValidations: {
    sort: "mean_rank_ic",
    order: "desc",
    abs: true,
    limit: 30,
    offset: 0,
    status: "success",
    profile_keys: [],
    title: "",
    neutralization_key: "",
  },
  factorValidationById: {},
  icSeriesChartDispose: null,
  icSeriesCache: new Map(),
  icDensityChartDispose: null,
  metricSummaryChartsDispose: null,
  validationProfiles: [],
  profileFormMode: "create",
  editingProfileKey: null,
  llmProviders: [],
  llmRoutes: [],
  llmProviderModels: {},
  llmFormMode: "create",
  llmRouteFormMode: "create",
  editingLlmKey: null,
  mlflowConfigs: [],
  mlflowActive: null,
  mlflowFormMode: "create",
  editingMlflowKey: null,
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
  factorValidationsBody: document.getElementById("factor-validations-body"),
  factorValidationsPager: document.getElementById("factor-validations-pager"),
  factorValidationsHint: document.getElementById("factor-validations-hint"),
  factorValidationsSort: document.getElementById("factor-validations-sort"),
  factorValidationsOrder: document.getElementById("factor-validations-order"),
  factorValidationsAbs: document.getElementById("factor-validations-abs"),
  factorValidationsLimit: document.getElementById("factor-validations-limit"),
  factorValidationsStatus: document.getElementById("factor-validations-status"),
  factorValidationsProfile: document.getElementById("factor-validations-profile"),
  factorValidationsTitle: document.getElementById("factor-validations-title"),
  factorValidationsNeutralization: document.getElementById("factor-validations-neutralization"),
  factorValidationsCharts: document.getElementById("factor-validations-charts"),
  settingsWorkflowBody: document.getElementById("settings-workflow-body"),
  settingsSchedulesBody: document.getElementById("settings-schedules-body"),
  settingsManualResult: document.getElementById("settings-manual-result"),
  settingsRunValidation: document.getElementById("settings-run-validation"),
  settingsRunCleanup: document.getElementById("settings-run-cleanup"),
  settingsRunForceCleanup: document.getElementById("settings-run-force-cleanup"),
  ideasSource: document.getElementById("ideas-source"),
  ideasTitle: document.getElementById("ideas-title"),
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
  mlflowBody: document.getElementById("mlflow-body"),
  mlflowActiveSummary: document.getElementById("mlflow-active-summary"),
  mlflowDialog: document.getElementById("mlflow-dialog"),
  mlflowForm: document.getElementById("mlflow-form"),
  mlflowFormTitle: document.getElementById("mlflow-form-title"),
  mlflowKeyInput: document.getElementById("mlflow-key"),
  mlflowNameInput: document.getElementById("mlflow-name"),
  mlflowTrackingUriInput: document.getElementById("mlflow-tracking-uri"),
  mlflowUsernameInput: document.getElementById("mlflow-username"),
  mlflowPasswordInput: document.getElementById("mlflow-password"),
  mlflowSortOrderInput: document.getElementById("mlflow-sort-order"),
  mlflowEnabledInput: document.getElementById("mlflow-enabled"),
  mlflowFormError: document.getElementById("mlflow-form-error"),
  mlflowFormTestResult: document.getElementById("mlflow-form-test-result"),
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
  densityDialog: document.getElementById("density-dialog"),
  densityDialogTitle: document.getElementById("density-dialog-title"),
  densityDialogMeta: document.getElementById("density-dialog-meta"),
  densityChartHost: document.getElementById("density-chart-host"),
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

function formatTableTime(value) {
  if (!value) return { text: "-", title: "" };
  const full = formatTime(value);
  return { text: full.length >= 16 ? full.slice(5, 16) : full, title: full };
}

function formatMetricCell(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return `<span class="muted">-</span>`;
  const signClass = num >= 0 ? "fv-metric-positive" : "fv-metric-negative";
  return `<span class="fv-metric-value ${signClass}">${num.toFixed(4)}</span>`;
}

function formatNeutralizationLabel(key) {
  const normalized = String(key || "none").trim() || "none";
  return NEUTRALIZATION_LABELS[normalized] || normalized;
}

function factorValidationNeutralizationBadge(key) {
  const normalized = String(key || "none").trim() || "none";
  const label = formatNeutralizationLabel(normalized);
  const variant = normalized === "none" ? "neutral" : "primary";
  return `<sl-badge variant="${variant}" pill>${escapeHtml(label)}</sl-badge>`;
}

function formatMetricDelta(primaryValue, neutralValue) {
  const primary = Number(primaryValue);
  const neutral = Number(neutralValue);
  if (!Number.isFinite(primary) || !Number.isFinite(neutral)) {
    return `<span class="muted">-</span>`;
  }
  const delta = neutral - primary;
  const signClass = delta >= 0 ? "fv-metric-positive" : "fv-metric-negative";
  const prefix = delta > 0 ? "+" : "";
  return `<span class="fv-metric-value ${signClass}" title="中性化 − 原始">${prefix}${delta.toFixed(4)}</span>`;
}

function factorValidationFactorCell(row, errHtml = "") {
  const title = escapeHtml(row.idea_title || `#${row.idea_id}`);
  const profile = escapeHtml(row.profile_name || row.profile_key);
  const statusBadge = row.status !== "success" ? validationStatusBadge(row.status) : "";
  const neutralBadge = factorValidationNeutralizationBadge(row.neutralization_key);
  return `
    <div class="fv-factor-cell">
      <button type="button" class="fv-idea-link idea-link" data-id="${row.idea_id}" data-kind="idea" title="${title}">${title}</button>
      <div class="fv-row-meta muted">
        <span>#${row.id}</span>
        <span class="fv-meta-sep">·</span>
        <span class="fv-meta-profile" title="${profile}">${profile}</span>
        <span class="fv-meta-sep">·</span>
        ${neutralBadge}
        ${statusBadge ? `<span class="fv-meta-sep">·</span>${statusBadge}` : ""}
      </div>
      ${errHtml}
    </div>
  `;
}

function factorValidationDensityIcon(kind, rowId) {
  const config = DENSITY_CHART_CONFIG[kind];
  if (!config) return "";
  return `
    <button
      type="button"
      class="fv-chart-icon-btn fv-chart-icon-btn--${kind}"
      data-action="view-density-chart"
      data-density-kind="${kind}"
      data-factor-validation-id="${rowId}"
      title="${config.title}"
      aria-label="${config.title}"
    >${DENSITY_CHART_ICON}</button>
  `;
}

function factorValidationChartCell(row) {
  if (row.status !== "success" || !row.mlflow_run_id) {
    return `<span class="muted">-</span>`;
  }
  const mlflowLink = row.mlflow_run_url
    ? `<a class="fv-chart-icon-btn fv-chart-icon-btn--mlflow" href="${escapeHtml(row.mlflow_run_url)}" target="_blank" rel="noopener noreferrer" title="打开 MLflow Run" aria-label="打开 MLflow Run" data-action="open-mlflow">${MLFLOW_LINK_ICON}</a>`
    : "";
  return `
    <div class="fv-chart-actions">
      <button type="button" class="fv-chart-icon-btn fv-chart-icon-btn--series" data-action="view-ic-chart" data-factor-validation-id="${row.id}" title="IC 序列" aria-label="IC 序列">${IC_SERIES_CHART_ICON}</button>
      ${factorValidationDensityIcon("mean_rank_ic", row.id)}
      ${factorValidationDensityIcon("rank_ic", row.id)}
      ${mlflowLink}
    </div>
  `;
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

function syncFactorValidationControlsFromState() {
  if (els.factorValidationsSort) {
    els.factorValidationsSort.value = state.factorValidations.sort;
  }
  if (els.factorValidationsOrder) {
    els.factorValidationsOrder.value = state.factorValidations.order;
  }
  if (els.factorValidationsAbs) {
    els.factorValidationsAbs.checked = state.factorValidations.abs;
  }
  if (els.factorValidationsLimit) {
    els.factorValidationsLimit.value = String(state.factorValidations.limit);
  }
  if (els.factorValidationsStatus) {
    els.factorValidationsStatus.value = state.factorValidations.status;
  }
  if (els.factorValidationsProfile) {
    els.factorValidationsProfile.value = state.factorValidations.profile_keys;
  }
  if (els.factorValidationsTitle) {
    els.factorValidationsTitle.value = state.factorValidations.title;
  }
  if (els.factorValidationsNeutralization) {
    els.factorValidationsNeutralization.value = state.factorValidations.neutralization_key;
  }
}

function readFactorValidationControlsToState() {
  state.factorValidations.sort = String(els.factorValidationsSort?.value ?? "mean_rank_ic").trim();
  state.factorValidations.order = els.factorValidationsOrder?.value === "asc" ? "asc" : "desc";
  state.factorValidations.abs = Boolean(els.factorValidationsAbs?.checked);
  state.factorValidations.limit = Math.min(
    200,
    Math.max(1, Number(els.factorValidationsLimit?.value ?? 30) || 30),
  );
  state.factorValidations.status = String(els.factorValidationsStatus?.value ?? "success").trim();
  state.factorValidations.profile_keys = Array.isArray(els.factorValidationsProfile?.value)
    ? els.factorValidationsProfile.value.map(String).filter(Boolean)
    : [];
  state.factorValidations.title = String(els.factorValidationsTitle?.value ?? "").trim();
  state.factorValidations.neutralization_key = String(
    els.factorValidationsNeutralization?.value ?? "",
  ).trim();
}

function buildFactorValidationQueryParams() {
  const { sort, order, abs, limit, offset, status, profile_keys, title, neutralization_key } =
    state.factorValidations;
  const params = new URLSearchParams({
    sort,
    order,
    abs: abs ? "1" : "0",
    limit: String(limit),
    offset: String(offset),
  });
  if (status) {
    params.set("status", status);
  }
  if (profile_keys.length) {
    params.set("profile_keys", profile_keys.join(","));
  }
  if (title) {
    params.set("title", title);
  }
  if (neutralization_key) {
    params.set("neutralization_key", neutralization_key);
  }
  return params.toString();
}

function updateFactorValidationSortHeaders() {
  document.querySelectorAll("#panel-factor-validations th[data-sort]").forEach((header) => {
    const field = header.getAttribute("data-sort");
    const active = field === state.factorValidations.sort;
    header.classList.toggle("sort-active", active);
    header.classList.toggle("sort-desc", active && state.factorValidations.order === "desc");
    header.classList.toggle("sort-asc", active && state.factorValidations.order === "asc");
  });
}

function factorValidationQueryHint(data) {
  const metricLabel = {
    mean_ic: "Mean IC",
    mean_rank_ic: "Mean Rank IC",
    evaluated_at: "评估时间",
    updated_at: "更新时间",
  }[data.sort] || data.sort;
  const absLabel =
    data.abs && data.sort !== "evaluated_at" && data.sort !== "updated_at" ? "绝对值 " : "";
  const statusLabel = data.status ? `，状态=${data.status}` : "，全部状态";
  const profileKeys = data.profile_keys?.length
    ? data.profile_keys
    : state.factorValidations.profile_keys;
  const profileLabel = profileKeys.length ? `，配置=${formatProfileKeysLabel(profileKeys)}` : "";
  const titleLabel = data.title ? `，标题含「${data.title}」` : "";
  const neutralLabel = data.neutralization_key
    ? `，中性化=${formatNeutralizationLabel(data.neutralization_key)}`
    : state.factorValidations.neutralization_key
      ? `，中性化=${formatNeutralizationLabel(state.factorValidations.neutralization_key)}`
      : "";
  return `${absLabel}${metricLabel} ${data.order === "desc" ? "降序" : "升序"} Top ${data.limit}${statusLabel}${profileLabel}${titleLabel}${neutralLabel} · 共 ${data.total} 条`;
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
  if (els.factorValidationsProfile) {
    els.factorValidationsProfile.innerHTML = state.validationProfiles
      .map(
        (profile) =>
          `<sl-option value="${escapeHtml(profile.key)}">${escapeHtml(profile.name || profile.key)}</sl-option>`,
      )
      .join("");
    els.factorValidationsProfile.value = current;
  }
}

async function loadEnabledProfileOptions() {
  return loadEnabledProfileOptionsForFactorValidations();
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

function truncateUrl(url, max = 48) {
  const text = String(url || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
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

async function loadMlflowAdmin() {
  const [listData, activeData] = await Promise.all([
    apiGet("/api/mlflow-tracking-configs"),
    apiGet("/api/workflow/mlflow-config"),
  ]);
  state.mlflowConfigs = listData.items || [];
  state.mlflowActive = activeData.active || null;
  renderMlflowActiveSummary();
  renderMlflowTable(state.mlflowConfigs);
}

function renderMlflowActiveSummary() {
  if (!els.mlflowActiveSummary) {
    return;
  }
  const active = state.mlflowActive;
  if (!active?.configured) {
    els.mlflowActiveSummary.textContent =
      "当前无启用的 MLflow 配置；验证任务将回退 Worker 环境变量。";
    return;
  }
  const sourceLabel = active.source === "d1" ? "D1 配置" : "环境变量";
  els.mlflowActiveSummary.textContent = `当前生效：${active.key || "-"}（${sourceLabel}）· ${active.tracking_uri}`;
}

function renderMlflowTable(items) {
  if (!els.mlflowBody) {
    return;
  }
  if (!items.length) {
    els.mlflowBody.innerHTML = `<tr><td colspan="8" class="muted">暂无 MLflow 配置。点击「新建配置」添加。</td></tr>`;
    return;
  }
  els.mlflowBody.innerHTML = items
    .map((item) => {
      const status = item.enabled
        ? '<span class="status-pill status-pill--active">启用</span>'
        : '<span class="status-pill">禁用</span>';
      return `
      <tr data-mlflow-key="${escapeHtml(item.key)}">
        <td><code>${escapeHtml(item.key)}</code></td>
        <td>${escapeHtml(item.name)}</td>
        <td class="mono">${escapeHtml(item.tracking_uri)}</td>
        <td>${escapeHtml(item.username)}</td>
        <td>${escapeHtml(String(item.sort_order ?? 0))}</td>
        <td>${status}</td>
        <td class="muted">${escapeHtml(item.last_used_at || "-")}</td>
        <td>
          <div class="table-actions">
            ${tableActionButton("编辑", "edit-mlflow", { "data-key": item.key })}
            ${tableActionButton(item.enabled ? "禁用" : "启用", "toggle-mlflow", { "data-key": item.key })}
            ${tableActionButton("删除", "delete-mlflow", { "data-key": item.key }, { danger: true })}
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function setMlflowFormError(message = "") {
  if (!message) {
    els.mlflowFormError.classList.add("hidden");
    els.mlflowFormError.textContent = "";
    return;
  }
  els.mlflowFormError.textContent = message;
  els.mlflowFormError.classList.remove("hidden");
}

function setMlflowFormTestResult(message = "", { ok = false } = {}) {
  if (!els.mlflowFormTestResult) {
    return;
  }
  if (!message) {
    els.mlflowFormTestResult.classList.add("hidden");
    els.mlflowFormTestResult.textContent = "";
    els.mlflowFormTestResult.classList.remove("auth-error");
    return;
  }
  els.mlflowFormTestResult.textContent = message;
  els.mlflowFormTestResult.classList.toggle("auth-error", !ok);
  els.mlflowFormTestResult.classList.remove("hidden");
}

function openMlflowDialog(mode, config = null) {
  state.mlflowFormMode = mode;
  state.editingMlflowKey = config?.key ?? null;
  setMlflowFormError("");
  setMlflowFormTestResult("");
  els.mlflowFormTitle.textContent = mode === "create" ? "新建 MLflow 配置" : "编辑 MLflow 配置";
  els.mlflowKeyInput.disabled = mode === "edit";
  els.mlflowKeyInput.value = config?.key ?? "";
  els.mlflowNameInput.value = config?.name ?? "";
  els.mlflowTrackingUriInput.value = config?.tracking_uri ?? "";
  els.mlflowUsernameInput.value = config?.username ?? "";
  els.mlflowPasswordInput.value = "";
  els.mlflowPasswordInput.required = mode === "create";
  els.mlflowSortOrderInput.value = String(config?.sort_order ?? 0);
  els.mlflowEnabledInput.checked = config?.enabled !== false;
  els.mlflowDialog.showModal();
}

function buildMlflowTestPayload() {
  const payload = {
    tracking_uri: els.mlflowTrackingUriInput.value.trim().replace(/\/$/, ""),
    username: els.mlflowUsernameInput.value.trim(),
  };
  const password = els.mlflowPasswordInput.value.trim();
  if (password) {
    payload.password = password;
  } else if (state.mlflowFormMode === "edit" && state.editingMlflowKey) {
    payload.key = state.editingMlflowKey;
  }
  return payload;
}

async function testMlflowFormConnection() {
  setMlflowFormError("");
  setMlflowFormTestResult("正在测试连接…");
  const payload = buildMlflowTestPayload();
  if (!payload.tracking_uri || !payload.username) {
    setMlflowFormTestResult("请填写 Tracking URI 与用户名", { ok: false });
    return;
  }
  if (!payload.password && !payload.key) {
    setMlflowFormTestResult("请填写密码，或在已保存配置下留空以使用已存密码", { ok: false });
    return;
  }
  try {
    const result = await apiPost("/api/mlflow-tracking-configs/test-connection", payload);
    const experiments =
      Array.isArray(result.existing_experiments) && result.existing_experiments.length
        ? result.existing_experiments.join("、")
        : "（无）";
    setMlflowFormTestResult(
      `连接成功（${result.latency_ms ?? "-"}ms）· 已完成读写探针（临时 experiment 已清理）· 可见实验：${experiments} · 测试 Run：${result.test_run_id}`,
      { ok: true },
    );
    showToast("MLflow 连接测试成功", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMlflowFormTestResult(message, { ok: false });
    showToast(message);
  }
}

async function submitMlflowForm(event) {
  event.preventDefault();
  const payload = {
    name: els.mlflowNameInput.value.trim(),
    tracking_uri: els.mlflowTrackingUriInput.value.trim().replace(/\/$/, ""),
    username: els.mlflowUsernameInput.value.trim(),
    sort_order: Number(els.mlflowSortOrderInput.value) || 0,
    enabled: els.mlflowEnabledInput.checked,
  };
  const password = els.mlflowPasswordInput.value.trim();
  if (password) {
    payload.password = password;
  } else if (state.mlflowFormMode === "create") {
    setMlflowFormError("新建配置时密码不能为空");
    return;
  }
  try {
    let saved;
    if (state.mlflowFormMode === "create") {
      payload.key = els.mlflowKeyInput.value.trim();
      saved = await apiPost("/api/mlflow-tracking-configs", payload);
      showToast("MLflow 配置已创建", "success");
    } else {
      saved = await apiPatch(`/api/mlflow-tracking-configs/${state.editingMlflowKey}`, payload);
      showToast("MLflow 配置已更新", "success");
    }
    const experiment = saved?.item?.experiment;
    if (experiment?.created) {
      showToast(`已创建 experiment：${experiment.name}`, "success");
    }
    els.mlflowDialog.close();
    await loadMlflowAdmin();
  } catch (error) {
    setMlflowFormError(error instanceof Error ? error.message : String(error));
  }
}

async function toggleMlflowConfig(key, enabled) {
  await apiPatch(`/api/mlflow-tracking-configs/${key}`, { enabled });
  showToast(enabled ? "MLflow 配置已启用" : "MLflow 配置已禁用", "success");
  await loadMlflowAdmin();
}

async function deleteMlflowConfig(key) {
  await apiDelete(`/api/mlflow-tracking-configs/${key}`);
  showToast("MLflow 配置已删除", "success");
  await loadMlflowAdmin();
}

async function backfillMlflowTasks() {
  const data = await apiPost("/api/workflow/mlflow-config/backfill", {});
  showToast(
    `已关联 ${data.updated ?? 0} 条成功任务${data.urls_patched ? `，补全 ${data.urls_patched} 条 Run URL` : ""}`,
    "success",
  );
  await loadMlflowAdmin();
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
  const candidates = (items || []).filter((row) => {
    if (!row?.mlflow_run_id) {
      return false;
    }
    const cached = factorValidationMetricsFromRow(row);
    return !Number.isFinite(Number(cached.mean_ic)) && !Number.isFinite(Number(cached.mean_rank_ic));
  });
  if (!candidates.length) {
    return new Map();
  }
  const entries = await Promise.all(
    candidates.map(async (row) => {
      const runId = String(row.mlflow_run_id).trim();
      const taskQuery =
        row.task_id != null && Number.isFinite(Number(row.task_id)) && Number(row.task_id) > 0
          ? `?task_id=${encodeURIComponent(String(row.task_id))}`
          : "";
      try {
        const data = await apiGet(`/api/mlflow/runs/${encodeURIComponent(runId)}${taskQuery}`);
        return [runId, parseMlflowRunMetrics(data)];
      } catch {
        return [runId, null];
      }
    }),
  );
  return new Map(entries);
}

async function loadFactorValidations() {
  syncFactorValidationControlsFromState();
  const params = buildFactorValidationQueryParams();
  const data = await apiGet(`/api/factor-validations?${params}`);
  const metricsMap = await fetchMlflowMetricsMap(data.items || []);
  updateFactorValidationSortHeaders();

  for (const row of data.items || []) {
    state.factorValidationById[row.id] = row;
  }

  if (els.factorValidationsHint) {
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
    els.factorValidationsHint.textContent = `${factorValidationQueryHint(data)}（指标优先读 D1）${metricsNote}`;
  }

  const rowsWithMetrics = (data.items || []).map((row) => {
    const cachedMetrics = factorValidationMetricsFromRow(row);
    const metrics =
      Number.isFinite(Number(cachedMetrics.mean_ic)) ||
      Number.isFinite(Number(cachedMetrics.mean_rank_ic))
        ? cachedMetrics
        : row.mlflow_run_id
          ? metricsMap.get(row.mlflow_run_id) || {}
          : {};
    return { row, metrics };
  });

  if (state.metricSummaryChartsDispose) {
    state.metricSummaryChartsDispose();
    state.metricSummaryChartsDispose = null;
  }
  if (els.factorValidationsCharts) {
    const chartValues = {
      mean_ic: rowsWithMetrics.map(({ metrics }) => Number(metrics.mean_ic)),
      mean_rank_ic: rowsWithMetrics.map(({ metrics }) => Number(metrics.mean_rank_ic)),
    };
    const hasChartValues =
      chartValues.mean_ic.some(Number.isFinite) || chartValues.mean_rank_ic.some(Number.isFinite);
    els.factorValidationsCharts.classList.toggle("hidden", !hasChartValues);
    if (hasChartValues) {
      state.metricSummaryChartsDispose = mountMetricSummaryCharts(els.factorValidationsCharts, chartValues);
    } else {
      els.factorValidationsCharts.innerHTML = "";
    }
  }

  els.factorValidationsBody.innerHTML = rowsWithMetrics
    .map(({ row, metrics }) => {
      const err = row.error_reason
        ? `<div class="muted validation-error" title="${escapeHtml(row.error_reason)}">${escapeHtml(row.error_reason.slice(0, 80))}${row.error_reason.length > 80 ? "…" : ""}</div>`
        : "";
      const evaluated = formatTableTime(row.evaluated_at || row.updated_at);
      return `
        <tr data-factor-validation-id="${row.id}" data-task-id="${row.task_id}" class="clickable-row">
          <td class="fv-col-factor">${factorValidationFactorCell(row, err)}</td>
          <td class="fv-col-metric">${formatMetricCell(metrics.mean_ic)}</td>
          <td class="fv-col-metric">${formatMetricCell(metrics.mean_rank_ic)}</td>
          <td class="fv-col-metric">${formatMetricCell(metrics.ic_ir)}</td>
          <td class="fv-col-actions">${factorValidationChartCell(row)}</td>
          <td class="fv-col-time" title="${escapeHtml(evaluated.title)}">${evaluated.text}</td>
        </tr>
      `;
    })
    .join("");

  if (!(data.items || []).length) {
    els.factorValidationsBody.innerHTML = `<tr><td colspan="6" class="muted">暂无因子验证记录。</td></tr>`;
    if (els.factorValidationsCharts) {
      els.factorValidationsCharts.classList.add("hidden");
      els.factorValidationsCharts.innerHTML = "";
    }
  }

  renderPager(els.factorValidationsPager, data, (nextOffset) => {
    state.factorValidations.offset = nextOffset;
    loadFactorValidations().catch(handleError);
  });
}

async function fetchIcSeriesCached(mlflowRunId, taskId = null) {
  const runId = String(mlflowRunId || "").trim();
  if (!runId) {
    throw new Error("缺少 MLflow run id");
  }
  const cacheKey = taskId ? `${runId}:${taskId}` : runId;
  if (state.icSeriesCache.has(cacheKey)) {
    return state.icSeriesCache.get(cacheKey);
  }
  const taskQuery =
    taskId != null && Number.isFinite(Number(taskId)) && Number(taskId) > 0
      ? `?task_id=${encodeURIComponent(String(taskId))}`
      : "";
  const series = await apiGet(
    `/api/mlflow/runs/${encodeURIComponent(runId)}/ic-series${taskQuery}`,
  );
  state.icSeriesCache.set(cacheKey, series);
  return series;
}

function densitySamplesFromSeries(series, kind) {
  const density = series?.density;
  if (kind === "mean_rank_ic") {
    if (Array.isArray(density?.mean_rank_ic) && density.mean_rank_ic.length) {
      return density.mean_rank_ic;
    }
    return (series?.points || [])
      .map((point) => Number(point?.mean_rank_ic))
      .filter(Number.isFinite);
  }
  if (kind === "rank_ic") {
    if (Array.isArray(density?.rank_ic) && density.rank_ic.length) {
      return density.rank_ic;
    }
    return [];
  }
  return [];
}

async function showFactorValidationDensityChart(factorValidationId, kind) {
  const config = DENSITY_CHART_CONFIG[kind];
  if (!config) {
    showToast("未知密度图类型");
    return;
  }

  if (state.icDensityChartDispose) {
    state.icDensityChartDispose();
    state.icDensityChartDispose = null;
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
  if (item.status !== "success" || !item.mlflow_run_id) {
    showToast("仅 success 且含 MLflow 的记录可查看密度图");
    return;
  }

  els.densityDialogTitle.textContent = config.title;
  els.densityDialogMeta.textContent = `因子验证 #${item.id} · ${item.idea_title || `#${item.idea_id}`} · ${config.subtitle}`;
  els.densityChartHost.innerHTML = `<p class="muted">加载密度数据…</p>`;
  els.densityDialog.showModal();

  try {
    const series = await fetchIcSeriesCached(item.mlflow_run_id, item.task_id);
    const samples = densitySamplesFromSeries(series, kind);
    const metrics = factorValidationMetricsFromRow(item);
    const referenceValue =
      kind === "mean_rank_ic"
        ? metrics.mean_rank_ic
        : kind === "rank_ic"
          ? metrics.mean_rank_ic
          : null;
    state.icDensityChartDispose = mountIcDensityChart(els.densityChartHost, samples, {
      title: config.title,
      color: config.color,
      referenceValue,
    });
  } catch (error) {
    els.densityChartHost.innerHTML = `<p class="auth-error">密度图加载失败：${escapeHtml(String(error.message || error))}</p>`;
  }
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
      const taskQuery =
        item.task_id != null && Number.isFinite(Number(item.task_id)) && Number(item.task_id) > 0
          ? `?task_id=${encodeURIComponent(String(item.task_id))}`
          : "";
      const mlflow = await apiGet(
        `/api/mlflow/runs/${encodeURIComponent(item.mlflow_run_id)}${taskQuery}`,
      );
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
    const series = await fetchIcSeriesCached(item.mlflow_run_id, item.task_id);
    state.icSeriesChartDispose = mountIcSeriesChart(chartHost, series);
  } catch (error) {
    chartHost.innerHTML = `<p class="auth-error">IC 序列加载失败：${escapeHtml(String(error.message || error))}</p>`;
  }
}

function applyFactorValidationPreset({ sort, abs = true, limit = 30, order = "desc", status = "success" }) {
  state.factorValidations.sort = sort;
  state.factorValidations.abs = abs;
  state.factorValidations.limit = limit;
  state.factorValidations.order = order;
  state.factorValidations.status = status;
  state.factorValidations.offset = 0;
  syncFactorValidationControlsFromState();
  loadFactorValidations().catch(handleError);
}

function renderIdeaFactorValidationsTable(data) {
  const items = data.items || [];
  for (const row of items) {
    state.factorValidationById[row.id] = row;
  }
  if (!items.length) {
    return `<p class="muted">尚未创建因子验证任务。</p>`;
  }

  const byProfile = new Map();
  for (const row of items) {
    const key = String(row.profile_key);
    if (!byProfile.has(key)) {
      byProfile.set(key, { primary: null, neutral: null, others: [] });
    }
    const bucket = byProfile.get(key);
    const neutralKey = String(row.neutralization_key || "none");
    if (neutralKey === "none") {
      bucket.primary = row;
    } else if (neutralKey !== "none" && !bucket.neutral) {
      bucket.neutral = row;
    } else {
      bucket.others.push(row);
    }
  }

  const rows = [];
  for (const [profileKey, bucket] of byProfile.entries()) {
    const profile = state.validationProfiles.find((item) => item.key === profileKey);
    const profileName = escapeHtml(profile?.name || profileKey);
    if (bucket.primary && bucket.neutral) {
      const primaryMetrics = factorValidationMetricsFromRow(bucket.primary);
      const neutralMetrics = factorValidationMetricsFromRow(bucket.neutral);
      rows.push(`
        <tr class="fv-compare-row">
          <td class="fv-col-factor" colspan="6">
            <div class="fv-compare-header">
              <strong>${profileName}</strong>
              <span class="muted">一次 vs 中性化</span>
            </div>
            <div class="fv-compare-grid">
              <div><span class="muted">Rank IC</span> ${formatMetricCell(primaryMetrics.mean_rank_ic)} → ${formatMetricCell(neutralMetrics.mean_rank_ic)} ${formatMetricDelta(primaryMetrics.mean_rank_ic, neutralMetrics.mean_rank_ic)}</div>
              <div><span class="muted">IC</span> ${formatMetricCell(primaryMetrics.mean_ic)} → ${formatMetricCell(neutralMetrics.mean_ic)} ${formatMetricDelta(primaryMetrics.mean_ic, neutralMetrics.mean_ic)}</div>
              <div><span class="muted">IR</span> ${formatMetricCell(primaryMetrics.ic_ir)} → ${formatMetricCell(neutralMetrics.ic_ir)}</div>
            </div>
          </td>
        </tr>
      `);
    }
    for (const row of [bucket.primary, bucket.neutral, ...bucket.others].filter(Boolean)) {
      const metrics = factorValidationMetricsFromRow(row);
      const evaluated = formatTableTime(row.evaluated_at || row.updated_at);
      rows.push(`
        <tr data-factor-validation-id="${row.id}" data-task-id="${row.task_id}" class="clickable-row">
          <td class="fv-col-factor">
            <div class="fv-factor-cell">
              <span class="fv-profile-label" title="${profileName}">${profileName}</span>
              <div class="fv-row-meta muted">
                <span>#${row.id}</span>
                <span class="fv-meta-sep">·</span>
                ${factorValidationNeutralizationBadge(row.neutralization_key)}
                ${row.status !== "success" ? `<span class="fv-meta-sep">·</span>${validationStatusBadge(row.status)}` : ""}
              </div>
            </div>
          </td>
          <td class="fv-col-metric">${formatMetricCell(metrics.mean_ic)}</td>
          <td class="fv-col-metric">${formatMetricCell(metrics.mean_rank_ic)}</td>
          <td class="fv-col-metric">${formatMetricCell(metrics.ic_ir)}</td>
          <td class="fv-col-actions">${factorValidationChartCell(row)}</td>
          <td class="fv-col-time" title="${escapeHtml(evaluated.title)}">${evaluated.text}</td>
        </tr>
      `);
    }
  }

  return `
    <table class="validation-table factor-validations-table factor-validations-table--compact">
      <thead>
        <tr>
          <th class="fv-col-factor">验证配置</th>
          <th class="fv-col-metric">IC</th>
          <th class="fv-col-metric">Rank IC</th>
          <th class="fv-col-metric">IR</th>
          <th class="fv-col-actions">操作</th>
          <th class="fv-col-time">评估</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

async function renderIdeaDetail(idea) {
  if (state.icSeriesChartDispose) {
    state.icSeriesChartDispose();
    state.icSeriesChartDispose = null;
  }
  els.detailDialog.classList.remove("detail-dialog--wide");
  const validations = await apiGet(`/api/ideas/${idea.id}/factor-validations`);
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
      <div id="validations-panel">${renderIdeaFactorValidationsTable(validations)}</div>
    </div>
  `;
  const enqueueButton = document.getElementById("enqueue-validations");
  enqueueButton?.addEventListener("click", async () => {
    enqueueButton.disabled = true;
    enqueueButton.loading = true;
    const originalText = enqueueButton.textContent;
    enqueueButton.textContent = "创建中…";
    try {
      const result = await apiPost(`/api/ideas/${idea.id}/factor-validations`, {});
      const createdCount = Array.isArray(result.created) ? result.created.length : 0;
      showToast(`已创建 ${createdCount} 条因子验证任务`, "success");
      const updated = await apiGet(`/api/ideas/${idea.id}/factor-validations`);
      document.getElementById("validations-panel").innerHTML = renderIdeaFactorValidationsTable(updated);
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
  const { offset, source, title } = state.ideas;
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (source) params.set("source", source);
  if (title) params.set("title", title);
  els.ideasSource.value = source || "";
  if (els.ideasTitle) {
    els.ideasTitle.value = title || "";
  }

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

function switchTab(tab, { updateUrl = true, replaceUrl = false } = {}) {
  const normalized = normalizeDashboardTab(tab);
  state.tab = normalized;
  document.querySelectorAll(".tab").forEach((button) => {
    const active = button.dataset.tab === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.getElementById("panel-ideas").classList.toggle("hidden", normalized !== "ideas");
  document.getElementById("panel-factor-validations").classList.toggle("hidden", normalized !== "factor-validations");
  document.getElementById("panel-profiles").classList.toggle("hidden", normalized !== "profiles");
  document.getElementById("panel-llm").classList.toggle("hidden", normalized !== "llm");
  document.getElementById("panel-mlflow").classList.toggle("hidden", normalized !== "mlflow");
  document.getElementById("panel-operators").classList.toggle("hidden", normalized !== "operators");
  document.getElementById("panel-settings").classList.toggle("hidden", normalized !== "settings");
  els.appLayout.classList.toggle(
    "layout-wide",
    normalized === "factor-validations" ||
      normalized === "profiles" || normalized === "llm" || normalized === "mlflow" || normalized === "settings",
  );
  updateDashboardDocumentTitle(normalized);
  if (updateUrl) {
    syncDashboardTabToUrl(normalized, { replace: replaceUrl });
  }
  if (normalized === "factor-validations") {
    loadEnabledProfileOptionsForFactorValidations()
      .then(() => loadFactorValidations())
      .catch(handleError);
  } else if (normalized === "profiles") {
    loadValidationProfilesAdmin().catch(handleError);
  } else if (normalized === "llm") {
    loadLlmAdmin().catch(handleError);
  } else if (normalized === "mlflow") {
    loadMlflowAdmin().catch(handleError);
  } else if (normalized === "settings") {
    loadSystemSettings().catch(handleError);
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

async function bootDashboard(initialTab = readDashboardTabFromUrl()) {
  switchTab(initialTab, { updateUrl: false });
  syncDashboardTabToUrl(initialTab, { replace: true });
  await Promise.all([loadStats(), loadIdeaSourceOptions(), loadIdeas(), loadOperators()]);
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    switchTab(button.dataset.tab);
  });
});

window.addEventListener("hashchange", () => {
  const tab = readDashboardTabFromUrl();
  if (tab !== state.tab) {
    switchTab(tab, { updateUrl: false });
  }
});

window.addEventListener("popstate", () => {
  const tab = readDashboardTabFromUrl();
  if (tab !== state.tab) {
    switchTab(tab, { updateUrl: false });
  }
});

document.getElementById("ideas-refresh").addEventListener("click", () => {
  state.ideas.offset = 0;
  Promise.all([loadStats(), loadIdeas()]).catch(handleError);
});

document.getElementById("ideas-apply").addEventListener("click", () => {
  state.ideas.source = els.ideasSource.value;
  state.ideas.title = String(els.ideasTitle?.value ?? "").trim();
  state.ideas.offset = 0;
  loadIdeas().catch(handleError);
});

els.ideasTitle?.addEventListener("sl-input", (event) => {
  if (event.detail?.source === "clear") {
    state.ideas.title = "";
    state.ideas.offset = 0;
    loadIdeas().catch(handleError);
  }
});

els.ideasTitle?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    state.ideas.source = els.ideasSource.value;
    state.ideas.title = String(els.ideasTitle?.value ?? "").trim();
    state.ideas.offset = 0;
    loadIdeas().catch(handleError);
  }
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

document.getElementById("factor-validations-apply")?.addEventListener("click", () => {
  readFactorValidationControlsToState();
  state.factorValidations.offset = 0;
  loadFactorValidations().catch(handleError);
});

els.factorValidationsTitle?.addEventListener("sl-input", (event) => {
  if (event.detail?.source === "clear") {
    readFactorValidationControlsToState();
    state.factorValidations.offset = 0;
    loadFactorValidations().catch(handleError);
  }
});

els.factorValidationsTitle?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    readFactorValidationControlsToState();
    state.factorValidations.offset = 0;
    loadFactorValidations().catch(handleError);
  }
});

document.getElementById("factor-validations-refresh")?.addEventListener("click", () => {
  readFactorValidationControlsToState();
  loadFactorValidations().catch(handleError);
});

document.getElementById("factor-validations-preset-rank-ic")?.addEventListener("click", () => {
  applyFactorValidationPreset({ sort: "mean_rank_ic" });
});

document.getElementById("factor-validations-preset-mean-ic")?.addEventListener("click", () => {
  applyFactorValidationPreset({ sort: "mean_ic" });
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

document.getElementById("mlflow-create")?.addEventListener("click", () => {
  openMlflowDialog("create");
});

document.getElementById("mlflow-refresh")?.addEventListener("click", () => {
  loadMlflowAdmin().catch(handleError);
});

document.getElementById("mlflow-backfill")?.addEventListener("click", async () => {
  if (!window.confirm("将把所有已成功且有 MLflow Run 的任务关联到当前启用的配置，并尝试补全 Run URL。继续？")) {
    return;
  }
  try {
    await backfillMlflowTasks();
  } catch (error) {
    handleError(error);
  }
});

els.mlflowForm?.addEventListener("submit", submitMlflowForm);

document.getElementById("mlflow-form-test")?.addEventListener("click", () => {
  testMlflowFormConnection().catch(handleError);
});

document.getElementById("mlflow-form-cancel")?.addEventListener("click", () => {
  els.mlflowDialog.close();
});

els.mlflowBody?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const key = button.getAttribute("data-key");
  const action = button.getAttribute("data-action");
  try {
    if (action === "edit-mlflow") {
      const config = state.mlflowConfigs.find((item) => item.key === key);
      if (config) openMlflowDialog("edit", config);
      return;
    }
    if (action === "toggle-mlflow") {
      const config = state.mlflowConfigs.find((item) => item.key === key);
      if (config) await toggleMlflowConfig(key, !config.enabled);
      return;
    }
    if (action === "delete-mlflow") {
      if (!window.confirm(`确定删除 MLflow 配置 ${key}？`)) return;
      await deleteMlflowConfig(key);
    }
  } catch (error) {
    handleError(error);
  }
});

document.querySelector("#panel-factor-validations thead")?.addEventListener("click", (event) => {
  const header = event.target.closest("th[data-sort]");
  if (!header) return;
  const sort = header.getAttribute("data-sort");
  if (state.factorValidations.sort === sort) {
    state.factorValidations.order = state.factorValidations.order === "desc" ? "asc" : "desc";
  } else {
    state.factorValidations.sort = sort;
    state.factorValidations.order = "desc";
  }
  state.factorValidations.offset = 0;
  syncFactorValidationControlsFromState();
  loadFactorValidations().catch(handleError);
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

  const icChartButton = event.target.closest("[data-action='view-ic-chart']");
  if (icChartButton) {
    event.stopPropagation();
    event.preventDefault();
    const factorValidationId = Number(icChartButton.getAttribute("data-factor-validation-id"));
    if (Number.isFinite(factorValidationId) && factorValidationId > 0) {
      showFactorValidationDetail(factorValidationId).catch(handleError);
    }
    return;
  }

  const densityChartButton = event.target.closest("[data-action='view-density-chart']");
  if (densityChartButton) {
    event.stopPropagation();
    event.preventDefault();
    const factorValidationId = Number(densityChartButton.getAttribute("data-factor-validation-id"));
    const kind = densityChartButton.getAttribute("data-density-kind");
    if (Number.isFinite(factorValidationId) && factorValidationId > 0 && kind) {
      showFactorValidationDensityChart(factorValidationId, kind).catch(handleError);
    }
    return;
  }

  if (event.target.closest("[data-action='open-mlflow']")) {
    event.stopPropagation();
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
    await bootDashboard();
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
    await bootDashboard();
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

els.densityDialog?.addEventListener("close", () => {
  if (state.icDensityChartDispose) {
    state.icDensityChartDispose();
    state.icDensityChartDispose = null;
  }
  if (els.densityChartHost) {
    els.densityChartHost.innerHTML = "";
  }
});

verifyAuthAndBoot();
