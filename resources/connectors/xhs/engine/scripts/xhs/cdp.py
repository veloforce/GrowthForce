"""CDP WebSocket 客户端（Browser, Page, Element），对应 Go browser/browser.go + go-rod API。

通过原生 WebSocket 与 Chrome DevTools Protocol 通信，实现浏览器自动化控制。
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
from collections import deque
from queue import Queue
from typing import Any

from .errors import CDPError, ElementNotFoundError

logger = logging.getLogger(__name__)

_WEBDRIVER_COMPATIBILITY_SCRIPT = r"""
(() => {
  const prototype = globalThis.Navigator && Navigator.prototype;
  if (!prototype || navigator.webdriver !== true) return;
  Object.defineProperty(prototype, "webdriver", {
    configurable: true,
    enumerable: true,
    get: () => undefined,
  });
})();
"""


class CDPClient:
    """底层 CDP WebSocket 通信客户端。"""

    def __init__(self, ws_url: str, websocket: Any | None = None) -> None:
        if websocket is None:
            import websockets.sync.client as ws_client

            websocket = ws_client.connect(ws_url, max_size=50 * 1024 * 1024)
        self._ws = websocket
        self._id = 0
        self._id_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._pending: dict[int, Queue[dict]] = {}
        self._pending_lock = threading.Lock()
        self._events: deque[dict] = deque(maxlen=2000)
        self._event_condition = threading.Condition()
        self._closed = False
        self._reader = threading.Thread(
            target=self._read_loop,
            name="xhs-cdp-reader",
            daemon=True,
        )
        self._reader.start()

    def send(self, method: str, params: dict | None = None) -> dict:
        """发送 CDP 命令并等待结果。"""
        return self._send_message(method, params)

    def send_session(
        self,
        session_id: str,
        method: str,
        params: dict | None = None,
        timeout: float = 60.0,
    ) -> dict:
        """向 flattened target session 发送命令并等待结果。"""
        return self._send_message(method, params, session_id=session_id, timeout=timeout)

    def _send_message(
        self,
        method: str,
        params: dict | None = None,
        *,
        session_id: str | None = None,
        timeout: float = 30.0,
    ) -> dict:
        with self._id_lock:
            self._id += 1
            msg_id = self._id
        msg: dict[str, Any] = {"id": msg_id, "method": method}
        if session_id:
            msg["sessionId"] = session_id
        if params:
            msg["params"] = params
        response_queue: Queue[dict] = Queue(maxsize=1)
        with self._pending_lock:
            self._pending[msg_id] = response_queue
        try:
            with self._send_lock:
                self._ws.send(json.dumps(msg))
            try:
                data = response_queue.get(timeout=timeout)
            except Exception as exc:
                raise CDPError(f"等待 CDP 响应超时 (id={msg_id})") from exc
            if "error" in data:
                raise CDPError(f"CDP 错误: {data['error']}")
            return data.get("result", {})
        finally:
            with self._pending_lock:
                self._pending.pop(msg_id, None)

    def _read_loop(self) -> None:
        while not self._closed:
            try:
                raw = self._ws.recv(timeout=0.5)
            except TimeoutError:
                continue
            except Exception:
                if not self._closed:
                    logger.exception("CDP reader 异常退出")
                return
            try:
                data = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                logger.warning("忽略无法解析的 CDP 消息")
                continue
            msg_id = data.get("id")
            if isinstance(msg_id, int):
                with self._pending_lock:
                    response_queue = self._pending.get(msg_id)
                if response_queue:
                    response_queue.put(data)
                continue
            with self._event_condition:
                self._events.append(data)
                self._event_condition.notify_all()

    def wait_for_event(
        self,
        method: str,
        *,
        session_id: str | None = None,
        predicate: Any | None = None,
        timeout: float = 30.0,
    ) -> dict:
        """等待并消费一个匹配的 CDP 异步事件。"""
        deadline = time.monotonic() + timeout
        with self._event_condition:
            while True:
                for event in list(self._events):
                    if event.get("method") != method:
                        continue
                    if session_id and event.get("sessionId") != session_id:
                        continue
                    if predicate and not predicate(event):
                        continue
                    self._events.remove(event)
                    return event
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CDPError(f"等待 CDP 事件超时: {method}")
                self._event_condition.wait(remaining)

    def clear_events(
        self,
        *,
        session_id: str | None = None,
        methods: set[str] | None = None,
    ) -> None:
        """清除目标 session 的历史事件，避免前一次页面操作污染当前动作。"""
        with self._event_condition:
            self._events = deque(
                (
                    event
                    for event in self._events
                    if not (
                        (session_id is None or event.get("sessionId") == session_id)
                        and (methods is None or event.get("method") in methods)
                    )
                ),
                maxlen=self._events.maxlen,
            )

    def close(self) -> None:
        import contextlib

        self._closed = True
        with self._pending_lock:
            pending = list(self._pending.values())
        for response_queue in pending:
            with contextlib.suppress(Exception):
                response_queue.put_nowait({
                    "error": {"message": "CDP connection closed"},
                })
        with contextlib.suppress(Exception):
            self._ws.close()
        with self._event_condition:
            self._event_condition.notify_all()


class Page:
    """CDP 页面对象，封装常用操作。"""

    def __init__(self, cdp: CDPClient, target_id: str, session_id: str) -> None:
        self._cdp = cdp
        self.target_id = target_id
        self.session_id = session_id

    def _send_session(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        """向 session 发送命令。"""
        return self._cdp.send_session(
            self.session_id,
            method,
            params,
            timeout=timeout,
        )

    def wait_for_event(
        self,
        method: str,
        *,
        predicate: Any | None = None,
        timeout: float = 30.0,
    ) -> dict:
        return self._cdp.wait_for_event(
            method,
            session_id=self.session_id,
            predicate=predicate,
            timeout=timeout,
        )

    def clear_events(self, methods: set[str] | None = None) -> None:
        self._cdp.clear_events(session_id=self.session_id, methods=methods)

    def navigate(self, url: str) -> None:
        """导航到指定 URL。"""
        logger.info("导航到: %s", url)
        self._send_session("Page.navigate", {"url": url})

    def wait_for_load(self, timeout: float = 60.0) -> None:
        """等待页面加载完成（通过轮询 document.readyState）。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                state = self.evaluate("document.readyState")
                if state == "complete":
                    return
            except CDPError:
                pass
            time.sleep(0.5)
        logger.warning("等待页面加载超时")

    def wait_dom_stable(self, timeout: float = 10.0, interval: float = 0.5) -> None:
        """等待 DOM 稳定（连续两次 DOM 快照一致）。"""
        last_html = ""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                html = self.evaluate("document.body ? document.body.innerHTML.length : 0")
                if html == last_html and html != "":
                    return
                last_html = html
            except CDPError:
                pass
            time.sleep(interval)

    def evaluate(self, expression: str, timeout: float = 30.0) -> Any:
        """执行 JavaScript 表达式并返回结果。"""
        result = self._send_session(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": False,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            raise CDPError(f"JS 执行异常: {result['exceptionDetails']}")
        remote_obj = result.get("result", {})
        return remote_obj.get("value")

    def evaluate_async(self, expression: str, timeout: float = 30.0) -> Any:
        """执行可能返回 Promise 的 JavaScript 表达式并返回结果。"""
        result = self._send_session(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            raise CDPError(f"JS 执行异常: {result['exceptionDetails']}")
        remote_obj = result.get("result", {})
        return remote_obj.get("value")

    def evaluate_function(self, function_body: str, *args: Any, timeout: float = 30.0) -> Any:
        """执行 JavaScript 函数并返回结果。

        function_body 是一个完整的函数体，如 `() => { return 1; }`
        """
        result = self._send_session(
            "Runtime.evaluate",
            {
                "expression": f"({function_body})()",
                "returnByValue": True,
                "awaitPromise": False,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            raise CDPError(f"JS 函数执行异常: {result['exceptionDetails']}")
        remote_obj = result.get("result", {})
        return remote_obj.get("value")

    def query_selector(self, selector: str) -> str | None:
        """查找单个元素，返回 objectId 或 None。"""
        result = self._send_session(
            "Runtime.evaluate",
            {
                "expression": f"document.querySelector({json.dumps(selector)})",
                "returnByValue": False,
            },
        )
        remote_obj = result.get("result", {})
        if remote_obj.get("subtype") == "null" or remote_obj.get("type") == "undefined":
            return None
        return remote_obj.get("objectId")

    def query_selector_all(self, selector: str) -> list[str]:
        """查找多个元素，返回 objectId 列表。"""
        # 通过 JS 返回元素数量，然后逐个获取
        count = self.evaluate(f"document.querySelectorAll({json.dumps(selector)}).length")
        if not count:
            return []
        object_ids = []
        for i in range(count):
            result = self._send_session(
                "Runtime.evaluate",
                {
                    "expression": (f"document.querySelectorAll({json.dumps(selector)})[{i}]"),
                    "returnByValue": False,
                },
            )
            obj = result.get("result", {})
            oid = obj.get("objectId")
            if oid:
                object_ids.append(oid)
        return object_ids

    def has_element(self, selector: str) -> bool:
        """检查元素是否存在。"""
        return self.evaluate(f"document.querySelector({json.dumps(selector)}) !== null") is True

    def wait_for_element(self, selector: str, timeout: float = 30.0) -> str:
        """等待元素出现，返回 objectId。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            oid = self.query_selector(selector)
            if oid:
                return oid
            time.sleep(0.5)
        raise ElementNotFoundError(selector)

    def click_element(self, selector: str) -> None:
        """点击指定选择器的元素（通过 CDP Input 事件，isTrusted=true）。"""
        box = self.evaluate(
            f"""
            (() => {{
                const nodes = Array.from(document.querySelectorAll({json.dumps(selector)}));
                if (!nodes.length) return null;
                const visible = nodes.find((el) => {{
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden';
                }}) || nodes[0];
                const target = visible.closest("button,[role='button'],a,[tabindex]") || visible;
                target.scrollIntoView({{block: 'center'}});
                const rect = target.getBoundingClientRect();
                return {{x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}};
            }})()
            """
        )
        if not box:
            return
        x = box["x"] + random.uniform(-3, 3)
        y = box["y"] + random.uniform(-3, 3)
        self.mouse_move(x, y)
        time.sleep(random.uniform(0.03, 0.08))
        self.mouse_click(x, y)

    def input_text(self, selector: str, text: str) -> None:
        """向指定选择器的元素输入文本。"""
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return;
                el.focus();
                el.value = {json.dumps(text)};
                el.dispatchEvent(new Event('input', {{bubbles: true}}));
                el.dispatchEvent(new Event('change', {{bubbles: true}}));
            }})()
            """
        )

    def input_content_editable(self, selector: str, text: str) -> None:
        """优先批量输入 contentEditable，校验失败时降级为逐字输入。"""
        started_at = time.monotonic()
        try:
            self._clear_content_editable(selector)
            self._send_session("Input.insertText", {"text": text})
            time.sleep(random.uniform(1.0, 3.0))
            if self._content_editable_matches(selector, text):
                logger.info(
                    "contentEditable 批量输入成功: chars=%d elapsed=%.2fs",
                    len(text),
                    time.monotonic() - started_at,
                )
                return
            logger.warning("contentEditable 批量输入校验失败，降级为逐字输入")
        except Exception as error:
            logger.warning("contentEditable 批量输入失败，降级为逐字输入: %s", error)

        fallback_started_at = time.monotonic()
        self._clear_content_editable(selector)
        self._type_content_editable(text)
        if not self._content_editable_matches(selector, text):
            raise CDPError("contentEditable 逐字输入后内容校验失败")
        logger.info(
            "contentEditable 逐字输入成功: chars=%d elapsed=%.2fs",
            len(text),
            time.monotonic() - fallback_started_at,
        )

    def _clear_content_editable(self, selector: str) -> None:
        """聚焦并清空 contentEditable。"""
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) throw new Error('元素不存在: ' + {json.dumps(selector)});
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }})()
            """
        )
        time.sleep(0.1)
        self._send_session(
            "Input.dispatchKeyEvent",
            {
                "type": "keyDown",
                "key": "Backspace",
                "code": "Backspace",
                "windowsVirtualKeyCode": 8,
            },
        )
        self._send_session(
            "Input.dispatchKeyEvent",
            {
                "type": "keyUp",
                "key": "Backspace",
                "code": "Backspace",
                "windowsVirtualKeyCode": 8,
            },
        )
        time.sleep(0.1)
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return;
                el.focus();
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }})()
            """
        )

    def _type_content_editable(self, text: str) -> None:
        """逐字输入，保留原有的人类输入节奏。"""
        for char in text:
            if char == "\n":
                self._send_session("Input.insertText", {"text": "\n"})
            else:
                self._send_session(
                    "Input.dispatchKeyEvent",
                    {"type": "keyDown", "text": char},
                )
                self._send_session(
                    "Input.dispatchKeyEvent",
                    {"type": "keyUp", "text": char},
                )
            time.sleep(random.uniform(0.03, 0.08))

    def _content_editable_matches(self, selector: str, expected: str) -> bool:
        """比较编辑器可见文本，兼容 CRLF、NBSP 和零宽字符。"""
        actual = self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return null;
                const blockTags = new Set([
                    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
                    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
                    'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
                    'PRE', 'SECTION', 'TABLE', 'UL'
                ]);
                const extract = (node) => {{
                    let output = '';
                    for (const child of node.childNodes) {{
                        if (child.nodeType === Node.TEXT_NODE) {{
                            output += child.nodeValue || '';
                            continue;
                        }}
                        if (child.nodeType !== Node.ELEMENT_NODE) continue;
                        if (child.tagName === 'BR') {{
                            output += '\\n';
                            continue;
                        }}
                        const childText = extract(child);
                        if (blockTags.has(child.tagName) && output && !output.endsWith('\\n')) {{
                            output += '\\n';
                        }}
                        output += childText;
                    }}
                    return output;
                }};
                return extract(el);
            }})()
            """
        )
        if not isinstance(actual, str):
            return False
        return self._normalize_editable_text(actual) == self._normalize_editable_text(expected)

    @staticmethod
    def _normalize_editable_text(text: str) -> str:
        return (
            text.replace("\r\n", "\n")
            .replace("\r", "\n")
            .replace("\u00a0", " ")
            .replace("\u200b", "")
        )

    def get_element_text(self, selector: str) -> str | None:
        """获取元素文本内容。"""
        return self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                return el ? el.textContent : null;
            }})()
            """
        )

    def get_element_attribute(self, selector: str, attr: str) -> str | None:
        """获取元素属性值。"""
        return self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                return el ? el.getAttribute({json.dumps(attr)}) : null;
            }})()
            """
        )

    def get_elements_count(self, selector: str) -> int:
        """获取匹配元素数量。"""
        result = self.evaluate(f"document.querySelectorAll({json.dumps(selector)}).length")
        return result if isinstance(result, int) else 0

    def scroll_by(self, x: int, y: int) -> None:
        """滚动页面。"""
        self.evaluate(f"window.scrollBy({x}, {y})")

    def scroll_to(self, x: int, y: int) -> None:
        """滚动到指定位置。"""
        self.evaluate(f"window.scrollTo({x}, {y})")

    def scroll_to_bottom(self) -> None:
        """滚动到页面底部。"""
        self.evaluate("window.scrollTo(0, document.body.scrollHeight)")

    def scroll_element_into_view(self, selector: str) -> None:
        """将元素滚动到可视区域。"""
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) el.scrollIntoView({{behavior: 'smooth', block: 'center'}});
            }})()
            """
        )

    def scroll_nth_element_into_view(self, selector: str, index: int) -> None:
        """将第 N 个匹配元素滚动到可视区域。"""
        self.evaluate(
            f"""
            (() => {{
                const els = document.querySelectorAll({json.dumps(selector)});
                if (els[{index}]) els[{index}].scrollIntoView(
                    {{behavior: 'smooth', block: 'center'}}
                );
            }})()
            """
        )

    def simulate_reading_mouse(self, duration_ms: int = 3000) -> None:
        """模拟阅读鼠标轨迹：逐行扫视 + 随机停顿，通过合成 mousemove 事件实现。

        在页面执行 JS 生成轨迹，Python 侧控制帧间延迟使时序真实。
        """
        import math as _math

        # 获取视口尺寸
        vw = int(self.evaluate("window.innerWidth || 1280") or 1280)
        vh = int(self.evaluate("window.innerHeight || 800") or 800)

        left   = int(vw * 0.25)
        right  = int(vw * 0.75)
        top    = int(vh * 0.20)
        bottom = int(vh * 0.80)

        def rand(a: int, b: int) -> int:
            return random.randint(a, b)

        def ease(t: float) -> float:
            return 2 * t * t if t < 0.5 else -1 + (4 - 2 * t) * t

        # 生成阅读路径：逐行扫视
        waypoints: list[tuple[int, int, float]] = []  # (x, y, delay_sec)
        cx, cy = rand(left, right), rand(top, top + (bottom - top) // 3)
        line_count = max(3, duration_ms // 600)
        line_step  = (bottom - top) // line_count

        for _ in range(line_count):
            row_end = rand(left + (right - left) // 2, right)
            # 逐步插值从 cx→row_end
            steps = max(3, rand(4, 8))
            for s in range(1, steps + 1):
                t = ease(s / steps)
                wx = int(cx + (row_end - cx) * t) + rand(-3, 3)
                wy = cy + rand(-2, 2)
                waypoints.append((wx, wy, rand(14, 28) / 1000))
            # 偶尔停顿（模拟阅读有趣的行）
            if random.random() < 0.3:
                waypoints.append((row_end, cy, rand(150, 500) / 1000))
            # 换行
            cy += line_step + rand(-6, 6)
            if cy > bottom:
                break
            cx = rand(left, left + (right - left) // 3)
            waypoints.append((cx, cy, rand(40, 80) / 1000))

        # 逐帧分发
        for x, y, delay in waypoints:
            self.evaluate(
                f"document.dispatchEvent(new MouseEvent('mousemove',"
                f"{{clientX:{x},clientY:{y},bubbles:true,cancelable:true}}));"
            )
            time.sleep(delay)

    def get_scroll_top(self) -> int:
        """获取当前滚动位置。"""
        result = self.evaluate(
            "window.pageYOffset || document.documentElement.scrollTop"
            " || document.body.scrollTop || 0"
        )
        return int(result) if result else 0

    def get_viewport_height(self) -> int:
        """获取视口高度。"""
        result = self.evaluate("window.innerHeight")
        return int(result) if result else 768

    def set_file_input(self, selector: str, files: list[str]) -> None:
        """设置文件输入框的文件（通过 CDP DOM.setFileInputFiles）。"""
        # 先获取 nodeId
        doc = self._send_session("DOM.getDocument", {"depth": 0})
        root_node_id = doc["root"]["nodeId"]
        result = self._send_session(
            "DOM.querySelector",
            {"nodeId": root_node_id, "selector": selector},
        )
        node_id = result.get("nodeId", 0)
        if node_id == 0:
            raise ElementNotFoundError(selector)
        self._send_session(
            "DOM.setFileInputFiles",
            {"nodeId": node_id, "files": files},
        )

    def dispatch_wheel_event(self, delta_y: float) -> None:
        """触发滚轮事件以激活懒加载。"""
        self.evaluate(
            f"""
            (() => {{
                let target = document.querySelector('.note-scroller')
                    || document.querySelector('.interaction-container')
                    || document.documentElement;
                const event = new WheelEvent('wheel', {{
                    deltaY: {delta_y},
                    deltaMode: 0,
                    bubbles: true,
                    cancelable: true,
                    view: window,
                }});
                target.dispatchEvent(event);
            }})()
            """
        )

    def mouse_move(self, x: float, y: float) -> None:
        """移动鼠标。"""
        self._send_session(
            "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": x, "y": y},
        )

    def mouse_click(self, x: float, y: float, button: str = "left") -> None:
        """在指定坐标点击。"""
        self._send_session(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": x, "y": y, "button": button, "clickCount": 1},
        )
        self._send_session(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": x, "y": y, "button": button, "clickCount": 1},
        )

    def type_text(self, text: str, delay_ms: int = 50) -> None:
        """逐字符输入文本。"""
        for char in text:
            self._send_session(
                "Input.dispatchKeyEvent",
                {"type": "keyDown", "text": char},
            )
            self._send_session(
                "Input.dispatchKeyEvent",
                {"type": "keyUp", "text": char},
            )
            if delay_ms > 0:
                time.sleep(delay_ms / 1000.0)

    def press_key(self, key: str) -> None:
        """按下并释放指定键。"""
        key_map = {
            "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13},
            "ArrowDown": {
                "key": "ArrowDown",
                "code": "ArrowDown",
                "windowsVirtualKeyCode": 40,
            },
            "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
        }
        info = key_map.get(key, {"key": key, "code": key})
        self._send_session(
            "Input.dispatchKeyEvent",
            {"type": "keyDown", **info},
        )
        self._send_session(
            "Input.dispatchKeyEvent",
            {"type": "keyUp", **info},
        )

    def remove_element(self, selector: str) -> None:
        """移除 DOM 元素。"""
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (el) el.remove();
            }})()
            """
        )

    def hover_element(self, selector: str) -> None:
        """悬停到元素中心。"""
        box = self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return {{x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}};
            }})()
            """
        )
        if box:
            self.mouse_move(box["x"], box["y"])

    def select_all_text(self, selector: str) -> None:
        """选中输入框内所有文本。"""
        self.evaluate(
            f"""
            (() => {{
                const el = document.querySelector({json.dumps(selector)});
                if (!el) return;
                el.focus();
                el.select ? el.select() : document.execCommand('selectAll');
            }})()
            """
        )

    def screenshot_element(self, selector: str, padding: int = 0) -> bytes:
        """对指定 CSS 选择器的元素截图，返回 PNG 字节。

        通过 CDP Page.captureScreenshot 截取元素所在区域，比 Python 层 PNG
        解码/重编码快很多，且图片直接来自浏览器渲染结果。

        Args:
            selector: CSS 选择器。
            padding:  在元素四周额外保留的像素数（背景色填充，相当于白边）。

        Returns:
            PNG 字节；元素不存在时返回 b""。
        """
        import base64 as _b64

        # 用 DOM.getBoxModel 获取元素坐标，返回的是 page 坐标系（CSS px，相对于文档左上角）。
        # getBoundingClientRect 返回的是 viewport 坐标系，对 position:fixed 遮罩层内的元素
        # 加 pageXOffset 后依然会截到遮罩背后的内容。DOM.getBoxModel 则始终正确。
        try:
            doc = self._send_session("DOM.getDocument", {"depth": 0})
            root_id = doc["root"]["nodeId"]
            query = self._send_session(
                "DOM.querySelector", {"nodeId": root_id, "selector": selector}
            )
            node_id = query.get("nodeId", 0)
            if not node_id:
                return b""
            box_model = self._send_session("DOM.getBoxModel", {"nodeId": node_id})
            model = box_model["model"]
            content = model["content"]  # [x1,y1, x2,y2, x3,y3, x4,y4] 顺时针四角
            x, y = content[0], content[1]
            width, height = float(model["width"]), float(model["height"])
        except Exception:
            return b""

        result = self._send_session(
            "Page.captureScreenshot",
            {
                "format": "png",
                "clip": {
                    "x": max(0.0, x - padding),
                    "y": max(0.0, y - padding),
                    "width": width + padding * 2,
                    "height": height + padding * 2,
                    "scale": 1.0,
                },
            },
        )
        return _b64.b64decode(result.get("data", ""))

    def get_404_diagnostics(self) -> list[dict]:
        """从 Electron NetLog 和当前页面状态生成 404/风控诊断。"""
        from .electron_risk import get_404_diagnostics

        return get_404_diagnostics(self)

    def clear_404_diagnostics(self) -> None:
        from .electron_risk import clear_404_diagnostics

        clear_404_diagnostics()

    def analyze_risk_control(self, probe_urls: list[str] | None = None) -> dict:
        """分析 Electron XHS 会话的风控状态。"""
        from .electron_risk import analyze_risk_control

        return analyze_risk_control(self, probe_urls or [])

    def get_netlog_enabled(self) -> bool:
        from .electron_risk import get_netlog_enabled

        return get_netlog_enabled()

    def get_netlog(self) -> list[dict]:
        from .electron_risk import read_netlog

        return read_netlog()


