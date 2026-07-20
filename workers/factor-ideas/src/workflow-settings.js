export const VALIDATION_SCHEDULE_CRON = "*/1 * * * *";
export const IDEA_GENERATION_CRON = "*/5 * * * *";

const VALIDATION_BATCH_KEY = "validation_batch_enabled";
const FACTOR_VALIDATION_BATCH_KEY = "factor_validation_batch_enabled";
const NEUTRAL_VALIDATION_BATCH_KEY = "neutral_validation_batch_enabled";
const NEUTRAL_VALIDATION_MIN_ABS_MEAN_RANK_IC_KEY = "neutral_validation_min_abs_mean_rank_ic";
const NEUTRAL_VALIDATION_BATCH_LIMIT_KEY = "neutral_validation_batch_limit";
const NEUTRAL_VALIDATION_KEY_SETTING = "neutral_validation_key";
const KERNEL_CLEANUP_KEY = "kernel_cleanup_enabled";
const VALIDATION_BATCH_LIMIT_KEY = "validation_batch_limit";

export const SYSTEM_SETTING_DEFS = [
  {
    key: VALIDATION_BATCH_KEY,
    label: "验证调度",
    description: "（已停用 Cron）旧版 idea_validations 验证；仅可通过 POST /run-validation-batch 手动触发。",
    type: "boolean",
    envKey: "VALIDATION_BATCH_ENABLED",
    defaultBoolean: false,
    group: "workflow",
  },
  {
    key: FACTOR_VALIDATION_BATCH_KEY,
    label: "因子验证（MLflow）调度",
    description: "开启后 Cron 每 1 分钟自动提交 factor_validations + ml_tasks 任务到 Prefect，由 work pool 执行评估并写入 DagsHub MLflow。",
    type: "boolean",
    envKey: "FACTOR_VALIDATION_BATCH_ENABLED",
    defaultBoolean: false,
    group: "workflow",
  },
  {
    key: NEUTRAL_VALIDATION_BATCH_KEY,
    label: "因子中性化二次验证调度",
    description: "开启后由 Prefect 定时 deployment（neutral_validation/production）拉取优秀因子并完成中性化二次验证；Worker Cron 不再触发。",
    type: "boolean",
    envKey: "NEUTRAL_VALIDATION_BATCH_ENABLED",
    defaultBoolean: false,
    group: "workflow",
  },
  {
    key: NEUTRAL_VALIDATION_MIN_ABS_MEAN_RANK_IC_KEY,
    label: "二次验证 Rank IC 阈值",
    description: "一次验证 |mean_rank_ic| 不低于该值才进入中性化二次验证队列。",
    type: "number",
    envKey: "NEUTRAL_VALIDATION_MIN_ABS_MEAN_RANK_IC",
    defaultNumber: 0.01,
    min: 0.0001,
    max: 1,
    group: "workflow",
  },
  {
    key: NEUTRAL_VALIDATION_BATCH_LIMIT_KEY,
    label: "每批二次验证上限",
    description: "每次调度最多提交的中性化验证任务数。",
    type: "integer",
    envKey: "NEUTRAL_VALIDATION_BATCH_LIMIT",
    defaultInt: 10,
    min: 1,
    max: 30,
    group: "workflow",
  },
  {
    key: NEUTRAL_VALIDATION_KEY_SETTING,
    label: "中性化配置",
    description: "二次验证中性化模式：auto=AI 选 exposures；或命名别名 none/liq_mom/liquidity/short_term_return/liquidity_volatility。",
    type: "string",
    envKey: "NEUTRAL_VALIDATION_KEY",
    defaultString: "auto",
    group: "workflow",
  },
  {
    key: KERNEL_CLEANUP_KEY,
    label: "Kernel 清理",
    description: "开启后 Cron 每 1 分钟清理已完成验证的 Jupyter kernel，并执行孤儿 kernel 扫描。",
    type: "boolean",
    envKey: "KERNEL_CLEANUP_ENABLED",
    defaultBoolean: true,
    group: "workflow",
  },
  {
    key: VALIDATION_BATCH_LIMIT_KEY,
    label: "每批验证上限",
    description: "每次调度最多提交的验证任务数。",
    type: "integer",
    envKey: "VALIDATION_BATCH_LIMIT",
    defaultInt: 10,
    min: 1,
    max: 30,
    group: "workflow",
  },
];

const SETTING_DEF_BY_KEY = new Map(SYSTEM_SETTING_DEFS.map((def) => [def.key, def]));

