import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.login_state import (
    build_user_info_timeout_result,
    should_finish_user_info_wait,
    validate_lightweight_preflight,
)
from xhs.login import check_session


COMPLETE_ACCOUNT = {
    "logged_in": True,
    "account_id": "account-id",
    "account_handle": "account-handle",
    "nickname": "nickname",
}


class UserInfoWaitPolicyTest(unittest.TestCase):
    def test_authorization_wait_continues_on_guest(self) -> None:
        self.assertFalse(
            should_finish_user_info_wait(
                {"logged_in": False, "guest": True, "failure_reason": "guest"},
                require_complete=True,
                return_on_guest=False,
            )
        )

    def test_session_check_finishes_on_guest(self) -> None:
        self.assertTrue(
            should_finish_user_info_wait(
                {"logged_in": False, "guest": True, "failure_reason": "guest"},
                require_complete=False,
                return_on_guest=True,
            )
        )

    def test_complete_account_finishes_authorization_wait(self) -> None:
        self.assertTrue(
            should_finish_user_info_wait(
                COMPLETE_ACCOUNT,
                require_complete=True,
                return_on_guest=False,
            )
        )

    def test_account_id_finishes_session_check(self) -> None:
        self.assertTrue(
            should_finish_user_info_wait(
                {"logged_in": True, "account_id": "account-id"},
                require_complete=False,
                return_on_guest=True,
            )
        )

    def test_incomplete_logged_in_account_keeps_authorization_waiting(self) -> None:
        self.assertFalse(
            should_finish_user_info_wait(
                {"logged_in": True, "account_id": "account-id"},
                require_complete=True,
                return_on_guest=False,
            )
        )

    def test_timeout_preserves_guest_as_last_failure_reason(self) -> None:
        result = build_user_info_timeout_result(
            {"logged_in": False, "guest": True, "failure_reason": "guest"},
            120,
        )
        self.assertEqual(result["failure_reason"], "timeout")
        self.assertEqual(result["last_failure_reason"], "guest")
        self.assertTrue(result["guest"])


class LightweightPreflightPolicyTest(unittest.TestCase):
    def test_guest_blocks_business_command(self) -> None:
        result = validate_lightweight_preflight(
            {"logged_in": False, "guest": True, "failure_reason": "guest"},
            expected_account_id="account-id",
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["failure_reason"], "guest")
        self.assertTrue(result["guest"])

    def test_matching_account_passes(self) -> None:
        result = validate_lightweight_preflight(
            {"logged_in": True, "account_id": "account-id"},
            expected_account_id="account-id",
        )
        self.assertIsNone(result)

    def test_account_mismatch_blocks_business_command(self) -> None:
        result = validate_lightweight_preflight(
            {"logged_in": True, "account_id": "other-account"},
            expected_account_id="account-id",
        )
        self.assertIsNotNone(result)
        self.assertEqual(result["failure_reason"], "account_mismatch")
        self.assertEqual(result["account_id"], "other-account")
        self.assertEqual(result["expected_account_id"], "account-id")

    def test_unknown_user_info_passes_to_business_command(self) -> None:
        self.assertIsNone(
            validate_lightweight_preflight(
                {"logged_in": False, "failure_reason": "no_user_info"},
                expected_account_id="account-id",
            )
        )

    def test_missing_account_id_passes_to_business_command(self) -> None:
        self.assertIsNone(
            validate_lightweight_preflight(
                {"logged_in": False, "failure_reason": "missing_account_id"},
                expected_account_id="account-id",
            )
        )


class CheckSessionNavigationTest(unittest.TestCase):
    def test_force_navigates_when_current_xhs_page_has_missing_account_id(self) -> None:
        page = FakeLoginPage(
            initial_url="https://www.xiaohongshu.com/explore",
            initial_user_info={"logged_in": False, "failure_reason": "missing_account_id"},
            navigated_user_info={"logged_in": True, "account_id": "account-id"},
        )

        result = check_session(page)

        self.assertEqual(result["account_id"], "account-id")
        self.assertEqual(page.navigations, ["about:blank", "https://www.xiaohongshu.com/explore"])

    def test_does_not_navigate_when_current_xhs_page_has_user_info(self) -> None:
        page = FakeLoginPage(
            initial_url="https://www.xiaohongshu.com/explore",
            initial_user_info={"logged_in": True, "account_id": "account-id"},
            navigated_user_info={"logged_in": True, "account_id": "other-account"},
        )

        result = check_session(page)

        self.assertEqual(result["account_id"], "account-id")
        self.assertEqual(page.navigations, [])


class FakeLoginPage:
    def __init__(self, initial_url: str, initial_user_info: dict, navigated_user_info: dict) -> None:
        self.url = initial_url
        self.user_info = initial_user_info
        self.navigated_user_info = navigated_user_info
        self.navigations: list[str] = []

    def evaluate(self, expression: str, timeout: float = 30.0):
        if expression == "location.href":
            return self.url
        if "window.__INITIAL_STATE__" in expression:
            return self.user_info
        return None

    def navigate(self, url: str) -> None:
        self.url = url
        self.user_info = self.navigated_user_info
        self.navigations.append(url)

    def wait_for_load(self) -> None:
        return None


if __name__ == "__main__":
    unittest.main()
