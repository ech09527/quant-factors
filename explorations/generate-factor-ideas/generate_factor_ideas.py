#!/usr/bin/env python3
"""Kaggle Kernel：Cursor Agent 自主查 K 线并生成因子想法。"""

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
AGENT_CURSOR_TIMEOUT = int(os.environ.get("AGENT_CURSOR_TIMEOUT_SECONDS", "1800"))
SUPPORTED_EXTENSIONS = {".csv", ".parquet", ".pq"}


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
    # 与 scripts/cursor_auth.py 保持同步；Kaggle 上通过 bundle 复制该模块。
    cursor_auth_py = SCRIPT_DIR / "cursor_auth.py"
    if cursor_auth_py.is_file():
        import importlib.util

        spec = importlib.util.spec_from_file_location("cursor_auth", cursor_auth_py)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if module.setup_cursor_auth(inputs=inputs):
                return True
            print(
                "警告: 未找到 Cursor 凭据（CURSOR_AUTH_JSON / CURSOR_API_KEY / auth.json），"
                "跳过 Cursor 步骤"
            )
            return False

    auth = str(inputs.get("cursor_auth_json") or "").strip()
    if not auth:
        auth = os.environ.get("CURSOR_AUTH_JSON", "").strip()
    if auth:
        config_dir = Path.home() / ".config" / "cursor"
        config_dir.mkdir(parents=True, exist_ok=True)
        auth_path = config_dir / "auth.json"
        auth_path.write_text(auth, encoding="utf-8")
        auth_path.chmod(0o600)
        return True

    api_key = str(inputs.get("cursor_api_key") or "").strip()
    if not api_key:
        api_key = os.environ.get("CURSOR_API_KEY", "").strip()
    if api_key:
        os.environ["CURSOR_API_KEY"] = api_key
        return True

    auth_path = Path.home() / ".config" / "cursor" / "auth.json"
    if auth_path.is_file():
        return True

    print(
        "警告: 未找到 Cursor 凭据（CURSOR_AUTH_JSON / CURSOR_API_KEY / auth.json），"
        "跳过 Cursor 步骤"
    )
    return False


def resolve_agent_binary() -> str:
    """定位 Cursor agent 可执行文件；缺失时安装 CLI。"""
    local_bin = Path.home() / ".local" / "bin"
    versions_root = Path.home() / ".local" / "share" / "cursor-agent" / "versions"
    candidates = [
        local_bin / "agent",
        local_bin / "cursor-agent",
        Path.home() / ".cursor" / "bin" / "agent",
        Path.home() / ".cursor" / "bin" / "cursor-agent",
    ]
    if versions_root.is_dir():
        for version_dir in sorted(versions_root.iterdir(), reverse=True):
            candidates.extend(
                [
                    version_dir / "cursor-agent",
                    version_dir / "agent",
                ]
            )

    def find_agent() -> str | None:
        for candidate in candidates:
            if candidate.is_file() or candidate.is_symlink():
                resolved = candidate.resolve()
                if resolved.is_file() and os.access(resolved, os.X_OK):
                    return str(resolved)
        cursor_root = Path.home() / ".local" / "share" / "cursor-agent"
        if cursor_root.is_dir():
            for path in sorted(cursor_root.rglob("cursor-agent")):
                if path.is_file() and os.access(path, os.X_OK):
                    return str(path)
        return None

    found = find_agent()
    if found:
        return found

    print("安装 Cursor CLI...")
    subprocess.run(
        ["bash", "-c", "curl -fsSL https://cursor.com/install | bash"],
        check=True,
    )
    local_bin_str = str(local_bin)
    os.environ["PATH"] = f"{local_bin_str}:{os.environ.get('PATH', '')}"

    found = find_agent()
    if found:
        return found

    for listing_dir in (local_bin, versions_root):
        if listing_dir.is_dir():
            listing = ", ".join(sorted(p.name for p in listing_dir.iterdir()))
            print(f"警告: {listing_dir} 内容: {listing}", file=sys.stderr)
    raise RuntimeError("Cursor agent 安装后未找到可执行文件")


def run_cursor_agent(
    prompt: str,
    output_path: Path,
    *,
    timeout: int | None = None,
    cwd: Path | None = None,
) -> str:
    agent_bin = resolve_agent_binary()
    effective_timeout = timeout if timeout is not None else CURSOR_TIMEOUT
    cmd = [
        "timeout",
        str(effective_timeout),
        agent_bin,
        "-p",
        "--force",
        "--output-format",
        "text",
        prompt,
    ]
    print(f"调用 Cursor agent（超时 {effective_timeout}s，cwd={cwd or Path.cwd()}）...")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=effective_timeout + 60,
        check=False,
        cwd=str(cwd) if cwd else None,
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


