"""Electron CDP runtime risk diagnostics for XHS.

This module intentionally avoids the upstream Chrome extension / bridge path.
It reads the Electron main-process NetLog sidecar file and uses read-only CDP
page probes to decide whether the current session looks risky.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .risk_analyzer import analyze as analyze_netlog


RISK_ORDER = {"safe": 0, "low": 1, "unknown": 1, "medium": 2, "high": 3}
STOP_REASON_OBSERVATION_UNAVAILABLE = "XHS_RISK_OBSERVATION_UNAVAILABLE"


def get_netlog_enabled() -> bool:
    return bool(_netlog_path())


def read_netlog() -> list[dict[str, Any]]:
    path = _netlog_path()
    if not path or not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return value if isinstance(value, list) else []


def clear_404_diagnostics() -> None:
    diagnostics_path = _diagnostics_path()
    if diagnostics_path:
        diagnostics_path.unlink(missing_ok=True)


def get_404_diagnostics(page: Any) -> list[dict[str, Any]]:
    entries = read_netlog()
    events = [_diagnose_netlog_entry(entry) for entry in entries if _is_404_candidate(entry)]
    events = [event for event in events if event]
    page_event = _diagnose_current_page(page)
    if page_event:
        events.append(page_event)
    _write_diagnostics(events)
    return events[-50:]


def analyze_risk_control(page: Any, probe_urls: list[str] | None = None) -> dict[str, Any]:
    probe_urls = probe_urls or []
    issues: list[dict[str, str]] = []
    recommendations: list[str] = []
    page_report = _read_page_risk_state(page, probe_urls)
    fingerprint = page_report.get("fingerprint", {}) if isinstance(page_report, dict) else {}
    page_state = page_report.get("page_state", {}) if isinstance(page_report, dict) else {}
    api_probes = page_report.get("api_probes", {}) if isinstance(page_report, dict) else {}

    if fingerprint.get("webdriver") is True:
        issues.append({"level": "high", "msg": "navigator.webdriver = true，自动化特征已暴露"})
    if fingerprint.get("plugins_count") == 0:
        issues.append({"level": "medium", "msg": "navigator.plugins 为空，疑似自动化环境"})
    if fingerprint.get("is_headless_ua"):
        issues.append({"level": "high", "msg": f"User-Agent 含自动化标志: {fingerprint.get('user_agent')}"})
    if fingerprint.get("is_electron_ua"):
        issues.append({"level": "high", "msg": "User-Agent 含 Electron 标志"})
    if fingerprint.get("is_agentstudio_ua"):
        issues.append({"level": "high", "msg": "User-Agent 含 GrowthForce 应用标志"})
    if fingerprint.get("has_electron_ua_ch"):
        issues.append({"level": "high", "msg": "User-Agent Client Hints 含 Electron 品牌"})
    if fingerprint.get("ua_version_consistent") is False:
        issues.append({"level": "high", "msg": "User-Agent 与 Client Hints 的 Chromium 主版本不一致"})
    if fingerprint.get("webgl_is_swiftshader"):
        issues.append({"level": "high", "msg": f"WebGL 软件渲染: {fingerprint.get('webgl_renderer')}"})
    if fingerprint.get("visibility_state") != "visible":
        issues.append({"level": "medium", "msg": f"document.visibilityState = {fingerprint.get('visibility_state')!r}"})

    if page_state.get("has_captcha_modal"):
        issues.append({"level": "high", "msg": "检测到页面验证码/人机验证弹窗"})
    if page_state.get("page_is_404"):
        issues.append({"level": "high", "msg": "当前页面为 404 或 not-found 状态"})
    if page_state.get("page_has_risk_block"):
        issues.append({"level": "high", "msg": "检测到风控封锁页面元素"})
    if page_state.get("state_risk_keys"):
        issues.append({"level": "high", "msg": "__INITIAL_STATE__ 含风控字段: " + ", ".join(page_state["state_risk_keys"])})

    for key, probe in api_probes.items():
        if not isinstance(probe, dict):
            continue
        if probe.get("risk_blocked"):
            issues.append({"level": "high", "msg": f"API {key} 返回风控状态码 {probe.get('status')}"})
        elif probe.get("xhs_code") in (300012, -9001):
            issues.append({"level": "high", "msg": f"API {key} 返回封号/风控码 {probe.get('xhs_code')}: {probe.get('xhs_msg')}"})
        elif probe.get("xhs_code") == -1:
            issues.append({"level": "medium", "msg": f"API {key} 返回系统繁忙 (-1): {probe.get('xhs_msg')}"})

    entries = read_netlog()
    leaked_request_uas = [
        str(entry.get("reqHeaders", {}).get("user-agent", ""))
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("reqHeaders"), dict)
        and ("electron/" in str(entry.get("reqHeaders", {}).get("user-agent", "")).lower()
             or "agentstudio/" in str(entry.get("reqHeaders", {}).get("user-agent", "")).lower()
             or "growthforce/" in str(entry.get("reqHeaders", {}).get("user-agent", "")).lower())
    ]
    if leaked_request_uas:
        issues.append({"level": "high", "msg": "网络请求 User-Agent 仍含 Electron 或 GrowthForce 标志"})
    request_headers = next((
        entry.get("reqHeaders", {})
        for entry in reversed(entries)
        if isinstance(entry, dict) and isinstance(entry.get("reqHeaders"), dict)
    ), {})
    request_ua = str(request_headers.get("user-agent", ""))
    page_ua = str(fingerprint.get("user_agent", ""))
    if request_ua and page_ua and request_ua != page_ua:
        issues.append({"level": "high", "msg": "网络请求 User-Agent 与 navigator.userAgent 不一致"})
    request_language = str(request_headers.get("accept-language", "")).split(",", 1)[0].split(";", 1)[0].strip().lower()
    page_languages = fingerprint.get("languages", [])
    page_language = str(page_languages[0]).strip().lower() if isinstance(page_languages, list) and page_languages else ""
    if request_language and page_language and request_language != page_language:
        issues.append({"level": "medium", "msg": "Accept-Language 与 navigator.languages 首选语言不一致"})
    netlog_report = analyze_netlog(entries)
    for signal in netlog_report.get("high_risk_signals", [])[:10]:
        issues.append({"level": "medium", "msg": str(signal)})
    for warning in netlog_report.get("warnings", [])[:5]:
        issues.append({"level": "low", "msg": str(warning)})

    if not entries:
        recommendations.append("当前 Electron XHS 会话尚无可分析请求，请先执行一次搜索、详情或发布前检查")
    if any(issue["level"] == "high" for issue in issues):
        recommendations.append("暂停发布或批量互动，等待账号状态恢复后再继续")
    elif any(issue["level"] == "medium" for issue in issues):
        recommendations.append("降低操作频率，避免继续批量详情、点赞、收藏或评论")
    elif issues:
        recommendations.append("继续操作时保持较长随机间隔")

    risk_level = _merge_risk_levels(_risk_level_from_issues(issues), str(netlog_report.get("risk_level", "unknown")))
    if not entries and not issues:
        risk_level = "unknown"

    return {
        "risk_level": risk_level,
        "issues": issues,
        "fingerprint": fingerprint,
        "page_state": page_state,
        "api_probes": api_probes,
        "netlog_summary": {
            "risk_level": netlog_report.get("risk_level", "unknown"),
            "total_requests": netlog_report.get("total_requests", 0),
            "summary": netlog_report.get("summary", ""),
            "category_distribution": netlog_report.get("category_distribution", {}),
            "top_hosts": netlog_report.get("top_hosts", {}),
        },
        "recommendations": recommendations,
        "probe_urls": probe_urls,
        "observation_available": bool(entries),
        "observation_unavailable_reason": None if entries else STOP_REASON_OBSERVATION_UNAVAILABLE,
    }


def _read_page_risk_state(page: Any, probe_urls: list[str]) -> dict[str, Any]:
    extra_probes = json.dumps(probe_urls, ensure_ascii=False)
    expression = r"""
    (async () => {
      const extraProbeUrls = __EXTRA_PROBE_URLS__;
      const report = {
        fingerprint: {},
        page_state: {},
        api_probes: {},
      };
      const fp = report.fingerprint;
      fp.webdriver = navigator.webdriver === true;
      fp.plugins_count = navigator.plugins ? navigator.plugins.length : 0;
      fp.languages = Array.from(navigator.languages || []);
      fp.user_agent = navigator.userAgent || "";
      fp.is_headless_ua = /HeadlessChrome|PhantomJS/.test(fp.user_agent);
      fp.is_electron_ua = /Electron\//.test(fp.user_agent);
      fp.is_agentstudio_ua = /(?:agentstudio|growthforce)\//i.test(fp.user_agent);
      const uaData = navigator.userAgentData || null;
      fp.ua_ch_brands = uaData ? Array.from(uaData.brands || []) : [];
      fp.ua_ch_platform = uaData ? uaData.platform || "" : "";
      fp.ua_ch_mobile = uaData ? uaData.mobile === true : false;
      fp.ua_ch_full_version_list = [];
      if (uaData && typeof uaData.getHighEntropyValues === "function") {
        try {
          const highEntropy = await uaData.getHighEntropyValues(["fullVersionList"]);
          fp.ua_ch_full_version_list = Array.from(highEntropy.fullVersionList || []);
        } catch (_) {}
      }
      const allBrands = fp.ua_ch_full_version_list.length ? fp.ua_ch_full_version_list : fp.ua_ch_brands;
      fp.has_electron_ua_ch = allBrands.some((item) => /electron/i.test(String(item && item.brand || "")));
      const uaMajor = (fp.user_agent.match(/Chrome\/(\d+)/) || [])[1] || null;
      const chromiumBrand = allBrands.find((item) => /^(Chromium|Google Chrome)$/.test(String(item && item.brand || "")));
      const brandMajor = chromiumBrand ? String(chromiumBrand.version || "").split(".")[0] : null;
      fp.ua_version_consistent = !uaMajor || !brandMajor ? null : uaMajor === brandMajor;
      fp.outer_width = window.outerWidth;
      fp.outer_height = window.outerHeight;
      fp.screen_width = screen.width;
      fp.screen_height = screen.height;
      fp.color_depth = screen.colorDepth;
      fp.device_memory = navigator.deviceMemory || null;
      fp.hardware_concurrency = navigator.hardwareConcurrency || null;
      fp.platform = navigator.platform || "";
      fp.visibility_state = document.visibilityState;
      fp.document_hidden = document.hidden;
      try {
        const perm = await navigator.permissions.query({ name: "notifications" });
        fp.notifications_permission = perm.state;
      } catch (_) {
        fp.notifications_permission = "unknown";
      }
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          if (dbg) {
            fp.webgl_vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
            fp.webgl_renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
            fp.webgl_is_swiftshader = /SwiftShader|llvmpipe|softpipe/i.test(fp.webgl_renderer || "");
          }
        }
      } catch (_) {}

      const ps = report.page_state;
      ps.current_url = window.location.href;
      ps.page_title = document.title;
      ps.has_captcha_modal = !!(
        document.querySelector('[class*="captcha"]') ||
        document.querySelector('[class*="verify-modal"]') ||
        document.querySelector("#captcha-container")
      );
      ps.page_is_404 = document.title.includes("404") ||
        !!(document.querySelector('[class*="not-found"]') || document.querySelector('[class*="error-page"]') || document.querySelector('[class*="page-404"]'));
      ps.page_has_risk_block = !!(
        document.querySelector('[class*="risk-block"]') ||
        document.querySelector('[class*="forbidden-page"]')
      );
      try {
        const state = window.__INITIAL_STATE__;
        ps.has_initial_state = !!state;
        const riskKeys = ["riskControl", "blockReason", "needVerification", "forbidden", "pageError", "noteError"];
        ps.state_risk_keys = state ? riskKeys.filter((key) => key in state) : [];
      } catch (_) {
        ps.has_initial_state = false;
        ps.state_risk_keys = [];
      }

      const defaultProbes = [
        { key: "/api/sns/web/v2/user/me", url: "https://www.xiaohongshu.com/api/sns/web/v2/user/me", method: "GET" },
        { key: "/api/sns/web/v1/search/complete", url: "https://www.xiaohongshu.com/api/sns/web/v1/search/complete?keyword=test", method: "GET" },
        { key: "/api/sns/web/v1/homefeed", url: "https://www.xiaohongshu.com/api/sns/web/v1/homefeed", method: "POST", body: JSON.stringify({ cursor_score: "", num: 1, refresh_type: 1, note_index: 1 }) },
      ];
      const probes = defaultProbes.concat(extraProbeUrls.map((url) => ({ key: url, url, method: "GET" })));
      for (const probe of probes) {
        try {
          const opts = { method: probe.method, credentials: "include" };
          if (probe.body) {
            opts.body = probe.body;
            opts.headers = { "Content-Type": "application/json" };
          }
          const resp = await fetch(probe.url, opts);
          let body = null;
          try { body = await resp.json(); } catch (_) {}
          report.api_probes[probe.key] = {
            status: resp.status,
            ok: resp.ok,
            xhs_code: body && typeof body === "object" ? body.code ?? null : null,
            xhs_msg: body && typeof body === "object" ? body.msg || body.message || null : null,
            risk_blocked: resp.status === 404 || resp.status === 461 || resp.status === 999,
          };
        } catch (e) {
          report.api_probes[probe.key] = { error: String(e && e.message || e) };
        }
      }
      return report;
    })()
    """.replace("__EXTRA_PROBE_URLS__", extra_probes)
    try:
        result = page.evaluate_async(expression, timeout=20.0)
        return result if isinstance(result, dict) else {}
    except Exception as exc:
        return {
            "fingerprint": {},
            "page_state": {},
            "api_probes": {},
            "probe_error": str(exc),
        }


def _is_404_candidate(entry: dict[str, Any]) -> bool:
    category = entry.get("category")
    status = entry.get("status")
    redirect = str(entry.get("redirectTo") or "")
    path = str(entry.get("path") or "")
    return (
        category in {"risk_redirect", "business_error", "signature_failure"}
        or status in (401, 403, 404, 461, 999)
        or "/404" in redirect
        or path.startswith("/404")
    )


def _diagnose_netlog_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    diagnosis = _diagnosis_from_entry(entry)
    if not diagnosis:
        return None
    return {
        "id": entry.get("id"),
        "timestamp": entry.get("tsLabel") or entry.get("ts"),
        "url": entry.get("url"),
        "final_url": entry.get("redirectTo") or entry.get("url"),
        "method": entry.get("method"),
        "status": entry.get("status"),
        "pageUrl": entry.get("url"),
        "intercept_type": "electron_netlog",
        "block_type": diagnosis.get("cause_category"),
        "request": {
            "xsec_token": _extract_xsec_token(str(entry.get("url") or "")),
            "has_xs": bool((entry.get("reqFingerprint") or {}).get("has_xs")),
            "has_xt": bool((entry.get("reqFingerprint") or {}).get("has_xt")),
            "has_referer": bool((entry.get("reqFingerprint") or {}).get("referer")),
        },
        "cookies": ((entry.get("reqFingerprint") or {}).get("cookie") or {}),
        "diagnosis": diagnosis,
    }


def _diagnosis_from_entry(entry: dict[str, Any]) -> dict[str, str] | None:
    cookie = ((entry.get("reqFingerprint") or {}).get("cookie") or {})
    url = str(entry.get("url") or "")
    redirect = str(entry.get("redirectTo") or "")
    status = int(entry.get("status") or 0)
    has_session = bool(cookie.get("has_web_session"))
    xsec_token = _extract_xsec_token(url)

    if "/404" in redirect and not has_session:
        return _diag("web_session 缺失或失效，服务端重定向到 /404", "session", "重新登录后再重试。", "high")
    if "/404" in redirect and not xsec_token and "/explore/" in url:
        return _diag("xsec_token 缺失，服务端重定向到 /404", "token_missing", "必须从搜索/推荐流获取带 xsecToken 的同一条 feed。", "high")
    if "/404" in redirect and xsec_token:
        return _diag("xsec_token 与当前 session/IP/source 绑定验证失败", "token_binding", "重新从当前账号的搜索或首页结果获取新的 xsecToken。", "high")
    if status in (401, 403):
        return _diag(f"请求被拒绝：HTTP {status}", "session", "检查登录态或降低频率后重试。", "medium")
    if status in (461, 999):
        return _diag(f"平台返回风控状态码：HTTP {status}", "risk_control", "停止批量操作，等待账号状态恢复。", "high")
    if status == 404:
        return _diag("页面或 API 返回 404，可能是 token、内容状态或风控拦截", "unknown", "结合详情 URL 和当前登录态进一步确认。", "medium")
    return None


def _diagnose_current_page(page: Any) -> dict[str, Any] | None:
    try:
        state = page.evaluate(
            r"""
            (() => {
              const cookieMap = {};
              for (const part of document.cookie.split(";")) {
                const index = part.indexOf("=");
                if (index < 0) continue;
                cookieMap[part.slice(0, index).trim()] = part.slice(index + 1).trim();
              }
              return {
                url: window.location.href,
                title: document.title,
                has_web_session: "web_session" in cookieMap,
                has_a1: "a1" in cookieMap,
                has_captcha: !!(document.querySelector('[class*="captcha"]') || document.querySelector('[class*="verify-modal"]') || document.querySelector("#captcha-container")),
                page_is_404: document.title.includes("404") || !!(document.querySelector('[class*="not-found"]') || document.querySelector('[class*="error-page"]') || document.querySelector('[class*="page-404"]')),
              };
            })()
            """
        )
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    diagnosis = None
    if state.get("has_captcha"):
        diagnosis = _diag("触发人机验证弹窗", "captcha", "停止互动/发布，等待用户手动处理或稍后再试。", "high")
    elif state.get("page_is_404"):
        diagnosis = _diag("当前页面为 404/not-found 状态", "unknown", "可能是 token、session 或内容不可用导致。", "medium")
    if not diagnosis:
        return None
    return {
        "id": "current_page",
        "timestamp": None,
        "url": state.get("url"),
        "final_url": state.get("url"),
        "method": "GET",
        "status": 404 if state.get("page_is_404") else "page_state",
        "pageUrl": state.get("url"),
        "intercept_type": "electron_page_state",
        "block_type": diagnosis["cause_category"],
        "request": {"xsec_token": _extract_xsec_token(str(state.get("url") or ""))},
        "cookies": {"has_web_session": state.get("has_web_session"), "has_a1": state.get("has_a1")},
        "diagnosis": diagnosis,
    }


def _diag(root_cause: str, category: str, detail: str, confidence: str) -> dict[str, str]:
    return {
        "root_cause": root_cause,
        "cause_category": category,
        "detail": detail,
        "confidence": confidence,
    }


def _extract_xsec_token(url: str) -> str | None:
    marker = "xsec_token="
    if marker not in url:
        return None
    return url.split(marker, 1)[1].split("&", 1)[0] or None


def _write_diagnostics(events: list[dict[str, Any]]) -> None:
    path = _diagnostics_path()
    if not path:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(events[-50:], ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _risk_level_from_issues(issues: list[dict[str, str]]) -> str:
    high = sum(1 for issue in issues if issue.get("level") == "high")
    medium = sum(1 for issue in issues if issue.get("level") == "medium")
    if high >= 2:
        return "high"
    if high >= 1 or medium >= 2:
        return "medium"
    if medium >= 1 or issues:
        return "low"
    return "safe"


def _merge_risk_levels(*levels: str) -> str:
    return max(levels, key=lambda level: RISK_ORDER.get(level, 1))


def _netlog_path() -> Path | None:
    value = os.environ.get("AGENTSTUDIO_XHS_NETLOG_PATH", "").strip()
    return Path(value).expanduser() if value else None


def _diagnostics_path() -> Path | None:
    value = os.environ.get("AGENTSTUDIO_XHS_DIAGNOSTICS_PATH", "").strip()
    return Path(value).expanduser() if value else None
