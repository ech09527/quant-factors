#!/usr/bin/env python3
"""本地 CLI：对 factor_sql.json 运行确定性评估引擎。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.evaluate_engine import evaluate_factor_sql


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本地运行因子评估引擎")
    parser.add_argument("--idea", type=Path, required=True)
    parser.add_argument("--factor-sql", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True, help="1h.parquet 路径")
    parser.add_argument("--sample-start", default="2023-01-01")
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args(argv)

    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)
    with args.factor_sql.open(encoding="utf-8") as handle:
        factor_sql = json.load(handle)

    evaluation = evaluate_factor_sql(
        factor_sql,
        title=idea["title"],
        title_hash=idea["title_hash"],
        formula_sketch=idea["formula_sketch"],
        data_path=str(args.data),
        sample_start=args.sample_start,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"已写入 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
