import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.interact_state import parse_collect_button_state, parse_like_button_state


class CollectButtonStateTest(unittest.TestCase):
    def test_parse_collected_from_aria_pressed(self) -> None:
        self.assertTrue(parse_collect_button_state({
            "exists": True,
            "nodes": [{"ariaPressed": "true"}],
        }))

    def test_parse_uncollected_from_aria_pressed(self) -> None:
        self.assertFalse(parse_collect_button_state({
            "exists": True,
            "nodes": [{"ariaPressed": "false"}],
        }))

    def test_parse_collected_from_label(self) -> None:
        self.assertTrue(parse_collect_button_state({
            "exists": True,
            "nodes": [{"ariaLabel": "已收藏"}],
        }))

    def test_parse_collected_from_cancel_favorite_label(self) -> None:
        self.assertTrue(parse_collect_button_state({
            "exists": True,
            "nodes": [{"ariaLabel": "取消收藏"}],
        }))

    def test_parse_collected_from_icon_href(self) -> None:
        self.assertTrue(parse_collect_button_state({
            "exists": True,
            "nodes": [{"href": "#collected"}],
        }))

    def test_parse_uncollected_from_icon_href(self) -> None:
        self.assertFalse(parse_collect_button_state({
            "exists": True,
            "nodes": [{"href": "#collect"}],
        }))

    def test_parse_uncollected_from_collect_label(self) -> None:
        self.assertFalse(parse_collect_button_state({
            "exists": True,
            "nodes": [{"ariaLabel": "收藏"}],
        }))

    def test_parse_collected_from_active_class(self) -> None:
        self.assertTrue(parse_collect_button_state({
            "exists": True,
            "nodes": [{"className": "reds-icon collect-icon active"}],
        }))

    def test_parse_unknown_without_button(self) -> None:
        self.assertIsNone(parse_collect_button_state({"exists": False}))


class LikeButtonStateTest(unittest.TestCase):
    def test_parse_liked_from_icon_href(self) -> None:
        self.assertTrue(parse_like_button_state({
            "exists": True,
            "nodes": [{"href": "#liked"}],
        }))

    def test_parse_unliked_from_icon_href(self) -> None:
        self.assertFalse(parse_like_button_state({
            "exists": True,
            "nodes": [{"href": "#like"}],
        }))

    def test_parse_liked_from_aria_pressed(self) -> None:
        self.assertTrue(parse_like_button_state({
            "exists": True,
            "nodes": [{"ariaPressed": "true"}],
        }))

    def test_parse_unknown_without_button(self) -> None:
        self.assertIsNone(parse_like_button_state({"exists": False}))


if __name__ == "__main__":
    unittest.main()
