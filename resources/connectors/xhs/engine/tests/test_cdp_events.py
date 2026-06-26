import json
import sys
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.cdp import Browser, CDPClient


class InMemoryWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.incoming: list[str] = []
        self.condition = threading.Condition()
        self.closed = False

    def send(self, raw: str) -> None:
        message = json.loads(raw)
        self.sent.append(message)
        with self.condition:
            self.incoming.extend([
                json.dumps({
                    "method": "Network.responseReceived",
                    "sessionId": message.get("sessionId"),
                    "params": {"requestId": "publish-1"},
                }),
                json.dumps({
                    "id": message["id"],
                    "sessionId": message.get("sessionId"),
                    "result": {"ok": True},
                }),
            ])
            self.condition.notify_all()

    def recv(self, timeout: float | None = None) -> str:
        with self.condition:
            if not self.incoming and not self.closed:
                self.condition.wait(timeout)
            if self.incoming:
                return self.incoming.pop(0)
            raise TimeoutError

    def close(self) -> None:
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class InvalidMessageWebSocket(InMemoryWebSocket):
    def send(self, raw: str) -> None:
        message = json.loads(raw)
        self.sent.append(message)
        with self.condition:
            self.incoming.extend([
                "{invalid-json",
                json.dumps({
                    "id": message["id"],
                    "result": {"ok": True},
                }),
            ])
            self.condition.notify_all()


class CDPEventDispatchTest(unittest.TestCase):
    def test_xhs_page_setup_installs_webdriver_compatibility_script(self) -> None:
        calls: list[tuple[str, dict | None]] = []

        class FakePage:
            def _send_session(self, method: str, params: dict | None = None) -> None:
                calls.append((method, params))

        page = FakePage()
        self.assertIs(Browser()._setup_page(page), page)
        script_calls = [params for method, params in calls if method == "Page.addScriptToEvaluateOnNewDocument"]
        self.assertEqual(len(script_calls), 1)
        self.assertIn("navigator.webdriver !== true", script_calls[0]["source"])

    def test_event_is_preserved_while_waiting_for_command_response(self) -> None:
        websocket = InMemoryWebSocket()
        client = CDPClient("memory://", websocket=websocket)
        self.addCleanup(client.close)

        result = client.send_session("session-1", "Runtime.evaluate")
        event = client.wait_for_event(
            "Network.responseReceived",
            session_id="session-1",
            timeout=1,
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(event["params"]["requestId"], "publish-1")

    def test_invalid_message_does_not_stop_reader(self) -> None:
        websocket = InvalidMessageWebSocket()
        client = CDPClient("memory://", websocket=websocket)
        self.addCleanup(client.close)

        self.assertEqual(client.send("Runtime.enable"), {"ok": True})

    def test_clear_events_removes_only_selected_session_events(self) -> None:
        websocket = InMemoryWebSocket()
        client = CDPClient("memory://", websocket=websocket)
        self.addCleanup(client.close)

        client.send_session("session-1", "Runtime.evaluate")
        client.clear_events(
            session_id="session-1",
            methods={"Network.responseReceived"},
        )

        with self.assertRaises(Exception):
            client.wait_for_event(
                "Network.responseReceived",
                session_id="session-1",
                timeout=0.01,
            )


if __name__ == "__main__":
    unittest.main()
