#!/usr/bin/env python3
"""导出 Worker 因子想法生成提示词到本地文件。"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_template() -> Path:
    return Path(__file__).resolve().parent / "prompts" / "generate-ideas-worker.txt"


def default_output() -> Path:
    return Path(__file__).resolve().parent / "prompts" / "generate-ideas-latest.txt"


def default_output_spec() -> Path:
    return repo_root() / "schemas" / "idea-output-spec.txt"


def default_factor_sql_rules() -> Path:
    return repo_root() / "schemas" / "idea-factor-sql-rules.txt"


def worker_assets_dir() -> Path:
    return repo_root() / "workers" / "factor-ideas" / "assets"


def slug_to_directory(slug: str) -> str:
    return slug.replace("/", "__")


def load_enabled_dataset_slugs(datasets_yaml: Path) -> list[str]:
    if not datasets_yaml.is_file():
        return ["yhydev97/quant-data"]
    text = datasets_yaml.read_text(encoding="utf-8")
    slugs: list[str] = []
    current_slug: str | None = None
    current_enabled = False
    for line in text.splitlines():
        slug_match = re.match(r"^\s+slug:\s+(.+)$", line)
        if slug_match:
            if current_slug and current_enabled:
                slugs.append(current_slug)
            current_slug = slug_match.group(1).strip()
            current_enabled = False
            continue
        enabled_match = re.match(r"^\s+enabled:\s+(true|false)", line)
        if enabled_match and current_slug:
            current_enabled = enabled_match.group(1) == "true"
    if current_slug and current_enabled:
        slugs.append(current_slug)
    return slugs or ["yhydev97/quant-data"]


def format_prompt_context_section(repo: Path) -> str:
    datasets_dir = repo / "datasets"
    slugs = load_enabled_dataset_slugs(datasets_dir / "datasets.yaml")
    parts: list[str] = []
    for slug in slugs:
        context_path = datasets_dir / slug_to_directory(slug) / "prompt-context.md"
        if not context_path.is_file():
            continue
        parts.append(f"### 数据集 `{slug}`\n\n{context_path.read_text(encoding='utf-8').strip()}\n")
    if not parts:
        return "（无已启用的数据集 prompt-context.md）\n"
    return "\n".join(parts)


def format_operators_section(operators: list[dict[str, Any]]) -> str:
    if not operators:
        return ""
    lines: list[str] = []
    for op in operators:
        block = [f"- **{op['name']}** `{op['signature']}`", f"  - {op['description']}"]
        if op.get("example"):
            block.append(f"  - 示例: `{op['example']}`")
        lines.append("\n".join(block))
    return f"## 已注册自定义算子\n\n{chr(10).join(lines)}\n"


def format_saturated_section(patterns: list[dict[str, Any]]) -> str:
    if not patterns:
        return ""
    body = "\n".join(f"- ({p['count']}×) `{p['expr_canonical']}`" for p in patterns)
    return f"## 饱和表达式（请避开雷同结构）\n\n{body}\n"


def build_prompt_text(
    *,
    template: str,
    output_spec: str,
    factor_sql_rules: str,
    dataset_section: str,
    active_operators: list[dict[str, Any]],
    saturated_patterns: list[dict[str, Any]],
    max_ideas: int,
) -> str:
    min_ideas = max(1, max_ideas)
    max_batch = max(min_ideas, min(5, max_ideas + 2))
    replacements = {
        "{{OUTPUT_SPEC}}": output_spec.strip(),
        "{{FACTOR_SQL_RULES}}": factor_sql_rules.strip(),
        "{{CUSTOM_OPS_SECTION}}": format_operators_section(active_operators),
        "{{SATURATED_SECTION}}": format_saturated_section(saturated_patterns),
        "{{MIN_IDEAS}}": str(min_ideas),
        "{{MAX_BATCH}}": str(max_batch),
        "{{DATASETS_SECTION}}": dataset_section.strip(),
    }
    prompt = template
    for key, value in replacements.items():
        prompt = prompt.replace(key, value)
    return prompt if prompt.endswith("\n") else prompt + "\n"


def fetch_json(url: str, token: str | None = None) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "quant-factors-export/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_active_operators(api_base: str, token: str | None) -> list[dict[str, Any]]:
    base = api_base.rstrip("/")
    url = f"{base}/api/operators?status=active&limit=200&offset=0"
    try:
        data = fetch_json(url, token)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"拉取自定义算子失败 ({exc.code}): {url}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 API: {url}") from exc
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [
        {
            "name": item["name"],
            "signature": item["signature"],
            "description": item["description"],
            **({"example": item["example"]} if item.get("example") else {}),
        }
        for item in items
        if item.get("name") and item.get("signature") and item.get("description")
    ]


def fetch_saturated_patterns(api_base: str, token: str | None, limit: int = 5) -> list[dict[str, Any]]:
    base = api_base.rstrip("/")
    url = f"{base}/api/ideas?limit={max(limit * 20, 100)}&offset=0"
    try:
        data = fetch_json(url, token)
    except (urllib.error.HTTPError, urllib.error.URLError):
        return []
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    counts: dict[str, int] = {}
    for item in items:
        canonical = item.get("expr_canonical")
        if not canonical:
            continue
        counts[canonical] = counts.get(canonical, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return [{"expr_canonical": expr, "count": count} for expr, count in ranked[:limit]]


def sync_worker_assets(
    template_path: Path,
    output_spec_path: Path,
    factor_sql_rules_path: Path,
) -> None:
    assets = worker_assets_dir()
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copy2(template_path, assets / "generate-ideas-worker.txt")
    shutil.copy2(output_spec_path, assets / "idea-output-spec.txt")
    shutil.copy2(factor_sql_rules_path, assets / "idea-factor-sql-rules.txt")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导出 Worker 因子想法生成提示词")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=repo_root(),
        help="仓库根目录",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=default_template(),
        help="提示词模板",
    )
    parser.add_argument(
        "--output-spec",
        type=Path,
        default=default_output_spec(),
        help="想法输出格式说明（替代完整 JSON Schema）",
    )
    parser.add_argument(
        "--factor-sql-rules",
        type=Path,
        default=default_factor_sql_rules(),
        help="factor_sql 翻译规则片段",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=default_output(),
        help="输出文件路径",
    )
    parser.add_argument(
        "--max-ideas",
        type=int,
        default=3,
        help="与 Worker MAX_IDEAS 对齐，用于 MIN/MAX 条数占位符",
    )
    parser.add_argument(
        "--api-base",
        help="可选：从 factor-ideas Worker / Dashboard API 拉取算子与饱和模式",
    )
    parser.add_argument(
        "--token",
        help="API Bearer token（也可用环境变量 FACTOR_API_TOKEN）",
    )
    parser.add_argument(
        "--sync-assets",
        action="store_true",
        help="同步模板与 schema 到 workers/factor-ideas/assets/",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    import os

    args = parse_args(argv)
    if not args.template.is_file():
        print(f"错误: 模板不存在: {args.template}", file=sys.stderr)
        return 1
    if not args.output_spec.is_file():
        print(f"错误: output spec 不存在: {args.output_spec}", file=sys.stderr)
        return 1
    if not args.factor_sql_rules.is_file():
        print(f"错误: factor_sql 规则不存在: {args.factor_sql_rules}", file=sys.stderr)
        return 1

    template = args.template.read_text(encoding="utf-8")
    output_spec = args.output_spec.read_text(encoding="utf-8")
    factor_sql_rules = args.factor_sql_rules.read_text(encoding="utf-8")
    dataset_section = format_prompt_context_section(args.repo_root)

    active_operators: list[dict[str, Any]] = []
    saturated_patterns: list[dict[str, Any]] = []
    token = args.token or os.environ.get("FACTOR_API_TOKEN")
    if args.api_base:
        active_operators = fetch_active_operators(args.api_base, token)
        saturated_patterns = fetch_saturated_patterns(args.api_base, token)

    prompt = build_prompt_text(
        template=template,
        output_spec=output_spec,
        factor_sql_rules=factor_sql_rules,
        dataset_section=dataset_section,
        active_operators=active_operators,
        saturated_patterns=saturated_patterns,
        max_ideas=args.max_ideas,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(prompt, encoding="utf-8")
    print(f"Wrote {args.output} ({len(prompt.encode('utf-8'))} bytes)")

    if args.sync_assets:
        sync_worker_assets(args.template, args.output_spec, args.factor_sql_rules)
        print(f"Synced assets to {worker_assets_dir()}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
