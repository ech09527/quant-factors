import translatePrompt from "../assets/translate-idea-to-sql.txt";
import factorSqlSchema from "../assets/factor-sql-schema.json";
import {
  chatCompletionWithFallback,
  LLM_USAGE_KEYS,
} from "./llm-providers.js";

const WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com/ech09527/quant-factors/main";

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("模型输出中未找到 JSON 对象");
  }
  return JSON.parse(match[0]);
}

function validateFactorSqlBasic(factorSql) {
  if (!factorSql || typeof factorSql !== "object" || Array.isArray(factorSql)) {
    throw new Error("factor_sql 必须是对象");
  }
  for (const key of ["version", "dialect", "evaluation_type", "data_source", "signal_sql", "postprocess"]) {
    if (!factorSql[key]) {
      throw new Error(`factor_sql 缺少字段: ${key}`);
    }
  }
  const signal = String(factorSql.signal_sql ?? "");
  if (!signal.trim()) {
    throw new Error("signal_sql 不能为空");
  }
  if (/\b(COPY|ATTACH|INSTALL|LOAD|EXPORT|READ_|CREATE|DROP|INSERT|UPDATE|DELETE|PRAGMA)\b/i.test(signal)) {
    throw new Error("signal_sql 含禁止关键字");
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": WORKFLOW_HTTP_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`fetch failed ${response.status}: ${url}`);
  }
  return response.text();
}

async function loadTranslationPromptAssets(env) {
  const useBundled = env.VALIDATION_USE_BUNDLED_PROMPTS?.trim().toLowerCase() !== "0";
  if (useBundled) {
    return { template: translatePrompt, schema: factorSqlSchema };
  }
  const base = (env.GITHUB_RAW_BASE ?? DEFAULT_RAW_BASE).replace(/\/$/, "");
  const [template, schemaText] = await Promise.all([
    fetchText(`${base}/scripts/prompts/translate-idea-to-sql.txt`),
    fetchText(`${base}/schemas/factor-sql-schema.json`),
  ]);
  return { template, schema: JSON.parse(schemaText) };
}

function buildTranslationPrompt(template, schema, idea, validationProfileKey, feedback = "") {
  const parts = [
    template,
    "",
    "## factor-sql-schema.json",
    JSON.stringify(schema, null, 2),
    "",
    "## 本次验证目标",
    JSON.stringify({ validation_profile_key: validationProfileKey }, null, 2),
    "",
    "## 因子想法",
    JSON.stringify(
      {
        title: idea.title,
        hypothesis: idea.hypothesis,
        formula_sketch: idea.formula_sketch,
        expected_signal: idea.expected_signal,
        evaluation_type_hint: idea.evaluation_type_hint,
        data_sources: idea.data_sources,
      },
      null,
      2,
    ),
  ];
  if (feedback) {
    parts.push("", "## 上次校验/执行失败（必须修正 signal_sql）", feedback);
  }
  return parts.join("\n");
}

async function callOpenAi(env, prompt) {
  return chatCompletionWithFallback(
    env.DB,
    env,
    LLM_USAGE_KEYS.VALIDATION_TRANSLATION,
    [
      { role: "system", content: "你是量化因子 SQL 翻译器，只输出合法 JSON 对象。" },
      { role: "user", content: prompt },
    ],
    { userAgent: WORKFLOW_HTTP_USER_AGENT },
  );
}

export async function translateIdeaToFactorSql(env, idea, validationProfileKey) {
  const maxAttempts = Number(env.TRANSLATION_MAX_ATTEMPTS ?? 3) || 3;
  const { template, schema } = await loadTranslationPromptAssets(env);
  let feedback = "";
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const raw = await callOpenAi(
        env,
        buildTranslationPrompt(template, schema, idea, validationProfileKey, feedback),
      );
      const factorSql = extractJsonObject(raw);
      validateFactorSqlBasic(factorSql);
      return factorSql;
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`多次翻译校验失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
