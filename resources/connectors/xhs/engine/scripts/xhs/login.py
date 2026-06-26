"""登录管理，对应 Go xiaohongshu/login.go。"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time

_QR_DIR = os.path.join(tempfile.gettempdir(), "xhs")
_QR_FILE = os.path.join(_QR_DIR, "login_qrcode.png")

from .cdp import Page
from .errors import RateLimitError
from .human import sleep_random
from .login_state import (
    build_user_info_timeout_result,
    has_complete_account_info,
    should_finish_user_info_wait,
)
from .selectors import (
    AGREE_CHECKBOX,
    AGREE_CHECKBOX_CHECKED,
    CODE_INPUT,
    GET_CODE_BUTTON,
    LOGIN_CONTAINER,
    LOGIN_ERR_MSG,
    LOGIN_STATUS,
    LOGOUT_MENU_ITEM,
    LOGOUT_MORE_BUTTON,
    PHONE_INPUT,
    PHONE_LOGIN_SUBMIT,
    QRCODE_IMG,
)
from .urls import EXPLORE_URL

logger = logging.getLogger(__name__)


def _wait_for_countdown(page: Page, timeout: float = 5.0) -> None:
    """等待"获取验证码"按钮出现倒计时数字，确认验证码已发送。

    轮询按钮文字直到包含数字（如 "60s"），超时则抛出 RateLimitError。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        btn_text = page.get_element_text(GET_CODE_BUTTON) or ""
        if any(ch.isdigit() for ch in btn_text):
            return
        time.sleep(0.3)
    raise RateLimitError()


def _read_current_user_info(page: Page, timeout: float = 3.0) -> dict:
    """读取当前页面 userInfo，不导航、不等待。"""
    try:
        info = page.evaluate(
            """
            (() => {
                const state = window.__INITIAL_STATE__ || {};
                const wrappedUserInfo = state?.user?.userInfo || {};
                const userInfo = wrappedUserInfo.value !== undefined
                    ? wrappedUserInfo.value
                    : (wrappedUserInfo._value !== undefined ? wrappedUserInfo._value : wrappedUserInfo);
                if (!userInfo || typeof userInfo !== 'object') {
                    return {
                        logged_in: false,
                        failure_reason: 'no_user_info',
                        message: '页面未暴露 userInfo',
                    };
                }
                if (userInfo.guest === true) {
                    return {
                        logged_in: false,
                        guest: true,
                        failure_reason: 'guest',
                        message: '当前页面是游客态',
                    };
                }
                const accountId = String(userInfo.userId || userInfo.user_id || userInfo.id || '').trim();
                const accountHandle = String(userInfo.redId || userInfo.red_id || '').trim();
                const nickname = String(userInfo.nickname || userInfo.nickName || '').trim();
                if (!accountId) {
                    return {
                        logged_in: false,
                        failure_reason: 'missing_account_id',
                        message: 'userInfo 中没有账号 ID',
                    };
                }
                return {
                    logged_in: true,
                    account_id: accountId,
                    account_handle: accountHandle,
                    nickname,
                    avatar_url: '',
                };
            })()
            """,
            timeout=timeout,
        )
    except Exception as error:
        logger.warning("读取 userInfo 失败: %s", error)
        return {
            "logged_in": False,
            "failure_reason": "read_user_info_failed",
            "message": str(error),
        }
    if isinstance(info, dict):
        return info
    return {
        "logged_in": False,
        "failure_reason": "invalid_user_info_result",
        "message": "页面返回的 userInfo 结果不是对象",
    }


def read_current_user_info(page: Page, timeout: float = 3.0) -> dict:
    """公开的同页 userInfo 快读：不导航、不等待。"""
    return _read_current_user_info(page, timeout=timeout)


def _ensure_xhs_page(page: Page, force: bool = False) -> None:
    current_url = page.evaluate("location.href") or ""
    if force or "xiaohongshu.com" not in current_url:
        page.navigate(EXPLORE_URL)
        page.wait_for_load()


def _force_reopen_xhs_page(page: Page) -> None:
    page.navigate("about:blank")
    page.navigate(EXPLORE_URL)


def _wait_for_user_info(
    page: Page,
    timeout: float,
    require_complete: bool = False,
    return_on_guest: bool = True,
) -> dict:
    deadline = time.monotonic() + timeout
    last_info: dict = {"logged_in": False, "failure_reason": "no_user_info"}
    while time.monotonic() < deadline:
        info = _read_current_user_info(page)
        last_info = info
        if should_finish_user_info_wait(
            info,
            require_complete=require_complete,
            return_on_guest=return_on_guest,
        ):
            return info
        time.sleep(0.3)
    return build_user_info_timeout_result(last_info, timeout)


