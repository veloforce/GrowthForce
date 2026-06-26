import sys
import unittest
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.errors import (
    AccountRiskControlError,
    CreatorSessionExpiredError,
    PublishError,
    PublishResultTimeoutError,
)
from xhs.publish_result import PUBLISH_RESULT_TIMEOUT_SECONDS, resolve_publish_result
from cli import _error_payload


class PublishResultTest(unittest.TestCase):
    def test_publish_result_timeout_is_60_seconds(self) -> None:
        self.assertEqual(PUBLISH_RESULT_TIMEOUT_SECONDS, 60)

    def test_timeout_without_feedback_has_distinct_error(self) -> None:
        with self.assertRaisesRegex(PublishResultTimeoutError, "已触发发布但未确认结果"):
            resolve_publish_result(None)

    def test_account_risk_control_is_structured_failure(self) -> None:
        with self.assertRaises(AccountRiskControlError) as context:
            resolve_publish_result({
                "code": -9136,
                "msg": "因违反社区规范禁止发笔记",
            })

        self.assertEqual(context.exception.code, -9136)
        self.assertEqual(context.exception.msg, "因违反社区规范禁止发笔记")

    def test_other_business_error_is_failure(self) -> None:
        with self.assertRaisesRegex(PublishError, "code=1001"):
            resolve_publish_result({
                "data": {
                    "code": "1001",
                    "message": "参数错误",
                },
            })

    def test_success_requires_note_id(self) -> None:
        with self.assertRaisesRegex(PublishError, "缺少 note_id"):
            resolve_publish_result({
                "code": 0,
                "success": True,
                "data": {},
            })

    def test_success_returns_nested_note_id(self) -> None:
        result = resolve_publish_result({
            "code": 0,
            "success": True,
            "data": {
                "note": {
                    "note_id": "note-123",
                },
            },
        })

        self.assertEqual(result["success"], True)
        self.assertEqual(result["status"], "发布完成")
        self.assertEqual(result["note_id"], "note-123")
        self.assertEqual(result["note_url"], "https://www.xiaohongshu.com/explore/note-123")
        self.assertTrue(result["published_at"])
        datetime.fromisoformat(result["published_at"])
        self.assertEqual(result["platform_code"], 0)

    def test_current_creator_response_returns_data_id_and_share_link(self) -> None:
        result = resolve_publish_result({
            "result": 0,
            "success": True,
            "data": {
                "score": 10,
                "id": "6a364a910000000022017696",
            },
            "share_link": (
                "https://www.xiaohongshu.com/discovery/item/"
                "6a364a910000000022017696"
            ),
            "msg": "",
        })

        self.assertEqual(result["note_id"], "6a364a910000000022017696")
        self.assertEqual(
            result["note_url"],
            "https://www.xiaohongshu.com/discovery/item/6a364a910000000022017696",
        )
        self.assertEqual(result["platform_code"], 0)

    def test_nonzero_result_is_failure(self) -> None:
        with self.assertRaisesRegex(PublishError, "code=1001"):
            resolve_publish_result({
                "result": 1001,
                "success": False,
                "msg": "参数错误",
            })

    def test_explicit_success_false_is_failure_even_when_result_is_zero(self) -> None:
        with self.assertRaisesRegex(PublishError, "code=0"):
            resolve_publish_result({
                "result": 0,
                "success": False,
                "data": {"id": "should-not-succeed"},
                "msg": "发布被拒绝",
            })

    def test_unrelated_nested_data_id_is_not_treated_as_note_id(self) -> None:
        with self.assertRaisesRegex(PublishError, "缺少 note_id"):
            resolve_publish_result({
                "code": 0,
                "payload": {"data": {"id": "unrelated-id"}},
            })

    def test_redirect_without_response_has_distinct_reason(self) -> None:
        error = PublishResultTimeoutError("published_redirect_without_response")
        payload = _error_payload(error)

        self.assertEqual(payload["reason"], "published_redirect_without_response")

    def test_cli_error_payload_for_account_restriction(self) -> None:
        payload = _error_payload(AccountRiskControlError(-9136, "禁止发笔记"))

        self.assertEqual(payload["success"], False)
        self.assertEqual(payload["error_code"], "ACCOUNT_RESTRICTED")
        self.assertEqual(payload["platform_code"], -9136)
        self.assertEqual(payload["platform_message"], "禁止发笔记")

    def test_cli_error_payload_for_publish_error(self) -> None:
        payload = _error_payload(PublishError("发布失败"))

        self.assertEqual(payload["success"], False)
        self.assertEqual(payload["error_code"], "PUBLISH_FAILED")
        self.assertEqual(payload["error"], "发布失败")

    def test_cli_error_payload_for_publish_result_timeout(self) -> None:
        payload = _error_payload(PublishResultTimeoutError())

        self.assertEqual(payload["success"], False)
        self.assertEqual(payload["error_code"], "PUBLISH_RESULT_UNKNOWN")
        self.assertEqual(payload["reason"], "timeout")
        self.assertEqual(payload["error"], "已触发发布但未确认结果")

    def test_cli_error_payload_for_creator_session_expired(self) -> None:
        payload = _error_payload(CreatorSessionExpiredError())

        self.assertEqual(payload["success"], False)
        self.assertEqual(payload["error_code"], "CREATOR_SESSION_EXPIRED")


if __name__ == "__main__":
    unittest.main()
