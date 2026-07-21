import { tool } from "ai";
import { z } from "zod";
import dataModelDoc from "../assets/factor-research-data-model.txt";
import { listFactorValidations } from "./factor-validation-db.js";
import {
  listAllowedResearchTables,
  validateReadonlySelectSql,
} from "./factor-research-sql-guard.js";

const MAX_RESULT_CHARS = 30_000;
const MAX_ROWS = 50;

const METRIC_ENUM = [
  "mean_ic",
  "mean_rank_ic",
  "ic_ir",
  "rank_ic_ir",
];

const FILTER_OPS = [
  "gt",
  "gte",
  "lt",
  "lte",
  "abs_gt",
  "abs_gte",
  "abs_lt",
  "abs_lte",
];

function truncatePayload(value) {
  const json = JSON.stringify(value);
  if (json.length <= MAX_RESULT_CHARS) {
    return value;
  }
  return {
    truncated: true,
    preview: json.slice(0, MAX_RESULT_CHARS),
    original_chars: json.length,
  };
}

function compactValidationItem(item) {
  const metrics = item?.metrics && typeof item.metrics === "object" ? item.metrics : null;
  return {
    id: item.id,
    idea_id: item.idea_id,
    idea_title: item.idea_title,
    profile_key: item.profile_key,
    neutralization_key: item.neutralization_key,
    status: item.status,
    metrics: metrics
      ? {
          mean_ic: metrics.mean_ic ?? null,
          mean_rank_ic: metrics.mean_rank_ic ?? null,
          ic_ir: metrics.ic_ir ?? null,
          rank_ic_ir: metrics.rank_ic_ir ?? null,
          n_periods: metrics.n_periods ?? null,
          ic_positive_ratio: metrics.ic_positive_ratio ?? null,
        }
      : null,
    evaluated_at: item.evaluated_at,
    error_reason: item.error_reason,
  };
}

function compactIdeaRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    title: String(row.title ?? ""),
    source: row.source == null ? null : String(row.source),
    hypothesis: row.hypothesis == null ? null : String(row.hypothesis),
    formula_sketch: row.formula_sketch == null ? null : String(row.formula_sketch),
    factor_expr: row.factor_expr == null ? null : String(row.factor_expr),
    expected_signal: row.expected_signal == null ? null : String(row.expected_signal),
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

/**
 * @param {{ DB: D1Database }} env
 */
