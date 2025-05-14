# core/settings.py
from __future__ import annotations
import logging # <--- 确保 logging 在最前面导入
import json
import os
from typing import List, Dict, Optional, Union # 合并 typing 导入
from pathlib import Path
from dotenv import load_dotenv

# --- httpx 导入 ---
try:
    import httpx
except ImportError:
    print("错误：httpx 库未安装。如果需要使用代理访问 OpenAI，请运行 'pip install httpx[http2]'")
    httpx = None

# --- 加载 .env 文件 ---
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH, override=True)
    # 使用 print 没问题，因为此时 logging 可能还未配置
    print(f"成功加载 .env 文件: {ENV_PATH}")
else:
    print(f"警告: .env 文件未找到于 {ENV_PATH}")

# --- Pydantic 相关导入 ---
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator # field_validator 导入但未使用，可以考虑移除

# --- 获取模块级 logger ---
# 在这里获取 logger 是安全的，因为它在 logging.basicConfig 之前
# basicConfig 会配置根 logger，这个 logger 会继承其设置
log = logging.getLogger(__name__)

class Settings(BaseSettings):
    # --- Pydantic‑Settings 配置 ---
    model_config = SettingsConfigDict(
        env_file=str(ENV_PATH),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- 基础设置 ---
    server_host: str = Field(default="0.0.0.0", validation_alias='SERVER_HOST')
    server_port: int = Field(default=5000, validation_alias='SERVER_PORT')
    
    # --- 认证 ---
    dashboard_token: str | None = Field(
        default=None,
        validation_alias='DASHBOARD_TOKEN',
        description='用于保护仪表板的 Bearer 令牌；留空则禁用认证',
    )

    # --- AI 提供商 API Keys ---
    openai_api_key: str | None = Field(default=None, validation_alias='OPENAI_API_KEY')
    gemini_api_key: str | None = Field(default=None, validation_alias='GEMINI_API_KEY')
    # 您可能还需要为 Claude 和 Grok 添加 API Key 字段，如果它们需要的话
    # claude_api_key: str | None = Field(default=None, validation_alias='CLAUDE_API_KEY')
    # grok_api_key: str | None = Field(default=None, validation_alias='GROK_API_KEY')


    # --- 功能配置 ---
    image_analysis_provider: str = Field(default="gemini", validation_alias='IMAGE_ANALYSIS_PROVIDER')

    # --- 调试模式 ---
    debug_mode: bool = Field(default=False, validation_alias='DEBUG_MODE')

    # --- 可选网络代理 ---
    http_proxy: str | None = Field(default=None, validation_alias='HTTP_PROXY')
    https_proxy: str | None = Field(default=None, validation_alias='HTTPS_PROXY')

    # 图片优化设置
    image_quality: int = Field(default=85, validation_alias='IMAGE_QUALITY')
    image_max_size: int = Field(default=1920, validation_alias='IMAGE_MAX_SIZE')

    # --- 新增：文本文件处理的最大字符数 ---
    MAX_TEXT_FILE_CHARS: int = Field(default=4000, validation_alias='MAX_TEXT_FILE_CHARS') # <--- **确保此行已添加**

    # 添加外部 URL 设置
    external_url: str | None = Field(
        default=None,
        validation_alias='EXTERNAL_URL',
        description='用于外部访问的完整 URL，例如 https://your-domain.com',
    )

    # 添加 CORS 允许的源
    cors_allowed_origins: str | None = Field(
        default=None,
        validation_alias='CORS_ALLOWED_ORIGINS',
        description='允许的 CORS 源，多个源用逗号分隔',
    )

    # --- 辅助属性 ---
    @property
    def base_url(self) -> str:
        if self.external_url:
            return self.external_url.rstrip('/') # 确保移除尾部斜杠
        # 确保 server_host 和 server_port 是字符串或可以转换
        host = str(self.server_host if self.server_host != '0.0.0.0' else '127.0.0.1')
        port = str(self.server_port)
        return f"http://{host}:{port}"

    # --- 代理辅助方法 ---
    def get_proxy_dict(self) -> Optional[Dict[str, str]]:
        proxies = {}
        # (您的代理逻辑保持不变，但使用 log.debug 而不是 logging.debug)
        if self.https_proxy:
            https_proxy_url = self.https_proxy if "://" in self.https_proxy else f"http://{self.https_proxy}"
            proxies['https'] = https_proxy_url
            log.debug(f"Using specific HTTPS proxy: {https_proxy_url}")
        if self.http_proxy:
            http_proxy_url = self.http_proxy if "://" in self.http_proxy else f"http://{self.http_proxy}"
            proxies.setdefault('https', http_proxy_url)
            proxies['http'] = http_proxy_url
            log.debug(f"Using HTTP proxy: {http_proxy_url} (may also apply to HTTPS if not overridden)")
        return proxies if proxies else None

    def get_httpx_client(self) -> Optional[httpx.Client]: # type: ignore
        if httpx is None:
             log.warning("httpx library not installed, cannot configure proxy for OpenAI.")
             return None
        proxies_for_httpx = {}
        if self.http_proxy:
            http_proxy_url = self.http_proxy if "://" in self.http_proxy else f"http://{self.http_proxy}"
            proxies_for_httpx['http://'] = http_proxy_url
            proxies_for_httpx.setdefault('https://', http_proxy_url)
        if self.https_proxy:
            https_proxy_url = self.https_proxy if "://" in self.https_proxy else f"http://{self.https_proxy}"
            proxies_for_httpx['https://'] = https_proxy_url
        if not proxies_for_httpx:
            return None
        log.info(f"Creating httpx client with proxies for keys: {list(proxies_for_httpx.keys())}")
        try:
            timeout = httpx.Timeout(10.0, read=60.0, connect=10.0) # type: ignore
            return httpx.Client(proxies=proxies_for_httpx, timeout=timeout, follow_redirects=True) # type: ignore
        except Exception as e:
            log.error(f"Failed to create httpx client with proxies: {e}", exc_info=True)
            return None

    # --- 验证器 ---
    # @field_validator("image_analysis_provider") # 如果不实际使用 field_validator 装饰器，可以移除它
    # @classmethod
    # def _norm_provider(cls, v: str) -> str:
    #     """验证并规范化 image_analysis_provider 字段"""
    #     # (您的验证逻辑可以保留，但确保它与 core.constants.ModelProvider 中的键一致)
    #     # 例如，您可能希望允许 "openai", "gemini", "claude", "grok"
    #     if not isinstance(v, str):
    #          raise ValueError("image_analysis_provider must be a string")
    #     v_lower = v.lower().strip()
    #     # from core.constants import ModelProvider # 动态检查
    #     # allowed_providers = {getattr(ModelProvider, attr) for attr in dir(ModelProvider) if not attr.startswith("__")}
    #     allowed_providers_simple = {"openai", "gemini", "claude", "grok"} # 手动维护或从 ModelProvider 构建
    #     if v_lower not in allowed_providers_simple:
    #         log.warning(f"IMAGE_ANALYSIS_PROVIDER ('{v}') not in {allowed_providers_simple}. Ensure core logic handles it.")
    #         # Consider raising ValueError if strict validation is needed
    #     return v_lower

# --- 创建全局 settings 实例 和 配置日志 ---
try:
    settings = Settings() # 创建实例

    # 日志配置应该在获取 logger 实例之后，并且在第一次使用 log.info() 等之前
    # 将其移到 settings 实例成功创建之后
    log_level = logging.DEBUG if settings.debug_mode else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)-8s] %(name)-25s L%(lineno)-4d %(funcName)-20s : %(message)s", # 调整格式
        datefmt="%Y-%m-%d %H:%M:%S",
        force=True # 强制覆盖根logger的任何现有处理器
    )
    # 现在可以安全地使用 log 对象记录信息
    log.info(f"Settings loaded successfully. Debug mode: {settings.debug_mode}")
    log.info(f"Image analysis provider: {settings.image_analysis_provider}")
    log.info(f"HTTP Proxy: {settings.http_proxy or 'Not set'}")
    log.info(f"HTTPS Proxy: {settings.https_proxy or 'Not set'}")
    log.info(f"MAX_TEXT_FILE_CHARS from settings: {settings.MAX_TEXT_FILE_CHARS}") # 确认加载

