"""组装 Kaggle 因子想法 Kernel 的 kernel_inputs.json。"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import json
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def slug_to_dir(slug: str) -> str:
    return slug.strip().strip("/").replace("/", "__")


def load_existing_titles(path: Path | None) -> list[str]:
    if path is None or not path.is_file():
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "ideas" in data:
        return [item["title"] for item in data["ideas"] if item.get("title")]
    if isinstance(data, list):
        return [item["title"] for item in data if item.get("title")]
    return []


def load_cached_exploration(repo: Path, slug: str) -> dict[str, Any] | None:
    dataset_dir = repo / "datasets" / slug_to_dir(slug)
    for name in ("exploration_summary.json", "schema.json"):
        path = dataset_dir / name
        if path.is_file():
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    return None


def build_inputs(
    *,
    dataset_slug: str,
    max_ideas: int,
    mode: str,
    existing_titles: list[str],
    forbidden_titles: list[str],
    target_file: str,
    repo: Path,
) -> dict[str, Any]:
    schema_path = repo / "schemas" / "idea-schema.json"
    with open(schema_path, encoding="utf-8") as f:
        idea_schema = json.load(f)

    payload: dict[str, Any] = {
        "dataset_slug": dataset_slug,
        "target_file": target_file,
        "max_ideas": max_ideas,
        "mode": mode,
        "existing_titles": existing_titles,
        "forbidden_titles": forbidden_titles,
        "idea_schema": idea_schema,
    }

    if mode == "generate_only":
        cached = load_cached_exploration(repo, dataset_slug)
        if cached is None:
            raise ValueError(
                f"generate_only 模式需要 datasets/{slug_to_dir(dataset_slug)}/ 下已有探索产物"
            )
        payload["cached_exploration"] = cached

    return payload


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建 Kaggle kernel_inputs.json")
    parser.add_argument("--dataset-slug", required=True, help="Kaggle 数据集 slug")
    parser.add_argument("--max-ideas", type=int, default=3)
    parser.add_argument(
        "--mode",
        choices=("explore_and_generate", "generate_only"),
        default="explore_and_generate",
    )
    parser.add_argument("--existing", type=Path, help="fetch_existing_ideas 输出 JSON")
    parser.add_argument(
        "--forbidden",
        nargs="*",
        default=[],
        help="本轮禁止重复的标题（重试时追加）",
    )
    parser.add_argument(
        "--target-file",
        default="futures/um/klines/1h.parquet",
        help="数据集内目标数据文件相对路径",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=repo_root(),
    )
    parser.add_argument("-o", "--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    existing = load_existing_titles(args.existing)
    all_forbidden = list(dict.fromkeys(existing + list(args.forbidden)))

    try:
        payload = build_inputs(
            dataset_slug=args.dataset_slug,
            max_ideas=args.max_ideas,
            mode=args.mode,
            existing_titles=all_forbidden,
            forbidden_titles=list(args.forbidden),
            target_file=args.target_file,
            repo=args.repo_root.resolve(),
        )
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
        return 0
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
