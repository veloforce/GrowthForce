import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import quote

import requests


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[3]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.cdp import Browser, Page


class ContentEditableInputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        electron = REPO_ROOT / "node_modules" / ".bin" / "electron"
        if not electron.exists():
            raise unittest.SkipTest("仓库未安装 Electron")

        cls._temp_dir = tempfile.TemporaryDirectory()
        app_dir = Path(cls._temp_dir.name)
        (app_dir / "package.json").write_text(
            '{"name":"xhs-cdp-input-test","main":"main.js"}',
            encoding="utf-8",
        )
        (app_dir / "main.js").write_text(
            """
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  win.loadURL("about:blank");
});
""".strip(),
            encoding="utf-8",
        )

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls._port = sock.getsockname()[1]

        cls._process = subprocess.Popen(
            [
                str(electron),
                f"--remote-debugging-port={cls._port}",
                "--no-sandbox",
                str(app_dir),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                response = requests.get(
                    f"http://127.0.0.1:{cls._port}/json/version",
                    timeout=0.5,
                )
                if response.ok:
                    return
            except requests.RequestException:
                pass
            if cls._process.poll() is not None:
                break
            time.sleep(0.1)

        cls.tearDownClass()
        raise RuntimeError("Electron CDP 测试实例启动失败")

    @classmethod
    def tearDownClass(cls) -> None:
        process = getattr(cls, "_process", None)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        temp_dir = getattr(cls, "_temp_dir", None)
        if temp_dir:
            temp_dir.cleanup()

    def _new_editor_page(self, script: str = ""):
        html = f"""
<!doctype html>
<html>
  <body>
    <div id="editor" contenteditable="true"></div>
    <script>
      window.singleCharacterInputs = 0;
      editor.addEventListener("input", (event) => {{
        if (event.data && event.data.length === 1) window.singleCharacterInputs += 1;
      }});
      {script}
    </script>
  </body>
</html>
"""
        browser = Browser(port=self._port)
        browser.connect()
        targets = requests.get(
            f"http://127.0.0.1:{self._port}/json",
            timeout=2,
        ).json()
        target_id = next(target["id"] for target in targets if target.get("type") == "page")
        page = browser.get_page_by_target_id(target_id)
        if page is None:
            browser.close()
            raise RuntimeError("无法连接 Electron 测试页面")
        page.navigate(f"data:text/html;charset=utf-8,{quote(html)}")
        page.wait_for_load(timeout=5)
        return browser, page

    def test_batch_input_preserves_multiline_special_text(self) -> None:
        browser, page = self._new_editor_page()
        text = '中文 English "quotes"\n\nemoji: 🚀\n#标签'
        try:
            page.input_content_editable("#editor", text)

            self.assertTrue(page._content_editable_matches("#editor", text))
            self.assertEqual(page.evaluate("window.singleCharacterInputs"), 0)
        finally:
            browser.close()

    def test_batch_mismatch_falls_back_to_character_input(self) -> None:
        browser, page = self._new_editor_page(
            """
let corrupted = false;
editor.addEventListener("input", (event) => {
  if (!corrupted && event.data && event.data.length > 1) {
    corrupted = true;
    queueMicrotask(() => { editor.textContent = "corrupted"; });
  }
});
"""
        )
        text = "fallback 成功\n第二行"
        try:
            page.input_content_editable("#editor", text)

            self.assertTrue(page._content_editable_matches("#editor", text))
            self.assertGreater(page.evaluate("window.singleCharacterInputs"), 0)
        finally:
            browser.close()

    def test_text_normalization_handles_browser_artifacts(self) -> None:
        self.assertEqual(
            Page._normalize_editable_text("第一行\r\n第二\u00a0行\u200b"),
            "第一行\n第二 行",
        )


if __name__ == "__main__":
    unittest.main()
