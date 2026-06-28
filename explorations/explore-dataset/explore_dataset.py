#!/usr/bin/env python3
"""Kaggle script kernel: explore dataset structure and emit schema artifacts."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

SAMPLE_ROWS = 5000
UNIQUE_THRESHOLD = 10_000
OUTPUT_DIR = Path("/kaggle/working")
SUPPORTED_EXTENSIONS = {".csv", ".parquet", ".pq"}

ID_NAME_PATTERNS = re.compile(
    r"^(id|index|idx|row_?id|pk|primary_?key|unnamed.*)$|_id$|^id_|^index$",
    re.IGNORECASE,
)

DATE_NAME_PATTERNS = re.compile(
    r"date|time|timestamp|datetime|trade_?date|asof|as_of|period|month|year|day",
    re.IGNORECASE,
)


class ExplorationError(Exception):
    """Raised when exploration cannot proceed."""


def slug_to_input_path(slug: str) -> Path:
    """Convert owner/dataset-name to /kaggle/input/owner-dataset-name/."""
    normalized = slug.strip().strip("/")
    if not normalized or "/" not in normalized:
        raise ExplorationError(
            f"Invalid DATASET_SLUG '{slug}': expected format 'owner/dataset-name'"
        )
    folder = normalized.replace("/", "-")
    return Path("/kaggle/input") / folder


def resolve_input_path(slug: str) -> Path:
    """解析 Kaggle 挂载路径；若标准路径不存在则扫描 /kaggle/input。"""
    expected = slug_to_input_path(slug)
    if expected.is_dir():
        return expected

    input_root = Path("/kaggle/input")
    if not input_root.is_dir():
        raise ExplorationError(
            f"Dataset mount path not found: {expected}. /kaggle/input is missing."
        )

    target = slug.strip().strip("/").replace("/", "-")
    candidates: list[Path] = []
    for child in sorted(input_root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if child.name == target or target in child.name:
            candidates.append(child)

    if not candidates:
        for child in sorted(input_root.iterdir()):
            if child.is_dir() and discover_data_files(child):
                candidates.append(child)

    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        return candidates[0]

    raise ExplorationError(
        f"Dataset mount path not found: {expected}. "
        f"Ensure dataset_sources includes '{slug}' in kernel-metadata.json. "
        f"Available mounts: {[p.name for p in input_root.iterdir() if p.is_dir()]}"
    )


def discover_data_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() in SUPPORTED_EXTENSIONS:
            files.append(path)
    return files


def read_sample(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    try:
        if suffix == ".csv":
            return pd.read_csv(path, nrows=SAMPLE_ROWS, low_memory=False)
        if suffix in {".parquet", ".pq"}:
            df = pd.read_parquet(path)
            if len(df) > SAMPLE_ROWS:
                return df.head(SAMPLE_ROWS).copy()
            return df
    except Exception as exc:
        raise ExplorationError(f"Failed to read {path.name}: {exc}") from exc
    raise ExplorationError(f"Unsupported file type: {path.suffix}")


def is_likely_id_column(name: str, series: pd.Series) -> bool:
    if ID_NAME_PATTERNS.search(name):
        return True
    if pd.api.types.is_numeric_dtype(series):
        nunique = series.nunique(dropna=True)
        nrows = len(series)
        if nrows > 0 and nunique == nrows:
            return True
    return False


def is_numeric_dtype(dtype: str) -> bool:
    lowered = dtype.lower()
    return any(
        token in lowered
        for token in ("int", "float", "double", "decimal", "number")
    )


def safe_json_value(value: Any) -> Any:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return value.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(value, float):
        if pd.isna(value) or value in (float("inf"), float("-inf")):
            return None
    return value


def sample_values(series: pd.Series, limit: int = 5) -> list[Any]:
    values: list[Any] = []
    for raw in series.dropna().head(limit * 3):
        converted = safe_json_value(raw)
        if converted is None:
            continue
        if converted not in values:
            values.append(converted)
        if len(values) >= limit:
            break
    return values


def column_stats(name: str, series: pd.Series) -> dict[str, Any]:
    null_rate = float(series.isna().mean()) if len(series) else None
    dtype = str(series.dtype)
    stats: dict[str, Any] = {
        "name": name,
        "dtype": dtype,
        "null_pct": round(null_rate * 100, 4) if null_rate is not None else None,
        "null_rate": round(null_rate, 6) if null_rate is not None else None,
        "sample_values": sample_values(series),
    }

    nunique = series.nunique(dropna=True)
    if nunique <= UNIQUE_THRESHOLD:
        stats["unique"] = int(nunique)

    if is_numeric_dtype(dtype):
        numeric = pd.to_numeric(series, errors="coerce")
        if numeric.notna().any():
            stats["min"] = safe_json_value(numeric.min())
            stats["max"] = safe_json_value(numeric.max())

    return stats


def detect_date_column(columns: list[dict[str, Any]], df: pd.DataFrame) -> str | None:
    candidates: list[str] = []
    for col in df.columns:
        if DATE_NAME_PATTERNS.search(str(col)):
            candidates.append(str(col))

    for col in candidates:
        parsed = pd.to_datetime(df[col], errors="coerce", utc=False)
        valid_ratio = parsed.notna().mean()
        if valid_ratio >= 0.5:
            return col

    for col in df.columns:
        if col in candidates:
            continue
        parsed = pd.to_datetime(df[col], errors="coerce", utc=False)
        if parsed.notna().mean() >= 0.8:
            return str(col)

    return None


def date_range_for_column(df: pd.DataFrame, column: str) -> dict[str, str] | None:
    parsed = pd.to_datetime(df[column], errors="coerce", utc=False)
    valid = parsed.dropna()
    if valid.empty:
        return None
    start = valid.min()
    end = valid.max()
    return {
        "column": column,
        "start": start.date().isoformat() if hasattr(start, "date") else str(start),
        "end": end.date().isoformat() if hasattr(end, "date") else str(end),
    }


def infer_primary_keys(columns: list[str], file_date_col: str | None) -> list[str]:
    keys: list[str] = []
    lowered = {c.lower(): c for c in columns}

    for candidate in ("symbol", "ticker", "code", "instrument", "secid", "permno"):
        if candidate in lowered:
            keys.append(lowered[candidate])
            break

    if file_date_col and file_date_col not in keys:
        keys.append(file_date_col)

    return keys


def factor_field_candidates(all_columns: list[dict[str, Any]]) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    for col in all_columns:
        name = col["name"]
        dtype = col.get("dtype", "")
        if name in seen:
            continue
        if not is_numeric_dtype(dtype):
            continue
        series = col.get("_series")
        if series is not None and is_likely_id_column(name, series):
            continue
        candidates.append(name)
        seen.add(name)

    return candidates


def build_warnings(files: list[dict[str, Any]], dataset_slug: str) -> list[str]:
    warnings: list[str] = []
    if not files:
        warnings.append(f"未在挂载路径中找到 csv/parquet 文件（slug: {dataset_slug}）")
        return warnings

    for file_info in files:
        for col in file_info.get("columns", []):
            null_rate = col.get("null_rate")
            if null_rate is not None and null_rate > 0.15:
                warnings.append(
                    f"{file_info['name']} 列 '{col['name']}' 缺失率约 {col['null_pct']:.1f}%"
                )

    return warnings


def explore_file(path: Path, root: Path) -> dict[str, Any]:
    df = read_sample(path)
    rel_name = str(path.relative_to(root))

    columns: list[dict[str, Any]] = []
    for name in df.columns:
        series = df[name]
        stats = column_stats(str(name), series)
        stats["_series"] = series
        columns.append(stats)

    date_col = detect_date_column(columns, df)
    file_date_range = date_range_for_column(df, date_col) if date_col else None

    schema_columns = []
    for col in columns:
        schema_col = {
            "name": col["name"],
            "dtype": col["dtype"],
            "null_rate": col["null_rate"],
            "sample_values": col["sample_values"],
        }
        schema_columns.append(schema_col)

    return {
        "name": rel_name,
        "size_bytes": path.stat().st_size,
        "row_count": int(len(df)),
        "sample_rows": int(len(df)),
        "columns": columns,
        "schema_columns": schema_columns,
        "date_range": file_date_range,
        "primary_keys": infer_primary_keys([c["name"] for c in columns], date_col),
    }


def merge_date_ranges(ranges: list[dict[str, str] | None]) -> dict[str, str] | None:
    valid = [r for r in ranges if r]
    if not valid:
        return None

    column = valid[0]["column"]
    starts = [r["start"] for r in valid]
    ends = [r["end"] for r in valid]
    return {"column": column, "start": min(starts), "end": max(ends)}


def build_schema(
    slug: str,
    files: list[dict[str, Any]],
    factor_candidates: list[str],
    warnings: list[str],
) -> dict[str, Any]:
    schema_files = []
    for file_info in files:
        schema_files.append(
            {
                "name": file_info["name"],
                "size_bytes": file_info.get("size_bytes"),
                "row_count": file_info.get("row_count"),
                "columns": file_info["schema_columns"],
            }
        )

    date_range = merge_date_ranges([f.get("date_range") for f in files])
    primary_keys: list[str] = []
    for file_info in files:
        for key in file_info.get("primary_keys", []):
            if key not in primary_keys:
                primary_keys.append(key)

    return {
        "slug": slug,
        "explored_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "kaggle_version": os.environ.get("KAGGLE_DATASET_VERSION"),
        "files": schema_files,
        "date_range": date_range,
        "primary_keys": primary_keys,
        "factor_field_candidates": factor_candidates,
        "warnings": warnings,
    }


def build_exploration_summary(
    slug: str,
    input_path: Path,
    files: list[dict[str, Any]],
    schema: dict[str, Any],
) -> dict[str, Any]:
    summary_files = []
    for file_info in files:
        export_columns = []
        for col in file_info["columns"]:
            export_col = {k: v for k, v in col.items() if k != "_series"}
            export_columns.append(export_col)

        summary_files.append(
            {
                "name": file_info["name"],
                "size_bytes": file_info.get("size_bytes"),
                "row_count": file_info.get("row_count"),
                "sample_rows": file_info.get("sample_rows"),
                "columns": export_columns,
                "date_range": file_info.get("date_range"),
                "primary_keys": file_info.get("primary_keys", []),
            }
        )

    return {
        "dataset": slug,
        "input_path": str(input_path),
        "explored_at": schema["explored_at"],
        "files": summary_files,
        "date_range": schema.get("date_range"),
        "primary_keys": schema.get("primary_keys", []),
        "factor_field_candidates": schema.get("factor_field_candidates", []),
        "warnings": schema.get("warnings", []),
        "notes": (
            f"基于每个文件最多 {SAMPLE_ROWS} 行抽样统计；"
            "row_count 为抽样行数而非全量。"
        ),
    }


def generate_readme(slug: str, schema: dict[str, Any], summary: dict[str, Any]) -> str:
    name_part = slug.split("/")[-1] if "/" in slug else slug
    explored_at = schema.get("explored_at", "")
    lines = [
        f"# {name_part}",
        "",
        f"> 自动探索于 {explored_at}，Kaggle slug: `{slug}`",
        "",
        "## 概述",
        "",
        f"- 输入路径: `{summary.get('input_path', '')}`",
        f"- 文件数: {len(schema.get('files', []))}",
        f"- 抽样说明: {summary.get('notes', '')}",
        "",
    ]

    date_range = schema.get("date_range")
    if date_range:
        lines.extend(
            [
                "## 时间范围",
                "",
                f"- 时间列: `{date_range.get('column')}`",
                f"- 起止: {date_range.get('start')} ~ {date_range.get('end')}",
                "",
            ]
        )

    if schema.get("primary_keys"):
        lines.extend(
            [
                "## 建议主键 / Join 键",
                "",
                ", ".join(f"`{k}`" for k in schema["primary_keys"]),
                "",
            ]
        )

    if schema.get("factor_field_candidates"):
        lines.extend(
            [
                "## 因子字段候选",
                "",
                ", ".join(f"`{c}`" for c in schema["factor_field_candidates"]),
                "",
            ]
        )

    lines.extend(["## 文件与字段", ""])

    for file_info in schema.get("files", []):
        lines.append(f"### {file_info['name']}")
        lines.append("")
        size_bytes = file_info.get("size_bytes")
        row_count = file_info.get("row_count")
        if size_bytes is not None:
            lines.append(f"- 大小: {size_bytes:,} bytes")
        if row_count is not None:
            lines.append(f"- 抽样行数: {row_count:,}")
        lines.append("")
        lines.append("| 列名 | 类型 | 缺失率 | 样本值 |")
        lines.append("|------|------|--------|--------|")

        for col in file_info.get("columns", []):
            null_rate = col.get("null_rate")
            null_display = f"{null_rate * 100:.2f}%" if null_rate is not None else "-"
            samples = col.get("sample_values") or []
            sample_str = ", ".join(str(s) for s in samples[:3]) or "-"
            if len(sample_str) > 60:
                sample_str = sample_str[:57] + "..."
            lines.append(
                f"| {col['name']} | {col.get('dtype', '-')} | {null_display} | {sample_str} |"
            )
        lines.append("")

    warnings = schema.get("warnings") or []
    if warnings:
        lines.extend(["## 已知限制 / 警告", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")

    lines.extend(
        [
            "## 因子潜力（模板）",
            "",
            "以下说明需结合业务语义人工补充：",
            "",
            "| 列名 | 类型 | 说明 | 因子潜力 |",
            "|------|------|------|----------|",
        ]
    )

    for candidate in schema.get("factor_field_candidates", [])[:10]:
        lines.append(f"| {candidate} | numeric | （待补充） | 动量、反转、波动等 |")

    if not schema.get("factor_field_candidates"):
        lines.append("| — | — | 未识别到数值型因子候选列 | — |")

    lines.append("")
    return "\n".join(lines)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    slug = os.environ.get("DATASET_SLUG", "").strip()
    if not slug:
        print(
            json.dumps(
                {
                    "error": "DATASET_SLUG environment variable is required",
                    "hint": "Set DATASET_SLUG to owner/dataset-name before kernel run",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1

    try:
        input_path = resolve_input_path(slug)

        data_files = discover_data_files(input_path)
        if not data_files:
            raise ExplorationError(
                f"No csv/parquet files under {input_path}. "
                "Check dataset contents and slug mapping (owner/name -> owner-name)."
            )

        explored_files: list[dict[str, Any]] = []
        errors: list[str] = []

        for path in data_files:
            try:
                explored_files.append(explore_file(path, input_path))
            except ExplorationError as exc:
                errors.append(str(exc))

        if not explored_files:
            raise ExplorationError(
                "All data files failed to load. Errors: " + "; ".join(errors)
            )

        flat_columns: list[dict[str, Any]] = []
        for file_info in explored_files:
            flat_columns.extend(file_info["columns"])

        factor_candidates = factor_field_candidates(flat_columns)
        warnings = build_warnings(explored_files, slug)
        if errors:
            warnings.append("部分文件读取失败: " + "; ".join(errors))

        schema = build_schema(slug, explored_files, factor_candidates, warnings)
        summary = build_exploration_summary(slug, input_path, explored_files, schema)
        readme = generate_readme(slug, schema, summary)

        write_json(OUTPUT_DIR / "schema.json", schema)
        write_json(OUTPUT_DIR / "exploration_summary.json", summary)
        (OUTPUT_DIR / "README.md").write_text(readme, encoding="utf-8")

        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    except ExplorationError as exc:
        try:
            resolved_path = str(slug_to_input_path(slug)) if slug else None
        except ExplorationError:
            resolved_path = None
        error_payload = {
            "error": str(exc),
            "dataset_slug": slug,
            "input_path": resolved_path,
        }
        print(json.dumps(error_payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    except Exception as exc:
        error_payload = {
            "error": f"Unexpected error: {exc}",
            "dataset_slug": slug,
        }
        print(json.dumps(error_payload, ensure_ascii=False, indent=2), file=sys.stderr)
        raise


if __name__ == "__main__":
    sys.exit(main())
