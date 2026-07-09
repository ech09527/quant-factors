"""将 GitHub Project 中的因子及其评估指标导出为 Excel。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import pandas as pd

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.fetch_existing_ideas import fetch_project_ideas
from scripts.github_graphql import get_github_token
from scripts.write_evaluation_to_project import EVAL_SECTION_HEADER

METRIC_ROW_PATTERN = re.compile(r"^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$")
SKIPPED_STATUS_PATTERN = re.compile(r"\*\*状态\*\*：skipped（([^）)]+)）")
FAILED_STATUS_PATTERN = re.compile(r"\*\*状态\*\*：failed（([^）)]+)）")

METRIC_LABELS = {
    "Mean IC": "mean_ic",
    "IC IR": "ic_ir",
    "Mean Rank IC": "mean_rank_ic",
    "Rank IC IR": "rank_ic_ir",
    "评估期数": "n_periods",
    "IC 正比例": "ic_positive_ratio",
}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_project_id(config_path: Path) -> str:
    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    project_id = config.get("id")
    if not project_id:
        raise ValueError(f"配置文件缺少 id: {config_path}")
    return project_id


def load_evaluation(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _parse_number(value: str) -> float | int | None:
    text = value.strip()
    if not text or text.upper() == "N/A":
        return None
    normalized = text.replace(",", "")
    if re.fullmatch(r"-?\d+", normalized):
        return int(normalized)
    try:
        return float(normalized)
    except ValueError:
        return None


def parse_metrics_from_body(body: str) -> dict[str, Any]:
    """从 Project Draft Issue body 的「评估结果」章节解析指标。"""
    if EVAL_SECTION_HEADER not in body:
        return {"status": "not_evaluated"}

    section = body.split(EVAL_SECTION_HEADER, 1)[1]

    skipped_match = SKIPPED_STATUS_PATTERN.search(section)
    if skipped_match:
        return {"status": "skipped", "skipped_reason": skipped_match.group(1)}

    failed_match = FAILED_STATUS_PATTERN.search(section)
    if failed_match:
        return {"status": "failed", "failed_reason": failed_match.group(1)}

    metrics: dict[str, Any] = {}
    for line in section.splitlines():
        match = METRIC_ROW_PATTERN.match(line.strip())
        if not match:
            continue
        label, raw_value = match.group(1).strip(), match.group(2).strip()
        if label in ("指标", "------"):
            continue
        key = METRIC_LABELS.get(label)
        if key:
            metrics[key] = _parse_number(raw_value)
        elif label == "引擎版本":
            metrics["engine_version"] = raw_value

    if metrics:
        metrics["status"] = "success"
        return metrics

    return {"status": "unknown"}


def resolve_evaluation(
    idea: dict[str, Any],
    *,
    evaluations_dir: Path,
) -> dict[str, Any]:
    """优先读取本地 evaluation JSON，否则解析 Project body。"""
    eval_path = evaluations_dir / f"{idea['title_hash']}.json"
    local_eval = load_evaluation(eval_path)
    if local_eval is not None:
        result: dict[str, Any] = {
            "status": local_eval.get("status", "unknown"),
            "evaluated_at": local_eval.get("evaluated_at"),
            "engine_version": local_eval.get("engine_version"),
            "evaluation_type": local_eval.get("evaluation_type"),
        }
        if local_eval.get("status") == "success":
            result.update(local_eval.get("metrics") or {})
        elif local_eval.get("status") == "skipped":
            result["skipped_reason"] = local_eval.get("skipped_reason")
        elif local_eval.get("status") == "failed":
            result["failed_reason"] = (local_eval.get("diagnostics") or {}).get("error")
        return result

    return parse_metrics_from_body(idea.get("body", ""))


def build_rows(
    ideas: list[dict[str, Any]],
    *,
    evaluations_dir: Path,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for idea in ideas:
        evaluation = resolve_evaluation(idea, evaluations_dir=evaluations_dir)
        row: dict[str, Any] = {
            "标题": idea["title"],
            "状态": evaluation.get("status"),
            "Mean IC": evaluation.get("mean_ic"),
            "IC IR": evaluation.get("ic_ir"),
            "Mean Rank IC": evaluation.get("mean_rank_ic"),
            "Rank IC IR": evaluation.get("rank_ic_ir"),
            "评估期数": evaluation.get("n_periods"),
            "IC 正比例": evaluation.get("ic_positive_ratio"),
            "评估类型": evaluation.get("evaluation_type"),
            "引擎版本": evaluation.get("engine_version"),
            "评估时间": evaluation.get("evaluated_at"),
        }
        if evaluation.get("status") == "skipped":
            row["备注"] = evaluation.get("skipped_reason")
        elif evaluation.get("status") == "failed":
            row["备注"] = evaluation.get("failed_reason")
        else:
            row["备注"] = None
        rows.append(row)
    return rows


def export_to_excel(rows: list[dict[str, Any]], output_path: Path) -> None:
    df = pd.DataFrame(rows)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="因子指标")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    root = repo_root()
    parser = argparse.ArgumentParser(description="导出 GitHub Project 因子指标到 Excel")
    parser.add_argument(
        "--project-id",
        help="GitHub Project node ID（默认读取 config/github-project.json）",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=root / "config" / "github-project.json",
    )
    parser.add_argument(
        "--evaluations-dir",
        type=Path,
        default=root / "evaluations",
        help="本地 evaluation JSON 目录（作为 Project body 的备选数据源）",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=root / "factor_metrics.xlsx",
        help="输出 Excel 文件路径",
    )
    parser.add_argument(
        "--ideas",
        type=Path,
        help="使用已有的 fetch_existing_ideas JSON，跳过 GitHub 拉取",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        if args.ideas:
            with args.ideas.open(encoding="utf-8") as handle:
                payload = json.load(handle)
            ideas = payload.get("ideas") if isinstance(payload, dict) else payload
            if not isinstance(ideas, list):
                raise ValueError("ideas 输入格式无效")
        else:
            project_id = args.project_id or load_project_id(args.config)
            token = get_github_token()
            ideas = fetch_project_ideas(project_id, token)

        rows = build_rows(ideas, evaluations_dir=args.evaluations_dir)
        export_to_excel(rows, args.output)

        success_count = sum(1 for row in rows if row["状态"] == "success")
        print(f"已导出 {len(rows)} 条因子（其中 {success_count} 条有评估指标）→ {args.output}")
        return 0
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