def slug_to_input_path(slug: str) -> Path:
    normalized = slug.strip().strip("/")
    if not normalized or "/" not in normalized:
        raise RuntimeError(f"Invalid dataset slug: {slug}")
    return Path("/kaggle/input") / normalized.replace("/", "-")


def discover_data_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            files.append(path)
    return files


def resolve_dataset_root(slug: str) -> Path:
    expected = slug_to_input_path(slug)
    if expected.is_dir():
        return expected

    input_root = Path("/kaggle/input")
    if not input_root.is_dir():
        raise FileNotFoundError(f"Kaggle 挂载目录不存在: {input_root}")

    target = slug.strip().strip("/").replace("/", "-")
    candidates = [
        child
        for child in sorted(input_root.iterdir())
        if child.is_dir() and not child.name.startswith(".") and target in child.name
    ]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        for child in sorted(input_root.iterdir()):
            if child.is_dir() and discover_data_files(child):
                candidates.append(child)
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        return candidates[0]

    mounts = [p.name for p in input_root.iterdir() if p.is_dir()]
    raise FileNotFoundError(
        f"未找到数据集挂载 {expected}；可用 mounts: {mounts}"
    )


def resolve_parquet_path(slug: str, target_file: str) -> Path:
    root = resolve_dataset_root(slug)
    direct = root / target_file
    if direct.is_file():
        return direct

    matches = [p for p in discover_data_files(root) if p.name == Path(target_file).name]
    if len(matches) == 1:
        return matches[0]
    if matches:
        return matches[0]

    all_files = discover_data_files(root)
    if len(all_files) == 1:
        return all_files[0]
    raise FileNotFoundError(
        f"在 {root} 下未找到目标文件 {target_file!r}；"
        f"候选: {[str(p.relative_to(root)) for p in all_files[:10]]}"
    )


def format_dataset_schema(schema: dict[str, Any]) -> str:
    if not schema:
        return "（无 schema，请先运行工作流 A 或检查 datasets/ 目录）\n"
    compact = {
        "slug": schema.get("slug"),
        "explored_at": schema.get("explored_at"),
        "catalog_summary": schema.get("catalog_summary"),
        "warnings": schema.get("warnings"),
        "files": [],
    }
    for file_info in schema.get("files") or []:
        compact["files"].append(
            {
                "name": file_info.get("name"),
                "row_count": file_info.get("row_count"),
                "sample_rows": file_info.get("sample_rows"),
                "symbol_count_in_sample": file_info.get("symbol_count_in_sample"),
                "columns": [
                    {
                        "name": col.get("name"),
                        "dtype": col.get("dtype"),
                        "null_rate": col.get("null_rate"),
                    }
                    for col in (file_info.get("columns") or [])
                ],
            }
        )
    return json.dumps(compact, ensure_ascii=False, indent=2)


