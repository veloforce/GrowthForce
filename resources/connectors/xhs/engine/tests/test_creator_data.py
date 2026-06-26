import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
FIXTURES = Path(__file__).parent / "fixtures"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.creator_data import normalize_account_snapshot, normalize_note_snapshot


class CreatorDataNormalizationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.responses = json.loads(
            (FIXTURES / "creator_responses.json").read_text(encoding="utf-8")
        )

    def test_account_snapshot_normalizes_periods_and_removes_transport_fields(self) -> None:
        result = normalize_account_snapshot(self.responses, period="all")

        self.assertTrue(result["success"])
        self.assertEqual(result["account"]["name"], "悠哉")
        self.assertEqual(result["profile"]["fansCount"], 14)
        self.assertEqual(result["periods"]["7"]["metrics"]["impressions"], 167)
        self.assertEqual(result["periods"]["30"]["metrics"]["publishedNotes"], 1)
        self.assertEqual(result["periods"]["7"]["trends"]["impressions"][0]["count"], 12)
        self.assertEqual(result["periods"]["7"]["startDate"], "2026-06-16")
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("set_impl_count", serialized)
        self.assertNotIn("_iterator", serialized)
        self.assertNotIn("_size", serialized)
        self.assertNotIn("view_count", serialized)
        self.assertNotIn("live_overview_data", serialized)

    def test_account_snapshot_distinguishes_permission_and_data_thresholds(self) -> None:
        result = normalize_account_snapshot(self.responses, period="7")

        self.assertEqual(result["permissions"]["dataCenter"]["reason"], "permission_pending")
        self.assertEqual(result["audience"]["source"]["reason"], "insufficient_data")
        self.assertEqual(result["audience"]["viewPeriods"]["reason"], "insufficient_data")
        self.assertEqual(result["fans"]["profile"]["reason"], "threshold_not_met")
        self.assertEqual(result["fans"]["periods"]["7"]["total"], 14)
        self.assertEqual(set(result["periods"]), {"7"})

    def test_sensitive_account_fields_are_opt_in(self) -> None:
        default_result = normalize_account_snapshot(self.responses, period="all")
        sensitive_result = normalize_account_snapshot(
            self.responses,
            period="all",
            include_sensitive=True,
        )

        self.assertNotIn("phone", default_result["account"])
        self.assertEqual(sensitive_result["account"]["phone"], "138****0000")

    def test_note_snapshot_merges_analysis_and_never_exposes_xsec_token(self) -> None:
        result = normalize_note_snapshot(
            self.responses["notePages"],
            self.responses["noteAnalysis"],
            status="all",
        )

        self.assertTrue(result["success"])
        self.assertEqual(len(result["notes"]["items"]), 2)
        video = result["notes"]["items"][0]
        normal = result["notes"]["items"][1]
        self.assertEqual(video["videoDurationSeconds"], 16)
        self.assertEqual(video["metrics"]["views"], 267)
        self.assertNotIn("analysis", video)
        self.assertEqual(normal["analysis"]["reads"], 5)
        self.assertEqual(result["notes"]["totalHint"], 16)
        self.assertIsNone(result["notes"]["nextPage"])
        self.assertNotIn("xsec", json.dumps(result, ensure_ascii=False).lower())

    def test_empty_note_status_is_successful(self) -> None:
        empty_page = {
            "code": 0,
            "success": True,
            "data": {"notes": [], "tags": [], "page": -1},
        }

        empty_analysis = {
            "code": 0,
            "success": True,
            "data": {
                "result": {"success": True, "code": 0},
                "note_infos": [],
                "total": 0,
            },
        }

        result = normalize_note_snapshot(
            [empty_page],
            empty_analysis,
            status="reviewing",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["notes"]["items"], [])
        self.assertFalse(result["partial"])

    def test_optional_failure_sets_partial_warning(self) -> None:
        responses = dict(self.responses)
        responses["activeFans"] = None

        result = normalize_account_snapshot(responses, period="all")

        self.assertTrue(result["success"])
        self.assertTrue(result["partial"])
        self.assertEqual(result["warnings"][0]["source"], "activeFans")


if __name__ == "__main__":
    unittest.main()
