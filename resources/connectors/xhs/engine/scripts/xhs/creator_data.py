"""小红书创作者后台只读数据采集与稳定字段归一化。"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .creator_network import ResponseSpec, capture_responses, navigate_and_capture
from .creator_session import ensure_creator_session
from .errors import CreatorDataError

CREATOR_HOME_URL = "https://creator.xiaohongshu.com/new/home"
CREATOR_NOTE_MANAGER_URL = "https://creator.xiaohongshu.com/new/note-manager"
CREATOR_ANALYSIS_URL = "https://creator.xiaohongshu.com/statistics/data-analysis"
CREATOR_ACCOUNT_URL = "https://creator.xiaohongshu.com/statistics/account/v2"
CREATOR_FANS_URL = "https://creator.xiaohongshu.com/statistics/fans-data"

USER_INFO_PATH = "/api/galaxy/user/info"
PERSONAL_INFO_PATH = "/api/galaxy/creator/home/personal_info"
ACCOUNT_BASE_PATH = "/api/galaxy/v2/creator/datacenter/account/base"
NOTE_DETAIL_PATH = "/api/galaxy/creator/data/note_detail_new"
LATEST_NOTE_PATH = "/api/galaxy/creator/home/latest_note_data"
LIVE_OVERVIEW_PATH = "/api/galaxy/v2/creator/datacenter/livedata/overview"
PERMISSION_PATH = "/api/galaxy/creator/datacenter/permission/query"
AUDIENCE_SOURCE_PATH = "/api/galaxy/v2/creator/datacenter/audience/source/account"
AUDIENCE_PERIODS_PATH = "/api/galaxy/v2/creator/datacenter/audience/view/periods"
FANS_OVERALL_PATH = "/api/galaxy/creator/data/fans/overall_new"
ACTIVE_FANS_PATH = "/api/galaxy/creator/data/active_fans_new"
POSTED_NOTES_PATH = "/api/galaxy/v2/creator/note/user/posted"
NOTE_ANALYSIS_PATH = "/api/galaxy/creator/datacenter/note/analyze/list"

STATUS_TABS = {"all": 0, "published": 1, "reviewing": 2, "rejected": 3}
STATUS_LABELS = {"published": "已发布", "reviewing": "审核中", "rejected": "未通过"}
XHS_TIMEZONE = ZoneInfo("Asia/Shanghai")

METRIC_FIELDS = {
    "impl_count": "impressions",
    "view_count": "views",
    "cover_click_rate": "coverClickRate",
    "video_full_view_rate": "videoCompletionRate",
    "avg_view_time": "averageViewTime",
    "view_time_avg": "totalViewTime",
    "home_view_count": "profileViews",
    "like_count": "likes",
    "collect_count": "favorites",
    "comment_count": "comments",
    "danmaku_count": "danmaku",
    "share_count": "shares",
    "rise_fans_count": "followersGained",
    "loss_fans_count": "followersLost",
    "net_rise_fans_count": "netFollowers",
    "home_conversion_rise_fans_rate": "profileFollowConversionRate",
    "publish_note_num": "publishedNotes",
    "publish_normal_note_num": "publishedImageNotes",
    "publish_video_note_num": "publishedVideoNotes",
}

TREND_FIELDS = {
    "impl_count_list": "impressions",
    "view_list": "views",
    "cover_click_rate_list": "coverClickRate",
    "video_full_view_rate_list": "videoCompletionRate",
    "avg_view_time_list": "averageViewTime",
    "view_time_list": "totalViewTime",
    "home_view_list": "profileViews",
    "like_list": "likes",
    "collect_list": "favorites",
    "comment_list": "comments",
    "danmaku_list": "danmaku",
    "share_list": "shares",
    "rise_fans_list": "followersGained",
    "loss_fans_count_list": "followersLost",
    "net_rise_fans_count_list": "netFollowers",
    "home_conversion_rise_fans_rate_list": "profileFollowConversionRate",
    "publish_note_num_list": "publishedNotes",
    "publish_normal_note_num_list": "publishedImageNotes",
    "publish_video_note_num_list": "publishedVideoNotes",
}


def _date_from_ms(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value / 1000, XHS_TIMEZONE).date().isoformat()


def _date_from_seconds(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value, XHS_TIMEZONE).date().isoformat()


def _clean_transport(value: Any) -> Any:
    if isinstance(value, list):
        return [_clean_transport(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        _camelize_key(key): _clean_transport(item)
        for key, item in value.items()
        if not key.startswith("set_")
        and not key.endswith("_iterator")
        and not key.endswith("_size")
    }


def _camelize_key(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in tail)


def _business_data(response: dict | None, source: str, *, required: bool) -> dict | None:
    if response is None:
        if required:
            raise CreatorDataError(f"缺少核心创作者响应: {source}")
        return None
    success = response.get("success")
    code = response.get("code", response.get("result"))
    if success is False or (isinstance(code, int) and code != 0):
        if required:
            raise CreatorDataError(f"创作者接口业务失败: {source} (code={code})")
        return None
    data = response.get("data")
    if not isinstance(data, dict):
        if required:
            raise CreatorDataError(f"创作者接口缺少 data: {source}")
        return None
    inner_result = data.get("result")
    if isinstance(inner_result, dict):
        inner_success = inner_result.get("success")
        inner_code = inner_result.get("code")
        if inner_success is False or (isinstance(inner_code, int) and inner_code != 0):
            if required:
                raise CreatorDataError(
                    f"创作者接口内层业务失败: {source} (code={inner_code})"
                )
            return None
    return data


def _normalize_points(points: Any) -> list[dict]:
    if not isinstance(points, list):
        return []
    result = []
    for point in points:
        if not isinstance(point, dict):
            continue
        item = {
            "date": _date_from_ms(point.get("date")),
            "timestampMs": point.get("date"),
            "count": point.get("count"),
        }
        if "count_with_double" in point:
            item["preciseValue"] = point.get("count_with_double")
        result.append(item)
    return result


def _normalize_period(data: dict) -> dict:
    metrics = {
        target: data.get(source)
        for source, target in METRIC_FIELDS.items()
        if source in data
    }
    trends = {
        target: _normalize_points(data.get(source))
        for source, target in TREND_FIELDS.items()
        if source in data
    }
    comparisons: dict[str, dict] = {}
    for source, target in METRIC_FIELDS.items():
        rate_key = f"{source}_rate"
        display_key = f"{rate_key}_display"
        if rate_key in data or display_key in data:
            comparisons[target] = {
                "rate": data.get(rate_key),
                "display": data.get(display_key),
            }
    return {
        "startDate": _date_from_ms(data.get("begin_time")),
        "endDate": _date_from_ms(data.get("end_time")),
        "startTimestampMs": data.get("begin_time"),
        "endTimestampMs": data.get("end_time"),
        "metrics": metrics,
        "trends": trends,
        "comparisons": comparisons,
        "summary": data.get("summary"),
    }


def _availability(items: Any, message: str | None = None) -> dict:
    normalized_items = _clean_transport(items) if isinstance(items, list) else []
    if normalized_items:
        return {"available": True, "items": normalized_items}
    if message and ("不足" in message or "无法分析" in message):
        reason = "insufficient_data"
    else:
        reason = "no_data"
    return {"available": False, "reason": reason, "message": message, "items": []}


def normalize_account_snapshot(
    responses: dict[str, Any],
    *,
    period: str = "all",
    include_sensitive: bool = False,
) -> dict:
    user = _business_data(responses.get("userInfo"), "userInfo", required=True) or {}
    profile = _business_data(responses.get("personalInfo"), "personalInfo", required=True) or {}
    account_base = _business_data(responses.get("accountBase"), "accountBase", required=True) or {}
    fans = _business_data(responses.get("fansOverall"), "fansOverall", required=False)
    active_fans = _business_data(responses.get("activeFans"), "activeFans", required=False)
    permission = _business_data(responses.get("permission"), "permission", required=False)
    source = _business_data(responses.get("audienceSource"), "audienceSource", required=False)
    view_periods = _business_data(
        responses.get("audiencePeriods"),
        "audiencePeriods",
        required=False,
    )
    note_detail = _business_data(responses.get("noteDetail"), "noteDetail", required=False)
    live = _business_data(responses.get("liveOverview"), "liveOverview", required=False)

    warnings = list(responses.get("_warnings") or [])
    for key, value in (
        ("fansOverall", fans),
        ("activeFans", active_fans),
        ("permission", permission),
        ("audienceSource", source),
        ("audiencePeriods", view_periods),
        ("noteDetail", note_detail),
        ("liveOverview", live),
    ):
        if value is None and not any(item.get("source") == key for item in warnings):
            warnings.append({"source": key, "reason": "not_available"})

    selected_periods = (
        ("seven", "thirty")
        if period == "all"
        else ({"7": "seven", "30": "thirty"}[period],)
    )
    period_names = {"seven": "7", "thirty": "30"}
    normalized_periods = {
        period_names[name]: _normalize_period(account_base.get(name) or {})
        for name in selected_periods
    }

    permission_message = permission.get("tip_msg") if permission else None
    if permission and permission.get("status") == 0 and permission_message:
        data_center_permission = {
            "available": False,
            "reason": "permission_pending",
            "message": permission_message,
        }
    elif permission:
        data_center_permission = {"available": True, "message": permission_message}
    else:
        data_center_permission = {"available": False, "reason": "not_available"}

    account = {
        "userId": user.get("userId"),
        "redId": user.get("redId"),
        "name": user.get("userName") or profile.get("name"),
        "role": user.get("role"),
        "avatar": user.get("userAvatar"),
        "description": user.get("userDesc"),
        "zone": user.get("zone"),
        "realNameVerified": user.get("realNameVerified"),
    }
    if include_sensitive:
        account["phone"] = user.get("phone")

    fans_periods: dict[str, dict] = {}
    if fans:
        for name in selected_periods:
            data = fans.get(name) or {}
            fans_periods[period_names[name]] = {
                "total": data.get("fans_count"),
                "gained": data.get("rise_fans_count"),
                "lost": data.get("leave_fans_count"),
                "totalTrend": _normalize_points(data.get("fans_list")),
                "gainedTrend": _normalize_points(data.get("rise_fans_list")),
                "lostTrend": _normalize_points(data.get("leave_fans_list")),
            }

    def audience_period_payload(data: dict | None) -> dict:
        if not data:
            return {"available": False, "reason": "not_available", "periods": {}}
        values = {}
        for name in selected_periods:
            prefix = period_names[name]
            values[prefix] = _availability(
                data.get(name),
                data.get(f"{name}_tip_msg"),
            )
            values[prefix]["startDate"] = _date_from_ms(data.get(f"{name}_begin_time"))
            values[prefix]["endDate"] = _date_from_ms(data.get(f"{name}_end_time"))
        available = any(item["available"] for item in values.values())
        reasons = {item.get("reason") for item in values.values()}
        reason = None if available else (
            "insufficient_data" if "insufficient_data" in reasons else "no_data"
        )
        return {"available": available, "reason": reason, "periods": values}

    fan_profile_state = responses.get("fanProfileState") or {
        "available": False,
        "reason": "threshold_not_met",
        "message": "粉丝数过少，暂未触发画像接口",
    }
    result = {
        "success": True,
        "account": account,
        "profile": {
            "name": profile.get("name"),
            "avatar": profile.get("avatar"),
            "followingCount": profile.get("follow_count"),
            "fansCount": profile.get("fans_count"),
            "likesAndFavorites": profile.get("faved_count"),
            "redNumber": profile.get("red_num"),
            "description": profile.get("personal_desc"),
            "diagnosisStatus": profile.get("diagnosis_status"),
            "live": _clean_transport(profile.get("live_info")),
            "growth": _clean_transport(profile.get("grow_info")),
        },
        "permissions": {
            "granted": user.get("permissions") or [],
            "dataCenter": data_center_permission,
        },
        "periods": normalized_periods,
        "noteOverview": {
            period_names[name]: _clean_transport((note_detail or {}).get(name) or {})
            for name in selected_periods
        },
        "benchmarks": _clean_transport(account_base.get("analyse_infos") or []),
        "fans": {
            "periods": fans_periods,
            "active": {
                period_names[name]: _clean_transport((active_fans or {}).get(name) or [])
                for name in selected_periods
            },
            "profile": fan_profile_state,
        },
        "audience": {
            "source": audience_period_payload(source),
            "viewPeriods": audience_period_payload(view_periods),
        },
        "liveOverview": _clean_transport((live or {}).get("live_overview_data")),
        "partial": bool(warnings),
        "warnings": warnings,
        "source": {
            "kind": "creator_page_network",
            "capturedAt": datetime.now().astimezone().isoformat(),
        },
    }
    return result


def _normalize_note(note: dict) -> dict:
    visible_time = note.get("visible_time")
    item = {
        "id": note.get("id"),
        "title": note.get("display_title"),
        "type": note.get("type"),
        "status": {
            "tabStatus": note.get("tab_status"),
            "permissionCode": note.get("permission_code"),
            "message": note.get("permission_msg"),
        },
        "publishedAt": note.get("time"),
        "publishedDate": _date_from_seconds(visible_time),
        "publishedTimestampSeconds": visible_time,
        "scheduledTimestampSeconds": note.get("schedule_post_time"),
        "metrics": {
            "views": note.get("view_count"),
            "likes": note.get("likes"),
            "favorites": note.get("collected_count"),
            "comments": note.get("comments_count"),
            "shares": note.get("shared_count"),
        },
        "sticky": note.get("sticky"),
        "cocreate": note.get("cocreate"),
        "covers": [
            image.get("url")
            for image in note.get("images_list") or []
            if isinstance(image, dict) and image.get("url")
        ],
    }
    video_info = note.get("video_info")
    if isinstance(video_info, dict):
        item["videoDurationSeconds"] = video_info.get("duration")
    return item


def _normalize_analysis(item: dict) -> dict:
    return {
        "reads": item.get("read_count"),
        "likes": item.get("like_count"),
        "favorites": item.get("fav_count"),
        "comments": item.get("comment_count"),
        "shares": item.get("share_count"),
        "auditStatus": item.get("audit_status"),
        "type": item.get("type"),
        "cover": item.get("cover_url"),
        "publishedDate": _date_from_ms(item.get("post_time")),
        "publishedTimestampMs": item.get("post_time"),
        "updatedTimestampMs": item.get("update_time"),
        "userUpdatedTimestampMs": item.get("user_update_time"),
    }


def normalize_note_snapshot(
    pages: list[dict],
    analysis_response: dict | None,
    *,
    status: str,
    warnings: list[dict] | None = None,
) -> dict:
    normalized_warnings = list(warnings or [])
    notes: list[dict] = []
    total_hint: int | None = None
    next_page: int | None = None

    for index, response in enumerate(pages):
        data = _business_data(response, f"notePage[{index}]", required=index == 0)
        if not data:
            normalized_warnings.append({
                "source": f"notePage[{index}]",
                "reason": "not_available",
            })
            continue
        notes.extend(
            _normalize_note(note)
            for note in data.get("notes") or []
            if isinstance(note, dict)
        )
        next_value = data.get("page")
        next_page = next_value if isinstance(next_value, int) and next_value >= 0 else None
        for tag in data.get("tags") or []:
            if (
                status == "all"
                and isinstance(tag, dict)
                and tag.get("id") == "special.note_time_desc"
            ):
                total_hint = tag.get("notes_count")

    analysis_data = _business_data(analysis_response, "noteAnalysis", required=False)
    analysis_items = (
        analysis_data.get("note_infos") or []
        if isinstance(analysis_data, dict)
        else []
    )
    by_id = {
        item.get("id"): _normalize_analysis(item)
        for item in analysis_items
        if isinstance(item, dict) and item.get("id")
    }
    for note in notes:
        analysis = by_id.get(note.get("id"))
        if analysis is not None:
            note["analysis"] = analysis

    if (
        analysis_response is None
        and not any(item.get("source") == "noteAnalysis" for item in normalized_warnings)
    ):
        normalized_warnings.append({"source": "noteAnalysis", "reason": "not_available"})
    return {
        "success": True,
        "status": status,
        "notes": {
            "items": notes,
            "totalHint": total_hint,
            "nextPage": next_page,
        },
        "analysis": {
            "items": [
                {"noteId": item.get("id"), **_normalize_analysis(item)}
                for item in analysis_items
                if isinstance(item, dict)
            ],
            "total": analysis_data.get("total") if analysis_data else None,
        },
        "partial": bool(normalized_warnings),
        "warnings": normalized_warnings,
        "source": {
            "kind": "creator_page_network",
            "capturedAt": datetime.now().astimezone().isoformat(),
        },
    }


def collect_account_snapshot(
    page,
    *,
    period: str = "all",
    include_sensitive: bool = False,
) -> dict:
    ensure_creator_session(page)
    responses: dict[str, Any] = {}
    warnings: list[dict] = []

    home, current_warnings = navigate_and_capture(
        page,
        CREATOR_HOME_URL,
        [
            ResponseSpec("userInfo", USER_INFO_PATH),
            ResponseSpec("personalInfo", PERSONAL_INFO_PATH),
            ResponseSpec("accountBase", ACCOUNT_BASE_PATH),
            ResponseSpec("noteDetail", NOTE_DETAIL_PATH, required=False),
            ResponseSpec("latestNote", LATEST_NOTE_PATH, required=False),
            ResponseSpec("liveOverview", LIVE_OVERVIEW_PATH, required=False),
        ],
    )
    responses.update(home)
    warnings.extend(current_warnings)

    account, current_warnings = navigate_and_capture(
        page,
        CREATOR_ACCOUNT_URL,
        [
            ResponseSpec("permission", PERMISSION_PATH),
            ResponseSpec("audienceSource", AUDIENCE_SOURCE_PATH, required=False),
            ResponseSpec("audiencePeriods", AUDIENCE_PERIODS_PATH, required=False),
        ],
    )
    responses.update(account)
    warnings.extend(current_warnings)

    fans, current_warnings = navigate_and_capture(
        page,
        CREATOR_FANS_URL,
        [
            ResponseSpec("fansOverall", FANS_OVERALL_PATH),
            ResponseSpec("activeFans", ACTIVE_FANS_PATH, required=False),
        ],
    )
    responses.update(fans)
    warnings.extend(current_warnings)
    try:
        body_text = page.evaluate("(document.body?.innerText || '').slice(0, 10000)") or ""
        if "粉丝数过少" in body_text:
            responses["fanProfileState"] = {
                "available": False,
                "reason": "threshold_not_met",
                "message": "粉丝数过少，先去涨粉吧～",
            }
    except Exception:
        pass
    responses["_warnings"] = warnings
    return normalize_account_snapshot(
        responses,
        period=period,
        include_sensitive=include_sensitive,
    )


def _click_note_status(page, label: str) -> None:
    result = page.evaluate(
        f"""
        (() => {{
            const label = {label!r};
            const candidates = [...document.querySelectorAll('div,span')];
            const target = candidates.find((element) => {{
                if ((element.textContent || '').trim() !== label) return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.left > -1000 && rect.top > -1000;
            }});
            if (!target) return false;
            target.click();
            return true;
        }})()
        """
    )
    if not result:
        raise CreatorDataError(f"未找到笔记状态筛选: {label}")


def _scroll_note_list(page) -> None:
    page.evaluate(
        """
        (() => {
            const containers = [...document.querySelectorAll('.content')]
                .filter((element) => {
                    const style = getComputedStyle(element);
                    return element.scrollHeight > element.clientHeight + 20
                        && ['auto', 'scroll'].includes(style.overflowY);
                });
            const target = containers.sort(
                (a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
            )[0];
            if (!target) return false;
            target.scrollTop = target.scrollHeight;
            target.dispatchEvent(new Event('scroll', {bubbles: true}));
            return true;
        })()
        """
    )


def collect_note_snapshot(
    page,
    *,
    status: str = "all",
    max_pages: int = 100,
) -> dict:
    ensure_creator_session(page)
    tab = STATUS_TABS[status]
    warnings: list[dict] = []
    initial, current_warnings = navigate_and_capture(
        page,
        CREATOR_NOTE_MANAGER_URL,
        [
            ResponseSpec(
                "notePage",
                POSTED_NOTES_PATH,
                query={"tab": "0", "page": "0"},
            )
        ],
    )
    warnings.extend(current_warnings)
    first_page = initial.get("notePage")

    if status != "all":
        selected, current_warnings = capture_responses(
            page,
            [
                ResponseSpec(
                    "notePage",
                    POSTED_NOTES_PATH,
                    query={"tab": str(tab), "page": "0"},
                )
            ],
            action=lambda: _click_note_status(page, STATUS_LABELS[status]),
        )
        warnings.extend(current_warnings)
        first_page = selected.get("notePage")

    pages = [first_page] if first_page else []
    next_page = (
        first_page.get("data", {}).get("page")
        if isinstance(first_page, dict)
        else -1
    )
    while isinstance(next_page, int) and next_page >= 0 and len(pages) < max_pages:
        page_number = next_page
        captured, current_warnings = capture_responses(
            page,
            [
                ResponseSpec(
                    "notePage",
                    POSTED_NOTES_PATH,
                    query={"tab": str(tab), "page": str(page_number)},
                )
            ],
            action=lambda: _scroll_note_list(page),
        )
        warnings.extend(current_warnings)
        response = captured.get("notePage")
        if not response:
            break
        pages.append(response)
        candidate = response.get("data", {}).get("page")
        if candidate == next_page:
            warnings.append({"source": "notePagination", "reason": "stalled"})
            break
        next_page = candidate
        time.sleep(0.2)

    if isinstance(next_page, int) and next_page >= 0 and len(pages) >= max_pages:
        warnings.append({
            "source": "notePagination",
            "reason": "max_pages_reached",
            "nextPage": next_page,
        })

    analysis, current_warnings = navigate_and_capture(
        page,
        CREATOR_ANALYSIS_URL,
        [
            ResponseSpec(
                "noteAnalysis",
                NOTE_ANALYSIS_PATH,
                required=False,
                query={"type": "0", "page_size": "10", "page_num": "1"},
            )
        ],
    )
    warnings.extend(current_warnings)
    return normalize_note_snapshot(
        pages,
        analysis.get("noteAnalysis"),
        status=status,
        warnings=warnings,
    )


def collect_full_snapshot(
    page,
    *,
    period: str = "all",
    max_pages: int = 100,
    include_sensitive: bool = False,
) -> dict:
    account = collect_account_snapshot(
        page,
        period=period,
        include_sensitive=include_sensitive,
    )
    notes = collect_note_snapshot(page, status="all", max_pages=max_pages)
    warnings = account.get("warnings", []) + notes.get("warnings", [])
    return {
        "success": True,
        "accountData": account,
        "noteData": notes,
        "partial": account.get("partial", False) or notes.get("partial", False),
        "warnings": warnings,
        "source": {
            "kind": "creator_page_network",
            "capturedAt": datetime.now().astimezone().isoformat(),
        },
    }
