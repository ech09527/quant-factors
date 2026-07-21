import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  LLM_USAGE_KEYS,
  resolveLlmUsageRouteConfigs,
  withLlmFallback,
  markLlmProviderUsed,
  markLlmModelUsed,
} from "./llm-providers.js";
import { createFactorResearchTools } from "./factor-research-tools.js";

const SYSTEM_PROMPT = `你是量化因子研究助手，只读查询 D1 中的因子想法与验证结果。

规则：
1. 只用提供的 tools 查数；不要编造指标或 idea_id。
2. 不确定表/字段/指标语义时，先调用 describe_data_model（通常只需一次）。
3. Rank IC / IC / IR 类筛选优先用 query_factor_validations（metric=mean_rank_ic 等），不要轻易写 SQL。
4. 对比一次验证与中性化二次验证优先 get_idea_bundle；neutralization_key=none 表示一次验证。
5. 仅在结构化 tools 不够时用 run_readonly_sql；禁止写操作与敏感表。
6. **每次回答必须以中文 Markdown 写出最终结论**（表格/列表），不能只调用工具就结束。
7. 若工具已返回足够数据，立即总结，勿重复同类查询。
8. 不要触发验证、不要建议修改数据库。`;

const MAX_MESSAGES = 20;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_AGENT_STEPS = 20;

function createProvider(config) {
  const header = String(config.auth_header || "Authorization").trim() || "Authorization";
  const scheme = String(config.auth_scheme || "Bearer").trim() || "Bearer";
  const useDefaultAuth = header === "Authorization" && /^bearer$/i.test(scheme);
  return createOpenAI({
    baseURL: config.base_url,
    apiKey: config.api_key,
    name: config.provider_key || "openai-compatible",
    headers: useDefaultAuth
      ? undefined
      : {
          [header]: `${scheme} ${config.api_key}`,
        },
  });
}

function isUiMessage(message) {
  return message != null && typeof message === "object" && Array.isArray(message.parts);
}

function normalizePlainMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  const cleaned = [];
  for (const item of rawMessages) {
    const role = String(item?.role ?? "").trim();
    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    cleaned.push({ role, content });
  }
  return cleaned.slice(-MAX_MESSAGES);
}

async function resolveModelMessages(rawMessages, tools) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return [];
  }
  const sliced = rawMessages.slice(-MAX_MESSAGES);
  if (sliced.some(isUiMessage)) {
    return convertToModelMessages(sliced, {
      tools,
      ignoreIncompleteToolCalls: true,
    });
  }
  return normalizePlainMessages(sliced);
}

function summarizeToolOutput(output) {
  if (output == null) {
    return null;
  }
  if (typeof output === "string") {
    return output.slice(0, 240);
  }
  try {
    const json = JSON.stringify(output);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return String(output).slice(0, 240);
  }
}

function buildToolTrace(steps) {
  const trace = [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      const result = (step.toolResults ?? []).find(
        (item) => item.toolCallId === call.toolCallId,
      );
      trace.push({
        tool: call.toolName,
        input: call.input ?? call.args ?? null,
        summary: summarizeToolOutput(result?.output ?? result?.result ?? null),
      });
    }
  }
  return trace;
}

function agentErrorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const isTimeout =
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /aborted|timeout/i.test(message);
  const status =
    Number(error?.status) ||
    (isTimeout ? 504 : /未配置 LLM|无效的 usage_key/i.test(message) ? 503 : 500);
  return Response.json(
    {
      ok: false,
      error: isTimeout ? "研究助手请求超时，请缩小问题范围后重试" : message,
    },
    { status },
  );
}

/**
 * @param {{ DB: D1Database }} env
 * @param {{ messages?: unknown[] }} body
 */
export async function runFactorResearchAgent(env, body = {}) {
  const tools = createFactorResearchTools(env);
  const messages = await resolveModelMessages(body.messages, tools);
  if (messages.length === 0) {
    const error = new Error("messages 不能为空");
    error.status = 400;
    throw error;
  }

  const abortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const { result, config } = await withLlmFallback(
    env.DB,
    env,
    LLM_USAGE_KEYS.FACTOR_RESEARCH_AGENT,
    async (llmConfig) => {
      const openai = createProvider(llmConfig);
      return generateText({
        model: openai.chat(llmConfig.model),
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        temperature: llmConfig.temperature ?? 0.2,
        abortSignal,
        maxRetries: 1,
      });
    },
  );

  return {
    ok: true,
    reply: String(result.text ?? "").trim(),
    tool_trace: buildToolTrace(result.steps),
    steps: Array.isArray(result.steps) ? result.steps.length : 0,
    provider_key: config.provider_key,
    model: config.model,
  };
}

/**
 * 流式：优先第一条可用路由（流式中途换路由成本高）。
 * @param {{ DB: D1Database }} env
 * @param {{ messages?: unknown[] }} body
 */
export async function streamFactorResearchAgent(env, body = {}) {
  const tools = createFactorResearchTools(env);
  const messages = await resolveModelMessages(body.messages, tools);
  if (messages.length === 0) {
    const error = new Error("messages 不能为空");
    error.status = 400;
    throw error;
  }

  const configs = await resolveLlmUsageRouteConfigs(
    env.DB,
    env,
    LLM_USAGE_KEYS.FACTOR_RESEARCH_AGENT,
  );
  const llmConfig = configs[0];
  const openai = createProvider(llmConfig);
  const abortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  const result = streamText({
    model: openai.chat(llmConfig.model),
    system: SYSTEM_PROMPT,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    temperature: llmConfig.temperature ?? 0.2,
    abortSignal,
    maxRetries: 1,
    onFinish: async () => {
      if (llmConfig.provider_key) {
        await markLlmProviderUsed(env.DB, llmConfig.provider_key);
        await markLlmModelUsed(env.DB, llmConfig.provider_key, llmConfig.model);
      }
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: Array.isArray(body.messages) ? body.messages : undefined,
      onError: (error) =>
        error instanceof Error ? error.message : "研究助手流式请求失败",
    }),
    headers: {
      "X-QF-Provider": String(llmConfig.provider_key ?? ""),
      "X-QF-Model": String(llmConfig.model ?? ""),
    },
  });
}

/**
 * @param {Request} request
 * @param {{ DB: D1Database }} env
 */
export async function handleFactorResearchChatRequest(request, env) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format")?.trim().toLowerCase();
  const wantJson = format === "json";

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }

  // 默认 UI message stream（@ai-sdk/react useChat）
  // 兼容：?format=json 返回整段 JSON
  if (wantJson) {
    try {
      const payload = await runFactorResearchAgent(env, body);
      return Response.json(payload);
    } catch (error) {
      return agentErrorResponse(error);
    }
  }

  try {
    return await streamFactorResearchAgent(env, body);
  } catch (error) {
    return agentErrorResponse(error);
  }
}
