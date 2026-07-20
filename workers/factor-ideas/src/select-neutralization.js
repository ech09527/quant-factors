import selectNeutralizationPrompt from "../assets/select-neutralization-exposures.txt";
import neutralizationSpecSchema from "../assets/neutralization-spec-schema.json";
import {
  chatCompletionWithFallback,
  LLM_USAGE_KEYS,
} from "./llm-providers.js";

const ALLOWED_FIELDS = new Set(neutralizationSpecSchema.properties.exposures.items.properties.field.enum);
const ALLOWED_TRANSFORMS = new Set(
  neutralizationSpecSchema.properties.exposures.items.properties.transform.enum
);
const MAX_EXPOSURES = neutralizationSpecSchema.properties.exposures.maxItems ?? 4;

export const DEFAULT_NEUTRALIZATION_SPEC = {
  version: "1",
  method: "sequential_ols",
  exposures: [
    { field: "quote_volume", transform: "ln" },
    { field: "ret_24h", transform: "identity" },
  ],
};

export const NAMED_NEUTRALIZATION_SPECS = {
  none: { version: "1", method: "sequential_ols", exposures: [] },
  liq_mom: DEFAULT_NEUTRALIZATION_SPEC,
  liquidity: {
    version: "1",
    method: "sequential_ols",
    exposures: [{ field: "quote_volume", transform: "ln" }],
  },
  short_term_return: {
    version: "1",
    method: "sequential_ols",
    exposures: [{ field: "log_ret_1", transform: "identity" }],
  },
  liquidity_volatility: {
    version: "1",
    method: "sequential_ols",
    exposures: [
      { field: "quote_volume", transform: "ln" },
      { field: "vol_24h", transform: "identity" },
    ],
  },
  auto: DEFAULT_NEUTRALIZATION_SPEC,
};

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("模型输出中未找到 JSON 对象");
  }
  return JSON.parse(match[0]);
}

export function normalizeNeutralizationSpec(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("neutralization_spec 必须是对象");
  }
  const version = String(raw.version ?? "1").trim() || "1";
  if (version !== "1") {
    throw new Error(`不支持的 neutralization_spec.version: ${version}`);
  }
  const method = String(raw.method ?? "sequential_ols").trim() || "sequential_ols";
  if (method !== "sequential_ols") {
    throw new Error(`不支持的 neutralization_spec.method: ${method}`);
  }
  const exposuresRaw = Array.isArray(raw.exposures) ? raw.exposures : [];
  if (exposuresRaw.length > MAX_EXPOSURES) {
    throw new Error(`exposures 最多 ${MAX_EXPOSURES} 项`);
  }
  const exposures = [];
  const seen = new Set();
  for (const item of exposuresRaw) {
    if (!item || typeof item !== "object") {
      throw new Error("exposure 必须是对象");
    }
    const field = String(item.field ?? "").trim();
    const transform = String(item.transform ?? "identity").trim().toLowerCase();
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`非法 exposure.field: ${field}`);
    }
    if (!ALLOWED_TRANSFORMS.has(transform)) {
      throw new Error(`非法 exposure.transform: ${transform}`);
    }
    const key = `${field}:${transform}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    exposures.push({ field, transform });
  }
  return { version: "1", method: "sequential_ols", exposures };
}

export function resolveNamedNeutralizationSpec(key) {
  const normalized = String(key ?? "none").trim() || "none";
  const named = NAMED_NEUTRALIZATION_SPECS[normalized];
  if (!named) {
    throw new Error(`未知 neutralization_key: ${normalized}`);
  }
  return normalizeNeutralizationSpec(named);
}

export function exposureLabel(exp) {
  return exp.transform === "identity" ? exp.field : `${exp.transform}(${exp.field})`;
}

function buildSelectionPrompt(job) {
  return [
    selectNeutralizationPrompt,
    "",
    "## neutralization-spec-schema.json",
    JSON.stringify(neutralizationSpecSchema, null, 2),
    "",
    "## 因子想法",
    JSON.stringify(
      {
        title: job.title,
        hypothesis: job.hypothesis,
        formula_sketch: job.formula_sketch,
        expected_signal: job.expected_signal,
        signal_sql: job.factor_sql?.signal_sql ?? null,
        postprocess: job.factor_sql?.postprocess ?? null,
        profile_key: job.profile_key,
      },
      null,
      2
    ),
  ].join("\n");
}

/**
 * 解析二次验证中性化规格：
 * - preferredKey=auto → 调 AI 选型，失败则默认 liq_mom exposures
 * - 其他命名 key → 固定别名
 * - 已有 neutralization_spec → 直接校验使用
 */
export async function resolveNeutralizationForJob(env, job, preferredKey = "auto") {
  if (job.neutralization_spec && typeof job.neutralization_spec === "object") {
    const spec = normalizeNeutralizationSpec(job.neutralization_spec);
    return {
      neutralization_key: String(job.neutralization_key ?? preferredKey).trim() || preferredKey,
      neutralization_spec: spec,
      source: "job",
      reason: null,
    };
  }

  const key = String(preferredKey ?? "auto").trim() || "auto";
  if (key !== "auto") {
    const spec = resolveNamedNeutralizationSpec(key);
    return {
      neutralization_key: key,
      neutralization_spec: spec,
      source: "named",
      reason: null,
    };
  }

  try {
    const prompt = buildSelectionPrompt(job);
    const content = await chatCompletionWithFallback(
      env.DB,
      env,
      LLM_USAGE_KEYS.NEUTRALIZATION_SELECTION,
      [
        {
          role: "system",
          content: "你是量化研究员助手，只输出合法 JSON 对象（neutralization_spec）。",
        },
        { role: "user", content: prompt },
      ]
    );
    const parsed = extractJsonObject(content);
    const spec = normalizeNeutralizationSpec(parsed);
    return {
      neutralization_key: "auto",
      neutralization_spec: spec,
      source: "ai",
      reason: parsed.reason == null ? null : String(parsed.reason),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      neutralization_key: "auto",
      neutralization_spec: normalizeNeutralizationSpec(DEFAULT_NEUTRALIZATION_SPEC),
      source: "default",
      reason: `AI 选型失败，回退默认 exposures: ${message}`,
    };
  }
}
