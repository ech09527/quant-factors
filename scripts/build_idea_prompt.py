"""汇总数据集说明与已有想法，生成 Cursor 因子想法 prompt。"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import json
from datetime import datetime, timezone
from typing import Any

STALE_DAYS = 14


def repo_root() -> Path:
    """返回仓库根目录。"""
    return Path(__file__).resolve().parent.parent


def default_prompt_template() -> Path:
    """默认 prompt 模板路径。"""
    return Path(__file__).resolve().parent / "prompts" / "generate-ideas.txt"


def load_existing_titles(path: Path | None) -> list[str]:
    """从 fetch_existing_ideas 输出提取已有标题。"""
    if path is None:
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "ideas" in data:
        return [item["title"] for item in data["ideas"] if item.get("title")]
    if isinstance(data, list):
        return [item["title"] for item in data if item.get("title")]
    return []


def check_schema_freshness(schema_path: Path, slug: str) -> None:
    """检查 explored_at 是否超过 STALE_DAYS 天，过期则 stderr 警告。"""
    with open(schema_path, encoding="utf-8") as f:
        schema = json.load(f)
    explored_at = schema.get("explored_at")
    if not explored_at:
        print(f"警告: {slug} 缺少 explored_at", file=sys.stderr)
        return

    try:
        explored = datetime.fromisoformat(explored_at.replace("Z", "+00:00"))
    except ValueError:
        print(f"警告: {slug} explored_at 格式无效: {explored_at}", file=sys.stderr)
        return

    if explored.tzinfo is None:
        explored = explored.replace(tzinfo=timezone.utc)

    age_days = (datetime.now(timezone.utc) - explored).days
    if age_days > STALE_DAYS:
        print(
            f"警告: {slug} 探索数据已 {age_days} 天未更新（>{STALE_DAYS} 天），"
            f"explored_at={explored_at}",
            file=sys.stderr,
        )


def collect_dataset_summaries(datasets_dir: Path) -> list[dict[str, Any]]:
    """遍历 datasets/*/ 收集 README 与 schema 摘要。"""
    summaries: list[dict[str, Any]] = []
    if not datasets_dir.is_dir():
        return summaries

    for entry in sorted(datasets_dir.iterdir()):
        if not entry.is_dir():
            continue
        readme_path = entry / "README.md"
        schema_path = entry / "schema.json"
        if not readme_path.is_file() and not schema_path.is_file():
            continue

        slug = entry.name.replace("__", "/")
        summary: dict[str, Any] = {"slug": slug, "directory": entry.name}

        if schema_path.is_file():
            with open(schema_path, encoding="utf-8") as f:
                schema = json.load(f)
            summary["schema"] = schema
            summary["slug"] = schema.get("slug", slug)
            summary["explored_at"] = schema.get("explored_at")
            check_schema_freshness(schema_path, summary["slug"])

        if readme_path.is_file():
            summary["readme"] = readme_path.read_text(encoding="utf-8")

        summaries.append(summary)

    return summaries


def format_dataset_section(summaries: list[dict[str, Any]]) -> str:
    """将数据集摘要格式化为 prompt 段落。"""
    if not summaries:
        return "（当前无已探索的数据集目录，请先运行工作流 A 完成数据探索。）\n"

    parts: list[str] = []
    for item in summaries:
        parts.append(f"### 数据集: `{item['slug']}`")
        if item.get("explored_at"):
            parts.append(f"- 探索时间: {item['explored_at']}")
        if item.get("readme"):
            parts.append("\n#### README\n")
            parts.append(item["readme"].strip())
        if item.get("schema"):
            parts.append("\n#### schema.json\n")
            parts.append("```json")
            parts.append(json.dumps(item["schema"], ensure_ascii=False, indent=2))
            parts.append("```")
        parts.append("")
    return "\n".join(parts)


def format_existing_titles(titles: list[str]) -> str:
    """格式化已有想法标题列表。"""
    if not titles:
        return "（暂无已有想法）\n"
    lines = [f"- {title}" for title in titles]
    return "\n".join(lines) + "\n"


def build_prompt(
    template_path: Path,
    datasets_dir: Path,
    existing_titles: list[str],
) -> str:
    """组装完整 prompt 文本。"""
    template = template_path.read_text(encoding="utf-8")
    summaries = collect_dataset_summaries(datasets_dir)
    schema_path = repo_root() / "schemas" / "idea-schema.json"
    schema_text = schema_path.read_text(encoding="utf-8")

    replacements = {
        "{{DATASETS_SECTION}}": format_dataset_section(summaries),
        "{{EXISTING_TITLES}}": format_existing_titles(existing_titles),
        "{{IDEA_SCHEMA}}": schema_text.strip(),
    }

    prompt = template
    for key, value in replacements.items():
        prompt = prompt.replace(key, value)
    return prompt


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生成 Cursor 因子想法 prompt"
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=repo_root(),
        help="仓库根目录（默认自动检测）",
    )
    parser.add_argument(
        "--existing",
        type=Path,
        help="已有想法 JSON（fetch_existing_ideas 输出）",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=default_prompt_template(),
        help="prompt 模板文件",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="输出文件路径（默认 stdout）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    datasets_dir = args.repo_root / "datasets"
    existing_titles = load_existing_titles(args.existing)

    if not args.template.is_file():
        print(f"错误: 模板文件不存在: {args.template}", file=sys.stderr)
        return 1

    prompt = build_prompt(args.template, datasets_dir, existing_titles)

    if args.output:
        text = prompt if prompt.endswith("\n") else prompt + "\n"
        args.output.write_text(text, encoding="utf-8")
    else:
        print(prompt, end="" if prompt.endswith("\n") else "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
