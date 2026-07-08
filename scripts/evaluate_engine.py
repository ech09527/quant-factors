"""DuckDB 因子评估确定性引擎（Stage 1 SQL + Stage 2 指标）。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
from jinja2 import Template

try:
    from scripts.compute_metrics import METRICS_VERSION, compute_metrics
    from scripts.validation_profiles import (
        DEFAULT_PROFILE_KEY,
        build_label_expr,
        get_validation_profile,
    )
except ImportError:
    from compute_metrics import METRICS_VERSION, compute_metrics
    from validation_profiles import (
        DEFAULT_PROFILE_KEY,
        build_label_expr,
        get_validation_profile,
    )

ENGINE_VERSION = "0.1.0"
TEMPLATE_VERSION = "0.1.0"

ALLOWED_COLUMNS = frozenset(
    {
        "symbol",
        "open_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "quote_volume",
        "count",
        "taker_buy_volume",
        "taker_buy_quote_volume",
        "log_ret_1",
        "ret_24h",
        "vol_24h",
    }
)

POSTPROCESS_EXPR = {
    "cs_rank": "PERCENT_RANK() OVER (PARTITION BY open_time ORDER BY raw_signal)",
    "cs_zscore": (
        "(raw_signal - AVG(raw_signal) OVER (PARTITION BY open_time)) "
        "/ (STDDEV_SAMP(raw_signal) OVER (PARTITION BY open_time) + 1e-8)"
    ),
    "none": "raw_signal",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def formula_hash(formula_sketch: str) -> str:
    import hashlib

    return hashlib.sha256(formula_sketch.encode("utf-8")).hexdigest()


def scripts_dir() -> Path:
    return Path(__file__).resolve().parent


def load_template() -> Template:
    path = scripts_dir() / "templates" / "evaluate_panel.sql.j2"
    return Template(path.read_text(encoding="utf-8"))


def build_universe_parts(universe: dict[str, Any]) -> tuple[str, list[str], list[str]]:
    """返回 (static_where_sql, enriched_select_exprs, window_filter_exprs)。"""
    static_parts: list[str] = []
    enriched_exprs: list[str] = []
    window_filters: list[str] = []

    dropna_cols = universe.get("dropna") or []
    for col in dropna_cols:
        if col not in ALLOWED_COLUMNS:
            raise ValueError(f"universe.dropna 含非法列: {col}")
        static_parts.append(f"{col} IS NOT NULL")

    min_bars = universe.get("min_symbol_bars")
    if min_bars is not None:
        enriched_exprs.append(
            f"COUNT(*) OVER (PARTITION BY symbol) AS _symbol_bars"
        )
        window_filters.append(f"_symbol_bars >= {int(min_bars)}")

    cs_q = universe.get("cs_quantile_gte")
    if cs_q:
        col = cs_q["col"]
        q = float(cs_q["q"])
        if col not in ALLOWED_COLUMNS:
            raise ValueError(f"universe.cs_quantile_gte 含非法列: {col}")
        enriched_exprs.append(
            f"({col} >= QUANTILE_CONT({col}, {q}) OVER (PARTITION BY open_time)) AS _cs_ok"
        )
        window_filters.append("_cs_ok")

    static_sql = " AND ".join(static_parts) if static_parts else "TRUE"
    return static_sql, enriched_exprs, window_filters


def validate_postprocess(factor_sql: dict[str, Any]) -> None:
    evaluation_type = factor_sql["evaluation_type"]
    postprocess = factor_sql["postprocess"]
    if evaluation_type == "cross_sectional" and postprocess not in ("cs_rank", "cs_zscore"):
        raise ValueError("cross_sectional 因子 postprocess 必须为 cs_rank 或 cs_zscore")
    if evaluation_type == "time_series" and postprocess != "none":
        raise ValueError("time_series 因子 postprocess 必须为 none")


def resolve_label_expr(
    *,
    validation_profile_key: str | None = None,
    label_kind: str | None = None,
    horizon_bars: int | None = None,
) -> tuple[str, dict[str, Any]]:
    if label_kind is not None and horizon_bars is not None:
        profile = {
            "key": validation_profile_key or "custom",
            "label_kind": label_kind,
            "horizon_bars": int(horizon_bars),
        }
    else:
        profile = get_validation_profile(validation_profile_key or DEFAULT_PROFILE_KEY)
    expr = build_label_expr(profile["label_kind"], profile["horizon_bars"])
    return expr, profile


def render_panel_sql(
    factor_sql: dict[str, Any],
    *,
    data_path: str,
    sample_start_ms: int,
    validation_profile_key: str | None = None,
    label_kind: str | None = None,
    horizon_bars: int | None = None,
) -> str:
    validate_postprocess(factor_sql)
    postprocess = factor_sql["postprocess"]
    postprocess_expr = POSTPROCESS_EXPR[postprocess]
    static_universe_sql, enriched_exprs, window_filters = build_universe_parts(
        factor_sql.get("universe") or {}
    )
    needs_window_universe = bool(enriched_exprs)
    enriched_select_sql = ",\n    ".join(enriched_exprs)
    window_universe_sql = " AND ".join(window_filters) if window_filters else "TRUE"
    label_expr, _profile = resolve_label_expr(
        validation_profile_key=validation_profile_key,
        label_kind=label_kind,
        horizon_bars=horizon_bars,
    )
    return load_template().render(
        data_path=data_path.replace("'", "''"),
        sample_start_ms=sample_start_ms,
        static_universe_sql=static_universe_sql,
        enriched_select_sql=enriched_select_sql,
        window_universe_sql=window_universe_sql,
        needs_window_universe=needs_window_universe,
        signal_sql=factor_sql["signal_sql"],
        postprocess_expr=postprocess_expr,
        label_expr=label_expr,
    )


def parse_sample_start_ms(sample_start: str) -> int:
    dt = datetime.strptime(sample_start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def write_minimal_validation_parquet(
    path: Path,
    *,
    sample_start_ms: int = 1_672_531_200_000,
    n_symbols: int = 40,
    n_hours: int = 250,
) -> None:
    """写入用于 signal_sql 校验的最小 parquet（覆盖常见 universe 窗口长度）。"""
    rows: list[dict[str, Any]] = []
    for s in range(n_symbols):
        symbol = f"VAL{s:03d}"
        price = 100.0 + s
        for t in range(n_hours):
            qv = 1_000_000.0 + s * 10_000 + t * 100
            rows.append(
                {
                    "symbol": symbol,
                    "open_time": sample_start_ms + t * 3_600_000,
                    "open": price,
                    "high": price * 1.002,
                    "low": price * 0.998,
                    "close": price,
                    "volume": qv * 0.8,
                    "quote_volume": qv,
                    "count": 1000.0 + t,
                    "taker_buy_volume": qv * 0.4,
                    "taker_buy_quote_volume": qv * 0.4,
                }
            )
            price *= 1.0005
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows)
    con = duckdb.connect()
    try:
        con.register("_validation_df", df)
        con.execute(f"COPY _validation_df TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


def validate_factor_sql_executable(
    factor_sql: dict[str, Any],
    *,
    sample_start: str = "2023-01-01",
) -> None:
    """在合成数据上 dry-run panel SQL，提前捕获 DuckDB 绑定/语法错误。"""
    if factor_sql["evaluation_type"] != "cross_sectional":
        return

    import tempfile

    sample_start_ms = parse_sample_start_ms(sample_start)
    with tempfile.TemporaryDirectory() as tmp:
        parquet_path = Path(tmp) / "validation.parquet"
        write_minimal_validation_parquet(parquet_path, sample_start_ms=sample_start_ms)
        try:
            run_panel_query(
                factor_sql,
                data_path=str(parquet_path),
                sample_start=sample_start,
            )
        except duckdb.Error as exc:
            raise ValueError(f"signal_sql DuckDB 执行校验失败: {exc}") from exc


def run_panel_query(
    factor_sql: dict[str, Any],
    *,
    data_path: str,
    sample_start: str = "2023-01-01",
    validation_profile_key: str | None = None,
    label_kind: str | None = None,
    horizon_bars: int | None = None,
    connection: duckdb.DuckDBPyConnection | None = None,
) -> pd.DataFrame:
    sql = render_panel_sql(
        factor_sql,
        data_path=data_path,
        sample_start_ms=parse_sample_start_ms(sample_start),
        validation_profile_key=validation_profile_key,
        label_kind=label_kind,
        horizon_bars=horizon_bars,
    )
    con = connection or duckdb.connect()
    try:
        return con.execute(sql).fetchdf()
    finally:
        if connection is None:
            con.close()


def summarize_data_range(panel: pd.DataFrame, sample_start: str) -> dict[str, Any]:
    if panel.empty:
        return {"start": sample_start, "end": sample_start, "n_bars": 0}

    times = pd.to_datetime(panel["open_time"], unit="ms", utc=True)
    return {
        "start": sample_start,
        "end": times.max().strftime("%Y-%m-%d"),
        "n_bars": int(len(panel)),
    }


def evaluate_factor_sql(
    factor_sql: dict[str, Any],
    *,
    title: str,
    title_hash: str,
    formula_sketch: str,
    data_path: str,
    sample_start: str = "2023-01-01",
    save_panel_path: Path | None = None,
    validation_profile_key: str | None = None,
    label_kind: str | None = None,
    horizon_bars: int | None = None,
) -> dict[str, Any]:
    """执行完整评估并返回 evaluation 字典。"""
    evaluation_type = factor_sql["evaluation_type"]
    evaluated_at = datetime.now(timezone.utc).isoformat()
    _label_expr, validation_profile = resolve_label_expr(
        validation_profile_key=validation_profile_key,
        label_kind=label_kind,
        horizon_bars=horizon_bars,
    )

    if evaluation_type == "time_series":
        return {
            "status": "skipped",
            "title": title,
            "title_hash": title_hash,
            "formula_hash": formula_hash(formula_sketch),
            "expression_version": factor_sql.get("version", "1"),
            "engine_version": ENGINE_VERSION,
            "metrics_version": METRICS_VERSION,
            "evaluation_type": evaluation_type,
            "validation_profile_key": validation_profile["key"],
            "evaluated_at": evaluated_at,
            "skipped_reason": "time_series_not_supported_in_mvp",
            "data_range": {"start": sample_start, "end": sample_start, "n_bars": 0},
            "factor_sql": factor_sql,
            "metrics": {
                "mean_ic": 0.0,
                "ic_ir": None,
                "mean_rank_ic": 0.0,
                "rank_ic_ir": None,
                "n_periods": 0,
                "ic_positive_ratio": 0.0,
            },
        }

    panel = run_panel_query(
        factor_sql,
        data_path=data_path,
        sample_start=sample_start,
        validation_profile_key=validation_profile["key"],
        label_kind=validation_profile.get("label_kind"),
        horizon_bars=validation_profile.get("horizon_bars"),
    )
    if save_panel_path is not None:
        save_panel_path.parent.mkdir(parents=True, exist_ok=True)
        panel.to_parquet(save_panel_path, index=False)

    metrics = compute_metrics(panel, evaluation_type)
    diagnostics = {
        k: metrics.pop(k)
        for k in list(metrics.keys())
        if k.startswith("skipped_") or k.startswith("avg_")
    }

    return {
        "status": "success",
        "title": title,
        "title_hash": title_hash,
        "formula_hash": formula_hash(formula_sketch),
        "expression_version": factor_sql.get("version", "1"),
        "engine_version": ENGINE_VERSION,
        "metrics_version": METRICS_VERSION,
        "evaluation_type": evaluation_type,
        "validation_profile_key": validation_profile["key"],
        "evaluated_at": evaluated_at,
        "data_range": summarize_data_range(panel, sample_start),
        "factor_sql": factor_sql,
        "metrics": {
            "mean_ic": metrics["mean_ic"],
            "ic_ir": metrics["ic_ir"],
            "mean_rank_ic": metrics["mean_rank_ic"],
            "rank_ic_ir": metrics["rank_ic_ir"],
            "n_periods": metrics["n_periods"],
            "ic_positive_ratio": metrics["ic_positive_ratio"],
        },
        "diagnostics": diagnostics,
    }


def resolve_kaggle_data_path(dataset_slug: str, target_file: str) -> str:
    slug_dir = dataset_slug.replace("/", "-")
    slug_path = dataset_slug.strip("/")
    candidates = [
        f"/kaggle/input/{slug_dir}/{target_file}",
        f"/kaggle/input/datasets/{slug_path}/{target_file}",
        f"/kaggle/input/datasets/{target_file}",
        f"/kaggle/input/{slug_dir}/{dataset_slug}/{target_file}",
    ]
    for path in candidates:
        if Path(path).is_file():
            return path

    input_root = Path("/kaggle/input")
    if input_root.is_dir():
        name = Path(target_file).name
        for path in sorted(input_root.rglob(name)):
            if path.is_file():
                return str(path)

    return candidates[0]
