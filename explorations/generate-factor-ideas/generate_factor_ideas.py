#!/usr/bin/env python3
"""Kaggle Kernel：探索数据 + Cursor 语义分析 + Cursor 生成因子想法。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

WORKING = Path("/kaggle/working")
SCRIPT_DIR = Path(__file__).resolve().parent
KERNEL_INPUTS_PATH = SCRIPT_DIR / "kernel_inputs.json"
KERNEL_INPUTS_INLINE = None  # __KERNEL_INPUTS_INLINE__
CURSOR_TIMEOUT = int(os.environ.get("CURSOR_TIMEOUT_SECONDS", "600"))


def load_kernel_inputs() -> dict[str, Any]:
    if KERNEL_INPUTS_INLINE is not None:
        return json.loads(KERNEL_INPUTS_INLINE)
    if KERNEL_INPUTS_PATH.is_file():
        with KERNEL_INPUTS_PATH.open(encoding="utf-8") as handle:
            return json.load(handle)
    raise RuntimeError(
        f"缺少 kernel_inputs：未注入 KERNEL_INPUTS_INLINE 且无 {KERNEL_INPUTS_PATH}"
    )


def setup_cursor_auth(inputs: dict[str, Any]) -> bool:
    auth = os.environ.get("CURSOR_AUTH_JSON", "").strip()
    if not auth:
        auth = str(inputs.get("cursor_auth_json") or "").strip()
    if not auth:
        injected = SCRIPT_DIR / ".cursor_auth_injected.json"
        if injected.is_file():
            auth = injected.read_text(encoding="utf-8").strip()
    if not auth:
        print("警告: 未设置 CURSOR_AUTH_JSON，跳过 Cursor 步骤")
        return False
    config_dir = Path.home() / ".config" / "cursor"
    config_dir.mkdir(parents=True, exist_ok=True)
    auth_path = config_dir / "auth.json"
    auth_path.write_text(auth, encoding="utf-8")
    auth_path.chmod(0o600)
    return True


def ensure_cursor_cli() -> str:
    cursor_bin = Path.home() / ".cursor" / "bin" / "agent"
    if cursor_bin.is_file():
        return str(cursor_bin.parent)

    print("安装 Cursor CLI...")
    subprocess.run(
        ["bash", "-c", "curl -fsSL https://cursor.com/install | bash"],
        check=True,
    )
    bin_dir = str(Path.home() / ".cursor" / "bin")
    os.environ["PATH"] = f"{bin_dir}:{os.environ.get('PATH', '')}"
    return bin_dir


def run_cursor_agent(prompt: str, output_path: Path) -> str:
    ensure_cursor_cli()
    cmd = [
        "timeout",
        str(CURSOR_TIMEOUT),
        "agent",
        "-p",
        "--force",
        "--output-format",
        "text",
        prompt,
    ]
    print(f"调用 Cursor agent（超时 {CURSOR_TIMEOUT}s）...")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=CURSOR_TIMEOUT + 60,
        check=False,
    )
    text = (result.stdout or "").strip()
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if result.returncode != 0 and not text:
        raise RuntimeError(f"Cursor agent 失败，exit={result.returncode}")
    output_path.write_text(text + ("\n" if text else ""), encoding="utf-8")
    return text


def fill_template(template: str, mapping: dict[str, str]) -> str:
    prompt = template
    for key, value in mapping.items():
        prompt = prompt.replace(key, value)
    return prompt


def format_titles(titles: list[str]) -> str:
    if not titles:
        return "（暂无已有想法）\n"
    return "\n".join(f"- {title}" for title in titles) + "\n"


EXPLORE_DATASET_EMBEDDED = None  # __EXPLORE_DATASET_EMBEDDED__


def ensure_explore_dataset_module() -> None:
    """Kaggle 仅上传主脚本时，从嵌入源码写出 explore_dataset.py。"""
    target = SCRIPT_DIR / "explore_dataset.py"
    if target.is_file():
        return
    if not EXPLORE_DATASET_EMBEDDED:
        raise RuntimeError("缺少 explore_dataset.py 且未嵌入 EXPLORE_DATASET_EMBEDDED")
    target.write_text(EXPLORE_DATASET_EMBEDDED, encoding="utf-8")


def run_exploration(slug: str) -> int:
    os.environ["DATASET_SLUG"] = slug
    ensure_explore_dataset_module()
    sys.path.insert(0, str(SCRIPT_DIR))
    import explore_dataset  # noqa: WPS433

    return explore_dataset.main()


def seed_cached_exploration(cached: dict[str, Any]) -> None:
    WORKING.mkdir(parents=True, exist_ok=True)
    if "files" in cached and "dataset" not in cached:
        schema = cached
        summary = {
            "dataset": schema.get("slug", ""),
            "explored_at": schema.get("explored_at"),
            "files": schema.get("files", []),
            "date_range": schema.get("date_range"),
            "factor_field_candidates": schema.get("factor_field_candidates", []),
            "warnings": schema.get("warnings", []),
            "catalog_summary": schema.get("catalog_summary"),
            "notes": "来自 Runner 注入的缓存探索产物（generate_only 模式）",
        }
    else:
        summary = cached
        schema_path = WORKING / "schema.json"
        if not schema_path.is_file():
            schema_path.write_text(
                json.dumps(cached, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

    (WORKING / "exploration_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_exploration_summary() -> dict[str, Any]:
    path = WORKING / "exploration_summary.json"
    if not path.is_file():
        raise FileNotFoundError("exploration_summary.json 不存在，探索步骤可能失败")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _try_parse_array(text: str) -> list[Any] | None:
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
    fence_pattern = re.compile(r"```(?:json)?\s*\n(.*?)\n```", re.DOTALL | re.IGNORECASE)
    for match in fence_pattern.finditer(text):
        parsed = _try_parse_array(match.group(1))
        if parsed is not None:
            return parsed
    return None


def _extract_balanced_array(text: str) -> list[Any] | None:
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
    for extractor in (_try_parse_array, _extract_from_code_fences, _extract_balanced_array):
        result = extractor(text)
        if result is not None:
            if not all(isinstance(item, dict) for item in result):
                raise ValueError("JSON 数组元素须为对象")
            return result
    raise ValueError("无法从 Cursor 输出中解析 JSON 数组")


def copy_working_artifacts_to_output() -> None:
    """确保 schema/README 等落在 working 目录供 kernels output 拉取。"""
    for name in ("schema.json", "README.md", "exploration_summary.json"):
        src = WORKING / name
        if src.is_file():
            continue
        bundled = SCRIPT_DIR / name
        if bundled.is_file():
            shutil.copy2(bundled, src)


def main() -> int:
    inputs = load_kernel_inputs()
    slug = inputs["dataset_slug"]
    mode = inputs.get("mode", "explore_and_generate")
    target_file = inputs.get("target_file", "futures/um/klines/1h.parquet")
    max_ideas = int(inputs.get("max_ideas", 3))
    existing_titles: list[str] = list(inputs.get("existing_titles") or [])

    def load_prompt(name: str, key: str) -> str:
        inline = inputs.get(key)
        if isinstance(inline, str) and inline.strip():
            return inline
        path = SCRIPT_DIR / "prompts" / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
        raise FileNotFoundError(f"缺少 prompt: {key} / {path}")

    WORKING.mkdir(parents=True, exist_ok=True)

    if mode == "generate_only":
        cached = inputs.get("cached_exploration")
        if not cached:
            print("错误: generate_only 模式缺少 cached_exploration", file=sys.stderr)
            return 1
        seed_cached_exploration(cached)
        print("已加载缓存探索产物（generate_only）")
    else:
        print(f"开始探索数据集: {slug}")
        rc = run_exploration(slug)
        if rc != 0:
            return rc

    summary = load_exploration_summary()
    summary_text = json.dumps(summary, ensure_ascii=False, indent=2)

    if not setup_cursor_auth(inputs):
        print("错误: Cursor 未配置，无法生成想法", file=sys.stderr)
        return 1

    explore_template_path = SCRIPT_DIR / "prompts" / "explore-dataset.txt"
    if (inputs.get("explore_prompt_template") or explore_template_path.is_file()) and mode != "generate_only":
        explore_template = load_prompt("explore-dataset.txt", "explore_prompt_template")
        explore_prompt = fill_template(
            explore_template,
            {
                "{{TARGET_FILE}}": target_file,
                "{{EXPLORATION_SUMMARY}}": summary_text,
            },
        )
        narrative = run_cursor_agent(explore_prompt, WORKING / "exploration_narrative_raw.txt")
        (WORKING / "exploration_narrative.md").write_text(narrative + "\n", encoding="utf-8")
        print("语义探索完成")
    else:
        narrative = ""
        cached_narrative = WORKING / "exploration_narrative.md"
        if cached_narrative.is_file():
            narrative = cached_narrative.read_text(encoding="utf-8")

    idea_template_path = SCRIPT_DIR / "prompts" / "generate-ideas-kaggle.txt"
    try:
        idea_template = load_prompt("generate-ideas-kaggle.txt", "idea_prompt_template")
    except FileNotFoundError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    idea_schema = inputs.get("idea_schema") or {}
    idea_prompt = fill_template(
        idea_template,
        {
            "{{IDEA_SCHEMA}}": json.dumps(idea_schema, ensure_ascii=False, indent=2),
            "{{MAX_IDEAS}}": str(max_ideas),
            "{{EXISTING_TITLES}}": format_titles(existing_titles),
            "{{EXPLORATION_SUMMARY}}": summary_text,
            "{{EXPLORATION_NARRATIVE}}": narrative or "（无语义探索报告）",
        },
    )

    ideas_raw = run_cursor_agent(idea_prompt, WORKING / "ideas_raw.txt")
    try:
        ideas = extract_ideas(ideas_raw)
        (WORKING / "ideas.json").write_text(
            json.dumps(ideas, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"已生成 {len(ideas)} 条想法并写入 ideas.json")
    except ValueError as exc:
        print(f"警告: 无法解析 ideas.json: {exc}", file=sys.stderr)
        print("ideas_raw.txt 已保留，Runner 将尝试二次解析", file=sys.stderr)

    copy_working_artifacts_to_output()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
