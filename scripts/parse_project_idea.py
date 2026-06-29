"""从 GitHub Project Draft Issue body 解析结构化因子想法。"""

from __future__ import annotations

import re
from typing import Any


SECTION_PATTERN = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def _split_sections(body: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    matches = list(SECTION_PATTERN.finditer(body))
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections[title] = body[start:end].strip()
    return sections


def _parse_list_block(text: str) -> list[str]:
    items: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("- "):
            items.append(line[2:].strip())
    return items


def _parse_data_sources(text: str) -> list[str]:
    sources: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        match = re.search(r"`([^`]+/[^`]+)`", line)
        if match:
            sources.append(match.group(1))
    return sources


def parse_project_idea_body(body: str) -> dict[str, Any]:
    sections = _split_sections(body)
    required = ["假设", "数据来源", "公式草稿", "预期信号", "风险"]
    missing = [name for name in required if name not in sections]
    if missing:
        raise ValueError(f"Draft Issue body 缺少章节: {missing}")

    data_sources = _parse_data_sources(sections["数据来源"])
    if not data_sources:
        raise ValueError("未解析到 data_sources")

    risks = _parse_list_block(sections["风险"])
    if not risks:
        raise ValueError("未解析到 risks")

    return {
        "hypothesis": sections["假设"],
        "data_sources": data_sources,
        "formula_sketch": sections["公式草稿"],
        "expected_signal": sections["预期信号"],
        "risks": risks,
    }


def infer_evaluation_type(expected_signal: str, formula_sketch: str) -> str:
    text = f"{expected_signal}\n{formula_sketch}".lower()
    if "横截面" in text or "cross" in text:
        return "cross_sectional"
    if "时序" in text or "单标的" in text or "time_series" in text:
        return "time_series"
    return "cross_sectional"
