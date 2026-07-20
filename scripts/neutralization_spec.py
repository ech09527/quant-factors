"""中性化规格：固定引擎 + 受控 exposures 配置（类比 signal_sql）。"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SPEC_VERSION = "1"
METHOD_SEQUENTIAL_OLS = "sequential_ols"
MAX_EXPOSURES = 4

# 面板已有 / 引擎 features CTE 可产出的列
ALLOWED_FIELDS: frozenset[str] = frozenset(
    {
        "quote_volume",
        "volume",
        "count",
        "log_ret_1",
        "ret_24h",
        "vol_24h",
        "taker_buy_volume",
        "taker_buy_quote_volume",
        "open",
        "high",
        "low",
        "close",
    }
)

ALLOWED_TRANSFORMS: frozenset[str] = frozenset({"identity", "ln"})

DEFAULT_EXPOSURES: list[dict[str, str]] = [
    {"field": "quote_volume", "transform": "ln"},
    {"field": "ret_24h", "transform": "identity"},
]

# 命名别名 → 规格（兼容旧 neutralization_key；新路径优先用 spec）
NAMED_SPECS: dict[str, dict[str, Any]] = {
    "none": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": [],
    },
    "liq_mom": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": list(DEFAULT_EXPOSURES),
    },
    "liquidity": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": [{"field": "quote_volume", "transform": "ln"}],
    },
    "short_term_return": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": [{"field": "log_ret_1", "transform": "identity"}],
    },
    "liquidity_volatility": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": [
            {"field": "quote_volume", "transform": "ln"},
            {"field": "vol_24h", "transform": "identity"},
        ],
    },
    "auto": {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": list(DEFAULT_EXPOSURES),
    },
}

# 兼容 evaluate_engine 旧接口
NEUTRALIZATION_PROFILES: dict[str, dict[str, Any]] = {
    key: {
        "key": key,
        "name": key,
        "exposures": [
            f"{e['transform']}({e['field']})" if e["transform"] != "identity" else e["field"]
            for e in spec["exposures"]
        ],
    }
    for key, spec in NAMED_SPECS.items()
}


def _normalize_exposure(item: Any) -> dict[str, str]:
    if not isinstance(item, dict):
        raise ValueError("exposure 必须是对象")
    field = str(item.get("field") or "").strip()
    transform = str(item.get("transform") or "identity").strip().lower()
    if field not in ALLOWED_FIELDS:
        raise ValueError(f"非法 exposure.field: {field}")
    if transform not in ALLOWED_TRANSFORMS:
        raise ValueError(f"非法 exposure.transform: {transform}")
    return {"field": field, "transform": transform}


def normalize_neutralization_spec(raw: dict[str, Any] | None) -> dict[str, Any]:
    """校验并规范化 neutralization_spec。"""
    if raw is None:
        raise ValueError("neutralization_spec 不能为空")
    if not isinstance(raw, dict):
        raise ValueError("neutralization_spec 必须是对象")

    version = str(raw.get("version") or SPEC_VERSION).strip() or SPEC_VERSION
    if version != SPEC_VERSION:
        raise ValueError(f"不支持的 neutralization_spec.version: {version}")

    method = str(raw.get("method") or METHOD_SEQUENTIAL_OLS).strip() or METHOD_SEQUENTIAL_OLS
    if method != METHOD_SEQUENTIAL_OLS:
        raise ValueError(f"不支持的 neutralization_spec.method: {method}")

    exposures_raw = raw.get("exposures")
    if exposures_raw is None:
        exposures_raw = []
    if not isinstance(exposures_raw, list):
        raise ValueError("exposures 必须是数组")
    if len(exposures_raw) > MAX_EXPOSURES:
        raise ValueError(f"exposures 最多 {MAX_EXPOSURES} 项")

    exposures: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in exposures_raw:
        exp = _normalize_exposure(item)
        key = (exp["field"], exp["transform"])
        if key in seen:
            continue
        seen.add(key)
        exposures.append(exp)

    return {
        "version": SPEC_VERSION,
        "method": METHOD_SEQUENTIAL_OLS,
        "exposures": exposures,
    }


def default_neutralization_spec() -> dict[str, Any]:
    return normalize_neutralization_spec(
        {
            "version": SPEC_VERSION,
            "method": METHOD_SEQUENTIAL_OLS,
            "exposures": list(DEFAULT_EXPOSURES),
        }
    )


def none_neutralization_spec() -> dict[str, Any]:
    return normalize_neutralization_spec(
        {"version": SPEC_VERSION, "method": METHOD_SEQUENTIAL_OLS, "exposures": []}
    )


def resolve_neutralization_spec(
    *,
    neutralization_key: str | None = None,
    neutralization_spec: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """解析中性化规格：显式 spec 优先；否则按命名 key；空 key → none。"""
    if neutralization_spec is not None:
        return normalize_neutralization_spec(neutralization_spec)

    key = (neutralization_key or "none").strip() or "none"
    named = NAMED_SPECS.get(key)
    if named is None:
        raise ValueError(f"未知 neutralization_key: {key}")
    return normalize_neutralization_spec(named)


def exposure_label(exp: dict[str, str]) -> str:
    if exp["transform"] == "identity":
        return exp["field"]
    return f"{exp['transform']}({exp['field']})"


def spec_fingerprint(spec: dict[str, Any]) -> str:
    """稳定短指纹，用于 neutralization_key / 去重。"""
    normalized = normalize_neutralization_spec(spec)
    if not normalized["exposures"]:
        return "none"
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:10]
    labels = [exposure_label(e).replace("(", "_").replace(")", "") for e in normalized["exposures"]]
    slug = "+".join(labels)
    slug = re.sub(r"[^a-z0-9_+]+", "", slug.lower())[:48] or "spec"
    return f"{slug}__{digest}"


def spec_storage_key(spec: dict[str, Any], *, preferred_key: str | None = None) -> str:
    """D1 neutralization_key：none / 命名别名 / 或指纹。"""
    normalized = normalize_neutralization_spec(spec)
    if not normalized["exposures"]:
        return "none"
    preferred = (preferred_key or "").strip()
    if preferred and preferred in NAMED_SPECS and preferred != "none":
        # 命名别名仅当 exposures 与别名一致时保留
        named = normalize_neutralization_spec(NAMED_SPECS[preferred])
        if named["exposures"] == normalized["exposures"]:
            return preferred
    if preferred == "auto":
        return "auto"
    return spec_fingerprint(normalized)


def exposure_sql_expr(field: str, transform: str) -> str:
    if transform == "ln":
        return f"LN({field} + 1e-8)"
    if transform == "identity":
        return field
    raise ValueError(f"未实现 transform: {transform}")


def build_neutralization_cte_sql(
    neutralization_key: str | None = None,
    *,
    neutralization_spec: dict[str, Any] | None = None,
) -> str:
    """在 signal 之后生成 neutralized CTE（输出 neutral_signal）。"""
    spec = resolve_neutralization_spec(
        neutralization_key=neutralization_key,
        neutralization_spec=neutralization_spec,
    )
    exposures = spec["exposures"]
    if not exposures:
        return """
