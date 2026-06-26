"""发布包本地预检：不得触发下载、CDP 导航或页面操作。"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from title_utils import calc_title_length

from .errors import (
    ContentTooLongError,
    ImageCountError,
    InvalidImagePathError,
    InvalidVideoPathError,
    TagCountError,
    TitleTooLongError,
)


MAX_TITLE_LENGTH = 20
MAX_CONTENT_LENGTH = 800
MAX_IMAGE_COUNT = 6
MAX_TAG_COUNT = 6


@dataclass(frozen=True)
class PublishPreflightResult:
    title: str
    content: str
    tags: list[str]
    images: list[str]
    video: str | None = None


def validate_image_publish_input(
    title: str,
    content: str,
    images: list[str],
    tags: list[str],
) -> PublishPreflightResult:
    normalized_title, normalized_content, normalized_tags = _validate_text_and_tags(title, content, tags)
    requested_images = [image.strip() for image in images if image.strip()]
    if not 1 <= len(requested_images) <= MAX_IMAGE_COUNT:
        raise ImageCountError(len(requested_images), 1, MAX_IMAGE_COUNT)
    normalized_images: list[str] = []
    for image in requested_images:
        if _is_http_url(image):
            normalized_images.append(image)
            continue
        expanded = os.path.expanduser(image)
        if not os.path.isabs(expanded) or not os.path.isfile(expanded):
            raise InvalidImagePathError(image)
        normalized_images.append(os.path.abspath(expanded))
    return PublishPreflightResult(
        title=normalized_title,
        content=normalized_content,
        tags=normalized_tags,
        images=normalized_images,
    )


def validate_video_publish_input(title: str, content: str, tags: list[str], video: str | None = None) -> PublishPreflightResult:
    normalized_title, normalized_content, normalized_tags = _validate_text_and_tags(title, content, tags)
    if video is not None:
        requested_video = video.strip()
        normalized_video = os.path.expanduser(requested_video)
        if not requested_video or not os.path.isabs(normalized_video) or not os.path.isfile(normalized_video):
            raise InvalidVideoPathError(video)
        normalized_video = os.path.abspath(normalized_video)
    else:
        normalized_video = None
    return PublishPreflightResult(
        title=normalized_title,
        content=normalized_content,
        tags=normalized_tags,
        images=[],
        video=normalized_video,
    )


def extract_final_tags(content: str, tags: list[str]) -> tuple[str, list[str]]:
    """提取正文末尾的 hashtag 行，并与显式标签按首次出现顺序去重。"""
    normalized_tags = _deduplicate_tags(tags)
    lines = content.rstrip().split("\n")
    if not lines:
        return content, normalized_tags
    last_line = lines[-1].strip()
    if not re.fullmatch(r"(#\S+\s*)+", last_line):
        return content, normalized_tags
    extracted = re.findall(r"#(\S+)", last_line)
    merged = _deduplicate_tags([*normalized_tags, *extracted])
    return "\n".join(lines[:-1]).rstrip(), merged


def _validate_text_and_tags(title: str, content: str, tags: list[str]) -> tuple[str, str, list[str]]:
    normalized_title = title.strip()
    title_length = calc_title_length(normalized_title)
    if title_length > MAX_TITLE_LENGTH:
        raise TitleTooLongError(str(title_length), str(MAX_TITLE_LENGTH))

    normalized_content, normalized_tags = extract_final_tags(content.strip(), tags)
    if len(normalized_content) > MAX_CONTENT_LENGTH:
        raise ContentTooLongError(str(len(normalized_content)), str(MAX_CONTENT_LENGTH))
    if len(normalized_tags) > MAX_TAG_COUNT:
        raise TagCountError(len(normalized_tags), MAX_TAG_COUNT)
    return normalized_title, normalized_content, normalized_tags


def _deduplicate_tags(tags: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        tag = raw_tag.strip().lstrip("#")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        result.append(tag)
    return result


def _is_http_url(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))
