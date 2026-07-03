import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs import publish
from xhs.errors import PublishError
from xhs.selectors import CONTENT_EDITOR


class FakeTagPage:
    def __init__(self, *, refreshed_editor_available: bool) -> None:
        self.refreshed_editor_available = refreshed_editor_available
        self.evaluate_calls: list[str] = []
        self.used_selectors: list[str] = []

    def evaluate(self, script: str) -> object:
        self.evaluate_calls.append(script)
        if "const selector =" in script:
            if "missing-editor" in script:
                return {"found": False, "selector": ".missing-editor"}
            if CONTENT_EDITOR in script and self.refreshed_editor_available:
                self.used_selectors.append(CONTENT_EDITOR)
                return {"found": True, "selector": CONTENT_EDITOR, "paragraphCount": 2}
            return {"found": False}
        if "document.querySelectorAll('p')" in script:
            return ""
        return None

    def has_element(self, selector: str) -> bool:
        return selector == CONTENT_EDITOR and self.refreshed_editor_available


class FakeProseMirrorPage:
    def __init__(self, *, editor_text: str) -> None:
        self.editor_text = editor_text
        self.evaluate_calls: list[str] = []
        self.inserted_texts: list[str] = []

    def evaluate(self, script: str) -> object:
        self.evaluate_calls.append(script)
        if "const selector =" in script:
            return {"found": True, "selector": "[role='textbox']", "paragraphCount": 1}
        if "classList.contains(\"ProseMirror\")" in script:
            return True
        if "el.innerText || el.textContent" in script:
            return self.editor_text
        return None

    def _send_session(self, method: str, params: dict) -> dict:
        if method == "Input.insertText":
            text = str(params.get("text", ""))
            self.inserted_texts.append(text)
            self.editor_text += text
        return {}


class PublishTagsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._sleep = publish.time.sleep
        self._input_single_tag = publish._input_single_tag
        publish.time.sleep = lambda _seconds: None
        publish._input_single_tag = lambda _page, _selector, _tag: None

    def tearDown(self) -> None:
        publish.time.sleep = self._sleep
        publish._input_single_tag = self._input_single_tag

    def test_input_tags_relocates_editor_when_original_selector_is_stale(self) -> None:
        page = FakeTagPage(refreshed_editor_available=True)

        publish._input_tags(page, ".missing-editor", ["AI工具"])

        self.assertIn(CONTENT_EDITOR, page.used_selectors)
        self.assertTrue(any("selectNodeContents(el)" in script for script in page.evaluate_calls))

    def test_input_tags_reports_clear_error_when_editor_cannot_be_relocated(self) -> None:
        page = FakeTagPage(refreshed_editor_available=False)

        with self.assertRaisesRegex(PublishError, "无法输入标签"):
            publish._input_tags(page, ".missing-editor", ["AI工具"])

    def test_input_tags_uses_insert_text_for_prosemirror_editor(self) -> None:
        page = FakeProseMirrorPage(editor_text="正文")

        publish._input_tags(page, "[role='textbox']", ["AI工具", "#增长测试"])

        self.assertEqual(page.inserted_texts, ["\n#AI工具 #增长测试"])
        self.assertIn("#AI工具", page.editor_text)
        self.assertIn("#增长测试", page.editor_text)

    def test_input_tags_fails_when_prosemirror_text_is_not_updated(self) -> None:
        page = FakeProseMirrorPage(editor_text="正文")
        page._send_session = lambda _method, _params: {}

        with self.assertRaisesRegex(PublishError, "标签输入失败"):
            publish._input_tags(page, "[role='textbox']", ["AI工具"])


if __name__ == "__main__":
    unittest.main()
