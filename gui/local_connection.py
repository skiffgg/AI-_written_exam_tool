"""
本地连接工具模块
提供直接连接到本地服务器的功能，绕过所有代理设置
"""
import os
import logging
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from core.settings import settings

logger = logging.getLogger(__name__)

class LocalConnection:
    """本地连接工具类，提供不使用代理的连接方法"""
    
    @staticmethod
    def clear_proxy_env():
        """清除所有代理相关的环境变量"""
        # 保存原始环境变量
        original_proxy_env = {}
        for proxy_var in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']:
            original_proxy_env[proxy_var] = os.environ.get(proxy_var)
            if proxy_var in os.environ:
                del os.environ[proxy_var]
        
        # 设置 NO_PROXY 环境变量
        os.environ['NO_PROXY'] = 'localhost,127.0.0.1,0.0.0.0'
        os.environ['no_proxy'] = 'localhost,127.0.0.1,0.0.0.0'
        
        return original_proxy_env
    
    @staticmethod
    def restore_proxy_env(original_env):
        """恢复原始的代理环境变量"""
        for var, value in original_env.items():
            if value is not None:
                os.environ[var] = value
            elif var in os.environ:
                del os.environ[var]
    
    @staticmethod
    def get_local_url(path=""):
        """获取本地服务器 URL"""
        base = f"http://127.0.0.1:{settings.server_port}"
        if path:
            if not path.startswith('/'):
                path = f"/{path}"
            return f"{base}{path}"
        return base
    
    @staticmethod
    def create_session():
        """创建一个配置好的请求会话，不使用代理"""
        session = requests.Session()
        session.trust_env = False  # 不使用环境变量中的代理
        
        # 配置更稳定的重试策略
        retry_strategy = Retry(
            total=5,                  # 增加重试次数
            backoff_factor=0.5,       # 退避因子
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "POST", "PUT", "DELETE", "OPTIONS", "TRACE"],  # 允许重试的方法
            raise_on_redirect=False,  # 不在重定向时抛出异常
            raise_on_status=False     # 不在状态错误时抛出异常
        )
        
        # 增加超时设置
        adapter = HTTPAdapter(
            max_retries=retry_strategy,
            pool_connections=10,      # 连接池大小
            pool_maxsize=10,          # 最大连接数
            pool_block=False          # 连接池满时不阻塞
        )
        
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        
        # 设置较长的超时时间
        session.timeout = (10, 30)  # (连接超时, 读取超时)
        
        return session
    
    @classmethod
    def request(cls, method, path, **kwargs):
        """发送不使用代理的请求到本地服务器"""
        url = cls.get_local_url(path)
        original_env = cls.clear_proxy_env()
        
        try:
            session = cls.create_session()
            
            # 添加认证头（如果需要）
            if settings.dashboard_token and 'headers' not in kwargs:
                kwargs['headers'] = {'Authorization': f"Bearer {settings.dashboard_token}"}
            elif settings.dashboard_token and 'headers' in kwargs:
                kwargs['headers']['Authorization'] = f"Bearer {settings.dashboard_token}"
            
            logger.debug(f"发送本地请求: {method.upper()} {url}")
            response = session.request(method, url, **kwargs)
            return response
        finally:
            cls.restore_proxy_env(original_env)
    
    @classmethod
    def get(cls, path, **kwargs):
        """发送 GET 请求到本地服务器"""
        return cls.request("get", path, **kwargs)
    
    @classmethod
    def post(cls, path, **kwargs):
        """发送 POST 请求到本地服务器"""
        return cls.request("post", path, **kwargs)