except Exception as e:
    # 如果 Settings() 初始化失败，logging 可能还未完全配置，所以使用 print 作为后备
    print(f"CRITICAL: Failed to initialize settings or logging: {e}")
    # 尝试用最基本的方式记录错误
    logging.basicConfig(level=logging.ERROR, format="%(asctime)s [%(levelname)-8s] %(name)s: %(message)s", force=True)
    logging.error(f"CRITICAL: Failed to initialize settings: {e}", exc_info=True)
    raise SystemExit(f"Failed to load settings: {e}")

# --- 用于直接运行此文件进行测试 ---
if __name__ == "__main__":
    # (您的 __main__ 测试代码保持不变)
    import pprint
    print("\n--- Loaded Settings (via model_dump) ---")
    pprint.pp(settings.model_dump())
    print("\n--- Proxy Helper Method Test ---")
    print(f"get_proxy_dict() returns: {settings.get_proxy_dict()}")
    httpx_client = settings.get_httpx_client()
    print(f"get_httpx_client() returns: {'Client object with proxies' if httpx_client else 'None'}")
    if httpx_client:
        print(f"  - httpx client proxies: {httpx_client.proxies}") # type: ignore

    print("\n--- Environment Variable Check ---")
    print(f".env file path used: {ENV_PATH}")
    print(f"DEBUG_MODE from env: {os.getenv('DEBUG_MODE')}")
    print(f"HTTP_PROXY from env: {os.getenv('HTTP_PROXY')}")
    print(f"HTTPS_PROXY from env: {os.getenv('HTTPS_PROXY')}")
    print(f"MAX_TEXT_FILE_CHARS from env: {os.getenv('MAX_TEXT_FILE_CHARS')}") # 检查环境变量
    print(f"MAX_TEXT_FILE_CHARS from settings object: {settings.MAX_TEXT_FILE_CHARS}") # 检查Pydantic加载的值