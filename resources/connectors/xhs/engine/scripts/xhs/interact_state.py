"""互动状态解析工具。"""

from __future__ import annotations


def parse_collect_button_state(snapshot: dict) -> bool | None:
    """从收藏按钮 DOM 快照推断收藏状态。

    返回 None 表示 DOM 没有给出足够明确的状态，调用方应继续使用数据状态或重试。
    """
    if not snapshot.get("exists"):
        return None

    nodes = snapshot.get("nodes")
    if not isinstance(nodes, list):
        return None

    positive_tokens = {
        "active",
        "selected",
        "checked",
        "collected",
        "is-collected",
        "is_collected",
    }
    negative_tokens = (
        "取消选择",
        "取消选中",
        "未收藏",
    )

    saw_collect_label = False
    for node in nodes:
        if not isinstance(node, dict):
            continue

        aria_pressed = node.get("ariaPressed")
        if aria_pressed == "true":
            return True
        if aria_pressed == "false":
            return False

        href = str(node.get("href") or "")
        if href.endswith("#collected"):
            return True
        if href.endswith("#collect"):
            return False

        text = " ".join(
            str(node.get(key) or "")
            for key in ("ariaLabel", "title", "text")
        )
        if any(token in text for token in negative_tokens):
            return False
        if "已收藏" in text or "取消收藏" in text:
            return True
        if "收藏" in text:
            saw_collect_label = True

        class_name = str(node.get("className") or "").lower()
        class_tokens = {
            token
            for token in class_name.replace("_", "-").split()
            if token
        }
        if class_tokens.intersection(positive_tokens):
            return True

    if saw_collect_label:
        return False
    return None


def parse_like_button_state(snapshot: dict) -> bool | None:
    """从点赞按钮 DOM 快照推断点赞状态。"""
    if not snapshot.get("exists"):
        return None

    nodes = snapshot.get("nodes")
    if not isinstance(nodes, list):
        return None

    for node in nodes:
        if not isinstance(node, dict):
            continue

        aria_pressed = node.get("ariaPressed")
        if aria_pressed == "true":
            return True
        if aria_pressed == "false":
            return False

        href = str(node.get("href") or "")
        if href.endswith("#liked"):
            return True
        if href.endswith("#like"):
            return False

        class_name = str(node.get("className") or "").lower()
        if "liked" in class_name:
            return True

    return None