function parseEnabledFlag(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "on" || text === "yes") {
    return true;
  }
  if (text === "0" || text === "false" || text === "off" || text === "no") {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function parsePositiveNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseStringSetting(value, fallback) {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

async function readWorkflowSettingRow(db, key) {
  return db.prepare(
    `SELECT value, updated_at
       FROM workflow_settings
       WHERE key = ?
       LIMIT 1`
  ).bind(key).first();
}

function readEnvFallback(env, def) {
  const raw = env?.[def.envKey];
  if (def.type === "boolean") {
    return parseEnabledFlag(raw, def.defaultBoolean);
  }
  if (def.type === "number") {
    return parsePositiveNumber(raw, def.defaultNumber, def.min, def.max);
  }
  if (def.type === "string") {
    return parseStringSetting(raw, def.defaultString);
  }
  return parsePositiveInt(raw, def.defaultInt, def.min, def.max);
}

async function readWorkflowSettingValue(db, env, def) {
  const row = await readWorkflowSettingRow(db, def.key);
  if (row?.value != null && row.value !== "") {
    if (def.type === "boolean") {
      return parseEnabledFlag(row.value, def.defaultBoolean);
    }
    if (def.type === "number") {
      return parsePositiveNumber(row.value, def.defaultNumber, def.min, def.max);
    }
    if (def.type === "string") {
      return parseStringSetting(row.value, def.defaultString);
    }
    return parsePositiveInt(row.value, def.defaultInt, def.min, def.max);
  }
  return readEnvFallback(env, def);
}

async function writeWorkflowSettingValue(db, def, value) {
  let stored;
  if (def.type === "boolean") {
    stored = value ? "1" : "0";
  } else if (def.type === "string") {
    stored = String(value ?? def.defaultString).trim() || def.defaultString;
  } else {
    stored = String(value);
  }
  await db.prepare(
    `INSERT INTO workflow_settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
  ).bind(def.key, stored).run();
}

function serializeSettingItem(def, value, row) {
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    type: def.type,
    group: def.group,
    value,
    ...(def.type === "integer" || def.type === "number" ? { min: def.min, max: def.max } : {}),
    updated_at: row?.updated_at ?? null,
    source: row ? "database" : "default",
  };
}

export async function getSystemSettings(db, env) {
  const items = [];
  for (const def of SYSTEM_SETTING_DEFS) {
    const row = await readWorkflowSettingRow(db, def.key);
    const value = row?.value != null && row.value !== ""
      ? (def.type === "boolean"
        ? parseEnabledFlag(row.value, def.defaultBoolean)
        : def.type === "number"
          ? parsePositiveNumber(row.value, def.defaultNumber, def.min, def.max)
          : def.type === "string"
            ? parseStringSetting(row.value, def.defaultString)
            : parsePositiveInt(row.value, def.defaultInt, def.min, def.max))
      : readEnvFallback(env, def);
    items.push(serializeSettingItem(def, value, row));
  }
  return {
    items,
    schedules: [
      {
        key: "validation_batch",
        label: "验证调度 / Prefect 执行",
        cron: VALIDATION_SCHEDULE_CRON,
        cron_label: "每 1 分钟",
      },
      {
        key: "idea_generation",
        label: "因子想法生成",
        cron: IDEA_GENERATION_CRON,
        cron_label: "每 5 分钟",
      },
    ],
  };
}

export async function patchSystemSettings(db, env, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch body must be an object");
  }
  const updated = [];
  for (const [key, rawValue] of Object.entries(patch)) {
    const def = SETTING_DEF_BY_KEY.get(key);
    if (!def) {
      throw new Error(`unknown setting: ${key}`);
    }
    let value;
    if (def.type === "boolean") {
      if (typeof rawValue !== "boolean") {
        throw new Error(`${key} must be boolean`);
      }
      value = rawValue;
    } else if (def.type === "number") {
      value = parsePositiveNumber(rawValue, NaN, def.min, def.max);
      if (!Number.isFinite(value)) {
        throw new Error(`${key} must be number between ${def.min} and ${def.max}`);
      }
    } else if (def.type === "string") {
      value = parseStringSetting(rawValue, "");
      if (!value) {
        throw new Error(`${key} must be non-empty string`);
      }
    } else {
      value = parsePositiveInt(rawValue, NaN, def.min, def.max);
      if (!Number.isFinite(value)) {
        throw new Error(`${key} must be integer between ${def.min} and ${def.max}`);
      }
    }
    await writeWorkflowSettingValue(db, def, value);
    const row = await readWorkflowSettingRow(db, def.key);
    updated.push(serializeSettingItem(def, value, row));
  }
  return { updated };
}

export async function getValidationBatchEnabled(db, env) {
  const def = SETTING_DEF_BY_KEY.get(VALIDATION_BATCH_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getKernelCleanupEnabled(db, env) {
  const def = SETTING_DEF_BY_KEY.get(KERNEL_CLEANUP_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getValidationBatchLimit(db, env) {
  const def = SETTING_DEF_BY_KEY.get(VALIDATION_BATCH_LIMIT_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function setValidationBatchEnabled(db, enabled) {
  const def = SETTING_DEF_BY_KEY.get(VALIDATION_BATCH_KEY);
  await writeWorkflowSettingValue(db, def, Boolean(enabled));
  return { enabled: Boolean(enabled) };
}

export async function getValidationScheduleSettings(db, env) {
  const enabled = await getValidationBatchEnabled(db, env);
  return {
    enabled,
    cron: VALIDATION_SCHEDULE_CRON,
    cron_label: "每 1 分钟",
  };
}

export async function getFactorValidationBatchEnabled(db, env) {
  const def = SETTING_DEF_BY_KEY.get(FACTOR_VALIDATION_BATCH_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getNeutralValidationBatchEnabled(db, env) {
  const def = SETTING_DEF_BY_KEY.get(NEUTRAL_VALIDATION_BATCH_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getNeutralValidationMinAbsMeanRankIc(db, env) {
  const def = SETTING_DEF_BY_KEY.get(NEUTRAL_VALIDATION_MIN_ABS_MEAN_RANK_IC_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getNeutralValidationBatchLimit(db, env) {
  const def = SETTING_DEF_BY_KEY.get(NEUTRAL_VALIDATION_BATCH_LIMIT_KEY);
  return readWorkflowSettingValue(db, env, def);
}

export async function getNeutralValidationKey(db, env) {
  const def = SETTING_DEF_BY_KEY.get(NEUTRAL_VALIDATION_KEY_SETTING);
  return readWorkflowSettingValue(db, env, def);
}

export async function isValidationBatchEnabled(db, env) {
  return getValidationBatchEnabled(db, env);
}
