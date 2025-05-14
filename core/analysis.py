# core/analysis.py
"""
封装图像分析功能。当使用多模态模型时，它会利用 core.chat 中的聊天函数
来获取图像描述或回答关于图像的问题。
"""
from __future__ import annotations
import logging
from typing import Any, Dict, Optional

# base64, io, Image from PIL are not strictly needed here anymore if chat.py handles image data
# However, keeping them for now if there's any direct image pre-processing planned here.
# import base64
# import io
# from PIL import Image

from core.settings import settings
from core.constants import (
    ALL_AVAILABLE_MODELS,
    ModelProvider,
    get_default_model_for_provider
)
# 导入更新后的 chat_only 函数
from core.chat import chat_only

log = logging.getLogger(__name__) # Changed from basicConfig

# 移除旧的 _call_openai 和 _call_gemini (视觉特定版本)
# 因为我们将通过 core.chat.chat_only 来处理，它现在是多模态的

def analyze_image(
    img_bytes: bytes, # Image data as bytes
    prompt: Optional[str] = None,
    model_id: Optional[str] = None,
    provider: Optional[str] = None
) -> Dict[str, Any]:
    """
    分析提供的图像字节。如果选择了多模态模型，则通过 core.chat.chat_only
    发送图像和提示进行分析。

    Args:
        img_bytes: 图像的字节数据。
        prompt: 关于图像的文本提示/问题。
        model_id: 要使用的特定模型ID。
        provider: AI提供商的标识符。

    Returns:
        一个包含 'provider', 'model_id', 和 'message' (分析结果) 的字典。
    """
    current_provider = provider
    current_model_id = model_id

    # 1. 确定提供商 (与 chat_only 中的逻辑类似)
    if not current_provider:
        if current_model_id:
            for p_name, models in ALL_AVAILABLE_MODELS.items():
                if current_model_id in models:
                    current_provider = p_name
                    break
        if not current_provider: # Fallback if still no provider
            current_provider = settings.image_analysis_provider or ModelProvider.OPENAI # Default provider
            log.warning(f"Image Analysis: Provider not specified, falling back to '{current_provider}'.")

    # 2. 确定模型ID (与 chat_only 中的逻辑类似)
    if not current_model_id:
        current_model_id = get_default_model_for_provider(current_provider)
        # Ensure the default model is vision-capable if possible
        if current_provider == ModelProvider.GEMINI and \
           current_model_id and \
           not any(vision_kw in current_model_id.lower() for vision_kw in ["vision", "flash", "pro", "ultra"]): # Simple check
             default_gemini_vision = "gemini-1.5-flash-latest" # Or a specific vision default from constants
             log.warning(f"Image Analysis: Default model '{current_model_id}' for Gemini might not be vision. Trying '{default_gemini_vision}'.")
             current_model_id = default_gemini_vision
        elif current_provider == ModelProvider.OPENAI and \
             current_model_id and \
             "gpt-4o" not in current_model_id.lower() and "vision" not in current_model_id.lower(): # GPT-4o is vision
             default_openai_vision = "gpt-4o"
             log.warning(f"Image Analysis: Default model '{current_model_id}' for OpenAI. Vision preferred, trying '{default_openai_vision}'.")
             current_model_id = default_openai_vision
        # Add similar checks for Claude, Grok if they have specific vision model naming conventions

    if not current_model_id or not current_provider:
        log.error(f"Image Analysis: Could not determine model_id or provider. Provider: {current_provider}, Model: {current_model_id}")
        return {"provider": "error", "message": "无法为图像分析确定AI模型或提供商。"}

    # Validate model against provider
    if current_provider not in ALL_AVAILABLE_MODELS or \
       current_model_id not in ALL_AVAILABLE_MODELS.get(current_provider, {}):
        log.error(f"Image Analysis: Model '{current_model_id}' is not valid for provider '{current_provider}'.")
        return {"provider": "error", "model_id": current_model_id, "message": f"模型 {current_model_id} 对提供商 {current_provider} 无效进行图像分析。"}


    analysis_prompt = prompt or "详细描述这张图片中的内容，并指出任何不寻常或有趣的地方。"
    log.info(f"Analyzing image using Provider: {current_provider}, Model: {current_model_id}. Prompt: '{analysis_prompt[:50]}...'")

    try:
        # 将图像字节转换为 base64 字符串，因为 chat_only 期望这个格式
        import base64 # Ensure base64 is imported
        image_base64_data = base64.b64encode(img_bytes).decode('utf-8')

        # 调用多模态的 chat_only 函数
        # 注意：对于图像分析，通常没有“历史记录”，除非您想实现基于先前分析的追问。
        # prompt 参数是文本提示，image_base64 是图像数据。
        chat_result = chat_only(
            prompt=analysis_prompt,
            history=None, # No history for a single image analysis call usually
            model_id=current_model_id,
            provider=current_provider,
            image_base64=image_base64_data
        )

        # chat_result 应该包含 'provider', 'model_id', 'message'
        if chat_result.get("provider") == "error":
            log.error(f"Image analysis via chat_only failed: {chat_result.get('message')}")
            # Return the error structure from chat_only
            return chat_result
        
        log.info(f"Image analysis successful using {chat_result.get('provider')}/{chat_result.get('model_id')}.")
        return {
            "provider": chat_result.get("provider", current_provider), # Prefer provider from chat_result
            "model_id": chat_result.get("model_id", current_model_id), # Prefer model_id from chat_result
            "message": chat_result.get("message", "图像分析未返回消息。")
        }

    except ValueError as ve: # E.g., API key missing from chat_only internal checks
        log.error(f"Configuration error during image analysis with {current_provider}/{current_model_id}: {ve}", exc_info=True)
        return {"provider": "error", "model_id": current_model_id, "message": f"配置错误: {str(ve)}"}
    except Exception as exc:
        log.exception(f"Image analysis failed. Provider: {current_provider}, Model: {current_model_id}")
        return {
            "provider": "error",
            "model_id": current_model_id,
            "message": f"图像分析出错 ({current_provider}/{current_model_id}): {str(exc)}"
        }

