import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";

export function getMessageText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function listToolParts(message: UIMessage) {
  if (!Array.isArray(message.parts)) {
    return [];
  }
  return message.parts.filter((part) => isToolUIPart(part));
}

function formatNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value == null ? "-" : String(value);
  }
  if (Math.abs(n) >= 1) {
    return n.toFixed(4);
  }
  return n.toFixed(6);
}

function rowsToMarkdownTable(rows: Record<string, unknown>[]): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "_无数据_";
  }
  const preferred = [
    "idea_id",
    "id",
    "title",
    "idea_title",
    "profile_key",
    "neutralization_key",
    "status",
    "mean_rank_ic",
    "mean_ic",
    "rank_ic_ir",
    "ic_ir",
    "neut_mean_rank_ic",
    "orig_mean_rank_ic",
  ];
  const keys = Object.keys(rows[0] ?? {});
  const cols = [
    ...preferred.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !preferred.includes(key)),
  ].slice(0, 8);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.slice(0, 20).map((row) => {
    const cells = cols.map((col) => {
      const value = row[col];
      if (typeof value === "number") {
        return formatNumber(value);
      }
      if (value && typeof value === "object") {
        return "`obj`";
      }
      const text = value == null ? "-" : String(value).replace(/\|/g, "/");
      return text.length > 40 ? `${text.slice(0, 37)}…` : text;
    });
    return `| ${cells.join(" | ")} |`;
  });
  return [header, sep, ...body].join("\n");
}

function summarizeToolOutput(output: unknown): string {
  if (output == null) {
    return "_无输出_";
  }
  if (typeof output === "string") {
    return output.slice(0, 500);
  }
  if (typeof output !== "object") {
    return String(output);
  }
  const obj = output as Record<string, unknown>;
  if (obj.ok === false && obj.error) {
    return `**错误**：${String(obj.error)}`;
  }
  if (Array.isArray(obj.items)) {
    const rows = obj.items.map((item) => {
      if (!item || typeof item !== "object") {
        return {};
      }
      const row = item as Record<string, unknown>;
      const metrics =
        row.metrics && typeof row.metrics === "object"
          ? (row.metrics as Record<string, unknown>)
          : {};
      return {
        idea_id: row.idea_id,
        title: row.idea_title ?? row.title,
        profile_key: row.profile_key,
        neutralization_key: row.neutralization_key,
        status: row.status,
        mean_rank_ic: metrics.mean_rank_ic,
        mean_ic: metrics.mean_ic,
        rank_ic_ir: metrics.rank_ic_ir,
        ic_ir: metrics.ic_ir,
      };
    });
    const total = obj.total != null ? `共 ${String(obj.total)} 条，展示前 ${rows.length} 条：\n\n` : "";
    return `${total}${rowsToMarkdownTable(rows)}`;
  }
  if (Array.isArray(obj.rows)) {
    return rowsToMarkdownTable(obj.rows as Record<string, unknown>[]);
  }
  if (obj.document) {
    return "_已读取数据模型说明_";
  }
  if (obj.idea && obj.validations) {
    return `想法 **${String((obj.idea as { id?: unknown }).id ?? "")}** 的验证包已取回。`;
  }
  try {
    const json = JSON.stringify(obj);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return "_无法展示工具输出_";
  }
}

/** 当模型未输出最终文本时，用工具结果拼一份可读 Markdown */
export function fallbackMarkdownFromTools(message: UIMessage): string {
  const tools = listToolParts(message);
  if (tools.length === 0) {
    return "";
  }
  const sections: string[] = ["（模型未返回最终总结，以下为工具结果摘要）"];
  for (const part of tools) {
    if (!isToolUIPart(part)) {
      continue;
    }
    const name = getToolName(part);
    const state = "state" in part ? String(part.state) : "";
    if (state === "output-available" && "output" in part) {
      sections.push(`### ${name}\n\n${summarizeToolOutput(part.output)}`);
    } else if (state === "output-error" && "errorText" in part) {
      sections.push(`### ${name}\n\n**错误**：${String(part.errorText)}`);
    } else if (state.includes("input") || state === "approval-requested") {
      sections.push(`### ${name}\n\n_执行中…_`);
    }
  }
  return sections.join("\n\n");
}

export function shortenErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "未知错误");
  if (/^data:\s*\{/m.test(raw) || raw.includes("text/event-stream")) {
    return "流式响应解析失败，请重试。若持续出现，请刷新页面。";
  }
  if (raw.length > 280) {
    return `${raw.slice(0, 280)}…`;
  }
  return raw;
}
