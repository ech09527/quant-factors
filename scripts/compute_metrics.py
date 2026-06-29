"""确定性 IC / Rank IC 指标计算（Stage 2）。"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

METRICS_VERSION = "0.1.0"
MIN_CROSS_SECTIONAL_N = 30
MIN_TIME_SERIES_N = 100


def _safe_ir(series: list[float]) -> float | None:
    if len(series) < 2:
        return None
    std = float(np.std(series, ddof=1))
    if std == 0 or np.isnan(std):
        return None
    return float(np.mean(series) / std)


def compute_cross_sectional_metrics(panel: pd.DataFrame) -> dict[str, Any]:
    """横截面 IC：按 open_time 分组计算 Pearson / Spearman 相关。"""
    ic_series: list[float] = []
    rank_ic_series: list[float] = []
    skipped_low_n = 0

    for _, grp in panel.groupby("open_time", sort=True):
        valid = grp.dropna(subset=["factor", "fwd_ret"])
        if len(valid) < MIN_CROSS_SECTIONAL_N:
            skipped_low_n += 1
            continue
        ic_t = valid["factor"].corr(valid["fwd_ret"])
        if ic_t is not None and not np.isnan(ic_t):
            ic_series.append(float(ic_t))
        rank_ic_t = valid["factor"].rank().corr(valid["fwd_ret"].rank())
        if rank_ic_t is not None and not np.isnan(rank_ic_t):
            rank_ic_series.append(float(rank_ic_t))

    if not ic_series:
        raise ValueError(
            f"横截面 IC 无有效 period（min_n={MIN_CROSS_SECTIONAL_N}）"
        )

    return {
        "mean_ic": float(np.mean(ic_series)),
        "ic_ir": _safe_ir(ic_series),
        "mean_rank_ic": float(np.mean(rank_ic_series)) if rank_ic_series else 0.0,
        "rank_ic_ir": _safe_ir(rank_ic_series) if rank_ic_series else None,
        "n_periods": len(ic_series),
        "ic_positive_ratio": float(np.mean([x > 0 for x in ic_series])),
        "skipped_periods_low_n": skipped_low_n,
        "avg_universe_size": float(
            panel.dropna(subset=["factor", "fwd_ret"])
            .groupby("open_time")
            .size()
            .mean()
        ),
    }


def compute_time_series_metrics(panel: pd.DataFrame) -> dict[str, Any]:
    """时序 IC：按 symbol 分组计算相关。"""
    ic_series: list[float] = []
    rank_ic_series: list[float] = []
    skipped_low_n = 0

    for _, grp in panel.groupby("symbol", sort=True):
        valid = grp.dropna(subset=["factor", "fwd_ret"])
        if len(valid) < MIN_TIME_SERIES_N:
            skipped_low_n += 1
            continue
        ic_t = valid["factor"].corr(valid["fwd_ret"])
        if ic_t is not None and not np.isnan(ic_t):
            ic_series.append(float(ic_t))
        rank_ic_t = valid["factor"].rank().corr(valid["fwd_ret"].rank())
        if rank_ic_t is not None and not np.isnan(rank_ic_t):
            rank_ic_series.append(float(rank_ic_t))

    if not ic_series:
        raise ValueError(
            f"时序 IC 无有效 symbol（min_n={MIN_TIME_SERIES_N}）"
        )

    return {
        "mean_ic": float(np.mean(ic_series)),
        "ic_ir": _safe_ir(ic_series),
        "mean_rank_ic": float(np.mean(rank_ic_series)) if rank_ic_series else 0.0,
        "rank_ic_ir": _safe_ir(rank_ic_series) if rank_ic_series else None,
        "n_periods": len(ic_series),
        "ic_positive_ratio": float(np.mean([x > 0 for x in ic_series])),
        "skipped_symbols_low_n": skipped_low_n,
    }


def compute_metrics(panel: pd.DataFrame, evaluation_type: str) -> dict[str, Any]:
    """根据 evaluation_type 计算 IC 指标。"""
    required = {"symbol", "open_time", "factor", "fwd_ret"}
    missing = required - set(panel.columns)
    if missing:
        raise ValueError(f"panel 缺少列: {sorted(missing)}")

    if evaluation_type == "cross_sectional":
        return compute_cross_sectional_metrics(panel)
    if evaluation_type == "time_series":
        return compute_time_series_metrics(panel)
    raise ValueError(f"未知 evaluation_type: {evaluation_type}")
