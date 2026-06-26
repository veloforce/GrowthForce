import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.electron_risk import (
    _diagnosis_from_entry,
    _risk_level_from_issues,
    analyze_risk_control,
    get_404_diagnostics,
    read_netlog,
)


class FakePage:
    def __init__(self, async_result=None, sync_result=None) -> None:
        self.async_result = async_result or {
            "fingerprint": {},
            "page_state": {},
            "api_probes": {},
        }
        self.sync_result = sync_result or {}

    def evaluate_async(self, _expression, timeout=30.0):
        return self.async_result

    def evaluate(self, _expression):
        return self.sync_result


class ElectronRiskTest(unittest.TestCase):
    def test_read_netlog_from_env_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "netlog.json"
            path.write_text('[{"category":"business_api"}]', encoding="utf-8")
            with mock.patch.dict(os.environ, {"AGENTSTUDIO_XHS_NETLOG_PATH": str(path)}):
                self.assertEqual(read_netlog(), [{"category": "business_api"}])

    def test_diagnoses_session_redirect(self) -> None:
        diagnosis = _diagnosis_from_entry({
            "url": "https://www.xiaohongshu.com/explore/abc?xsec_token=t",
            "redirectTo": "https://www.xiaohongshu.com/404?source=/explore/abc",
            "status": 302,
            "reqFingerprint": {"cookie": {"has_web_session": False}},
        })

        self.assertIsNotNone(diagnosis)
        self.assertEqual(diagnosis["cause_category"], "session")
        self.assertEqual(diagnosis["confidence"], "high")

    def test_diagnoses_missing_token_redirect(self) -> None:
        diagnosis = _diagnosis_from_entry({
            "url": "https://www.xiaohongshu.com/explore/abc",
            "redirectTo": "https://www.xiaohongshu.com/404?source=/explore/abc",
            "status": 302,
            "reqFingerprint": {"cookie": {"has_web_session": True}},
        })

        self.assertIsNotNone(diagnosis)
        self.assertEqual(diagnosis["cause_category"], "token_missing")

    def test_diagnoses_risk_status(self) -> None:
        diagnosis = _diagnosis_from_entry({
            "url": "https://edith.xiaohongshu.com/api/sns/web/v1/comment/post",
            "status": 461,
            "reqFingerprint": {"cookie": {"has_web_session": True}},
        })

        self.assertIsNotNone(diagnosis)
        self.assertEqual(diagnosis["cause_category"], "risk_control")

    def test_get_404_diagnostics_includes_current_page_captcha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "netlog.json"
            path.write_text("[]", encoding="utf-8")
            page = FakePage(sync_result={
                "url": "https://www.xiaohongshu.com/explore",
                "has_captcha": True,
                "has_web_session": True,
                "has_a1": True,
                "page_is_404": False,
            })
            with mock.patch.dict(os.environ, {"AGENTSTUDIO_XHS_NETLOG_PATH": str(path)}):
                events = get_404_diagnostics(page)

        self.assertEqual(events[0]["diagnosis"]["cause_category"], "captcha")

    def test_risk_level_from_issues(self) -> None:
        self.assertEqual(_risk_level_from_issues([]), "safe")
        self.assertEqual(_risk_level_from_issues([{"level": "medium"}]), "low")
        self.assertEqual(_risk_level_from_issues([{"level": "medium"}, {"level": "medium"}]), "medium")
        self.assertEqual(_risk_level_from_issues([{"level": "high"}]), "medium")
        self.assertEqual(_risk_level_from_issues([{"level": "high"}, {"level": "high"}]), "high")

    def test_analyze_risk_control_merges_page_and_netlog(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "netlog.json"
            path.write_text(
                '[{"host":"www.xiaohongshu.com","path":"/404","status":404,"category":"business_error","reqFingerprint":{"cookie":{"has_web_session":true}}}]',
                encoding="utf-8",
            )
            page = FakePage(async_result={
                "fingerprint": {"webdriver": True},
                "page_state": {"has_captcha_modal": True},
                "api_probes": {},
            })
            with mock.patch.dict(os.environ, {"AGENTSTUDIO_XHS_NETLOG_PATH": str(path)}):
                report = analyze_risk_control(page, [])

        self.assertEqual(report["risk_level"], "high")
        self.assertTrue(any(issue["level"] == "high" for issue in report["issues"]))

    def test_analyze_risk_control_flags_electron_identity_leaks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "netlog.json"
            path.write_text(
                '[{"reqHeaders":{"user-agent":"Mozilla/5.0 Electron/41.6.1 agentstudio/0.1.12"}}]',
                encoding="utf-8",
            )
            page = FakePage(async_result={
                "fingerprint": {
                    "is_electron_ua": True,
                    "is_agentstudio_ua": True,
                    "has_electron_ua_ch": True,
                    "ua_version_consistent": False,
                },
                "page_state": {},
                "api_probes": {},
            })
            with mock.patch.dict(os.environ, {"AGENTSTUDIO_XHS_NETLOG_PATH": str(path)}):
                report = analyze_risk_control(page, [])

        messages = [issue["msg"] for issue in report["issues"]]
        self.assertTrue(any("Electron" in message for message in messages))
        self.assertTrue(any("AgentStudio" in message for message in messages))
        self.assertTrue(any("Client Hints" in message for message in messages))
        self.assertTrue(any("网络请求 User-Agent" in message for message in messages))

    def test_analyze_risk_control_flags_header_and_navigator_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "netlog.json"
            path.write_text(
                '[{"reqHeaders":{"user-agent":"Chrome/146 request","accept-language":"en-US,en;q=0.9"}}]',
                encoding="utf-8",
            )
            page = FakePage(async_result={
                "fingerprint": {"user_agent": "Chrome/146 page", "languages": ["zh-CN", "zh"]},
                "page_state": {},
                "api_probes": {},
            })
            with mock.patch.dict(os.environ, {"AGENTSTUDIO_XHS_NETLOG_PATH": str(path)}):
                report = analyze_risk_control(page, [])

        messages = [issue["msg"] for issue in report["issues"]]
        self.assertTrue(any("navigator.userAgent 不一致" in message for message in messages))
        self.assertTrue(any("navigator.languages" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
