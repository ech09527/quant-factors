"""校验 evaluation.json 输出。"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jsonschema

from scripts.evaluate_engine import ENGINE_VERSION
from scripts.validate_sql import validate_factor_sql


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_evaluation_schema() -> dict[str, Any]:
    path = repo_root() / "schemas" / "evaluation-schema.json"
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate_evaluation(
    evaluation: dict[str, Any],
    *,
    expected_title_hash: str | None = None,
    expected_formula_hash: str | None = None,
) -> None:
    schema = load_evaluation_schema()
    jsonschema.validate(instance=evaluation, schema=schema)
    validate_factor_sql(evaluation["factor_sql"])

    if expected_title_hash and evaluation.get("title_hash") != expected_title_hash:
        raise ValueError("title_hash 与输入不一致")

    if expected_formula_hash and evaluation.get("formula_hash") != expected_formula_hash:
        raise ValueError("formula_hash 与输入不一致")

    status = evaluation.get("status")
    if status == "success":
        metrics = evaluation["metrics"]
        if abs(metrics["mean_ic"]) > 1:
            raise ValueError("|mean_ic| 必须 <= 1")
        if metrics["n_periods"] < 100:
            raise ValueError("success 评估要求 n_periods >= 100")
        if evaluation.get("engine_version") != ENGINE_VERSION:
            raise ValueError(f"engine_version 应为 {ENGINE_VERSION}")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="校验 evaluation.json")
    parser.add_argument("input", type=Path)
    parser.add_argument("--title-hash")
    parser.add_argument("--formula-hash")
    args = parser.parse_args(argv)

    try:
        with args.input.open(encoding="utf-8") as handle:
            evaluation = json.load(handle)
        validate_evaluation(
            evaluation,
            expected_title_hash=args.title_hash,
            expected_formula_hash=args.formula_hash,
        )
        print("OK")
        return 0
    except (json.JSONDecodeError, jsonschema.ValidationError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