def check_session(page: Page) -> dict:
    """轻量检查当前登录态，无二维码、无文件、无用户可见副作用。"""
    try:
        current_url = page.evaluate("location.href") or ""
        if "xiaohongshu.com" not in current_url:
            _ensure_xhs_page(page)
        else:
            info = _read_current_user_info(page)
            if should_finish_user_info_wait(
                info,
                require_complete=False,
                return_on_guest=True,
            ):
                return info
            logger.info("当前小红书页面缺少 userInfo，强制重新打开首页后重试: %s", info.get("failure_reason"))
            _force_reopen_xhs_page(page)
    except Exception as error:
        logger.warning("轻量检查登录态打开页面失败: %s", error)
        return {
            "logged_in": False,
            "failure_reason": "ensure_page_failed",
            "message": str(error),
        }

    try:
        info = _wait_for_user_info(
            page,
            timeout=120.0,
            require_complete=False,
            return_on_guest=True,
        )
        if not info.get("logged_in"):
            return info
        return info
    except Exception as error:
        logger.warning("轻量检查登录态失败: %s", error)
        return {
            "logged_in": False,
            "failure_reason": "check_failed",
            "message": str(error),
        }


def wait_for_account_info(page: Page, timeout: float = 120.0) -> dict:
    """等待登录完成，并返回完整账号信息。"""
    _ensure_xhs_page(page)
    info = _wait_for_user_info(
        page,
        timeout=timeout,
        require_complete=True,
        return_on_guest=False,
    )
    if has_complete_account_info(info):
        logger.info("登录成功: %s", info.get("account_id"))
    return info


def get_current_account_info(page: Page) -> dict:
    """获取当前登录账号信息，失败时返回 logged_in=false 或空字段。"""
    try:
        _ensure_xhs_page(page)
        return _wait_for_user_info(
            page,
            timeout=3.0,
            require_complete=True,
            return_on_guest=True,
        )
    except Exception:
        logger.warning("获取账号信息失败")
        return {"logged_in": False}


def check_login_status(page: Page) -> bool:
    """检查登录状态。

    Returns:
        True 已登录，False 未登录。
    """
    _ensure_xhs_page(page)
    info = _wait_for_user_info(
        page,
        timeout=10.0,
        require_complete=False,
        return_on_guest=True,
    )
    if info.get("logged_in") and info.get("account_id"):
        return True
    return False


def fetch_qrcode(page: Page) -> tuple[bytes, str, bool]:
    """获取登录二维码图片。

    直接读取 img.src（data:image/png;base64,...），跳过 Canvas 绘制。

    Returns:
        (png_bytes, b64_str, already_logged_in)
        - 如果已登录，返回 (b"", "", True)
        - 如果未登录，返回 (png_bytes, b64_str, False)
    """
    # 如果当前页面已在 explore（如 check-login 刚导航过），跳过重复导航
    current_url = page.evaluate("location.href") or ""
    if "explore" not in current_url:
        page.navigate(EXPLORE_URL)
        page.wait_for_load()

    # 快速检查是否已登录，避免无谓等待二维码
    if check_login_status(page):
        return b"", "", True

    # 直接等待二维码元素出现，合并了 _wait_for_auth_ui 的逻辑
    page.wait_for_element(QRCODE_IMG, timeout=15.0)

    # img.src 本身就是 data:image/png;base64,...，直接读取
    src = page.evaluate(
        f"document.querySelector({json.dumps(QRCODE_IMG)})?.src || ''"
    )
    if not src or "base64," not in src:
        raise RuntimeError("二维码图片 src 读取失败")

    b64_str = src.split("base64,", 1)[1]

    import base64
    png_bytes = base64.b64decode(b64_str)

    return png_bytes, b64_str, False


def _decode_qr_content(png_bytes: bytes) -> str | None:
    """通过 goqr.me read API 解码二维码内容。

    Returns:
        解码后的文本（通常是登录 URL），失败返回 None。
    """
    import http.client

    boundary = "----XhsQrBoundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file";'
        f' filename="qr.png"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode() + png_bytes + f"\r\n--{boundary}--\r\n".encode()

    try:
        conn = http.client.HTTPSConnection(
            "api.qrserver.com", timeout=5
        )
        conn.request(
            "POST",
            "/v1/read-qr-code/",
            body=body,
            headers={
                "Content-Type": (
                    f"multipart/form-data; boundary={boundary}"
                ),
            },
        )
        resp = conn.getresponse()
        if resp.status != 200:
            return None
        result = json.loads(resp.read().decode())
        data = result[0]["symbol"][0].get("data")
        return data if data else None
    except Exception:
        logger.debug("goqr.me 解码失败，将使用 base64 fallback")
        return None


def make_qrcode_url(
    png_bytes: bytes,
) -> tuple[str, str | None]:
    """生成二维码展示 URL 和登录链接。

    通过 goqr.me read API 解码 QR 内容，构造 API 图片 URL
    （~270 字符）和小红书官方登录链接。

    Returns:
        (image_url, login_url)
        - image_url: 可用于 markdown 图片的 URL
        - login_url: 小红书官方登录链接（解码失败时为 None）
    """
    import base64
    import urllib.parse

    qr_content = _decode_qr_content(png_bytes)
    if qr_content:
        image_url = (
            "https://api.qrserver.com/v1/create-qr-code/"
            "?size=300x300&data="
            + urllib.parse.quote(qr_content, safe="")
        )
        return image_url, qr_content

    # fallback: base64 data URL
    b64 = base64.b64encode(png_bytes).decode()
    return "data:image/png;base64," + b64, None


