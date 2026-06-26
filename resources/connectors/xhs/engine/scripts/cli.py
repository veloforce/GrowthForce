"""统一 CLI 入口。

GrowthForce 内置运行时通过 Electron CDP 连接小红书专用浏览器页面。

输出: JSON（ensure_ascii=False）
退出码: 0=成功, 1=未登录, 2=错误
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

# Windows 控制台默认编码（如 cp1252）不支持中文，强制 UTF-8
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("xhs-cli")


# ─── 进程登记 ────────────────────────────────────────────────────────────────


def _safe_registry_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in value)[:160]


def _is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _prune_stale_registry_entries(registry_dir: Path, request_id: str) -> None:
    pattern = f"{_safe_registry_name(request_id)}-*.json"
    for entry in registry_dir.glob(pattern):
        try:
            payload = json.loads(entry.read_text(encoding="utf-8"))
            pid = int(payload.get("pid", 0))
            if not _is_process_alive(pid):
                entry.unlink(missing_ok=True)
        except Exception:
            try:
                entry.unlink(missing_ok=True)
            except Exception:
                pass


def _register_process() -> Path | None:
    request_id = os.environ.get("AGENTSTUDIO_AGENT_REQUEST_ID", "").strip()
    registry_root = os.environ.get("AGENTSTUDIO_XHS_PROCESS_REGISTRY_DIR", "").strip()
    if not request_id or not registry_root:
        return None

    registry_dir = Path(registry_root).expanduser()
    try:
        registry_dir.mkdir(parents=True, exist_ok=True)
        _prune_stale_registry_entries(registry_dir, request_id)
        pid = os.getpid()
        registry_path = registry_dir / f"{_safe_registry_name(request_id)}-{pid}.json"
        payload = {
            "pid": pid,
            "requestId": request_id,
            "profileKey": os.environ.get("AGENTSTUDIO_XHS_PROFILE_KEY", ""),
            "targetId": os.environ.get("AGENTSTUDIO_XHS_TARGET_ID", ""),
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "argv": sys.argv,
        }
        registry_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return registry_path
    except Exception as error:
        logger.debug("无法登记 xhs-cli 进程: %s", error)
        return None


def _unregister_process(registry_path: Path | None) -> None:
    if registry_path is None:
        return
    try:
        registry_path.unlink(missing_ok=True)
    except Exception as error:
        logger.debug("无法清理 xhs-cli 进程登记: %s", error)


# ─── 输出工具 ────────────────────────────────────────────────────────────────


def _output(data: dict, exit_code: int = 0) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))
    sys.exit(exit_code)


def _error_payload(error: Exception) -> dict:
    """把关键业务异常转成上层 agent 可判定的结构化 JSON。"""
    from xhs.errors import (
        AccountRiskControlError,
        CreatorDataError,
        CreatorSessionExpiredError,
        PublishError,
        PublishResultTimeoutError,
        PublishValidationError,
    )

    payload: dict = {"success": False, "error": str(error)}
    if isinstance(error, AccountRiskControlError):
        payload.update({
            "error_code": "ACCOUNT_RESTRICTED",
            "platform_code": error.code,
            "platform_message": error.msg,
        })
    elif isinstance(error, PublishResultTimeoutError):
        payload.update({
            "error_code": "PUBLISH_RESULT_UNKNOWN",
            "reason": error.reason,
        })
    elif isinstance(error, CreatorSessionExpiredError):
        payload["error_code"] = "CREATOR_SESSION_EXPIRED"
    elif isinstance(error, CreatorDataError):
        payload["error_code"] = "CREATOR_DATA_FAILED"
    elif isinstance(error, PublishValidationError):
        payload["error_code"] = "PUBLISH_VALIDATION_FAILED"
    elif isinstance(error, PublishError):
        payload["error_code"] = "PUBLISH_FAILED"
    return payload


def _open_file_if_display(path: str) -> None:
    """有桌面时用系统默认程序打开文件。"""
    import platform
    import subprocess

    try:
        system = platform.system()
        if system == "Windows":
            os.startfile(path)
        elif system == "Darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:
        logger.debug("无法自动打开文件: %s", path)


# ─── CDP 连接 ────────────────────────────────────────────────────────────────


def _connect_electron_cdp(args: argparse.Namespace):
    """返回 (browser, page)，通过 Electron remote-debugging CDP 操作浏览器。"""
    from xhs.cdp import Browser
    from xhs.errors import CDPError

    raw_port = os.environ.get("AGENTSTUDIO_XHS_CDP_PORT", "")
    target_id = os.environ.get("AGENTSTUDIO_XHS_TARGET_ID", "")
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        port = 0
    if port <= 0:
        raise CDPError("缺少 AGENTSTUDIO_XHS_CDP_PORT，请通过 GrowthForce 小红书连接器运行")
    if not target_id:
        raise CDPError("缺少 AGENTSTUDIO_XHS_TARGET_ID，请通过 GrowthForce 小红书连接器运行")

    browser = Browser(port=port)
    browser.connect()
    page = browser.get_page_by_target_id(target_id) if target_id else browser.get_or_create_page()
    if not page:
        browser.close()
        raise CDPError(f"无法连接到 Electron CDP target: {target_id}")
    return browser, page


def _connect(args: argparse.Namespace):
    """返回 (browser, page)。"""
    return _connect_electron_cdp(args)


# _connect_saved_tab / _connect_existing 在 Electron CDP 模式下与 _connect 等价。
# _connect_existing 用于发布页后续步骤，不能做会改变当前页面预期的额外保护。
_connect_saved_tab = _connect
_connect_existing = _connect


LIGHTWEIGHT_PREFLIGHT_COMMANDS = {
    "list-feeds",
    "search-feeds",
    "get-feed-detail",
    "user-profile",
    "post-comment",
    "reply-comment",
    "like-feed",
    "favorite-feed",
    "publish",
    "fill-publish",
    "publish-video",
    "fill-publish-video",
    "long-article",
}


def _run_lightweight_login_preflight(page) -> None:
    """业务命令前的登录态快读保护：不导航、不等待。"""
    from xhs.login import read_current_user_info
    from xhs.login_state import validate_lightweight_preflight

    info = read_current_user_info(page)
    failure = validate_lightweight_preflight(
        info,
        expected_account_id=os.environ.get("AGENTSTUDIO_XHS_ACCOUNT_ID", ""),
    )
    if failure:
        _output(failure, exit_code=1)


def _connect_checked(args: argparse.Namespace):
    """连接 CDP，并对安全的导航型业务命令做同页登录态快读保护。"""
    browser, page = _connect(args)
    if getattr(args, "command", "") in LIGHTWEIGHT_PREFLIGHT_COMMANDS:
        try:
            _run_lightweight_login_preflight(page)
        except SystemExit:
            browser.close()
            raise
    return browser, page


# ─── 子命令实现 ───────────────────────────────────────────────────────────────


def _qrcode_fallback(browser, page, args: argparse.Namespace) -> None:
    """频率限制时刷新页面返回二维码。"""
    from xhs.login import fetch_qrcode, make_qrcode_url, save_qrcode_to_file
    from xhs.urls import EXPLORE_URL

    page.navigate(EXPLORE_URL)
    page.wait_for_load()

    png_bytes, _b64_orig, already = fetch_qrcode(page)
    if already:
        _output({"logged_in": True, "message": "已登录"})
        return

    qrcode_path = save_qrcode_to_file(png_bytes)
    image_url, login_url = make_qrcode_url(png_bytes)
    _open_file_if_display(qrcode_path)

    result: dict = {
        "logged_in": False,
        "login_method": "qrcode",
        "qrcode_path": qrcode_path,
        "qrcode_image_url": image_url,
        "message": "验证码发送受限，已切换为二维码登录，请扫码。扫码后运行 wait-login 等待登录结果。",
    }
    if login_url:
        result["qr_login_url"] = login_url
    _output(result, exit_code=1)


def cmd_check_login(args: argparse.Namespace) -> None:
    """轻量检查登录状态，无二维码、无文件、无外部窗口副作用。"""
    from xhs.errors import CDPError
    from xhs.login import check_session

    try:
        browser, page = _connect(args)
    except CDPError as error:
        _output(
            {
                "logged_in": False,
                "failure_reason": "cdp_error",
                "message": str(error),
            },
            exit_code=2,
        )
    except Exception as error:
        _output(
            {
                "logged_in": False,
                "failure_reason": "connect_failed",
                "message": str(error),
            },
            exit_code=2,
        )

    try:
        result = check_session(page)
        _output(result, exit_code=0 if result.get("logged_in") else 1)
    finally:
        browser.close()


cmd_check_session = cmd_check_login


def cmd_login(args: argparse.Namespace) -> None:
    """登录（扫码，阻塞等待完成）。"""
    from xhs.login import fetch_qrcode, make_qrcode_url, save_qrcode_to_file, wait_for_account_info

    browser, page = _connect(args)
    try:
        png_bytes, _b64_orig, already = fetch_qrcode(page)
        if already:
            _output({"logged_in": True, "message": "已登录"})
            return

        qrcode_path = save_qrcode_to_file(png_bytes)
        image_url, login_url = make_qrcode_url(png_bytes)
        _open_file_if_display(qrcode_path)

        result: dict = {"qrcode_path": qrcode_path, "qrcode_image_url": image_url}
        if login_url:
            result["qr_login_url"] = login_url
        logger.info("二维码已生成，等待扫码...")

        result = wait_for_account_info(page, timeout=120)
        if result.get("logged_in") and result.get("account_id"):
            result["message"] = "登录成功"
            _output(result, exit_code=0)
        result["message"] = "等待超时"
        _output(result, exit_code=2)
    finally:
        browser.close()


def cmd_get_qrcode(args: argparse.Namespace) -> None:
    """获取登录二维码截图并立即返回（非阻塞）。"""
    from xhs.login import fetch_qrcode, make_qrcode_url, save_qrcode_to_file

    browser, page = _connect(args)
    try:
        png_bytes, _b64_orig, already = fetch_qrcode(page)
        if already:
            browser.close()
            _output({"logged_in": True, "message": "已登录"})
            return

        qrcode_path = save_qrcode_to_file(png_bytes)
        image_url, login_url = make_qrcode_url(png_bytes)
        _open_file_if_display(qrcode_path)
        browser.close()

        result: dict = {
            "qrcode_path": qrcode_path,
            "qrcode_image_url": image_url,
            "message": "二维码已生成，请扫码登录。扫码后运行 wait-login 等待登录结果。",
        }
        if login_url:
            result["qr_login_url"] = login_url
        _output(result)
    finally:
        pass


def cmd_wait_login(args: argparse.Namespace) -> None:
    """等待扫码登录完成（配合 get-qrcode 使用）。"""
    from xhs.login import wait_for_account_info

    browser, page = _connect_saved_tab(args)
    try:
        result = wait_for_account_info(page, timeout=args.timeout)
        if result.get("logged_in") and result.get("account_id"):
            result["message"] = "登录成功"
            _output(result, exit_code=0)
        result["message"] = "等待超时，请继续在登录窗口扫码或手机号登录"
        _output(result, exit_code=2)
    finally:
        browser.close()


def cmd_account_info(args: argparse.Namespace) -> None:
    """获取当前登录账号信息。"""
    from xhs.login import get_current_account_info

    browser, page = _connect(args)
    try:
        info = get_current_account_info(page)
        _output(info, exit_code=0 if info.get("logged_in") else 1)
    finally:
        browser.close()


def cmd_phone_login(args: argparse.Namespace) -> None:
    """手机号+验证码登录（交互式）。"""
    from xhs.errors import RateLimitError
    from xhs.login import send_phone_code, submit_phone_code

    browser, page = _connect(args)
    try:
        sent = send_phone_code(page, args.phone)
        if not sent:
            _output({"logged_in": True, "message": "已登录，无需重新登录"})
            return

        code = args.code
        if not code:
            code = input("请输入收到的短信验证码: ").strip()

        success = submit_phone_code(page, code)
        _output(
            {"logged_in": success, "message": "登录成功" if success else "验证码错误或超时"},
            exit_code=0 if success else 2,
        )
    except RateLimitError:
        _qrcode_fallback(browser, page, args)
    finally:
        browser.close()


def cmd_send_code(args: argparse.Namespace) -> None:
    """分步登录第一步：发送手机验证码。"""
    from xhs.errors import RateLimitError
    from xhs.login import send_phone_code

    browser, page = _connect(args)
    try:
        sent = send_phone_code(page, args.phone)
        if not sent:
            _output({"logged_in": True, "message": "已登录，无需重新登录"})
            return
        _output({
            "status": "code_sent",
            "message": (
                f"验证码已发送至 {args.phone[:3]}****{args.phone[-4:]}，"
                "请运行 verify-code --code <验证码>"
            ),
        })
    except RateLimitError:
        _qrcode_fallback(browser, page, args)
    finally:
        browser.close()


def cmd_verify_code(args: argparse.Namespace) -> None:
    """分步登录第二步：填写验证码并提交。"""
    from xhs.login import submit_phone_code

    browser, page = _connect_saved_tab(args)
    try:
        success = submit_phone_code(page, args.code)
        _output(
            {"logged_in": success, "message": "登录成功" if success else "验证码错误或超时"},
            exit_code=0 if success else 2,
        )
    finally:
        browser.close()


def cmd_delete_cookies(args: argparse.Namespace) -> None:
    """退出登录（页面 UI 点击退出）。"""
    from xhs.login import logout

    browser, page = _connect(args)
    try:
        logged_out = logout(page)
        msg = "已退出登录" if logged_out else "未登录"
        _output({"success": True, "message": msg})
    finally:
        browser.close()


def cmd_list_feeds(args: argparse.Namespace) -> None:
    """获取首页 Feed 列表。"""
    from xhs.feeds import list_feeds

    browser, page = _connect_checked(args)
    try:
        feeds = list_feeds(page)
        _output({"feeds": [f.to_dict() for f in feeds], "count": len(feeds)})
    finally:
        browser.close()


def cmd_search_feeds(args: argparse.Namespace) -> None:
    """搜索 Feeds。"""
    from xhs.search import search_feeds
    from xhs.types import FilterOption

    filter_opt = FilterOption(
        sort_by=args.sort_by or "",
        note_type=args.note_type or "",
        publish_time=args.publish_time or "",
        search_scope=args.search_scope or "",
        location=args.location or "",
    )

    browser, page = _connect_checked(args)
    try:
        feeds = search_feeds(page, args.keyword, filter_opt)
        _output({"feeds": [f.to_dict() for f in feeds], "count": len(feeds)})
    finally:
        browser.close()


def cmd_get_feed_detail(args: argparse.Namespace) -> None:
    """获取 Feed 详情。"""
    from xhs.feed_detail import get_feed_detail
    from xhs.types import CommentLoadConfig

    config = CommentLoadConfig(
        click_more_replies=args.click_more_replies,
        max_replies_threshold=args.max_replies_threshold,
        max_comment_items=args.max_comment_items,
        scroll_speed=args.scroll_speed,
    )

    browser, page = _connect_checked(args)
    try:
        detail = get_feed_detail(
            page,
            args.feed_id,
            args.xsec_token,
            load_all_comments=args.load_all_comments,
            config=config,
            keyword=getattr(args, "keyword", "篮球"),
        )
        _output(detail.to_dict())
    except Exception as e:
        # 附带 404 诊断事件，帮助定位根因
        diagnostics: list = []
        try:
            diagnostics = page.get_404_diagnostics() or []
        except Exception:
            pass
        err_data: dict = {"success": False, "error": str(e)}
        if diagnostics:
            latest = diagnostics[-1]
            err_data["diagnosis"] = {
                "root_cause": latest.get("diagnosis", {}).get("root_cause"),
                "cause_category": latest.get("diagnosis", {}).get("cause_category"),
                "detail": latest.get("diagnosis", {}).get("detail"),
                "how_xhs_decides": latest.get("diagnosis", {}).get("how_xhs_decides"),
                "url": latest.get("url"),
                "final_url": latest.get("final_url"),
            }
        _output(err_data, exit_code=2)
    finally:
        browser.close()


def cmd_user_profile(args: argparse.Namespace) -> None:
    """获取用户主页。"""
    from xhs.user_profile import get_user_profile

    browser, page = _connect_checked(args)
    try:
        profile = get_user_profile(page, args.user_id, args.xsec_token or "")
        _output(profile.to_dict())
    finally:
        browser.close()


def cmd_post_comment(args: argparse.Namespace) -> None:
    """发表评论。"""
    from xhs.comment import post_comment

    browser, page = _connect_checked(args)
    try:
        post_comment(page, args.feed_id, args.xsec_token, args.content)
        _output({"success": True, "message": "评论发送成功"})
    finally:
        browser.close()


def cmd_reply_comment(args: argparse.Namespace) -> None:
    """回复评论。"""
    from xhs.comment import reply_comment

    browser, page = _connect_checked(args)
    try:
        reply_comment(
            page,
            args.feed_id,
            args.xsec_token,
            args.content,
            comment_id=args.comment_id or "",
            user_id=args.user_id or "",
        )
        _output({"success": True, "message": "回复成功"})
    finally:
        browser.close()


def cmd_like_feed(args: argparse.Namespace) -> None:
    """点赞/取消点赞。"""
    from xhs.like_favorite import like_feed, unlike_feed

    browser, page = _connect_checked(args)
    try:
        if args.unlike:
            result = unlike_feed(page, args.feed_id, args.xsec_token)
        else:
            result = like_feed(page, args.feed_id, args.xsec_token)
        _output(result.to_dict())
    finally:
        browser.close()


def cmd_favorite_feed(args: argparse.Namespace) -> None:
    """收藏/取消收藏。"""
    from xhs.like_favorite import favorite_feed, unfavorite_feed

    browser, page = _connect_checked(args)
    try:
        if args.unfavorite:
            result = unfavorite_feed(page, args.feed_id, args.xsec_token)
        else:
            result = favorite_feed(page, args.feed_id, args.xsec_token)
        _output(result.to_dict())
    finally:
        browser.close()


def cmd_publish(args: argparse.Namespace) -> None:
    """发布图文内容。"""
    from xhs.publish_preflight import validate_image_publish_input

    with open(args.title_file, encoding="utf-8") as f:
        title = f.read().strip()
    with open(args.content_file, encoding="utf-8") as f:
        content = f.read().strip()

    preflight = validate_image_publish_input(title, content, args.images or [], args.tags or [])
    from image_downloader import process_images
    from xhs.publish import publish_image_content
    from xhs.types import PublishImageContent

    image_paths = process_images(preflight.images)
    if not image_paths:
        _output({"success": False, "error": "没有有效的图片"}, exit_code=2)

    browser, page = _connect_checked(args)
    try:
        result = publish_image_content(
            page,
            PublishImageContent(
                title=preflight.title,
                content=preflight.content,
                tags=preflight.tags,
                image_paths=image_paths,
                schedule_time=args.schedule_at,
                is_original=args.original,
                visibility=args.visibility or "",
            ),
        )
        _output({**result, "title": preflight.title, "images": len(image_paths)})
    finally:
        browser.close()


def cmd_fill_publish(args: argparse.Namespace) -> None:
    """只填写图文表单，不发布。"""
    from xhs.publish_preflight import validate_image_publish_input

    with open(args.title_file, encoding="utf-8") as f:
        title = f.read().strip()
    with open(args.content_file, encoding="utf-8") as f:
        content = f.read().strip()

    preflight = validate_image_publish_input(title, content, args.images or [], args.tags or [])
    from image_downloader import process_images
    from xhs.publish import fill_publish_form
    from xhs.types import PublishImageContent

    image_paths = process_images(preflight.images)
    if not image_paths:
        _output({"success": False, "error": "没有有效的图片"}, exit_code=2)

    browser, page = _connect_checked(args)
    try:
        fill_publish_form(
            page,
            PublishImageContent(
                title=preflight.title,
                content=preflight.content,
                tags=preflight.tags,
                image_paths=image_paths,
                schedule_time=args.schedule_at,
                is_original=args.original,
                visibility=args.visibility or "",
            ),
        )
        _output({"success": True, "title": preflight.title, "images": len(image_paths), "status": "表单已填写，等待确认发布"})
    finally:
        browser.close()


def cmd_fill_publish_video(args: argparse.Namespace) -> None:
    """只填写视频表单，不发布。"""
    from xhs.publish_preflight import validate_video_publish_input

    with open(args.title_file, encoding="utf-8") as f:
        title = f.read().strip()
    with open(args.content_file, encoding="utf-8") as f:
        content = f.read().strip()

    preflight = validate_video_publish_input(title, content, args.tags or [], args.video)
    from xhs.publish_video import fill_publish_video_form
    from xhs.types import PublishVideoContent

    browser, page = _connect_checked(args)
    try:
        fill_publish_video_form(
            page,
            PublishVideoContent(
                title=preflight.title,
                content=preflight.content,
                tags=preflight.tags,
                video_path=preflight.video or args.video,
                schedule_time=args.schedule_at,
                visibility=args.visibility or "",
            ),
        )
        _output({"success": True, "title": preflight.title, "video": preflight.video or args.video, "status": "视频表单已填写，等待确认发布"})
    finally:
        browser.close()


def cmd_click_publish(args: argparse.Namespace) -> None:
    """点击发布按钮（在用户确认后调用）。"""
    from xhs.publish import click_publish_button

    browser, page = _connect_existing(args)
    try:
        result = click_publish_button(page)
        _output(result)
    finally:
        browser.close()


def cmd_save_draft(args: argparse.Namespace) -> None:
    """保存为草稿。"""
    from xhs.publish import save_as_draft

    browser, page = _connect_existing(args)
    try:
        save_as_draft(page)
        _output({"success": True, "status": "内容已保存到草稿箱"})
    finally:
        browser.close()


def cmd_long_article(args: argparse.Namespace) -> None:
    """长文模式：填写内容 + 一键排版，返回模板列表。"""
    from xhs.publish_long_article import publish_long_article

    with open(args.title_file, encoding="utf-8") as f:
        title = f.read().strip()
    with open(args.content_file, encoding="utf-8") as f:
        content = f.read().strip()

    browser, page = _connect_checked(args)
    try:
        template_names = publish_long_article(
            page,
            title=title,
            content=content,
            image_paths=args.images,
        )
        _output({"success": True, "templates": template_names, "status": "长文已填写，请选择模板"})
    finally:
        browser.close()


def cmd_select_template(args: argparse.Namespace) -> None:
    """选择排版模板。"""
    from xhs.publish_long_article import select_template

    browser, page = _connect_existing(args)
    try:
        selected = select_template(page, args.name)
        if selected:
            _output({"success": True, "template": args.name, "status": "模板已选择"})
        else:
            _output({"success": False, "error": f"未找到模板: {args.name}"}, exit_code=2)
    finally:
        browser.close()


def cmd_next_step(args: argparse.Namespace) -> None:
    """点击下一步 + 填写发布页描述。"""
    from xhs.publish_long_article import click_next_and_fill_description

    with open(args.content_file, encoding="utf-8") as f:
        description = f.read().strip()

    browser, page = _connect_existing(args)
    try:
        click_next_and_fill_description(page, description)
        _output({"success": True, "status": "已进入发布页，等待确认发布"})
    finally:
        browser.close()


def cmd_diagnose_404(args: argparse.Namespace) -> None:
    """获取拦截器捕获的 404 诊断事件，打印根因分析报告。"""
    browser, page = _connect(args)
    try:
        if args.clear:
            page.clear_404_diagnostics()
            _output({"success": True, "message": "诊断记录已清空"})
            return

        events = page.get_404_diagnostics()
        if not events:
            _output({"success": True, "events": [], "message": "暂无拦截记录，请在小红书页面进行操作后重试"})
            return

        # 控制台可读报告（写到 stderr）
        logger.info("═" * 60)
        logger.info("404 诊断报告 — 共 %d 条拦截记录", len(events))
        logger.info("═" * 60)
        for i, ev in enumerate(events, 1):
            diag = ev.get("diagnosis", {})
            logger.info(
                "[%d] %s %s → HTTP %s",
                i, ev.get("method", "?"), ev.get("url", "?")[:80], ev.get("status", "?"),
            )
            logger.info("    根因: %s", diag.get("root_cause", "未知"))
            logger.info("    详情: %s", diag.get("detail", "")[:120])
            logger.info("    置信: %s | 类别: %s", diag.get("confidence", "?"), diag.get("cause_category", "?"))
            logger.info("    时间: %s | 页面: %s", ev.get("timestamp", "?"), ev.get("pageUrl", "?")[:60])
            cookies = ev.get("cookies", {})
            req = ev.get("request", {})
            logger.info(
                "    凭证: web_session=%s a1=%s xs=%s xsec_token=%s",
                cookies.get("has_web_session"), cookies.get("has_a1"),
                req.get("has_xs"), bool(req.get("xsec_token")),
            )
            logger.info("─" * 60)

        _output({"success": True, "events": events})
    finally:
        browser.close()


def cmd_check_risk(args: argparse.Namespace) -> None:
    """分析小红书风控状态：检测自动化特征与 API 拦截情况。"""
    import json as _json

    browser, page = _connect(args)
    try:
        probe_urls = args.probe_urls or []
        report = page.analyze_risk_control(probe_urls=probe_urls)
        if not report:
            _output({"success": False, "error": "扫描返回空结果"}, exit_code=2)
            return

        risk_level = report.get("risk_level", "unknown")
        issues = report.get("issues", [])

        # 控制台可读摘要（写到 stderr，不影响 JSON stdout）
        logger.info("风控扫描完成 | 等级: %s | 问题数: %d", risk_level.upper(), len(issues))
        for issue in issues:
            logger.info("  [%s] %s", issue.get("level", "?").upper(), issue.get("msg", ""))

        _output({"success": True, "report": report})
    finally:
        browser.close()


def cmd_get_netlog(args: argparse.Namespace) -> None:
    """获取 NetLog 原始 entries（最多 500 条）。"""
    browser, page = _connect(args)
    try:
        if not page.get_netlog_enabled():
            print(json.dumps({
                "error": "netlogger 未启用",
                "hint": "Electron XHS 会话未提供 NetLog 路径，请通过 GrowthForce 小红书连接器运行",
            }, ensure_ascii=False, indent=2))
            sys.exit(2)

        entries = page.get_netlog()
        if args.limit:
            entries = entries[-args.limit:]
        print(json.dumps({
            "total": len(entries),
            "entries": entries,
        }, ensure_ascii=False, indent=2))
    finally:
        browser.close()


def cmd_risk_report(args: argparse.Namespace) -> None:
    """基于 NetLog 数据生成风控分析报告。"""
    from xhs.risk_analyzer import analyze

    browser, page = _connect(args)
    try:
        if not page.get_netlog_enabled():
            print(json.dumps({
                "error": "netlogger 未启用",
                "hint": "Electron XHS 会话未提供 NetLog 路径，请通过 GrowthForce 小红书连接器运行",
            }, ensure_ascii=False, indent=2))
            sys.exit(2)

        entries = page.get_netlog()
        report = analyze(entries)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        browser.close()


def cmd_publish_video(args: argparse.Namespace) -> None:
    """发布视频内容。"""
    from xhs.publish_preflight import validate_video_publish_input

    with open(args.title_file, encoding="utf-8") as f:
        title = f.read().strip()
    with open(args.content_file, encoding="utf-8") as f:
        content = f.read().strip()

    preflight = validate_video_publish_input(title, content, args.tags or [], args.video)
    from xhs.publish_video import publish_video_content
    from xhs.types import PublishVideoContent

    browser, page = _connect_checked(args)
    try:
        publish_video_content(
            page,
            PublishVideoContent(
                title=preflight.title,
                content=preflight.content,
                tags=preflight.tags,
                video_path=preflight.video or args.video,
                schedule_time=args.schedule_at,
                visibility=args.visibility or "",
            ),
        )
        _output({"success": True, "title": preflight.title, "video": preflight.video or args.video, "status": "发布完成"})
    finally:
        browser.close()


def cmd_creator_account_stats(args: argparse.Namespace) -> None:
    """读取创作者账号、周期、粉丝和受众数据。"""
    from xhs.creator_data import collect_account_snapshot

    browser, page = _connect(args)
    try:
        _output(
            collect_account_snapshot(
                page,
                period=args.period,
                include_sensitive=args.include_sensitive,
            )
        )
    finally:
        browser.close()


def cmd_creator_note_stats(args: argparse.Namespace) -> None:
    """读取并自动分页创作者笔记及内容分析数据。"""
    from xhs.creator_data import collect_note_snapshot

    browser, page = _connect(args)
    try:
        _output(
            collect_note_snapshot(
                page,
                status=args.status,
                max_pages=args.max_pages,
            )
        )
    finally:
        browser.close()


def cmd_creator_data_snapshot(args: argparse.Namespace) -> None:
    """读取当前可用的完整创作者数据快照。"""
    from xhs.creator_data import collect_full_snapshot

    browser, page = _connect(args)
    try:
        _output(
            collect_full_snapshot(
                page,
                period=args.period,
                max_pages=args.max_pages,
                include_sensitive=args.include_sensitive,
            )
        )
    finally:
        browser.close()


# ─── 参数解析 ──────────────────────────────────────────────────────────────────


INTERNAL_COMMANDS = {"check-login", "account-info", "login", "get-qrcode", "wait-login"}


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须是正整数")
    return parsed


def build_parser(*, include_internal: bool = False) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xhs-cli",
        description="小红书业务 CLI",
    )

    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
        metavar=(
            "{check-session,list-feeds,search-feeds,get-feed-detail,user-profile,"
            "post-comment,reply-comment,like-feed,favorite-feed,"
            "publish,publish-video,fill-publish,fill-publish-video,click-publish,save-draft,"
            "long-article,select-template,next-step,creator-account-stats,creator-note-stats,"
            "creator-data-snapshot,diagnose-404,check-risk,get-netlog,risk-report}"
        ),
    )

    if include_internal:
        # check-login
        sub = subparsers.add_parser("check-login", help=argparse.SUPPRESS)
        sub.set_defaults(func=cmd_check_login)

        # account-info
        sub = subparsers.add_parser("account-info", help=argparse.SUPPRESS)
        sub.set_defaults(func=cmd_account_info)

        # login
        sub = subparsers.add_parser("login", help=argparse.SUPPRESS)
        sub.set_defaults(func=cmd_login)

        # get-qrcode
        sub = subparsers.add_parser("get-qrcode", help=argparse.SUPPRESS)
        sub.set_defaults(func=cmd_get_qrcode)

        # wait-login
        sub = subparsers.add_parser("wait-login", help=argparse.SUPPRESS)
        sub.add_argument("--timeout", type=float, default=120.0, help=argparse.SUPPRESS)
        sub.set_defaults(func=cmd_wait_login)

    # check-session
    sub = subparsers.add_parser("check-session", help="检查当前登录态")
    sub.set_defaults(func=cmd_check_session)

    # list-feeds
    sub = subparsers.add_parser("list-feeds", help="获取首页推荐笔记列表")
    sub.set_defaults(func=cmd_list_feeds)

    # search-feeds
    sub = subparsers.add_parser("search-feeds", help="按关键词搜索笔记")
    sub.add_argument("--keyword", required=True, help="搜索关键词")
    sub.add_argument("--sort-by", help="排序: 综合|最新|最多点赞|最多评论|最多收藏")
    sub.add_argument("--note-type", help="类型: 不限|视频|图文")
    sub.add_argument("--publish-time", help="时间: 不限|一天内|一周内|半年内")
    sub.add_argument("--search-scope", help="范围: 不限|已看过|未看过|已关注")
    sub.add_argument("--location", help="位置: 不限|同城|附近")
    sub.set_defaults(func=cmd_search_feeds)

    # get-feed-detail
    sub = subparsers.add_parser("get-feed-detail", help="获取笔记详情和评论")
    sub.add_argument("--feed-id", required=True, help="Feed ID")
    sub.add_argument("--xsec-token", required=True, help="同一条 feed 的 xsecToken")
    sub.add_argument("--load-all-comments", action="store_true", help="加载全部评论")
    sub.add_argument("--click-more-replies", action="store_true", help="展开更多回复")
    sub.add_argument("--max-replies-threshold", type=int, default=10, help="展开子评论阈值")
    sub.add_argument("--max-comment-items", type=int, default=0, help="最多加载评论数，0 表示不限制")
    sub.add_argument("--scroll-speed", default="normal", help="slow|normal|fast")
    sub.add_argument("--keyword", default="篮球", help=argparse.SUPPRESS)
    sub.set_defaults(func=cmd_get_feed_detail)

    # user-profile
    sub = subparsers.add_parser("user-profile", help="获取用户主页")
    sub.add_argument("--user-id", required=True, help="用户 ID")
    sub.add_argument("--xsec-token", default="", help=argparse.SUPPRESS)
    sub.set_defaults(func=cmd_user_profile)

    # post-comment
    sub = subparsers.add_parser("post-comment", help="对笔记发表评论")
    sub.add_argument("--feed-id", required=True, help="Feed ID")
    sub.add_argument("--xsec-token", required=True, help="同一条 feed 的 xsecToken")
    sub.add_argument("--content", required=True, help="评论内容")
    sub.set_defaults(func=cmd_post_comment)

    # reply-comment
    sub = subparsers.add_parser("reply-comment", help="回复指定评论或用户")
    sub.add_argument("--feed-id", required=True, help="Feed ID")
    sub.add_argument("--xsec-token", required=True, help="同一条 feed 的 xsecToken")
    sub.add_argument("--content", required=True, help="回复内容")
    sub.add_argument("--comment-id", help="要回复的评论 ID")
    sub.add_argument("--user-id", help="要回复的用户 ID")
    sub.set_defaults(func=cmd_reply_comment)

    # like-feed
    sub = subparsers.add_parser("like-feed", help="点赞或取消点赞笔记")
    sub.add_argument("--feed-id", required=True, help="Feed ID")
    sub.add_argument("--xsec-token", required=True, help="同一条 feed 的 xsecToken")
    sub.add_argument("--unlike", action="store_true", help="取消点赞")
    sub.set_defaults(func=cmd_like_feed)

    # favorite-feed
    sub = subparsers.add_parser("favorite-feed", help="收藏或取消收藏笔记")
    sub.add_argument("--feed-id", required=True, help="Feed ID")
    sub.add_argument("--xsec-token", required=True, help="同一条 feed 的 xsecToken")
    sub.add_argument("--unfavorite", action="store_true", help="取消收藏")
    sub.set_defaults(func=cmd_favorite_feed)

    # publish
    sub = subparsers.add_parser("publish", help="发布图文")
    sub.add_argument("--title-file", required=True, help="标题文本文件")
    sub.add_argument("--content-file", required=True, help="正文文本文件")
    sub.add_argument("--images", nargs="+", required=True, help="图片路径或 URL")
    sub.add_argument("--tags", nargs="*", help="话题标签")
    sub.add_argument("--schedule-at", help="定时发布时间，ISO8601 格式")
    sub.add_argument("--original", action="store_true", help="声明原创")
    sub.add_argument("--visibility", help="可见范围")
    sub.set_defaults(func=cmd_publish)

    # publish-video
    sub = subparsers.add_parser("publish-video", help="发布视频")
    sub.add_argument("--title-file", required=True, help="标题文本文件")
    sub.add_argument("--content-file", required=True, help="正文文本文件")
    sub.add_argument("--video", required=True, help="视频文件路径")
    sub.add_argument("--tags", nargs="*", help="话题标签")
    sub.add_argument("--schedule-at", help="定时发布时间，ISO8601 格式")
    sub.add_argument("--visibility", help="可见范围")
    sub.set_defaults(func=cmd_publish_video)

    # fill-publish
    sub = subparsers.add_parser("fill-publish", help="填写图文表单（不发布）")
    sub.add_argument("--title-file", required=True, help="标题文本文件")
    sub.add_argument("--content-file", required=True, help="正文文本文件")
    sub.add_argument("--images", nargs="+", required=True, help="图片路径或 URL")
    sub.add_argument("--tags", nargs="*", help="话题标签")
    sub.add_argument("--schedule-at", help="定时发布时间，ISO8601 格式")
    sub.add_argument("--original", action="store_true", help="声明原创")
    sub.add_argument("--visibility", help="可见范围")
    sub.set_defaults(func=cmd_fill_publish)

    # fill-publish-video
    sub = subparsers.add_parser("fill-publish-video", help="填写视频表单（不发布）")
    sub.add_argument("--title-file", required=True, help="标题文本文件")
    sub.add_argument("--content-file", required=True, help="正文文本文件")
    sub.add_argument("--video", required=True, help="视频文件路径")
    sub.add_argument("--tags", nargs="*", help="话题标签")
    sub.add_argument("--schedule-at", help="定时发布时间，ISO8601 格式")
    sub.add_argument("--visibility", help="可见范围")
    sub.set_defaults(func=cmd_fill_publish_video)

    # click-publish
    sub = subparsers.add_parser("click-publish", help="点击发布按钮")
    sub.set_defaults(func=cmd_click_publish)

    # save-draft
    sub = subparsers.add_parser("save-draft", help="保存当前发布页为草稿")
    sub.set_defaults(func=cmd_save_draft)

    # long-article
    sub = subparsers.add_parser("long-article", help="长文模式：填写 + 一键排版")
    sub.add_argument("--title-file", required=True, help="标题文本文件")
    sub.add_argument("--content-file", required=True, help="正文文本文件")
    sub.add_argument("--images", nargs="*", help="图片路径或 URL")
    sub.set_defaults(func=cmd_long_article)

    # select-template
    sub = subparsers.add_parser("select-template", help="选择排版模板")
    sub.add_argument("--name", required=True, help="模板名称")
    sub.set_defaults(func=cmd_select_template)

    # next-step
    sub = subparsers.add_parser("next-step", help="点击下一步 + 填写描述")
    sub.add_argument("--content-file", required=True, help="发布页描述文本文件")
    sub.set_defaults(func=cmd_next_step)

    # creator-account-stats
    sub = subparsers.add_parser("creator-account-stats", help="读取创作者账号与数据看板")
    sub.add_argument("--period", choices=("7", "30", "all"), default="all", help="统计周期")
    sub.add_argument(
        "--include-sensitive",
        action="store_true",
        help="包含绑定手机号等敏感账号字段",
    )
    sub.set_defaults(func=cmd_creator_account_stats)

    # creator-note-stats
    sub = subparsers.add_parser("creator-note-stats", help="读取创作者笔记与单篇数据")
    sub.add_argument(
        "--status",
        choices=("all", "published", "reviewing", "rejected"),
        default="all",
        help="笔记状态",
    )
    sub.add_argument("--max-pages", type=_positive_int, default=100, help="最多读取页数，默认 100")
    sub.set_defaults(func=cmd_creator_note_stats)

    # creator-data-snapshot
    sub = subparsers.add_parser("creator-data-snapshot", help="读取完整创作者数据快照")
    sub.add_argument("--period", choices=("7", "30", "all"), default="all", help="统计周期")
    sub.add_argument(
        "--max-pages",
        type=_positive_int,
        default=100,
        help="最多读取笔记页数，默认 100",
    )
    sub.add_argument(
        "--include-sensitive",
        action="store_true",
        help="包含绑定手机号等敏感账号字段",
    )
    sub.set_defaults(func=cmd_creator_data_snapshot)

    # diagnose-404
    sub = subparsers.add_parser("diagnose-404", help="获取拦截器捕获的 404 根因诊断报告")
    sub.add_argument("--clear", action="store_true", help="清空已有诊断记录")
    sub.set_defaults(func=cmd_diagnose_404)

    # check-risk
    sub = subparsers.add_parser("check-risk", help="分析小红书风控状态")
    sub.add_argument(
        "--probe-urls",
        nargs="*",
        dest="probe_urls",
        default=[],
        help="额外探测的 API URL 列表",
    )
    sub.set_defaults(func=cmd_check_risk)

    # get-netlog
    sub = subparsers.add_parser("get-netlog", help="获取 NetLog 原始 entries")
    sub.add_argument("--limit", type=int, default=None, help="只取最近 N 条")
    sub.set_defaults(func=cmd_get_netlog)

    # risk-report
    sub = subparsers.add_parser("risk-report", help="基于 NetLog 生成风控分析报告")
    sub.set_defaults(func=cmd_risk_report)

    return parser


def _strip_hidden_runtime_args(argv: list[str]) -> list[str]:
    hidden_options = {"--runtime", "--bridge-url", "--cdp-port", "--target-id"}
    cleaned: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        option = arg.split("=", 1)[0]
        if option in hidden_options:
            if "=" not in arg and index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                index += 2
            else:
                index += 1
            continue
        cleaned.append(arg)
        index += 1
    return cleaned


def main() -> None:
    registry_path = _register_process()
    try:
        argv = _strip_hidden_runtime_args(sys.argv[1:])
        wants_command_help = any(arg in {"-h", "--help"} for arg in argv[1:])
        include_internal = bool(argv and argv[0] in INTERNAL_COMMANDS and not wants_command_help)
        parser = build_parser(include_internal=include_internal)
        args = parser.parse_args(argv)

        try:
            args.func(args)
        except Exception as e:
            logger.error("执行失败: %s", e, exc_info=True)
            _output(_error_payload(e), exit_code=2)
    finally:
        _unregister_process(registry_path)


if __name__ == "__main__":
    main()
