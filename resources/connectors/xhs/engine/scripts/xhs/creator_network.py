"""读取创作者页面自身发起的 CDP Network 响应。"""

from __future__ import annotations

import base64
import contextlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

from .cdp import CDPError, Page


@dataclass(frozen=True)
class ResponseSpec:
    key: str
    path: str
    required: bool = True
    query: dict[str, str] | None = None

    def matches(self, url: str) -> bool:
        parsed = urlparse(url)
        if parsed.path != self.path:
            return False
        if not self.query:
            return True
        actual = parse_qs(parsed.query)
        return all(actual.get(key) == [value] for key, value in self.query.items())


def _read_response_json(page: Page, request_id: str, timeout: float = 10.0) -> dict:
    with contextlib.suppress(CDPError):
        page.wait_for_event(
            "Network.loadingFinished",
            predicate=lambda item: item.get("params", {}).get("requestId") == request_id,
            timeout=timeout,
        )
    # 某些缓存响应不产生可观察的 loadingFinished；继续尝试读取响应体。

    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            result = page._send_session(
                "Network.getResponseBody",
                {"requestId": request_id},
                timeout=timeout,
            )
            body = result.get("body", "")
            if result.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise CDPError("创作者接口响应不是 JSON object")
            return payload
        except (CDPError, json.JSONDecodeError, UnicodeDecodeError) as error:
            last_error = error
            time.sleep(0.1)
    raise CDPError(f"无法读取创作者接口响应体: {last_error}")


def capture_responses(
    page: Page,
    specs: list[ResponseSpec],
    *,
    action: Callable[[], None],
    timeout: float = 20.0,
    settle_seconds: float = 1.0,
) -> tuple[dict[str, dict], list[dict]]:
    """执行页面动作并捕获匹配的真实响应体。"""
    methods = {
        "Network.responseReceived",
        "Network.loadingFinished",
        "Network.loadingFailed",
    }
    page._send_session(
        "Network.enable",
        {
            "maxTotalBufferSize": 100 * 1024 * 1024,
            "maxResourceBufferSize": 10 * 1024 * 1024,
        },
    )
    page.clear_events(methods)
    action()

    captured: dict[str, dict] = {}
    warnings: list[dict] = []
    deadline = time.monotonic() + timeout
    required_keys = {spec.key for spec in specs if spec.required}
    required_done_at: float | None = None

    while time.monotonic() < deadline:
        completion_reached = (
            required_keys.issubset(captured)
            if required_keys
            else bool(captured)
        )
        if completion_reached:
            if required_done_at is None:
                required_done_at = time.monotonic()
            elif time.monotonic() - required_done_at >= settle_seconds:
                break
        try:
            event = page.wait_for_event("Network.responseReceived", timeout=0.2)
        except CDPError:
            continue
        response = event.get("params", {}).get("response", {})
        url = response.get("url", "")
        spec = next((candidate for candidate in specs if candidate.matches(url)), None)
        if spec is None:
            continue
        status = int(response.get("status") or 0)
        if status != 200:
            warnings.append({
                "source": spec.key,
                "reason": "http_error",
                "status": status,
                "url": url,
            })
            continue
        request_id = event.get("params", {}).get("requestId")
        if not request_id:
            warnings.append({"source": spec.key, "reason": "missing_request_id", "url": url})
            continue
        try:
            captured[spec.key] = _read_response_json(page, request_id)
        except Exception as error:
            warnings.append({
                "source": spec.key,
                "reason": "response_body_unavailable",
                "message": str(error),
            })

    for spec in specs:
        already_warned = any(item.get("source") == spec.key for item in warnings)
        if spec.key not in captured and not already_warned:
            warnings.append({
                "source": spec.key,
                "reason": "timeout" if spec.required else "not_available",
            })
    return captured, warnings


def navigate_and_capture(
    page: Page,
    url: str,
    specs: list[ResponseSpec],
    *,
    timeout: float = 20.0,
) -> tuple[dict[str, dict], list[dict]]:
    return capture_responses(
        page,
        specs,
        action=lambda: page.navigate(url),
        timeout=timeout,
    )