def save_qrcode_to_file(png_bytes: bytes) -> str:
    """将二维码 PNG 字节保存到临时文件，返回文件路径。

    Args:
        png_bytes: CDP 截图返回的 PNG 字节。

    Returns:
        file_path: 保存的 PNG 文件绝对路径。
    """
    os.makedirs(_QR_DIR, exist_ok=True)
    with open(_QR_FILE, "wb") as f:
        f.write(png_bytes)
    logger.info("二维码已保存: %s", _QR_FILE)
    return _QR_FILE


def send_phone_code(page: Page, phone: str) -> bool:
    """填写手机号并发送短信验证码。

    适用于无界面服务器场景，全程通过 CDP 操作，无需扫码。

    Args:
        page: CDP 页面对象。
        phone: 手机号（不含国家码，如 13800138000）。

    Returns:
        True 验证码已发送，False 已登录（无需再登录）。

    Raises:
        RuntimeError: 找不到登录表单或手机号输入框。
    """
    # 如果当前页面已在 explore，跳过重复导航
    current_url = page.evaluate("location.href") or ""
    if "explore" not in current_url:
        page.navigate(EXPLORE_URL)
        page.wait_for_load()

    # 直接等待登录容器出现（合并了 _wait_for_auth_ui 的逻辑，避免重复等待）
    try:
        page.wait_for_element(LOGIN_CONTAINER, timeout=10.0)
    except Exception as exc:
        # 可能已登录（没有登录容器），检查登录状态
        if check_login_status(page):
            return False
        raise RuntimeError("找不到登录表单") from exc

    if check_login_status(page):
        return False

    sleep_random(200, 400)

    # 点击手机号输入框并逐字输入
    page.click_element(PHONE_INPUT)
    sleep_random(200, 400)
    page.type_text(phone, delay_ms=80)
    sleep_random(200, 400)

    # 先勾选用户协议，再点获取验证码
    if not page.has_element(AGREE_CHECKBOX_CHECKED):
        page.click_element(AGREE_CHECKBOX)
        sleep_random(300, 600)

    # 点击"获取验证码"
    page.click_element(GET_CODE_BUTTON)

    # 事件驱动：轮询按钮文字直到出现倒计时数字，替代固定 2-2.5s 等待
    _wait_for_countdown(page)

    logger.info("验证码已发送至 %s", phone[:3] + "****" + phone[-4:])
    return True


def submit_phone_code(page: Page, code: str) -> bool:
    """填写短信验证码并提交登录。

    Args:
        page: CDP 页面对象。
        code: 收到的短信验证码。

    Returns:
        True 登录成功，False 失败（超时或验证码错误）。
    """
    # 点击验证码输入框，先清空再用 CDP 键盘事件逐字输入（isTrusted=true，React 能识别）
    page.click_element(CODE_INPUT)
    sleep_random(100, 200)
    page.evaluate(
        f"""(() => {{
            const el = document.querySelector({json.dumps(CODE_INPUT)});
            if (el && el.value) {{
                const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                setter.call(el, '');
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
            }}
        }})()"""
    )
    page.type_text(code, delay_ms=0)
    sleep_random(100, 200)

    # 点击登录按钮
    page.click_element(PHONE_LOGIN_SUBMIT)
    sleep_random(500, 1000)

    # 检查是否有错误提示
    err = page.get_element_text(LOGIN_ERR_MSG)
    if err and err.strip():
        logger.warning("登录失败: %s", err.strip())
        return False

    return wait_for_login(page, timeout=30.0)


def logout(page: Page) -> bool:
    """通过页面 UI 退出登录（点击"更多"→"退出登录"）。

    Args:
        page: CDP 页面对象。

    Returns:
        True 退出成功，False 未登录或操作失败。
    """
    page.navigate(EXPLORE_URL)
    page.wait_for_load()
    sleep_random(800, 1500)

    if not check_login_status(page):
        logger.info("当前未登录，无需退出")
        return False

    # 点击"更多"按钮展开菜单
    page.click_element(LOGOUT_MORE_BUTTON)
    sleep_random(500, 800)

    # 等待退出菜单项出现并点击
    page.wait_for_element(LOGOUT_MENU_ITEM, timeout=5.0)
    page.click_element(LOGOUT_MENU_ITEM)
    sleep_random(1000, 1500)

    logger.info("已退出登录")
    return True


def wait_for_login(page: Page, timeout: float = 120.0) -> bool:
    """等待扫码登录完成。

    Args:
        page: CDP 页面对象。
        timeout: 超时时间（秒）。

    Returns:
        True 登录成功，False 超时。
    """
    _ensure_xhs_page(page)
    info = _wait_for_user_info(
        page,
        timeout=timeout,
        require_complete=False,
        return_on_guest=False,
    )
    if info.get("logged_in") and info.get("account_id"):
        logger.info("登录成功")
        return True
    return False
