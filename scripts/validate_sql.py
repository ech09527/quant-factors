"""校验 AI 生成的 factor_sql JSON 与 signal_sql 片段。"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jsonschema

from scripts.evaluate_engine import (
    ALLOWED_COLUMNS,
    validate_factor_sql_executable,
    validate_postprocess,
)

FORBIDDEN_KEYWORDS = re.compile(
    r"\b(COPY|ATTACH|INSTALL|LOAD|EXPORT|READ_|CREATE|DROP|INSERT|UPDATE|DELETE|"
    r"PRAGMA|CALL|PREPARE|EXECUTE|LEAD)\b",
    re.IGNORECASE,
)

FORBIDDEN_CS_PARTITION = re.compile(
    r"PARTITION\s+BY\s+open_time",
    re.IGNORECASE,
)

SQL_RESERVED = frozenset(
    {
        "over",
        "partition",
        "by",
        "order",
        "rows",
        "between",
        "preceding",
        "following",
        "current",
        "row",
        "and",
        "or",
        "not",
        "null",
        "true",
        "false",
        "case",
        "when",
        "then",
        "else",
        "end",
        "cast",
        "as",
        "distinct",
        "filter",
        "within",
        "group",
        "window",
        "w",
    }
)

SQL_FUNCTIONS = frozenset(
    {
        "abs",
        "avg",
        "coalesce",
        "count",
        "dense_rank",
        "exp",
        "floor",
        "greatest",
        "if",
        "iff",
        "isnan",
        "isinf",
        "lag",
        "lead",
        "least",
        "ln",
        "log",
        "log10",
        "max",
        "min",
        "nullif",
        "percent_rank",
        "power",
        "quantile_cont",
        "quantile_disc",
        "rank",
        "round",
        "sign",
        "sqrt",
        "stddev",
        "stddev_pop",
        "stddev_samp",
        "sum",
        "var_pop",
        "var_samp",
    }
)


def extract_column_refs(signal_sql: str) -> set[str]:
    tokens = set(re.findall(r"\b([a-z_][a-z0-9_]*)\b", signal_sql.lower()))
    ignored = SQL_RESERVED | SQL_FUNCTIONS
    return {t for t in tokens if t not in ignored}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_factor_sql_schema() -> dict[str, Any]:
    path = repo_root() / "schemas" / "factor-sql-schema.json"
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate_signal_sql(signal_sql: str, evaluation_type: str) -> list[str]:
    errors: list[str] = []
    if not signal_sql.strip():
        errors.append("signal_sql 为空")
        return errors

    if FORBIDDEN_KEYWORDS.search(signal_sql):
        errors.append("signal_sql 含禁止关键字（含 LEAD/COPY/ATTACH 等）")

    if evaluation_type == "cross_sectional" and FORBIDDEN_CS_PARTITION.search(signal_sql):
        errors.append("signal_sql 不应含 PARTITION BY open_time（截面逻辑由 postprocess 处理）")

    refs = extract_column_refs(signal_sql)
    unknown = refs - ALLOWED_COLUMNS
    if unknown:
        errors.append(f"signal_sql 引用未知列: {sorted(unknown)}")

    return errors


def validate_factor_sql(factor_sql: dict[str, Any]) -> None:
    schema = load_factor_sql_schema()
    jsonschema.validate(instance=factor_sql, schema=schema)
    validate_postprocess(factor_sql)

    errors = validate_signal_sql(
        factor_sql["signal_sql"],
        factor_sql["evaluation_type"],
    )
    if errors:
        raise ValueError("; ".join(errors))

    validate_factor_sql_executable(factor_sql)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="校验 factor_sql.json")
    parser.add_argument("input", type=Path, help="factor_sql JSON 文件")
    args = parser.parse_args(argv)

    try:
        with args.input.open(encoding="utf-8") as handle:
            factor_sql = json.load(handle)
        validate_factor_sql(factor_sql)
        print("OK")
        return 0
    except (json.JSONDecodeError, jsonschema.ValidationError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
