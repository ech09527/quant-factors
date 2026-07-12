const TRANSIENT_ERROR_PATTERNS = [
  /kernel capacity/i,
  /websocket/i,
  /\btimeout\b/i,
  /http 5\d\d/i,
  /stale running reclaimed/i
];

const PERMANENT_ERROR_PATTERNS = [
  /scalar function with name \w+ does not exist/i,
  /catalog error/i,
  /binder error/i,
  /parser error/i,
  /syntax error/i,
  /factor_sql 无效/i,
  /signal_sql 含 dsl 函数名/i
];

export function isPermanentFactorValidationError(errorReason) {
  const text = String(errorReason ?? "").trim();
  if (!text) {
    return false;
  }
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  return PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function resolveFactorValidationTerminalStatus(status, errorReason) {
  const normalized = String(status ?? "").trim();
  if (normalized !== "failed") {
    return normalized;
  }
  return isPermanentFactorValidationError(errorReason) ? "skipped" : "failed";
}
