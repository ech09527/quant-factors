"""按 title_hash 从 fetch_existing_ideas 输出中提取单条想法。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.fetch_pending_evaluations import enrich_idea


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="提取单条因子想法")
    parser.add_argument("--ideas", type=Path, required=True)
    parser.add_argument("--title-hash", required=True)
    parser.add_argument("-o", "--output", type=Path, required=True)
    return parser.parse_args(argv)


def find_idea(payload: dict[str, Any], title_hash: str) -> dict[str, Any]:
    ideas = payload.get("ideas", [])
    for raw in ideas:
        if raw.get("title_hash") == title_hash:
            return enrich_idea(raw)
    raise ValueError(f"未找到 title_hash={title_hash}")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.ideas.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    try:
        idea = find_idea(payload, args.title_hash)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(idea, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已写入 {args.output}")
        return 0
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
