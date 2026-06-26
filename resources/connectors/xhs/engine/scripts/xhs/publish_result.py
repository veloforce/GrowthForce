"""小红书发布业务结果判定。"""

from __future__ import annotations

from datetime import datetime

from .errors import AccountRiskControlError, PublishError, PublishResultTimeoutError

PUBLISH_RESULT_TIMEOUT_SECONDS = 60


def resolve_publish_result(result: dict | None) -> dict:
    """校验发布业务结果，返回可供 CLI 输出的结构化成功结果。"""
    if not result:
        raise PublishResultTimeoutError

    code = _normalize_code(_find_first_value(result, ("code", "result")))
    msg = _find_first_value(result, ("msg", "message")) or ""
    success = result.get("success") if isinstance(result, dict) else None

    is_risk_control = (
        (code is not None and -9140 <= code <= -9130)
        or "违反" in (msg or "")
        or "禁止发笔记" in (msg or "")
        or "违规" in (msg or "")
    )
    if is_risk_control:
        raise AccountRiskControlError(code or -9136, msg or "账号被风控")

    if success is False or code != 0:
        raise PublishError(f"发布失败：code={code} msg={msg!r}")

    note_id = _find_note_id(result)
    if not note_id:
        raise PublishError("发布响应无效：平台返回成功，但缺少 note_id")
    share_link = _find_first_value(result, ("share_link", "shareLink"))
    note_url = (
        str(share_link)
        if isinstance(share_link, str) and share_link.strip()
        else f"https://www.xiaohongshu.com/explore/{note_id}"
    )

    return {
        "success": True,
        "status": "发布完成",
        "note_id": note_id,
        "note_url": note_url,
        "published_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "platform_code": code,
        "platform_message": msg,
    }


def _find_first_value(value: object, keys: tuple[str, ...]) -> object | None:
    if isinstance(value, dict):
        for key in keys:
            if key in value:
                return value[key]
        for nested in value.values():
            found = _find_first_value(nested, keys)
            if found is not None:
                return found
    elif isinstance(value, list):
        for nested in value:
            found = _find_first_value(nested, keys)
            if found is not None:
                return found
    return None


def _normalize_code(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _find_note_id(value: object) -> str:
    """从不同版本的发布响应结构中递归提取 note_id。"""
    if isinstance(value, dict):
        direct = value.get("note_id") or value.get("noteId")
        if isinstance(direct, (str, int)) and str(direct).strip():
            return str(direct)
        if "result" in value or "success" in value:
            data = value.get("data")
            if isinstance(data, dict):
                current_id = data.get("id")
                if isinstance(current_id, (str, int)) and str(current_id).strip():
                    return str(current_id)
        for nested in value.values():
            note_id = _find_note_id(nested)
            if note_id:
                return note_id
    elif isinstance(value, list):
        for nested in value:
            note_id = _find_note_id(nested)
            if note_id:
                return note_id
    return ""
