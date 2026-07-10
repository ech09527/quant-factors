export const VALIDATION_SCHEDULE_CRON = "*/2 * * * *";
export const IDEA_GENERATION_CRON = "*/5 * * * *";

const VALIDATION_BATCH_KEY = "validation_batch_enabled";
const KERNEL_CLEANUP_KEY = "kernel_cleanup_enabled";
const VALIDATION_BATCH_LIMIT_KEY = "validation_batch_limit";

export const SYSTEM_SETTING_DEFS = [
  {
    key: VALIDATION_BATCH_KEY,
    label: "验证调度",
    description: "开启后 Cron 每 2 分钟自动提交待验证任务；关闭时仅执行 kernel 清理。",
    type: "boolean",
    envKey: "VALIDATION_BATCH_ENABLED",
    defaultBoolean: false,
    group: "workflow",
  },
  {
    key: KERNEL_CLEANUP_KEY,
    label: "Kernel 清理",
    description: "开启后 Cron 每 2 分钟清理已完成验证的 Jupyter kernel，并执行孤儿 kernel 扫描。",
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
  return parsePositiveInt(raw, def.defaultInt, def.min, def.max);
}

async function readWorkflowSettingValue(db, env, def) {
  const row = await readWorkflowSettingRow(db, def.key);
  if (row?.value != null && row.value !== "") {
    if (def.type === "boolean") {
      return parseEnabledFlag(row.value, def.defaultBoolean);
    }
    return parsePositiveInt(row.value, def.defaultInt, def.min, def.max);
  }
  return readEnvFallback(env, def);
}

async function writeWorkflowSettingValue(db, def, value) {
  const stored = def.type === "boolean" ? (value ? "1" : "0") : String(value);
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
    ...(def.type === "integer" ? { min: def.min, max: def.max } : {}),
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
        : parsePositiveInt(row.value, def.defaultInt, def.min, def.max))
      : readEnvFallback(env, def);
    items.push(serializeSettingItem(def, value, row));
  }
  return {
    items,
    schedules: [
      {
        key: "validation_batch",
        label: "验证调度 / Kernel 清理",
        cron: VALIDATION_SCHEDULE_CRON,
        cron_label: "每 2 分钟",
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
    cron_label: "每 2 分钟",
  };
}

export async function isValidationBatchEnabled(db, env) {
  return getValidationBatchEnabled(db, env);
}