__all__ = ["analyze_image"]

# Example usage (for testing if run directly)
if __name__ == "__main__":
    print("测试 analyze_image 函数 (多模态)...")
    # This requires core.settings to be loadable and a .env or env vars for API keys
    # Also requires a dummy image.
    
    # Create a tiny dummy PNG image (1x1 red pixel)
    try:
        from PIL import Image as PILImage
        import io, base64
        img = PILImage.new('RGB', (1, 1), color = 'red')
        img_byte_arr = io.BytesIO()
        img.save(img_byte_arr, format='PNG')
        dummy_img_bytes = img_byte_arr.getvalue()
        
        print(f"Dummy image bytes length: {len(dummy_img_bytes)}")

        # Test with a default provider/model (relies on settings and constants)
        # result_default = analyze_image(dummy_img_bytes, prompt="What is this image?")
        # print(f"\nAnalysis (Default Provider/Model):")
        # print(f"  Provider: {result_default.get('provider')}")
        # print(f"  Model ID: {result_default.get('model_id')}")
        # print(f"  Message: {result_default.get('message')[:100]}...")


        if settings.openai_api_key:
            print(f"\n--- Testing with OpenAI (gpt-4o via analyze_image) ---")
            result_openai = analyze_image(dummy_img_bytes, provider=ModelProvider.OPENAI, model_id="gpt-4o")
            print(f"  Provider: {result_openai.get('provider')}")
            print(f"  Model ID: {result_openai.get('model_id')}")
            print(f"  Message: {result_openai.get('message')[:100]}...")

        if settings.gemini_api_key:
            print(f"\n--- Testing with Gemini (gemini-1.5-flash-latest via analyze_image) ---")
            # Ensure the model_id is one that supports vision for Gemini
            result_gemini = analyze_image(dummy_img_bytes, provider=ModelProvider.GEMINI, model_id="gemini-1.5-flash-latest")
            print(f"  Provider: {result_gemini.get('provider')}")
            print(f"  Model ID: {result_gemini.get('model_id')}")
            print(f"  Message: {result_gemini.get('message')[:100]}...")

    except ImportError:
        print("Pillow not installed, cannot run image creation for test.")
    except Exception as e:
        print(f"An error occurred during __main__ test: {e}")