"""小红书自动化异常体系。"""


class XHSError(Exception):
    """小红书自动化基础异常。"""


class NoFeedsError(XHSError):
    """没有捕获到 feeds 数据。"""

    def __init__(self) -> None:
        super().__init__("没有捕获到 feeds 数据")


class NoFeedDetailError(XHSError):
    """没有捕获到 feed 详情数据。"""

    def __init__(self) -> None:
        super().__init__("没有捕获到 feed 详情数据")


class NotLoggedInError(XHSError):
    """未登录。"""

    def __init__(self) -> None:
        super().__init__("未登录，请先扫码登录")


class PageNotAccessibleError(XHSError):
    """页面不可访问。"""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"笔记不可访问: {reason}")


class UploadTimeoutError(XHSError):
    """上传超时。"""


class PublishError(XHSError):
    """发布失败。"""


class CreatorSessionExpiredError(PublishError):
    """创作中心会话无法通过页面已有账号态自动恢复。"""

    def __init__(self) -> None:
        super().__init__("创作中心会话已失效，需要重新授权")


class CreatorDataError(XHSError):
    """创作者数据读取或核心响应校验失败。"""


class PublishValidationError(PublishError):
    """发布包本地预检失败。"""


class PublishResultTimeoutError(PublishError):
    """已触发发布，但未能确认最终结果。"""

    def __init__(self, reason: str = "timeout") -> None:
        self.reason = reason
        super().__init__("已触发发布但未确认结果")


class AccountRiskControlError(PublishError):
    """账号被风控，无法发布。

    XHS 后端业务错误码（HTTP 200 + code≠0）：
      - -9136: 因违反社区规范禁止发笔记
    """

    def __init__(self, code: int, msg: str) -> None:
        self.code = code
        self.msg = msg
        super().__init__(f"账号被风控（code={code}）：{msg}")


class TitleTooLongError(PublishValidationError):
    """标题超过长度限制。"""

    def __init__(self, current: str, maximum: str) -> None:
        self.current = current
        self.maximum = maximum
        super().__init__(f"当前输入长度为{current}，最大长度为{maximum}")


class ContentTooLongError(PublishValidationError):
    """正文超过长度限制。"""

    def __init__(self, current: str, maximum: str) -> None:
        self.current = current
        self.maximum = maximum
        super().__init__(f"当前输入长度为{current}，最大长度为{maximum}")


class ImageCountError(PublishValidationError):
    """图文图片数量不符合限制。"""

    def __init__(self, current: int, minimum: int = 1, maximum: int = 6) -> None:
        self.current = current
        self.minimum = minimum
        self.maximum = maximum
        super().__init__(f"图片数量为{current}，允许范围为{minimum}-{maximum}")


class TagCountError(PublishValidationError):
    """最终标签数量超过限制。"""

    def __init__(self, current: int, maximum: int = 6) -> None:
        self.current = current
        self.maximum = maximum
        super().__init__(f"标签数量为{current}，最大数量为{maximum}")


class InvalidImagePathError(PublishValidationError):
    """本地图片路径无效。"""

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"本地图片不存在或不是普通文件: {path}")


class InvalidVideoPathError(PublishValidationError):
    """本地视频路径无效。"""

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"本地视频不存在或不是普通文件: {path}")


class RateLimitError(XHSError):
    """请求频率过高，验证码获取失败。"""

    def __init__(self) -> None:
        super().__init__("请求太频繁，验证码获取失败，请重启浏览器后重试")


class CDPError(XHSError):
    """CDP 通信异常。"""


class ElementNotFoundError(XHSError):
    """页面元素未找到。"""

    def __init__(self, selector: str) -> None:
        self.selector = selector
        super().__init__(f"未找到元素: {selector}")
