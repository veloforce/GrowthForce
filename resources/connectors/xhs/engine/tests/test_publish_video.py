import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.errors import UploadTimeoutError
from xhs.publish_video import (
    _get_publish_button_state,
    _is_publish_button_clickable,
    _upload_video,
    _wait_for_publish_button_clickable,
)


class FakePage:
    def __init__(self, evaluate_results: list[object] | None = None) -> None:
        self.evaluate_results = list(evaluate_results or [])
        self.last_evaluate_result: object = {"clickable": False, "reason": "button_not_found"}
        self.evaluate_calls: list[str] = []
        self.file_inputs: list[tuple[str, list[str]]] = []

    def evaluate(self, script: str) -> object:
        self.evaluate_calls.append(script)
        if self.evaluate_results:
            self.last_evaluate_result = self.evaluate_results.pop(0)
            return self.last_evaluate_result
        return self.last_evaluate_result

    def has_element(self, selector: str) -> bool:
        return True

    def set_file_input(self, selector: str, paths: list[str]) -> None:
        self.file_inputs.append((selector, paths))


class PublishVideoTest(unittest.TestCase):
    def test_new_publish_button_host_is_treated_as_clickable(self) -> None:
        page = FakePage([{"clickable": True, "reason": "host_submit_enabled"}])

        self.assertTrue(_is_publish_button_clickable(page))
        self.assertIn('xhs-publish-btn[is-publish="true"]', page.evaluate_calls[0])
        self.assertIn("submit-disabled", page.evaluate_calls[0])

    def test_wait_succeeds_when_new_publish_button_host_becomes_enabled(self) -> None:
        page = FakePage([
            {"clickable": False, "reason": "host_not_clickable"},
            {"clickable": True, "reason": "host_submit_enabled"},
        ])

        _wait_for_publish_button_clickable(page, max_wait=1, poll_interval=0)

        self.assertEqual(len(page.evaluate_calls), 2)

    def test_wait_times_out_when_publish_button_stays_disabled_or_missing(self) -> None:
        page = FakePage([
            {
                "clickable": False,
                "reason": "host_not_clickable",
                "hostFound": True,
                "submitDisabled": "true",
            }
        ])

        with self.assertRaisesRegex(UploadTimeoutError, "host_not_clickable"):
            _wait_for_publish_button_clickable(page, max_wait=0.01, poll_interval=0)

    def test_legacy_boolean_result_remains_supported(self) -> None:
        page = FakePage([True])

        self.assertTrue(_is_publish_button_clickable(page))

    def test_legacy_publish_button_selector_is_kept_as_fallback(self) -> None:
        page = FakePage([{"clickable": True, "reason": "legacy_button_enabled"}])

        self.assertTrue(_is_publish_button_clickable(page))
        self.assertIn(".publish-page-publish-btn button.bg-red", page.evaluate_calls[0])

    def test_video_file_name_diagnostic_is_dynamic(self) -> None:
        page = FakePage([
            {
                "clickable": False,
                "reason": "button_not_found",
                "uploadDiagnostics": {"videoFileNameMatched": True},
            }
        ])

        state = _get_publish_button_state(page, video_path="/tmp/custom-video-name.mp4")

        self.assertTrue(state["uploadDiagnostics"]["videoFileNameMatched"])
        self.assertIn("custom-video-name.mp4", page.evaluate_calls[0])
        self.assertNotIn("output.mp4", page.evaluate_calls[0])

    def test_upload_video_continues_after_new_publish_button_is_clickable(self) -> None:
        page = FakePage([{"clickable": True, "reason": "host_submit_enabled"}])

        with tempfile.TemporaryDirectory() as temp_dir:
            video = Path(temp_dir) / "video.mp4"
            video.write_bytes(b"video")

            _upload_video(page, str(video))

        self.assertEqual(len(page.file_inputs), 1)
        self.assertEqual(page.file_inputs[0][1], [str(video)])


if __name__ == "__main__":
    unittest.main()
