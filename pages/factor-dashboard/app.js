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
  validationProfiles: [],
  profileFormMode: "create",
  editingProfileKey: null,
  jupyterServers: [],
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
  validationsHint: document.getElementById("validations-hint"),
  validationsSort: document.getElementById("validations-sort"),
  validationsOrder: document.getElementById("validations-order"),
  validationsAbs: document.getElementById("validations-abs"),
  validationsLimit: document.getElementById("validations-limit"),
  validationsStatus: document.getElementById("validations-status"),
  validationsProfile: document.getElementById("validations-profile"),
  validationsSource: document.getElementById("validations-source"),
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
    els.jupyterBody.innerHTML = `<tr><td colspan="7" class="muted">暂无 Jupyter Server 配置。</td></tr>`;
    return;
  }
  els.jupyterBody.innerHTML = items
    .map(
      (server) => `
      <tr data-jupyter-key="${server.key}">
        <td><code>${server.key}</code></td>
        <td>${server.name}</td>
        <td title="${server.base_url}"><code>${truncateUrl(server.base_url)}</code></td>
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
  document.getElementById("panel-profiles").classList.toggle("hidden", tab !== "profiles");
  document.getElementById("panel-jupyter").classList.toggle("hidden", tab !== "jupyter");
  document.getElementById("panel-llm").classList.toggle("hidden", tab !== "llm");
  document.getElementById("panel-operators").classList.toggle("hidden", tab !== "operators");
  els.appLayout.classList.toggle(
    "layout-wide",
    tab === "validations" || tab === "profiles" || tab === "jupyter" || tab === "llm",
  );
  if (tab === "validations") {
    loadIdeaSourceOptions()
      .then(() => loadEnabledProfileOptions())
      .then(() => loadValidationResults())
      .catch(handleError);
  } else if (tab === "profiles") {
    loadValidationProfilesAdmin().catch(handleError);
  } else if (tab === "jupyter") {
    loadJupyterServersAdmin().catch(handleError);
  } else if (tab === "llm") {
    loadLlmAdmin().catch(handleError);
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
  loadJupyterServersAdmin().catch(handleError);
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

verifyAuthAndBoot();
