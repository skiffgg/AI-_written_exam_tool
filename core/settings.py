
# core/settings.py
from __future__ import annotations
import logging
import json
import os # <-- 确保导入 os (虽然可能已被 dotenv 加载，但明确导入更好)
from typing import List 
from pathlib import Path
from typing import Dict, Optional, Union # <-- 确保导入 Dict, Optional, Union
from dotenv import load_dotenv

# --- httpx 导入，用于 OpenAI 代理 ---
try:
    import httpx
except ImportError:
    # 提供一个友好的提示，如果 httpx 未安装
    print("错误：httpx 库未安装。如果需要使用代理访问 OpenAI，请运行 'pip install httpx[http2]'")
    httpx = None # 设置为 None 以便后续检查

# --- 加载 .env 文件 ---
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH, override=True)
    print(f"成功加载 .env 文件: {ENV_PATH}")
else:
    print(f"警告: .env 文件未找到于 {ENV_PATH}")


# --- Pydantic 相关导入 ---
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator

# --- 日志配置 (如果决定在这里配置) ---
log = logging.getLogger(__name__) # 获取 logger 实例

class Settings(BaseSettings):
    # --- Pydantic‑Settings 配置 ---
    model_config = SettingsConfigDict(
        env_file=str(ENV_PATH),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- 基础设置 ---
    server_host: str = Field(default="0.0.0.0", validation_alias='SERVER_HOST') # 修改默认主机设置，使其监听所有网络接口
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

    # --- 功能配置 ---
    image_analysis_provider: str = Field(default="gemini", validation_alias='IMAGE_ANALYSIS_PROVIDER')

    # --- 调试模式 ---
    debug_mode: bool = Field(default=False, validation_alias='DEBUG_MODE')

    # --- CORS 设置 ---
    # cors_allowed_origins = json.loads(os.getenv("CORS_ALLOWED_ORIGINS", "[]"))

    # --- 可选网络代理 ---
    http_proxy: str | None = Field(default=None, validation_alias='HTTP_PROXY')
    https_proxy: str | None = Field(default=None, validation_alias='HTTPS_PROXY')
    # all_proxy: str | None = Field(default=None, validation_alias='ALL_PROXY') # 暂时不用 all_proxy

    # 图片优化设置
    image_quality: int = Field(default=85, validation_alias='IMAGE_QUALITY')
    image_max_size: int = Field(default=1920, validation_alias='IMAGE_MAX_SIZE')

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
        """返回基础 URL，优先使用外部 URL"""
        if self.external_url:
            return self.external_url
        return f"http://{self.server_host if self.server_host != '0.0.0.0' else '127.0.0.1'}:{self.server_port}"

    # --- 新增：代理辅助方法 ---

    def get_proxy_dict(self) -> Optional[Dict[str, str]]:
        """
        根据配置返回适用于 requests 或 google-generativeai (transport='rest') 的代理字典。
        优先使用 https_proxy (如果设置了)。
        """
        proxies = {}
        # 优先使用 https_proxy 作为 https 的代理
        if self.https_proxy:
            # 确保代理地址包含协议头 (http:// 或 https://)
            # 如果 .env 文件中是 127.0.0.1:port 格式，需要添加 http://
            https_proxy_url = self.https_proxy if "://" in self.https_proxy else f"http://{self.https_proxy}"
            proxies['https'] = https_proxy_url
            logging.debug(f"Using specific HTTPS proxy: {https_proxy_url}")
        # 如果设置了 http_proxy，用它作为 http 和 https (除非 https 已被专门设置)
        if self.http_proxy:
            http_proxy_url = self.http_proxy if "://" in self.http_proxy else f"http://{self.http_proxy}"
            # 只有在 https 代理未被 https_proxy 设置时，才使用 http_proxy 作为 https 代理
            proxies.setdefault('https', http_proxy_url)
            proxies['http'] = http_proxy_url
            logging.debug(f"Using HTTP proxy: {http_proxy_url} (may also apply to HTTPS if not overridden)")

        # log.debug(f"Generated proxy dict for requests/Gemini: {proxies if proxies else 'None'}")
        return proxies if proxies else None

    def get_httpx_client(self) -> Optional[httpx.Client]:
        """
        根据配置创建并返回一个配置了代理的 httpx.Client 实例，
        用于传递给 openai 库。如果未设置代理或 httpx 未安装，则返回 None。
        """
        if httpx is None: # 检查 httpx 是否成功导入
             logging.warning("httpx library not installed, cannot configure proxy for OpenAI.")
             return None

        proxies_for_httpx = {}
        # httpx 需要代理 URL 包含 scheme (http:// 或 https://)
        # httpx 的格式是 'http://': 'http://proxy...', 'https://': 'http://proxy...'
        if self.http_proxy:
            http_proxy_url = self.http_proxy if "://" in self.http_proxy else f"http://{self.http_proxy}"
            proxies_for_httpx['http://'] = http_proxy_url
            # 如果没有专门的 https 代理，http 代理通常也用于 https 请求
            proxies_for_httpx.setdefault('https://', http_proxy_url)
            logging.debug(f"Using HTTP proxy for httpx: {http_proxy_url}")
        if self.https_proxy:
            https_proxy_url = self.https_proxy if "://" in self.https_proxy else f"http://{self.https_proxy}"
            proxies_for_httpx['https://'] = https_proxy_url # 覆盖 https
            logging.debug(f"Using specific HTTPS proxy for httpx: {https_proxy_url}")


        if not proxies_for_httpx:
            # log.debug("No proxies configured, returning None for httpx client.")
            return None # 没有代理，返回 None，OpenAI 库将使用默认 client

        log.info(f"Creating httpx client with proxies for keys: {list(proxies_for_httpx.keys())}")
        try:
            # 可以添加超时等其他配置
            timeout = httpx.Timeout(10.0, read=60.0, connect=10.0) # 增加读取超时
            # mounts 参数可用于更精细控制 http/https 代理，但 proxies 通常足够
            # mounts = {
            #    "http://": httpx.HTTPTransport(proxy=proxies_for_httpx.get("http://")),
            #    "https://": httpx.HTTPTransport(proxy=proxies_for_httpx.get("https://"))
            # }
            return httpx.Client(proxies=proxies_for_httpx, timeout=timeout, follow_redirects=True)
        except Exception as e:
            log.error(f"Failed to create httpx client with proxies: {e}", exc_info=True)
            return None # 创建失败也返回 None


    # --- 验证器 ---
    @field_validator("image_analysis_provider")
    @classmethod
    def _norm_provider(cls, v: str) -> str:
        """验证并规范化 image_analysis_provider 字段"""
        if not isinstance(v, str):
             raise ValueError("image_analysis_provider must be a string")
        v = v.lower().strip()
        allowed_providers = {"openai", "gemini"}
        if v not in allowed_providers:
            raise ValueError(f"image_analysis_provider must be one of {allowed_providers}")
        return v

# --- 创建全局 settings 实例 ---
try:
    settings = Settings()
    # 配置日志 (可选，但建议在此处根据 debug_mode 配置一次)
    log_level = logging.DEBUG if settings.debug_mode else logging.INFO
    # 移除或注释掉 web_server.py 中的 basicConfig 调用，避免冲突
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)-8s] %(name)-15s: %(message)s", # 更详细的格式
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    # 获取根 logger 并设置级别 (basicConfig 可能不够用时)
    # logging.getLogger().setLevel(log_level)
    logging.info(f"Settings loaded successfully. Debug mode: {settings.debug_mode}")
    logging.info(f"Image analysis provider: {settings.image_analysis_provider}")
    logging.info(f"HTTP Proxy: {settings.http_proxy or 'Not set'}")
    logging.info(f"HTTPS Proxy: {settings.https_proxy or 'Not set'}")

except Exception as e:
    logging.basicConfig(level=logging.ERROR) # 确保至少有错误日志输出
    logging.error(f"CRITICAL: Failed to initialize settings: {e}", exc_info=True)
    raise SystemExit(f"Failed to load settings: {e}") # 启动失败直接退出

# --- 用于直接运行此文件进行测试 ---
if __name__ == "__main__":
    import pprint
    print("\n--- Loaded Settings (via model_dump) ---")
    pprint.pp(settings.model_dump())
    print("\n--- Proxy Helper Method Test ---")
    print(f"get_proxy_dict() returns: {settings.get_proxy_dict()}")
    httpx_client = settings.get_httpx_client()
    print(f"get_httpx_client() returns: {'Client object with proxies' if httpx_client else 'None'}")
    if httpx_client:
        print(f"  - httpx client proxies: {httpx_client.proxies}")

    print("\n--- Environment Variable Check ---")
    print(f".env file path used: {ENV_PATH}")
    print(f"DEBUG_MODE from env: {os.getenv('DEBUG_MODE')}")
    print(f"HTTP_PROXY from env: {os.getenv('HTTP_PROXY')}")
    print(f"HTTPS_PROXY from env: {os.getenv('HTTPS_PROXY')}")