def setup_agent_workspace(parquet_path: Path, schema: dict[str, Any]) -> Path:
    WORKING.mkdir(parents=True, exist_ok=True)
    working_target = WORKING / "query_klines.py"
    query_src = SCRIPT_DIR / "query_klines.py"
    if query_src.is_file():
        shutil.copy2(query_src, working_target)
    elif QUERY_KLINES_EMBEDDED:
        working_target.write_text(QUERY_KLINES_EMBEDDED, encoding="utf-8")
    else:
        raise FileNotFoundError(f"缺少 query_klines.py: {query_src}")

    os.environ["KLINES_PARQUET_PATH"] = str(parquet_path)
    os.environ["EXPLORATION_LOG_PATH"] = str(WORKING / "exploration_log.json")

    if schema:
        (WORKING / "schema.json").write_text(
            json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return working_target


EXPLORE_DATASET_EMBEDDED = None  # __EXPLORE_DATASET_EMBEDDED__
QUERY_KLINES_EMBEDDED = None  # __QUERY_KLINES_EMBEDDED__


def ensure_explore_dataset_module() -> None:
    """将嵌入的 explore_dataset 写到 /kaggle/working（/kaggle/src 只读）。"""
    working_target = WORKING / "explore_dataset.py"
    if working_target.is_file():
        sys.path.insert(0, str(WORKING))
        return
    if not EXPLORE_DATASET_EMBEDDED:
        raise RuntimeError("缺少 explore_dataset.py 且未嵌入 EXPLORE_DATASET_EMBEDDED")
    WORKING.mkdir(parents=True, exist_ok=True)
    working_target.write_text(EXPLORE_DATASET_EMBEDDED, encoding="utf-8")
    sys.path.insert(0, str(WORKING))


def run_exploration(slug: str) -> int:
    os.environ["DATASET_SLUG"] = slug
    ensure_explore_dataset_module()
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


def load_ideas_from_file(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(f"缺少 {path}")
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("ideas"), list):
        return data["ideas"]
    raise ValueError(f"{path} 不是 JSON 数组")


def finalize_ideas_output() -> None:
    ideas_path = WORKING / "ideas.json"
    if ideas_path.is_file():
        ideas = load_ideas_from_file(ideas_path)
        print(f"已生成 {len(ideas)} 条想法（ideas.json）")
        return

    raw_path = WORKING / "ideas_raw.txt"
    if raw_path.is_file():
        ideas = extract_ideas(raw_path.read_text(encoding="utf-8"))
        ideas_path.write_text(json.dumps(ideas, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已从 ideas_raw.txt 解析 {len(ideas)} 条想法")
        return

    raise FileNotFoundError("Agent 未产出 ideas.json 或 ideas_raw.txt")


def copy_working_artifacts_to_output() -> None:
    """确保 schema/README 等落在 working 目录供 kernels output 拉取。"""
    for name in (
        "schema.json",
        "README.md",
        "exploration_summary.json",
        "exploration_log.json",
    ):
        src = WORKING / name
        if src.is_file():
            continue
        bundled = SCRIPT_DIR / name
        if bundled.is_file():
            shutil.copy2(bundled, src)


def load_prompt(inputs: dict[str, Any], name: str, key: str) -> str:
    inline = inputs.get(key)
    if isinstance(inline, str) and inline.strip():
        return inline
    path = SCRIPT_DIR / "prompts" / name
    if path.is_file():
        return path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"缺少 prompt: {key} / {path}")


def run_agent_generate(inputs: dict[str, Any]) -> int:
    slug = inputs["dataset_slug"]
    target_file = inputs.get("target_file", "futures/um/klines/1h.parquet")
    max_ideas = int(inputs.get("max_ideas", 3))
    existing_titles: list[str] = list(inputs.get("existing_titles") or [])
    schema: dict[str, Any] = dict(inputs.get("dataset_schema") or {})

    WORKING.mkdir(parents=True, exist_ok=True)

    if not setup_cursor_auth(inputs):
        print("错误: Cursor 未配置，无法生成想法", file=sys.stderr)
        return 1

    try:
        parquet_path = resolve_parquet_path(slug, target_file)
    except FileNotFoundError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1

    print(f"Agent 模式：Parquet={parquet_path}")
    query_tool = setup_agent_workspace(parquet_path, schema)

    idea_schema = inputs.get("idea_schema") or {}
    agent_template = load_prompt(inputs, "generate-ideas-agent.txt", "agent_prompt_template")
    agent_prompt = fill_template(
        agent_template,
        {
            "{{DATASET_SLUG}}": slug,
            "{{PARQUET_PATH}}": str(parquet_path),
            "{{TARGET_FILE}}": target_file,
            "{{DATASET_SCHEMA}}": format_dataset_schema(schema),
            "{{QUERY_TOOL_PATH}}": str(query_tool),
            "{{MAX_IDEAS}}": str(max_ideas),
            "{{EXISTING_TITLES}}": format_titles(existing_titles),
            "{{IDEA_SCHEMA}}": json.dumps(idea_schema, ensure_ascii=False, indent=2),
        },
    )

    run_cursor_agent(
        agent_prompt,
        WORKING / "ideas_raw.txt",
        timeout=int(inputs.get("agent_cursor_timeout_seconds") or AGENT_CURSOR_TIMEOUT),
        cwd=WORKING,
    )

    try:
        finalize_ideas_output()
    except (ValueError, FileNotFoundError) as exc:
        print(f"警告: {exc}", file=sys.stderr)
        print("ideas_raw.txt 已保留，Runner 将尝试二次解析", file=sys.stderr)

    copy_working_artifacts_to_output()
    return 0


def run_legacy_generate(inputs: dict[str, Any]) -> int:
    slug = inputs["dataset_slug"]
    mode = inputs.get("mode", "explore_and_generate")
    target_file = inputs.get("target_file", "futures/um/klines/1h.parquet")
    max_ideas = int(inputs.get("max_ideas", 3))
    existing_titles: list[str] = list(inputs.get("existing_titles") or [])

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
        explore_template = load_prompt(inputs, "explore-dataset.txt", "explore_prompt_template")
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

    idea_template = load_prompt(inputs, "generate-ideas-kaggle.txt", "idea_prompt_template")
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

    run_cursor_agent(idea_prompt, WORKING / "ideas_raw.txt")
    try:
        finalize_ideas_output()
    except (ValueError, FileNotFoundError) as exc:
        print(f"警告: {exc}", file=sys.stderr)
        print("ideas_raw.txt 已保留，Runner 将尝试二次解析", file=sys.stderr)

    copy_working_artifacts_to_output()
    return 0


def main() -> int:
    inputs = load_kernel_inputs()
    mode = inputs.get("mode", "agent_generate")
    if mode == "agent_generate":
        return run_agent_generate(inputs)
    return run_legacy_generate(inputs)


if __name__ == "__main__":
    raise SystemExit(main())
