"""使用 Cursor CLI 将因子想法翻译为 factor_sql.json。"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.run_local_factor_evaluation import run_local_evaluation
from scripts.validate_sql import validate_factor_sql

CURSOR_TIMEOUT = int(os.environ.get("CURSOR_TIMEOUT_SECONDS", "600"))
MAX_TRANSLATION_ATTEMPTS = int(os.environ.get("TRANSLATION_MAX_ATTEMPTS", "3"))


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_agent_binary() -> str:
    local_bin = Path.home() / ".local" / "bin"
    candidates = [
        local_bin / "agent",
        local_bin / "cursor-agent",
        Path.home() / ".cursor" / "bin" / "agent",
        Path.home() / ".cursor" / "bin" / "cursor-agent",
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())

    print("安装 Cursor CLI...")
    subprocess.run(
        ["bash", "-c", "curl -fsSL https://cursor.com/install | bash"],
        check=True,
    )
    os.environ["PATH"] = f"{local_bin}:{os.environ.get('PATH', '')}"
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
    raise RuntimeError("Cursor agent 安装后未找到可执行文件")


def extract_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("{"):
        return json.loads(text)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("Cursor 输出中未找到 JSON 对象")
    return json.loads(match.group(0))


def build_prompt(
    idea: dict[str, Any],
    schema: dict[str, Any],
    *,
    validation_feedback: str = "",
) -> str:
    template = (
        repo_root() / "scripts" / "prompts" / "translate-idea-to-sql.txt"
    ).read_text(encoding="utf-8")
    parts = [
        template,
        "",
        "## factor-sql-schema.json",
        json.dumps(schema, ensure_ascii=False, indent=2),
        "",
        "## 因子想法",
        json.dumps(
            {
                "title": idea["title"],
                "hypothesis": idea["hypothesis"],
                "formula_sketch": idea["formula_sketch"],
                "expected_signal": idea["expected_signal"],
                "evaluation_type_hint": idea.get("evaluation_type_hint"),
                "data_sources": idea["data_sources"],
            },
            ensure_ascii=False,
            indent=2,
        ),
    ]
    if validation_feedback:
        parts.extend(
            [
                "",
                "## 上次校验/执行失败（必须修正 signal_sql）",
                validation_feedback,
                "",
                "修正后须能通过：",
                "1. `python scripts/validate_sql.py <factor_sql.json>`",
                "2. `python scripts/run_local_factor_evaluation.py --idea <idea.json> --factor-sql <factor_sql.json>`",
            ]
        )
    return "\n".join(parts)


def run_cursor(prompt: str) -> str:
    agent_bin = resolve_agent_binary()
    cmd = [
        "timeout",
        str(CURSOR_TIMEOUT),
        agent_bin,
        "-p",
        "--force",
        "--output-format",
        "text",
        prompt,
    ]
    print(f"调用 Cursor agent（超时 {CURSOR_TIMEOUT}s）...")
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"Cursor 失败 (code={result.returncode}): {result.stderr or result.stdout}"
        )
    return result.stdout


def translate_idea(
    idea: dict[str, Any],
    *,
    use_cursor: bool = True,
    factor_sql_override: Path | None = None,
    with_local_eval: bool = False,
    sample_start: str = "2023-01-01",
) -> dict[str, Any]:
    if factor_sql_override is not None:
        with factor_sql_override.open(encoding="utf-8") as handle:
            factor_sql = json.load(handle)
        validate_factor_sql(factor_sql)
        if with_local_eval:
            run_local_evaluation(idea, factor_sql, sample_start=sample_start)
        return factor_sql

    if not use_cursor:
        raise ValueError("未提供 --factor-sql 且未启用 Cursor")

    schema_path = repo_root() / "schemas" / "factor-sql-schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    last_error: Exception | None = None
    feedback = ""
    for attempt in range(1, MAX_TRANSLATION_ATTEMPTS + 1):
        try:
            raw = run_cursor(build_prompt(idea, schema, validation_feedback=feedback))
            factor_sql = extract_json_object(raw)
            validate_factor_sql(factor_sql)
            if with_local_eval:
                run_local_evaluation(idea, factor_sql, sample_start=sample_start)
            return factor_sql
        except (ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            feedback = str(exc)
            print(
                f"翻译校验失败 ({attempt}/{MAX_TRANSLATION_ATTEMPTS}): {exc}",
                file=sys.stderr,
            )
    raise ValueError(f"多次翻译校验失败: {last_error}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="翻译因子想法为 factor_sql.json")
    parser.add_argument("--idea", type=Path, required=True, help="单条 idea JSON")
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument(
        "--factor-sql",
        type=Path,
        help="跳过 Cursor，直接使用已有 factor_sql.json",
    )
    parser.add_argument(
        "--skip-cursor",
        action="store_true",
        help="与 --factor-sql 配合；无 Cursor 时用于本地测试",
    )
    parser.add_argument(
        "--with-local-eval",
        action="store_true",
        help="翻译后在 Runner 上用合成数据执行本地评估，失败时将报错反馈给 Cursor 重试",
    )
    parser.add_argument(
        "--sample-start",
        default=os.environ.get("SAMPLE_START", "2023-01-01"),
        help="本地评估样本起始日",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)

    try:
        factor_sql = translate_idea(
            idea,
            use_cursor=not args.skip_cursor,
            factor_sql_override=args.factor_sql,
            with_local_eval=args.with_local_eval,
            sample_start=args.sample_start,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(factor_sql, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已写入 {args.output}")
        return 0
    except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
