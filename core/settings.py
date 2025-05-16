# core/settings.py
from __future__ import annotations
import logging
import json
import os
from typing import List, Dict, Optional, Union
from pathlib import Path
from dotenv import load_dotenv
from typing import Optional

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
    print(f"成功加载 .env 文件: {ENV_PATH}")
else:
    print(f"警告: .env 文件未找到于 {ENV_PATH}")

# --- Pydantic-Settings 导入 ---
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

# --- 获取模块级 logger ---
log = logging.getLogger(__name__)

class Settings(BaseSettings):
    # --- Pydantic-Settings 配置 ---
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
    dashboard_token: Optional[str] = Field(
        default=None,
        validation_alias='DASHBOARD_TOKEN',
        description='用于保护仪表板的 Bearer 令牌；留空则禁用认证',
    )

    # --- 语音转文字提供商配置 ---
    stt_provider: str = Field(
        default="google",
        validation_alias="STT_PROVIDER",
        description='语音转文字使用的后端，"google" 或 "whisper"'
    )
    whisper_model: str = Field(
        default="base",
        validation_alias="WHISPER_MODEL",
        description='Whisper 模型名称（tiny、base、small、medium、large）'
    )

    # --- AI 提供商 API Keys ---
    openai_api_key: Optional[str] = Field(default=None, validation_alias='OPENAI_API_KEY')
    gemini_api_key: Optional[str] = Field(default=None, validation_alias='GEMINI_API_KEY')
    # claude_api_key: Optional[str] = Field(default=None, validation_alias='CLAUDE_API_KEY')
    # grok_api_key: Optional[str] = Field(default=None, validation_alias='GROK_API_KEY')

    # --- 功能配置 ---
    image_analysis_provider: str = Field(default="gemini", validation_alias='IMAGE_ANALYSIS_PROVIDER')

    # --- 调试模式 ---
    debug_mode: bool = Field(default=False, validation_alias='DEBUG_MODE')

    # --- 可选网络代理 ---
    http_proxy: Optional[str] = Field(default=None, validation_alias='HTTP_PROXY')
    https_proxy: Optional[str] = Field(default=None, validation_alias='HTTPS_PROXY')

    # --- 图片优化设置 ---
    image_quality: int = Field(default=85, validation_alias='IMAGE_QUALITY')
    image_max_size: int = Field(default=1920, validation_alias='IMAGE_MAX_SIZE')

    # --- 文本文件处理最大字符数 ---
    MAX_TEXT_FILE_CHARS: int = Field(default=4000, validation_alias='MAX_TEXT_FILE_CHARS')

    # --- 外部 URL 和 CORS 配置 ---
    external_url: Optional[str] = Field(
        default=None,
        validation_alias='EXTERNAL_URL',
        description='用于外部访问的完整 URL，例如 https://your-domain.com',
    )
    cors_allowed_origins: Optional[str] = Field(
        default=None,
        validation_alias='CORS_ALLOWED_ORIGINS',
        description='允许的 CORS 源，多个源用逗号分隔',
    )

    # --- 辅助属性 ---
    @property
    def base_url(self) -> str:
        if self.external_url:
            return self.external_url.rstrip('/')
        host = str(self.server_host if self.server_host != '0.0.0.0' else '127.0.0.1')
        port = str(self.server_port)
        return f"http://{host}:{port}"

    # --- 代理辅助方法 ---
    def get_proxy_dict(self) -> Optional[Dict[str, str]]:
        proxies: Dict[str, str] = {}
        if self.https_proxy:
            https_url = self.https_proxy if "://" in self.https_proxy else f"http://{self.https_proxy}"
            proxies['https'] = https_url
            log.debug(f"Using specific HTTPS proxy: {https_url}")
        if self.http_proxy:
            http_url = self.http_proxy if "://" in self.http_proxy else f"http://{self.http_proxy}"
            proxies.setdefault('https', http_url)
            proxies['http'] = http_url
            log.debug(f"Using HTTP proxy: {http_url}")
        return proxies or None

    def get_httpx_client(self) -> Optional[httpx.Client]:
        """
        Returns an httpx.Client that respects OS environment proxy settings.
        """
        if httpx is None:
            log.warning("httpx not installed, cannot configure HTTP client.")
            return None
        try:
            from httpx import Timeout
            timeout = Timeout(10.0, read=60.0, connect=10.0)  # type: ignore
            # trust_env=True 让客户端自动读取 HTTP_PROXY/HTTPS_PROXY 环境变量
            return httpx.Client(timeout=timeout, follow_redirects=True, trust_env=True)
        except Exception as e:
            log.error(f"Failed to create httpx client: {e}", exc_info=True)
            return None


# --- 创建全局 settings 实例并配置日志 ---
try:
    settings = Settings()
    log_level = logging.DEBUG if settings.debug_mode else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)-8s] %(name)-25s %(funcName)-20s L%(lineno)-4d : %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        force=True
    )
    log.info(f"Settings loaded. Debug mode: {settings.debug_mode}")
    log.info(f"STT provider: {settings.stt_provider}, Whisper model: {settings.whisper_model}")
    log.info(f"Image analysis provider: {settings.image_analysis_provider}")
    log.info(f"MAX_TEXT_FILE_CHARS: {settings.MAX_TEXT_FILE_CHARS}")
except Exception as e:
    print(f"CRITICAL: Failed to initialize settings: {e}")
    raise SystemExit(f"Settings load error: {e}")

# --- 测试或直接运行 ---
if __name__ == "__main__":
    import pprint
    pprint.pp(settings.model_dump())
    print("Proxy dict:", settings.get_proxy_dict())
