"""内置验证配置（与 D1 validation_profiles 表种子数据保持一致）。"""

from __future__ import annotations

from typing import Any, TypedDict


class ValidationProfile(TypedDict):
    key: str
    name: str
    label_kind: str
    horizon_bars: int
    description: str


DEFAULT_VALIDATION_PROFILES: list[ValidationProfile] = [
    {
        "key": "fwd_ret_1",
        "name": "1周期前向收益",
        "label_kind": "forward_return",
        "horizon_bars": 1,
        "description": "因子与下一根 K 线收益率的 IC",
    },
    {
        "key": "fwd_ret_2",
        "name": "2周期前向收益",
        "label_kind": "forward_return",
        "horizon_bars": 2,
        "description": "因子与 2 根 K 线后累计收益的 IC",
    },
    {
        "key": "fwd_ret_24",
        "name": "24周期前向收益",
        "label_kind": "forward_return",
        "horizon_bars": 24,
        "description": "因子与 24 根 K 线后累计收益的 IC",
    },
    {
        "key": "fwd_vol_1",
        "name": "1周期前向波动",
        "label_kind": "forward_volatility",
        "horizon_bars": 1,
        "description": "因子与下一根 K 线绝对对数收益的 IC",
    },
    {
        "key": "fwd_vol_24",
        "name": "24周期前向波动",
        "label_kind": "forward_volatility",
        "horizon_bars": 24,
        "description": "因子与未来 24 根 K 线实现波动率的 IC",
    },
]

DEFAULT_PROFILE_KEY = "fwd_ret_1"

_PROFILE_BY_KEY = {profile["key"]: profile for profile in DEFAULT_VALIDATION_PROFILES}


def get_validation_profile(key: str | None = None) -> ValidationProfile:
    resolved = key or DEFAULT_PROFILE_KEY
    profile = _PROFILE_BY_KEY.get(resolved)
    if profile is None:
        raise ValueError(f"未知 validation_profile: {resolved}")
    return profile


def _normalize_label_kind(value: str | None) -> str | None:
    if value is None:
        return None
    kind = str(value).strip()
    if kind in ("forward_return", "forward_volatility"):
        return kind
    return None


def _normalize_horizon_bars(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        horizon = int(value)
    except (TypeError, ValueError):
        return None
    return horizon if horizon >= 1 else None


def resolve_validation_profile(
    *,
    validation_profile_key: str | None = None,
    label_kind: str | None = None,
    horizon_bars: int | None = None,
) -> ValidationProfile:
    """解析验证配置：已知 profile_key 以内置/D1 种子为准，未知 key 使用 job 中的 label 字段。"""
    key = (validation_profile_key or "").strip() or DEFAULT_PROFILE_KEY
    builtin = _PROFILE_BY_KEY.get(key)
    if builtin is not None:
        return dict(builtin)

    normalized_kind = _normalize_label_kind(label_kind)
    normalized_horizon = _normalize_horizon_bars(horizon_bars)
    if normalized_kind is not None and normalized_horizon is not None:
        return {
            "key": key,
            "name": key,
            "label_kind": normalized_kind,
            "horizon_bars": normalized_horizon,
            "description": "",
        }

    return get_validation_profile(key)


def list_validation_profiles(*, enabled_only: bool = True) -> list[ValidationProfile]:
    profiles = list(DEFAULT_VALIDATION_PROFILES)
    if enabled_only:
        return profiles
    return profiles


def build_label_expr(label_kind: str, horizon_bars: int) -> str:
    """生成 DuckDB label 表达式（引用列 close、log_ret_1 与窗口 w）。"""
    horizon = int(horizon_bars)
    if horizon < 1:
        raise ValueError("horizon_bars 必须 >= 1")

    if label_kind == "forward_return":
        return f"LEAD(close, {horizon}) OVER w / close - 1"

    if label_kind == "forward_volatility":
        if horizon == 1:
            return "ABS(LEAD(log_ret_1, 1) OVER w)"
        leads = ", ".join(f"LEAD(log_ret_1, {offset}) OVER w" for offset in range(1, horizon + 1))
        return f"(SELECT STDDEV_SAMP(v) FROM unnest([{leads}]) AS t(v))"

    raise ValueError(f"未知 label_kind: {label_kind}")


def profile_to_public_dict(profile: ValidationProfile) -> dict[str, Any]:
    return dict(profile)
