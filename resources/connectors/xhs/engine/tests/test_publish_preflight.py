import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from xhs.errors import (
    ContentTooLongError,
    ImageCountError,
    InvalidImagePathError,
    TagCountError,
    TitleTooLongError,
)
from xhs.publish_preflight import validate_image_publish_input, validate_video_publish_input
from title_utils import calc_title_length


class PublishPreflightTest(unittest.TestCase):
    def test_image_publish_accepts_boundary_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            images = []
            for index in range(6):
                image = Path(temp_dir) / f"{index}.png"
                image.write_bytes(b"png")
                images.append(str(image))

            result = validate_image_publish_input("标" * 20, "正" * 800, images, [f"标签{i}" for i in range(6)])

        self.assertEqual(len(result.images), 6)
        self.assertEqual(len(result.tags), 6)
        self.assertEqual(len(result.content), 800)

    def test_image_publish_rejects_each_exceeded_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "image.png"
            image.write_bytes(b"png")

            with self.assertRaises(TitleTooLongError):
                validate_image_publish_input("标" * 21, "正文", [str(image)], [])
            with self.assertRaises(ContentTooLongError):
                validate_image_publish_input("标题", "正" * 801, [str(image)], [])
            with self.assertRaises(ImageCountError):
                validate_image_publish_input("标题", "正文", [str(image)] * 7, [])
            with self.assertRaises(TagCountError):
                validate_image_publish_input("标题", "正文", [str(image)], [f"标签{i}" for i in range(7)])

    def test_title_limit_uses_utf16_units(self) -> None:
        self.assertEqual(calc_title_length("a" * 39), 20)
        self.assertEqual(calc_title_length("a" * 41), 21)
        self.assertEqual(calc_title_length("中" * 20), 20)
        self.assertEqual(calc_title_length("💇\u200d♀️"), 5)

        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "image.png"
            image.write_bytes(b"png")
            validate_image_publish_input("a" * 39, "正文", [str(image)], [])
            validate_image_publish_input("中" * 20, "正文", [str(image)], [])
            with self.assertRaises(TitleTooLongError):
                validate_image_publish_input("a" * 41, "正文", [str(image)], [])

    def test_final_tag_limit_uses_merged_deduplicated_tags(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "image.png"
            image.write_bytes(b"png")
            result = validate_image_publish_input(
                "标题",
                "正文\n#标签1 #标签2",
                [str(image)],
                ["标签1", "标签3", "标签3"],
            )

        self.assertEqual(result.content, "正文")
        self.assertEqual(result.tags, ["标签1", "标签3", "标签2"])

    def test_missing_or_non_file_local_image_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaises(InvalidImagePathError):
                validate_image_publish_input("标题", "正文", [str(Path(temp_dir) / "missing.png")], [])
            with self.assertRaises(InvalidImagePathError):
                validate_image_publish_input("标题", "正文", [temp_dir], [])
            with self.assertRaises(InvalidImagePathError):
                validate_image_publish_input("标题", "正文", ["relative.png"], [])

    def test_video_publish_uses_content_and_tag_limits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            video = Path(temp_dir) / "video.mp4"
            video.write_bytes(b"video")
            result = validate_video_publish_input("标题", "正" * 800, [f"标签{i}" for i in range(6)], str(video))
            self.assertEqual(len(result.content), 800)
            self.assertEqual(result.video, str(video))
            with self.assertRaises(ContentTooLongError):
                validate_video_publish_input("标题", "正" * 801, [], str(video))
            with self.assertRaises(TagCountError):
                validate_video_publish_input("标题", "正文", [f"标签{i}" for i in range(7)], str(video))

    def test_real_cli_rejects_invalid_package_before_cdp_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            title = Path(temp_dir) / "title.txt"
            content = Path(temp_dir) / "content.txt"
            image = Path(temp_dir) / "image.png"
            title.write_text("标题", encoding="utf-8")
            content.write_text("正" * 801, encoding="utf-8")
            image.write_bytes(b"png")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "cli.py"),
                    "fill-publish",
                    "--title-file",
                    str(title),
                    "--content-file",
                    str(content),
                    "--images",
                    str(image),
                ],
                capture_output=True,
                text=True,
                check=False,
                env={},
            )

        self.assertEqual(completed.returncode, 2)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["error_code"], "PUBLISH_VALIDATION_FAILED")
        self.assertIn("最大长度为800", payload["error"])
        self.assertNotIn("CDP", completed.stderr)


if __name__ == "__main__":
    unittest.main()