export function createFactorResearchTools(env) {
  const db = env.DB;
  const allowedTables = listAllowedResearchTables();

  return {
    describe_data_model: tool({
      description:
        "返回受控数据模型说明（ideas / factor_validations / ml_tasks 字段与指标语义）。查数前若不确定字段请先调用。",
      inputSchema: z.object({}),
      execute: async () => truncatePayload({ document: String(dataModelDoc) }),
    }),

    describe_table: tool({
      description: `返回白名单表的列信息（PRAGMA table_info）。允许的表：${allowedTables.join(", ")}`,
      inputSchema: z.object({
        table: z.enum([
          "ideas",
          "factor_validations",
          "ml_tasks",
          "validation_profiles",
        ]),
      }),
      execute: async ({ table }) => {
        const name = String(table).toLowerCase();
        if (!allowedTables.includes(name)) {
          return { ok: false, error: `表不在白名单: ${name}` };
        }
        const result = await db.prepare(`PRAGMA table_info(${name})`).all();
        return truncatePayload({
          table: name,
          columns: result.results ?? [],
        });
      },
    }),

    search_ideas: tool({
      description: "按标题子串或 idea_id 搜索因子想法。",
      inputSchema: z.object({
        title: z.string().optional().describe("标题子串（不区分大小写）"),
        idea_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ title, idea_id, limit }) => {
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
        const clauses = [];
        const binds = [];
        if (idea_id != null && Number.isFinite(Number(idea_id))) {
          clauses.push("id = ?");
          binds.push(Number(idea_id));
        }
        const titleQuery = title != null && String(title).trim() ? String(title).trim() : null;
        if (titleQuery) {
          clauses.push("instr(lower(title), lower(?)) > 0");
          binds.push(titleQuery);
        }
        if (clauses.length === 0) {
          return { ok: false, error: "请提供 title 或 idea_id" };
        }
        const where = `WHERE ${clauses.join(" AND ")}`;
        const result = await db
          .prepare(
            `SELECT id, title, source, hypothesis, formula_sketch, factor_expr,
                    expected_signal, created_at, updated_at
               FROM ideas
               ${where}
               ORDER BY id DESC
               LIMIT ?`,
          )
          .bind(...binds, safeLimit)
          .all();
        return truncatePayload({
          items: (result.results ?? []).map(compactIdeaRow),
          limit: safeLimit,
        });
      },
    }),

    query_factor_validations: tool({
      description:
        "筛选因子验证结果。支持 status、neutralization_key、标题、指标阈值（metric/op/value）、排序。优先用本工具回答 Rank IC / IC 类问题。",
      inputSchema: z.object({
        status: z.string().optional().describe("如 success / failed / running"),
        neutralization_key: z
          .string()
          .optional()
          .describe("none=一次验证；其它为中性化 key"),
        title: z.string().optional().describe("想法标题子串"),
        idea_id: z.number().int().positive().optional(),
        profile_keys: z.array(z.string()).optional(),
        metric: z.enum(METRIC_ENUM).optional(),
        op: z.enum(FILTER_OPS).optional(),
        value: z.number().optional(),
        sort: z.enum([...METRIC_ENUM, "evaluated_at", "updated_at"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        abs: z.boolean().optional().describe("排序是否按绝对值，默认 true"),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (input) => {
        const safeLimit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
        const metricFilter =
          input.metric && input.op && Number.isFinite(Number(input.value))
            ? {
                metric: input.metric,
                op: input.op,
                value: Number(input.value),
              }
            : null;
        const data = await listFactorValidations(db, {
          ideaId: input.idea_id ?? null,
          status: input.status ?? null,
          profileKeys: input.profile_keys ?? null,
          neutralizationKey: input.neutralization_key ?? null,
          title: input.title ?? null,
          sort: input.sort ?? "mean_rank_ic",
          order: input.order ?? "desc",
          abs: input.abs !== false,
          limit: safeLimit,
          offset: 0,
          metricFilter,
        });
        return truncatePayload({
          total: data.total,
          limit: data.limit,
          sort: data.sort,
          order: data.order,
          abs: data.abs,
          metric_filter: metricFilter,
          items: (data.items ?? []).map(compactValidationItem),
        });
      },
    }),

    get_idea_bundle: tool({
      description:
        "获取单个想法详情及其验证记录（含一次验证与中性化二次验证），用于对比。",
      inputSchema: z.object({
        idea_id: z.number().int().positive(),
      }),
      execute: async ({ idea_id }) => {
        const ideaRow = await db
          .prepare(
            `SELECT id, title, source, hypothesis, formula_sketch, factor_expr,
                    expected_signal, created_at, updated_at
               FROM ideas WHERE id = ? LIMIT 1`,
          )
          .bind(Number(idea_id))
          .first();
        if (!ideaRow) {
          return { ok: false, error: `idea ${idea_id} 不存在` };
        }
        const validations = await listFactorValidations(db, {
          ideaId: Number(idea_id),
          limit: 100,
          offset: 0,
          abs: true,
          sort: "mean_rank_ic",
          order: "desc",
        });
        return truncatePayload({
          idea: compactIdeaRow(ideaRow),
          validations: {
            total: validations.total,
            items: (validations.items ?? []).map(compactValidationItem),
          },
        });
      },
    }),

    run_readonly_sql: tool({
      description:
        "执行只读 SELECT（表白名单、强制 LIMIT≤100）。仅当结构化 tools 不够用时使用。禁止写操作与敏感表。",
      inputSchema: z.object({
        sql: z.string().describe("SELECT 或 WITH … SELECT"),
      }),
      execute: async ({ sql }) => {
        const checked = validateReadonlySelectSql(sql, { maxLimit: 100 });
        if (!checked.ok) {
          return { ok: false, error: checked.error };
        }
        try {
          const result = await db.prepare(checked.sql).all();
          const rows = result.results ?? [];
          return truncatePayload({
            ok: true,
            sql: checked.sql,
            row_count: rows.length,
            rows: rows.slice(0, MAX_ROWS),
          });
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            sql: checked.sql,
          };
        }
      },
    }),
  };
}
