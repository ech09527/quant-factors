#!/usr/bin/env python3
"""使用大模型 API 将因子想法翻译为 factor_sql。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.run_local_factor_evaluation import run_local_evaluation
from scripts.validate_sql import validate_factor_sql

MAX_TRANSLATION_ATTEMPTS = int(os.environ.get("TRANSLATION_MAX_ATTEMPTS", "3"))
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
FACTOR_API_BASE_URL = os.environ.get("FACTOR_API_BASE_URL", "").strip()
FACTOR_API_TOKEN = os.environ.get("FACTOR_API_TOKEN", "").strip()
WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0"


def fetch_llm_config_from_api(
    *,
    usage: str = "validation_translation",
    base_url: str | None = None,
    token: str | None = None,
) -> list[dict[str, Any]]:
    api_base = (base_url or FACTOR_API_BASE_URL).rstrip("/")
    auth_token = (token or FACTOR_API_TOKEN).strip()
    if not api_base or not auth_token:
        raise RuntimeError("缺少 FACTOR_API_BASE_URL 或 FACTOR_API_TOKEN，无法从 API 读取 LLM 配置")

    url = f"{api_base}/api/workflow/llm-config?usage={usage}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {auth_token}",
            "User-Agent": WORKFLOW_HTTP_USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"读取 LLM 配置失败: HTTP {exc.code} {detail[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"读取 LLM 配置失败: {exc}") from exc

    data = json.loads(raw)
    routes = data.get("routes")
    if isinstance(routes, list) and routes:
        return routes
    if data.get("api_key"):
        return [data]
    raise RuntimeError("LLM 配置 API 未返回可用 routes")


def resolve_llm_runtime_configs() -> list[dict[str, Any]]:
    if FACTOR_API_BASE_URL and FACTOR_API_TOKEN:
        try:
            return fetch_llm_config_from_api()
        except RuntimeError as exc:
            print(f"警告: 无法从 API 读取 LLM 配置，尝试环境变量: {exc}", file=sys.stderr)

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("未配置 LLM：请在 D1 添加 Provider，或设置 FACTOR_API_* / OPENAI_API_KEY")
    return [
        {
            "base_url": OPENAI_BASE_URL,
            "api_key": api_key,
            "model": OPENAI_MODEL,
            "auth_header": "Authorization",
            "auth_scheme": "Bearer",
            "temperature": 0.1,
            "source": "env",
            "priority": 0,
        }
    ]


def build_auth_header(config: dict[str, Any]) -> dict[str, str]:
    header = str(config.get("auth_header") or "Authorization")
    scheme = str(config.get("auth_scheme") or "Bearer").strip()
    token = str(config["api_key"])
    if scheme.lower() == "bearer":
        return {header: f"Bearer {token}"}
    if scheme.lower() == "token":
        return {header: f"token {token}"}
    return {header: f"{scheme} {token}"}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def extract_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("{"):
        return json.loads(text)
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise ValueError("模型输出中未找到 JSON 对象")
    return json.loads(match.group(0))


def build_prompt(
    idea: dict[str, Any],
    schema: dict[str, Any],
    *,
    validation_profile_key: str,
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
        "## 本次验证目标",
        json.dumps({"validation_profile_key": validation_profile_key}, ensure_ascii=False, indent=2),
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
            ]
        )
    return "\n".join(parts)


def call_openai(prompt: str) -> str:
    configs = resolve_llm_runtime_configs()
    last_error: Exception | None = None
    for config in configs:
        base_url = str(config.get("base_url") or OPENAI_BASE_URL).rstrip("/")
        url = f"{base_url}/chat/completions"
        temperature = config.get("temperature")
        if temperature is None:
            temperature = 0.1
        payload = {
            "model": config.get("model") or OPENAI_MODEL,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": "你是量化因子 SQL 翻译器，只输出合法 JSON 对象。"},
                {"role": "user", "content": prompt},
            ],
        }
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                **build_auth_header(config),
                "User-Agent": WORKFLOW_HTTP_USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            last_error = RuntimeError(f"模型接口失败: HTTP {exc.code} {detail[:300]}")
            continue
        except urllib.error.URLError as exc:
            last_error = RuntimeError(f"模型接口失败: {exc}")
            continue

        data = json.loads(raw)
        choices = data.get("choices") or []
        if not choices:
            last_error = RuntimeError("模型接口返回空 choices")
            continue
        content = choices[0].get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            last_error = RuntimeError("模型接口返回空 content")
            continue
        return content

    raise last_error or RuntimeError("所有 LLM 路由均失败")


def translate_idea(
    idea: dict[str, Any],
    *,
    validation_profile_key: str,
    with_local_eval: bool = False,
    sample_start: str = "2023-01-01",
) -> dict[str, Any]:
    schema_path = repo_root() / "schemas" / "factor-sql-schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    last_error: Exception | None = None
    feedback = ""
    for attempt in range(1, MAX_TRANSLATION_ATTEMPTS + 1):
        try:
            raw = call_openai(
                build_prompt(
                    idea,
                    schema,
                    validation_profile_key=validation_profile_key,
                    validation_feedback=feedback,
                ),
            )
            factor_sql = extract_json_object(raw)
            validate_factor_sql(factor_sql)
            if with_local_eval:
                run_local_evaluation(idea, factor_sql, sample_start=sample_start)
            return factor_sql
        except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            feedback = str(exc)
            print(
                f"翻译校验失败 ({attempt}/{MAX_TRANSLATION_ATTEMPTS}): {exc}",
                file=sys.stderr,
            )
    raise ValueError(f"多次翻译校验失败: {last_error}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="使用大模型翻译因子想法为 factor_sql.json")
    parser.add_argument("--idea", type=Path, required=True)
    parser.add_argument("--validation-profile-key", default="fwd_ret_1")
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--with-local-eval", action="store_true")
    parser.add_argument(
        "--sample-start",
        default=os.environ.get("SAMPLE_START", "2023-01-01"),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    with args.idea.open(encoding="utf-8") as handle:
        idea = json.load(handle)

    try:
        factor_sql = translate_idea(
            idea,
            validation_profile_key=args.validation_profile_key,
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
