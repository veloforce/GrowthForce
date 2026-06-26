"""小红书 userInfo 等待策略。"""

from __future__ import annotations


def has_complete_account_info(info: dict) -> bool:
    return bool(
        info.get("logged_in")
        and info.get("account_id")
        and info.get("account_handle")
        and info.get("nickname")
    )


def should_finish_user_info_wait(
    info: dict,
    *,
    require_complete: bool,
    return_on_guest: bool,
) -> bool:
    if return_on_guest and info.get("guest") is True:
        return True
    if require_complete:
        return has_complete_account_info(info)
    return bool(info.get("logged_in") and info.get("account_id"))


def build_user_info_timeout_result(last_info: dict, timeout: float) -> dict:
    result = {
        "logged_in": False,
        "failure_reason": "timeout",
        "message": f"等待 userInfo 登录态超时（{timeout:.0f}s）",
    }
    if last_info.get("failure_reason"):
        result["last_failure_reason"] = last_info.get("failure_reason")
    if last_info.get("guest") is True:
        result["guest"] = True
    return result


def validate_lightweight_preflight(info: dict, expected_account_id: str = "") -> dict | None:
    """判断业务命令前的同页登录态快读是否应该拦截。

    这个保护只消费当前页面已经暴露的 userInfo，不负责等待、导航或判定“不确定”
    状态。只有明确读到 guest 或明确读到不同账号时才阻断；未暴露 userInfo、
    读取失败、缺少账号 ID 等情况交给后续业务命令自身处理。
    """
    if info.get("guest") is True:
        return {
            "logged_in": False,
            "guest": True,
            "failure_reason": "guest",
            "message": "当前页面是游客态，请在 GrowthForce 小红书连接器中重新授权后再试",
        }

    account_id = str(info.get("account_id") or "").strip()
    expected_id = str(expected_account_id or "").strip()
    if account_id and expected_id and account_id != expected_id:
        return {
            "logged_in": False,
            "failure_reason": "account_mismatch",
            "message": "当前 profile 登录到了另一个小红书账号，请在 GrowthForce 小红书连接器中重新授权后再试",
            "account_id": account_id,
            "expected_account_id": expected_id,
        }

    return None
