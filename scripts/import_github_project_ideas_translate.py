#!/usr/bin/env python3
"""串行翻译并导入 GitHub Project 中尚无 factor_sql 的想法。

用法:
  uv run python scripts/import_github_project_ideas_translate.py --dry-run --limit 5
  AUTH_PASSWORD=... uv run python scripts/import_github_project_ideas_translate.py

  AUTH_PASSWORD=... uv run python scripts/import_github_project_ideas_translate.py

  默认使用本地 Project 缓存；更新缓存: --refresh
  --dry-run 只翻译不入库；正式导入请去掉 --dry-run

环境变量（仓库根 .env）:
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
  AUTH_PASSWORD 或 FACTOR_API_TOKEN

默认使用 OpenAI 兼容 SSE（stream=true），实时打印 [sse:reasoning] / [sse:content]。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import requests

from scripts.github_project_import_common import (
    DEFAULT_PROJECT_ID,
    ImportStats,
    add_project_cache_args,
    build_import_record,
    flush_import_batch,
    load_project_items,
    load_repo_env,
    load_translate_progress,
    mark_translate_progress,
    translate_progress_path,
    validate_factor_sql_basic,
)
from scripts.parse_project_idea import (
    infer_evaluation_type,
    load_factor_sql_from_evaluations,
    parse_factor_sql_from_body,
    parse_project_idea_body,
)
from scripts.validation_profiles import DEFAULT_PROFILE_KEY

WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0"


def load_translation_assets() -> tuple[str, dict[str, Any]]:
    template_path = REPO_ROOT / "workers" / "factor-ideas" / "assets" / "translate-idea-to-sql.txt"
    schema_path = REPO_ROOT / "workers" / "factor-ideas" / "assets" / "factor-sql-schema.json"
    return (
        template_path.read_text(encoding="utf-8"),
        json.loads(schema_path.read_text(encoding="utf-8")),
    )


def build_translation_prompt(
    template: str,
    schema: dict[str, Any],
    idea: dict[str, Any],
    profile_key: str,
    feedback: str = "",
) -> str:
    parts = [
        template,
        "",
        "## factor-sql-schema.json",
        json.dumps(schema, ensure_ascii=False, indent=2),
        "",
        "## 本次验证目标",
        json.dumps({"validation_profile_key": profile_key}, ensure_ascii=False, indent=2),
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
    if feedback:
        parts.extend(["", "## 上次校验/执行失败（必须修正 signal_sql）", feedback])
    return "\n".join(parts)


def extract_json_object(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    if trimmed.startswith("{"):
        payload = json.loads(trimmed)
    else:
        match = re.search(r"\{[\s\S]*\}", trimmed)
        if not match:
            raise ValueError("模型输出中未找到 JSON 对象")
        payload = json.loads(match.group(0))
    if not isinstance(payload, dict):
        raise ValueError("模型输出不是 JSON 对象")
    return payload


def _emit_sse_delta(
    delta: dict[str, Any],
    *,
    log_reasoning: bool,
    stream_state: dict[str, bool],
) -> str:
    """解析 SSE delta，实时打印并返回可拼接的正文片段。"""
    parts: list[str] = []
    reasoning = delta.get("reasoning_content")
    if log_reasoning and isinstance(reasoning, str) and reasoning:
        if not stream_state.get("reasoning_open"):
            print("[sse:reasoning] ", end="", flush=True)
            stream_state["reasoning_open"] = True
        print(reasoning, end="", flush=True)
    for key in ("content", "text"):
        value = delta.get(key)
        if isinstance(value, str) and value:
            if stream_state.get("reasoning_open") and not stream_state.get("content_open"):
                print("\n[sse:content] ", end="", flush=True)
                stream_state["content_open"] = True
            elif not stream_state.get("content_open"):
                print("[sse:content] ", end="", flush=True)
                stream_state["content_open"] = True
            print(value, end="", flush=True)
            parts.append(value)
    return "".join(parts)


def _parse_sse_data_line(
    data: str,
    *,
    log_reasoning: bool,
    stream_state: dict[str, bool],
) -> str:
    if data == "[DONE]":
        return ""
    try:
        event = json.loads(data)
    except json.JSONDecodeError:
        print(f"[sse:raw] {data}", flush=True)
        return ""

    if not isinstance(event, dict):
        return ""

    # 部分网关会把日志放在顶层字段
    for log_key in ("log", "message", "status", "comment"):
        log_value = event.get(log_key)
        if isinstance(log_value, str) and log_value.strip():
            print(f"[sse:{log_key}] {log_value}", flush=True)

    choices = event.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict):
                fragment = _emit_sse_delta(
                    delta,
                    log_reasoning=log_reasoning,
                    stream_state=stream_state,
                )
                if fragment:
                    return fragment
            message = choice.get("message")
            if isinstance(message, dict):
                fragment = _emit_sse_delta(
                    message,
                    log_reasoning=log_reasoning,
                    stream_state=stream_state,
                )
                if fragment:
                    return fragment

    # OpenAI 兼容错误事件
    error = event.get("error")
    if isinstance(error, dict):
        message = error.get("message") or json.dumps(error, ensure_ascii=False)
        raise RuntimeError(f"SSE 错误: {message}")
    if isinstance(error, str) and error:
        raise RuntimeError(f"SSE 错误: {error}")

    return ""


def call_openai_chat_stream(
    prompt: str,
    *,
    timeout: int,
    log_reasoning: bool = True,
) -> str:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("缺少 OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()

    print("[sse] >>> stream start", flush=True)
    response = requests.post(
        f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        json={
            "model": model,
            "temperature": 0.2,
            "stream": True,
            "messages": [
                {"role": "system", "content": "你是量化因子 SQL 翻译器，只输出合法 JSON 对象。"},
                {"role": "user", "content": prompt},
            ],
        },
        stream=True,
        timeout=(30, timeout),
    )
    response.raise_for_status()

    content_type = (response.headers.get("Content-Type") or "").lower()
    if "text/event-stream" not in content_type and "stream" not in content_type:
        body = response.json()
        choices = body.get("choices") or []
        content = choices[0].get("message", {}).get("content") if choices else None
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError(f"非 SSE 响应且无 content: {body}")
        print(content, flush=True)
        print("[sse] <<< stream end (non-sse fallback)", flush=True)
        return content

    chunks: list[str] = []
    stream_state = {"reasoning_open": False, "content_open": False}
    for raw_line in response.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(":"):
            print(f"[sse:keepalive] {line}", flush=True)
            continue
        if line.startswith("event:"):
            print(f"[sse:event] {line[6:].strip()}", flush=True)
            continue
        if not line.startswith("data:"):
            print(f"[sse:line] {line}", flush=True)
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        fragment = _parse_sse_data_line(
            data,
            log_reasoning=log_reasoning,
            stream_state=stream_state,
        )
        if fragment:
            chunks.append(fragment)

    print("", flush=True)
    print("[sse] <<< stream end", flush=True)
    content = "".join(chunks).strip()
    if not content:
        raise RuntimeError("SSE 流结束但 content 为空")
    return content


def call_openai_chat(prompt: str, *, timeout: int, stream: bool = True, log_reasoning: bool = True) -> str:
    if stream:
        return call_openai_chat_stream(prompt, timeout=timeout, log_reasoning=log_reasoning)
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("缺少 OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()
    response = requests.post(
        f"{base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        json={
            "model": model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": "你是量化因子 SQL 翻译器，只输出合法 JSON 对象。"},
                {"role": "user", "content": prompt},
            ],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    body = response.json()
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError(f"OpenAI 响应无 choices: {body}")
    content = choices[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("OpenAI 响应 content 为空")
    return content


def translate_idea_to_factor_sql(
    idea: dict[str, Any],
    profile_key: str,
    *,
    max_attempts: int = 3,
    timeout: int = 300,
    stream: bool = True,
    log_reasoning: bool = True,
) -> dict[str, Any]:
    template, schema = load_translation_assets()
    feedback = ""
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            if attempt > 1:
                print(f"[retry] 第 {attempt}/{max_attempts} 次", flush=True)
            prompt = build_translation_prompt(template, schema, idea, profile_key, feedback)
            raw = call_openai_chat(
                prompt,
                timeout=timeout,
                stream=stream,
                log_reasoning=log_reasoning,
            )
            factor_sql = extract_json_object(raw)
            validate_factor_sql_basic(factor_sql, idea["data_sources"])
            return factor_sql
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            feedback = str(exc)
            print(f"[retry] 失败: {exc}", file=sys.stderr, flush=True)
    raise RuntimeError(f"翻译失败: {last_error}" if last_error else "翻译失败")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="串行翻译并导入无 factor_sql 的 Project 想法")
    parser.add_argument("--project-id", default=os.environ.get("GITHUB_PROJECT_ID", DEFAULT_PROJECT_ID))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--profile-key", default=DEFAULT_PROFILE_KEY)
    parser.add_argument("--timeout", type=int, default=300, help="单次 LLM 请求超时秒数")
    parser.add_argument("--no-stream", action="store_true", help="禁用 SSE，使用普通 JSON 响应")
    parser.add_argument("--no-reasoning-log", action="store_true", help="不打印 reasoning_content 流")
    parser.add_argument("--sleep", type=float, default=1.0, help="每条翻译间隔秒数")
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--reset-progress",
        action="store_true",
        help="清空翻译导入进度（默认跳过已入库条目）",
    )
    add_project_cache_args(parser)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_repo_env()
    if not args.dry_run:
        from scripts.github_project_import_common import api_token

        _ = api_token()
    else:
        print("dry-run 模式：只翻译校验，不会写入 D1", flush=True)

    if args.reset_progress:
        progress_path = translate_progress_path(args.project_id)
        if progress_path.is_file():
            progress_path.unlink()
            print(f"已清空进度: {progress_path}", flush=True)

    items, _source = load_project_items(
        args.project_id,
        cache_path=args.cache,
        refresh=args.refresh,
    )
    completed = load_translate_progress(args.project_id)
    pending = [
        item
        for item in items
        if parse_factor_sql_from_body(item["body"]) is None
        and load_factor_sql_from_evaluations(item["title_hash"], REPO_ROOT) is None
        and item["title_hash"] not in completed
    ]
    if completed:
        print(f"跳过已入库 {len(completed)} 条（进度缓存）", flush=True)
    if args.limit > 0:
        pending = pending[: args.limit]
    print(f"待翻译 {len(pending)} 条（串行）", flush=True)

    stats = ImportStats(fetched=len(pending))
    batch_no = 0

    for index, item in enumerate(pending, start=1):
        parsed = parse_project_idea_body(item["body"])
        idea = {
            "title": item["title"],
            **parsed,
            "evaluation_type_hint": infer_evaluation_type(
                parsed["expected_signal"],
                parsed["formula_sketch"],
            ),
        }
        print(f"[{index}/{len(pending)}] 串行翻译: {item['title']}", flush=True)
        try:
            factor_sql = translate_idea_to_factor_sql(
                idea,
                args.profile_key,
                timeout=args.timeout,
                stream=not args.no_stream,
                log_reasoning=not args.no_reasoning_log,
            )
            stats.translated += 1
            record = build_import_record(item, factor_sql)
            stats.ready += 1
            if args.dry_run:
                print(f"  dry-run OK: {record['factor_sql']['signal_sql'][:80]}...", flush=True)
            else:
                batch_no += 1
                flush_import_batch([record], stats, dry_run=False, batch_no=batch_no)
                mark_translate_progress(args.project_id, item)
        except Exception as exc:  # noqa: BLE001
            stats.errors.append(f"{item['title']}: {exc}")
            print(f"  失败: {exc}", file=sys.stderr, flush=True)
        if args.sleep > 0 and index < len(pending):
            time.sleep(args.sleep)

    summary = {"mode": "translate_serial", "ok": len(stats.errors) == 0, "stats": stats.__dict__}
    print(
        f"完成: translated={stats.translated} created={stats.import_created} "
        f"skipped_api={stats.import_skipped} errors={len(stats.errors)}",
        flush=True,
    )
    if args.report:
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if not stats.errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
