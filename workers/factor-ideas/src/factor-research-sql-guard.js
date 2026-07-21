const ALLOWED_TABLES = new Set([
  "ideas",
  "factor_validations",
  "ml_tasks",
  "validation_profiles"
]);

const FORBIDDEN_PATTERN =
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|reindex|replace|create|grant|revoke|truncate)\b/i;

/**
 * 提取 WITH cte_name AS (...) 中的 CTE 名，允许 FROM/JOIN 引用。
 */
export function extractCteNames(sql) {
  const names = new Set();
  const re = /\b(?:with|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
  let match;
  while ((match = re.exec(String(sql ?? ""))) !== null) {
    names.add(String(match[1]).toLowerCase());
  }
  return names;
}

/**
 * 校验只读 SQL：仅允许 SELECT/WITH…SELECT，表白名单，强制 LIMIT。
 * @returns {{ ok: true, sql: string } | { ok: false, error: string }}
 */
export function validateReadonlySelectSql(rawSql, { maxLimit = 100 } = {}) {
  const sql = String(rawSql ?? "").trim().replace(/;+\s*$/g, "");
  if (!sql) {
    return { ok: false, error: "SQL 不能为空" };
  }
  if (sql.includes(";")) {
    return { ok: false, error: "禁止多语句" };
  }
  if (FORBIDDEN_PATTERN.test(sql)) {
    return { ok: false, error: "仅允许只读 SELECT" };
  }
  if (!/^\s*(with|select)\b/i.test(sql)) {
    return { ok: false, error: "必须以 SELECT 或 WITH 开头" };
  }

  const cteNames = extractCteNames(sql);
  const tableMatches = [...sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)];
  for (const match of tableMatches) {
    const table = String(match[1] ?? "").toLowerCase();
    if (!table) {
      continue;
    }
    if (ALLOWED_TABLES.has(table) || cteNames.has(table)) {
      continue;
    }
    return { ok: false, error: `表不在白名单: ${table}` };
  }

  let finalSql = sql;
  const limitMatch = sql.match(/\blimit\s+(\d+)\b/i);
  if (limitMatch) {
    const limit = Number(limitMatch[1]);
    if (!Number.isFinite(limit) || limit <= 0) {
      return { ok: false, error: "LIMIT 非法" };
    }
    if (limit > maxLimit) {
      finalSql = sql.replace(/\blimit\s+\d+\b/i, `LIMIT ${maxLimit}`);
    }
  } else {
    finalSql = `${sql} LIMIT ${maxLimit}`;
  }

  return { ok: true, sql: finalSql };
}

export function listAllowedResearchTables() {
  return [...ALLOWED_TABLES];
}
