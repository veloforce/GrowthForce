"""视频发布，对应 Go xiaohongshu/publish_video.go。"""

from __future__ import annotations

import json
import logging
import os
import time

from .cdp import Page
from .errors import PublishError, UploadTimeoutError
from .publish import (
    _click_publish_tab,
    _find_content_element,
    _input_tags,
    _navigate_to_publish_page,
    _set_schedule_publish,
    _set_visibility,
    click_publish_button,
)
from .selectors import (
    FILE_INPUT,
    PUBLISH_BUTTON,
    TITLE_INPUT,
    UPLOAD_INPUT,
)
from .types import PublishVideoContent

logger = logging.getLogger(__name__)


def publish_video_content(page: Page, content: PublishVideoContent) -> dict:
    """发布视频内容（填写表单 + 点击发布）。

    Args:
        page: CDP 页面对象。
        content: 视频发布内容。

    Raises:
        PublishError: 发布失败。
        UploadTimeoutError: 上传/处理超时。
    """
    fill_publish_video_form(page, content)
    return click_publish_video_button(page)


def fill_publish_video_form(page: Page, content: PublishVideoContent) -> None:
    """填写视频发布表单，不点击发布按钮。

    Args:
        page: CDP 页面对象。
        content: 视频发布内容。

    Raises:
        PublishError: 填写失败。
        UploadTimeoutError: 上传/处理超时。
    """
    if not content.video_path:
        raise PublishError("视频不能为空")

    # 导航到发布页
    _navigate_to_publish_page(page)

    # 点击"上传视频" TAB
    _click_publish_tab(page, "上传视频")
    time.sleep(1)

    # 上传视频
    _upload_video(page, content.video_path)

    # 填写表单（不点击发布）
    _fill_publish_video_form(
        page,
        content.title,
        content.content,
        content.tags,
        content.schedule_time,
        content.visibility,
    )


def click_publish_video_button(page: Page) -> dict:
    """点击视频发布按钮。

    Args:
        page: CDP 页面对象。
    """
    _wait_for_publish_button_clickable(page)
    result = click_publish_button(page)
    logger.info("视频发布完成")
    return result


def _upload_video(page: Page, video_path: str) -> None:
    """上传视频文件。"""
    if not os.path.exists(video_path):
        raise PublishError(f"视频文件不存在: {video_path}")

    # 查找上传输入框
    selector = UPLOAD_INPUT if page.has_element(UPLOAD_INPUT) else FILE_INPUT
    page.set_file_input(selector, [video_path])

    # 等待发布按钮可点击（视频处理完成）
    _wait_for_publish_button_clickable(page, video_path=video_path)
    logger.info("视频上传/处理完成")


def _wait_for_publish_button_clickable(
    page: Page,
    *,
    max_wait: float = 600.0,
    poll_interval: float = 1.0,
    video_path: str | None = None,
) -> None:
    """等待发布按钮可点击（视频处理可能需要较长时间）。"""
    start = time.monotonic()
    next_log_at = start + 10
    last_state: dict | None = None

    logger.info("开始等待发布按钮可点击(视频)")

    while time.monotonic() - start < max_wait:
        last_state = _get_publish_button_state(page, video_path=video_path)
        if last_state.get("clickable") is True:
            logger.info(
                "发布按钮可点击(视频): elapsed=%.1fs state=%s",
                time.monotonic() - start,
                _format_publish_button_state(last_state),
            )
            return
        now = time.monotonic()
        if now >= next_log_at:
            logger.info(
                "等待发布按钮可点击中(视频): elapsed=%.1fs state=%s",
                now - start,
                _format_publish_button_state(last_state),
            )
            next_log_at = now + 10
        time.sleep(poll_interval)

    raise UploadTimeoutError(
        "等待发布按钮可点击超时(10分钟)，最后状态: "
        f"{_format_publish_button_state(last_state)}"
    )


def _is_publish_button_clickable(page: Page) -> bool:
    """判断当前发布页是否已经完成视频处理并允许发布。"""
    return bool(_get_publish_button_state(page).get("clickable"))


