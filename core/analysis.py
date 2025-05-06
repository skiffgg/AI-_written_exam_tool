"""
封装 OpenAI 与 Gemini 图像分析，统一接口 analyze_image。
"""
from __future__ import annotations
import base64
import io
import logging
from typing import Any, Dict,Optional

from PIL import Image
import openai
import google.generativeai as genai

from core.settings import settings
from core.constants import DEFAULT_MODEL_GEMINI, DEFAULT_MODEL_OPENAI

# 基本日志配置
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")


def _call_openai(img_bytes: bytes, prompt: str) -> str:
    """调用 OpenAI Vision 模型，返回描述文本"""
    client = openai.OpenAI(api_key=settings.openai_api_key)
    b64_png = base64.b64encode(img_bytes).decode()
    data_url = f"data:image/png;base64,{b64_png}"

    logging.info(f"调用 OpenAI Vision... prompt: {prompt}")
    chat = client.chat.completions.create(
        model=DEFAULT_MODEL_OPENAI,
        max_tokens=1024,
        messages=[
            {"role": "system", "content": (
                "You are an assistant that concisely describes screenshots "
                "and points out anything unusual."
            )},
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url, "detail": "low"}},
            ]},
        ],
    )
    return chat.choices[0].message.content.strip()



def _call_gemini(img_bytes: bytes, prompt: str) -> str:
    """调用 Google Gemini Vision，返回描述文本"""
    genai.configure(api_key=settings.gemini_api_key)
    model = genai.GenerativeModel(DEFAULT_MODEL_GEMINI)

    pil_img = Image.open(io.BytesIO(img_bytes))
    gen_cfg = genai.GenerationConfig(max_output_tokens=1024)

    logging.info(f"调用 Gemini Vision... prompt: {prompt}")
    response = model.generate_content(
        [prompt, pil_img],
        generation_config=gen_cfg,
    )
    return response.text.strip()


def analyze_image(img_bytes: bytes, prompt: Optional[str] = None) -> Dict[str, Any]:
    provider = settings.image_analysis_provider or ("openai" if settings.openai_api_key else "gemini")
    prompt = prompt or "Describe this screenshot and highlight anything unusual."  # ✅ 设置默认 prompt
    try:
        if provider == "openai" and settings.openai_api_key:
            msg = _call_openai(img_bytes, prompt)
        elif provider == "gemini" and settings.gemini_api_key:
            msg = _call_gemini(img_bytes, prompt)
        else:
            return {"provider": "none", "message": "图像分析未启用"}
        return {"provider": provider, "message": msg}
    except Exception as exc:
        logging.exception("分析失败：%s", exc)
        return {"provider": "error", "message": f"分析出错：{exc}"}




# 明确导出公共接口
__all__ = ["analyze_image"]
