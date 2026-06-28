"""从 Cursor CLI 文本输出中提取并校验因子想法 JSON 数组。"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import json
import re
from typing import Any

import jsonschema


def repo_root() -> Path:
    """返回仓库根目录（scripts/ 的上级）。"""
    return Path(__file__).resolve().parent.parent


def load_schema() -> dict[str, Any]:
    """加载 idea-schema.json。"""
    schema_path = repo_root() / "schemas" / "idea-schema.json"
    with open(schema_path, encoding="utf-8") as f:
        return json.load(f)


def _try_parse_array(text: str) -> list[Any] | None:
    """尝试将文本解析为 JSON 数组或含 ideas 数组的对象。"""
    stripped = text.strip()
    if not stripped:
        return None

    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        return None

    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("ideas"), list):
        return data["ideas"]
    return None


def _extract_from_code_fences(text: str) -> list[Any] | None:
    """从 markdown ```json / ``` 代码块中提取 JSON 数组。"""
    fence_pattern = re.compile(
        r"```(?:json)?\s*\n(.*?)\n```",
        re.DOTALL | re.IGNORECASE,
    )
    for match in fence_pattern.finditer(text):
        parsed = _try_parse_array(match.group(1))
        if parsed is not None:
            return parsed
    return None


def _extract_balanced_array(text: str) -> list[Any] | None:
    """扫描文本中首个平衡的 [...] 并尝试解析。"""
    start = text.find("[")
    while start != -1:
        depth = 0
        in_string = False
        escape = False

        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
                if depth == 0:
                    parsed = _try_parse_array(text[start : index + 1])
                    if parsed is not None:
                        return parsed
                    break

        start = text.find("[", start + 1)
    return None


def extract_ideas(text: str) -> list[dict[str, Any]]:
    """从 Cursor 输出文本中提取想法 JSON 数组。"""
    for extractor in (
        _try_parse_array,
        _extract_from_code_fences,
        _extract_balanced_array,
    ):
        result = extractor(text)
        if result is not None:
            if not all(isinstance(item, dict) for item in result):
                raise ValueError("JSON 数组元素须为对象")
            return result

    raise ValueError(
        "无法从 Cursor 输出中解析 JSON 数组（支持纯 JSON、markdown 代码块或嵌入的 [...]）"
    )


def validate_ideas(ideas: list[dict[str, Any]], schema: dict[str, Any]) -> None:
    """逐条校验想法是否符合 schema。"""
    for index, idea in enumerate(ideas):
        try:
            jsonschema.validate(instance=idea, schema=schema)
        except jsonschema.ValidationError as exc:
            raise ValueError(f"第 {index + 1} 条想法校验失败: {exc.message}") from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 Cursor CLI 文本输出提取并校验因子想法 JSON 数组"
    )
    parser.add_argument(
        "input",
        type=Path,
        nargs="?",
        help="Cursor 输出文本文件（默认 stdin）",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="输出 JSON 文件路径（默认 stdout，输出纯数组）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        if args.input:
            text = args.input.read_text(encoding="utf-8")
        else:
            text = sys.stdin.read()

        ideas = extract_ideas(text)
        schema = load_schema()
        validate_ideas(ideas, schema)

        payload = json.dumps(ideas, ensure_ascii=False, indent=2)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(payload)
                f.write("\n")
        else:
            print(payload)
        return 0
    except (ValueError, OSError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