def _get_publish_button_state(page: Page, *, video_path: str | None = None) -> dict:
    """读取当前发布按钮状态，并返回不含页面正文的诊断信息。"""
    video_file_name = os.path.basename(video_path) if video_path else ""
    state = page.evaluate(
        f"""
        (() => {{
            const videoFileName = {_js_str(video_file_name)};
            const rectOf = (el) => {{
                const rect = el.getBoundingClientRect();
                return {{
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    x: Math.round(rect.x),
                    y: Math.round(rect.y)
                }};
            }};
            const isVisibleRect = (rect) => rect.width > 0 && rect.height > 0;
            const text = (document.body && document.body.innerText || '').slice(0, 5000);
            const uploadDiagnostics = {{
                hasReuploadAction: text.includes('重新上传'),
                hasUploadProgressNode: Boolean(document.querySelector(
                    '[class*="progress"], [class*="loading"], [class*="upload"]'
                )),
                hasUploadErrorText: /上传失败|处理失败|请刷新|失败/.test(text),
                videoFileNameMatched: Boolean(videoFileName && text.includes(videoFileName))
            }};

            const host = document.querySelector('xhs-publish-btn[is-publish="true"]');
            if (host) {{
                const rect = rectOf(host);
                const submitDisabled = host.getAttribute('submit-disabled');
                const clickable = isVisibleRect(rect) && submitDisabled !== 'true';
                return {{
                    clickable,
                    reason: clickable ? 'host_submit_enabled' : 'host_not_clickable',
                    url: location.href,
                    hostFound: true,
                    submitDisabled,
                    rect,
                    buttonText: host.getAttribute('submit-text') || '',
                    uploadDiagnostics
                }};
            }}

            const btn = document.querySelector({_js_str(PUBLISH_BUTTON)});
            if (!btn) {{
                return {{
                    clickable: false,
                    reason: 'button_not_found',
                    url: location.href,
                    hostFound: false,
                    uploadDiagnostics
                }};
            }}
            const rect = rectOf(btn);
            const disabled = Boolean(btn.disabled);
            const classDisabled = btn.classList.contains('disabled');
            const clickable = isVisibleRect(rect) && !disabled && !classDisabled;
            return {{
                clickable,
                reason: clickable ? 'legacy_button_enabled' : 'legacy_button_not_clickable',
                url: location.href,
                hostFound: false,
                legacyButtonFound: true,
                rect,
                disabled,
                classDisabled,
                buttonText: (btn.innerText || btn.textContent || '').trim().slice(0, 80),
                uploadDiagnostics
            }};
        }})()
        """
    )
    return state if isinstance(state, dict) else {"clickable": bool(state), "reason": "legacy_boolean_result"}


def _format_publish_button_state(state: dict | None) -> str:
    """压缩按钮状态为单行 JSON，避免日志输出完整页面文本。"""
    if not state:
        return "{}"
    allowed_keys = {
        "clickable",
        "reason",
        "hostFound",
        "legacyButtonFound",
        "submitDisabled",
        "rect",
        "disabled",
        "classDisabled",
        "buttonText",
        "uploadDiagnostics",
    }
    compact = {key: value for key, value in state.items() if key in allowed_keys}
    return json.dumps(compact, ensure_ascii=False, sort_keys=True)


def _fill_publish_video_form(
    page: Page,
    title: str,
    content: str,
    tags: list[str],
    schedule_time: str | None,
    visibility: str,
) -> None:
    """填写视频表单（不点击发布）。"""
    # 标题
    page.input_text(TITLE_INPUT, title)
    time.sleep(1)

    # 正文 + 标签
    content_selector = _find_content_element(page)
    page.input_content_editable(content_selector, content)

    # 回点标题
    time.sleep(1)
    page.click_element(TITLE_INPUT)

    if tags:
        _input_tags(page, content_selector, tags)
    time.sleep(1)

    # 定时发布
    if schedule_time:
        _set_schedule_publish(page, schedule_time)

    # 可见范围
    _set_visibility(page, visibility)

    logger.info("视频表单填写完成，等待确认发布")


def _js_str(s: str) -> str:
    """将 Python 字符串转为 JS 字面量。"""
    import json

    return json.dumps(s)