class Browser:
    """Chrome 浏览器 CDP 控制器。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 9222) -> None:
        self.host = host
        self.port = port
        self.base_url = f"http://{host}:{port}"
        self._cdp: CDPClient | None = None
        self._chrome_version: str | None = None

    def connect(self) -> None:
        """连接到 Chrome DevTools。"""
        import requests

        resp = requests.get(f"{self.base_url}/json/version", timeout=5)
        resp.raise_for_status()
        info = resp.json()
        ws_url = info["webSocketDebuggerUrl"]

        # 从 "Chrome/134.0.6998.88" 提取真实版本号，用于动态构建 UA
        browser_str = info.get("Browser", "")
        if "/" in browser_str:
            self._chrome_version = browser_str.split("/", 1)[1]

        logger.info("连接到 Chrome: %s (version=%s)", ws_url, self._chrome_version)
        self._cdp = CDPClient(ws_url)

    def _setup_page(self, page: Page) -> Page:
        """为 Page 对象启用必要的 CDP domain。"""
        page._send_session("Page.enable")
        page._send_session("DOM.enable")
        page._send_session("Runtime.enable")
        page._send_session(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": _WEBDRIVER_COMPATIBILITY_SCRIPT},
        )
        return page

    def new_page(self, url: str = "about:blank") -> Page:
        """创建新页面（强制开新 tab）。"""
        if not self._cdp:
            self.connect()
        assert self._cdp is not None

        result = self._cdp.send("Target.createTarget", {"url": url})
        target_id = result["targetId"]
        result = self._cdp.send(
            "Target.attachToTarget",
            {"targetId": target_id, "flatten": True},
        )
        session_id = result["sessionId"]
        return self._setup_page(Page(self._cdp, target_id, session_id))

    def get_or_create_page(self) -> Page:
        """复用现有空白 tab，找不到时才新建。

        避免每次命令都创建新 tab 导致 Chrome 中 tab 无限堆积。
        空白 tab 判定：url 为 about:blank 或 chrome://newtab/。
        """
        if not self._cdp:
            self.connect()
        assert self._cdp is not None

        import contextlib
        import requests

        resp = requests.get(f"{self.base_url}/json", timeout=5)
        targets = resp.json()

        for target in targets:
            if target.get("type") == "page" and target.get("url") in (
                "about:blank",
                "chrome://newtab/",
            ):
                target_id = target["id"]
                with contextlib.suppress(Exception):
                    result = self._cdp.send(
                        "Target.attachToTarget",
                        {"targetId": target_id, "flatten": True},
                    )
                    session_id = result.get("sessionId")
                    if session_id:
                        logger.debug("复用空白 tab: %s", target_id)
                        return self._setup_page(Page(self._cdp, target_id, session_id))

        # 没有空白 tab，新建一个
        return self.new_page()

    def get_page_by_target_id(self, target_id: str) -> Page | None:
        """通过 target_id 精确连接到指定 tab。"""
        if not self._cdp:
            self.connect()
        assert self._cdp is not None
        try:
            result = self._cdp.send(
                "Target.attachToTarget",
                {"targetId": target_id, "flatten": True},
            )
        except Exception:
            return None
        session_id = result.get("sessionId")
        if not session_id:
            return None
        return self._setup_page(Page(self._cdp, target_id, session_id))

    def get_existing_page(self) -> Page | None:
        """获取已有页面（取第一个非 about:blank 的 page target）。"""
        if not self._cdp:
            self.connect()
        assert self._cdp is not None

        import requests

        resp = requests.get(f"{self.base_url}/json", timeout=5)
        targets = resp.json()

        for target in targets:
            if target.get("type") == "page" and target.get("url") != "about:blank":
                target_id = target["id"]
                result = self._cdp.send(
                    "Target.attachToTarget",
                    {"targetId": target_id, "flatten": True},
                )
                session_id = result["sessionId"]
                return self._setup_page(Page(self._cdp, target_id, session_id))
        return None

    def close_page(self, page: Page) -> None:
        """关闭页面。"""
        import contextlib

        if self._cdp:
            with contextlib.suppress(CDPError):
                self._cdp.send("Target.closeTarget", {"targetId": page.target_id})

    def close(self) -> None:
        """关闭连接。"""
        if self._cdp:
            self._cdp.close()
            self._cdp = None
