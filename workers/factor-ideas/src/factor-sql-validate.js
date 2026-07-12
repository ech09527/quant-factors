export function hasStoredFactorSql(factorSql) {
  if (factorSql == null || factorSql === "") {
    return false;
  }
  if (typeof factorSql === "string") {
    const trimmed = factorSql.trim();
    if (!trimmed || trimmed === "null") {
      return false;
    }
    try {
      return hasStoredFactorSql(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }
  if (typeof factorSql !== "object" || Array.isArray(factorSql)) {
    return false;
  }
  return Boolean(String(factorSql.signal_sql ?? "").trim());
}

const DSL_FUNCTION_LEAK =
  /\b(Div|Add|Sub|Mul|Neg|Log|CSRank|CSZScore|Mean|Delta|Ref|Corr|Std|Abs)\s*\(/i;

export function detectDslLeakInSignalSql(signalSql) {
  const signal = String(signalSql ?? "").trim();
  if (!signal) {
    return null;
  }
  if (DSL_FUNCTION_LEAK.test(signal)) {
    return "signal_sql 含 DSL 函数名（如 Div/Log），须改写为 DuckDB SQL（如 a / b、LN(a)）";
  }
  return null;
}

export function validateFactorSqlBasic(factorSql) {
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
  const dslLeak = detectDslLeakInSignalSql(signal);
  if (dslLeak) {
    throw new Error(dslLeak);
  }
  const evaluationType = String(factorSql.evaluation_type);
  const postprocess = String(factorSql.postprocess);
  if (evaluationType === "cross_sectional" && !["cs_rank", "cs_zscore"].includes(postprocess)) {
    throw new Error("cross_sectional 因子 postprocess 须为 cs_rank 或 cs_zscore");
  }
  if (evaluationType === "time_series" && postprocess !== "none") {
    throw new Error("time_series 因子 postprocess 须为 none");
  }
}