neutralized AS (
  SELECT
    symbol,
    open_time,
    close,
    log_ret_1,
    raw_signal AS neutral_signal
  FROM signal
),
"""

    exp_selects = ",\n    ".join(
        f"{exposure_sql_expr(e['field'], e['transform'])} AS exp_{i}"
        for i, e in enumerate(exposures)
    )
    parts: list[str] = [
        f"""
with_exp AS (
  SELECT
    *,
    {exp_selects}
  FROM signal
),
"""
    ]

    prev_signal = "raw_signal"
    prev_from = "with_exp"
    for i in range(len(exposures)):
        residual_alias = "neutral_signal" if i == len(exposures) - 1 else f"res_{i}"
        keep_exps = ",\n    ".join(f"exp_{j}" for j in range(i + 1, len(exposures)))
        keep_sql = f",\n    {keep_exps}" if keep_exps else ""
        cte_name = "neutralized" if i == len(exposures) - 1 else f"step_{i}"
        parts.append(
            f"""
{cte_name} AS (
  SELECT
    symbol,
    open_time,
    close,
    log_ret_1{keep_sql},
    {prev_signal} - (
      regr_intercept({prev_signal}, exp_{i}) OVER (PARTITION BY open_time)
      + regr_slope({prev_signal}, exp_{i}) OVER (PARTITION BY open_time) * exp_{i}
    ) AS {residual_alias}
  FROM {prev_from}
),
"""
        )
        prev_signal = residual_alias
        prev_from = cte_name

    return "".join(parts)


def get_neutralization_profile(key: str | None = None) -> dict[str, Any]:
    """兼容旧接口。"""
    resolved = (key or "none").strip() or "none"
    profile = NEUTRALIZATION_PROFILES.get(resolved)
    if profile is None:
        # 指纹 key：用 resolve 失败时仍给出可读信息
        raise ValueError(f"未知 neutralization_key: {resolved}")
    return dict(profile)


def neutralization_audit_payload(
    *,
    key: str,
    spec: dict[str, Any],
    source: str = "engine",
    reason: str | None = None,
) -> dict[str, Any]:
    normalized = normalize_neutralization_spec(spec)
    return {
        "key": key,
        "source": source,
        "reason": reason,
        "method": normalized["method"],
        "version": normalized["version"],
        "exposures": [exposure_label(e) for e in normalized["exposures"]],
        "spec": normalized,
    }
