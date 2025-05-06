# # core/uploader.py
# from __future__ import annotations
# import base64
# import requests
# import logging

# from core.settings import settings

# logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

# _ENDPOINT = f"{settings.base_url}/upload_screenshot"

# def upload(img_bytes: bytes) -> dict[str, str]:
#     """上传图片到 web 服务，返回 JSON 响应"""
#     try:
#         resp = requests.post(
#             _ENDPOINT,
#             json={"image": base64.b64encode(img_bytes).decode()},
#             timeout=20,
#         )
#         resp.raise_for_status()
#         return resp.json()
#     except requests.RequestException as exc:
#         logging.error("上传失败：%s", exc, exc_info=True)
#         return {"message": str(exc)}

# if __name__ == "__main__":
#     from core.capture import grab_screen
#     result = upload(grab_screen())
#     print(result)

####################################v1###########################################

# core/uploader.py
from __future__ import annotations

import base64
import logging
import os                      # ← 新增
import requests

from core.settings import settings

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s: %(message)s")

_ENDPOINT = f"{settings.base_url}/upload_screenshot"

def upload(img_bytes: bytes) -> dict[str, str]:
    """上传图片到 web 服务，返回 JSON 响应"""
    try:
        # ─── 1. 准备请求头 ────────────────────────────
        token = os.getenv("DASHBOARD_TOKEN", "")        # 从环境变量读取
        headers = {"Authorization": f"Bearer {token}"} if token else {}

        # ─── 2. 发送请求 ────────────────────────────
        resp = requests.post(
            _ENDPOINT,
            json={"image": base64.b64encode(img_bytes).decode()},
            headers=headers,        # ← 新增
            timeout=20,
        )
        resp.raise_for_status()
        return resp.json()

    except requests.RequestException as exc:
        logging.error("上传失败：%s", exc, exc_info=True)
        return {"message": str(exc)}

if __name__ == "__main__":
    from core.capture import grab_screen
    result = upload(grab_screen())
    print(result)

