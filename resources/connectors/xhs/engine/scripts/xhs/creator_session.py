"""创作中心只读会话恢复。"""

from __future__ import annotations

import json
import logging
import time
from urllib.parse import urlparse

from .cdp import CDPError, Page
from .errors import CreatorSessionExpiredError, PublishError
from .selectors import CREATOR_TAB, UPLOAD_INPUT
from .urls import PUBLISH_URL

logger = logging.getLogger(__name__)


def ensure_creator_session(page: Page, timeout: float = 30.0) -> None:
    """通过官方发布页触发创作中心复用当前主站账号态。

    只导航和观察登录态，不点击发布 tab，不填写或提交任何内容。
    """
    page._send_session("Network.enable")
    page.clear_events({"Network.responseReceived"})
    page.navigate(PUBLISH_URL)
    deadline = time.monotonic() + timeout
    saw_creator_login = False
    creator_user_info_ok = False

    while time.monotonic() < deadline:
        try:
            event = page.wait_for_event(
                "Network.responseReceived",
                predicate=lambda item: (
                    urlparse(
                        item.get("params", {})
                        .get("response", {})
                        .get("url", "")
                    ).path
                    == "/api/galaxy/user/info"
                ),
                timeout=0.05,
            )
            status = event.get("params", {}).get("response", {}).get("status")
            if status == 200:
                creator_user_info_ok = True
            elif status == 401:
                saw_creator_login = True
        except CDPError:
            pass

        try:
            state = page.evaluate(
                f"""
                (() => {{
                    const url = location.href;
                    const bodyText = (document.body?.innerText || '').slice(0, 2000);
                    const imageInput = document.querySelector({json.dumps(UPLOAD_INPUT)});
                    const publishTab = [...document.querySelectorAll({json.dumps(CREATOR_TAB)})]
                        .some((tab) => {{
                            if (tab.hasAttribute('data-hp-kind')
                                || tab.hasAttribute('button-hp-installed')) return false;
                            const title = tab.querySelector('span.title');
                            const rect = tab.getBoundingClientRect();
                            return title?.textContent.trim() === '上传图文'
                                && rect.left > -1000 && rect.top > -1000;
                        }});
                    return {{
                        url,
                        ready: Boolean(imageInput || publishTab),
                        onLogin: /\\/login(?:[/?#]|$)/.test(url),
                        needsHumanLogin: /扫码登录|短信登录|验证码登录|获取验证码/.test(bodyText),
                    }};
                }})()
                """
            )
            if (
                state
                and creator_user_info_ok
                and state.get("ready")
                and not state.get("onLogin")
                and urlparse(state.get("url", "")).path == "/publish/publish"
            ):
                if saw_creator_login:
                    logger.info("创作中心页面已通过现有账号态恢复")
                return
            if state and (state.get("onLogin") or state.get("needsHumanLogin")):
                if not saw_creator_login:
                    logger.info("创作中心会话失效，等待页面使用现有账号态自动恢复")
                saw_creator_login = True
        except Exception:
            pass
        time.sleep(0.5)

    if saw_creator_login:
        raise CreatorSessionExpiredError
    raise PublishError("创作中心发布页在限定时间内未就绪")
