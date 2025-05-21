# core/chat.py
"""
提供 chat_only 和 chat_only_stream 函数，用于根据选定的模型和提供商
调用相应的 AI API（OpenAI, Gemini 等）返回回复，并支持多轮对话历史以及可选的图像输入。
"""
from __future__ import annotations
import logging
import json
import base64
import io
from typing import Any, Dict, List, Optional, Callable
import os # 确保导入 os

import openai # Ensure openai is imported
from google import genai                # <--- 新的SDK导入方式
from google.genai import types

from google.genai import types as genai_types
from PIL import Image # For Gemini image processing
from google.genai import Client as GeminiClient
from google.genai import errors as genai_errors # 导入 SDK 的错误模块
from google.api_core import exceptions as google_api_exceptions # Google 通用 API 错误


from core.settings import settings
from core.constants import (
    ALL_AVAILABLE_MODELS,
    ModelProvider,
    get_default_model_for_provider,
)
from google.api_core import exceptions as google_api_exceptions


log = logging.getLogger(__name__)

# --- System Prompt Preparation ---
def _prepare_system_message(provider: str) -> Dict[str, Any] | None:
    """
    准备系统消息，告诉 AI 它的角色和能力。
    """
    content = """你是一个有用的AI助手。请提供准确、有帮助的信息。
如果分析图像，请详细描述图像内容，并指出任何不寻常之处。
如果需要展示数学公式，可以使用 LaTeX 语法：
- 行内公式使用 $...$ 或 \\(...\\)
- 行间公式使用 $$...$$  或 \\[...\\]
例如：爱因斯坦质能方程: $E=mc^2$
"""
    if provider == ModelProvider.OPENAI:
        return {"role": "system", "content": content}
    elif provider == ModelProvider.GEMINI:
        # Gemini 通常通过 system_instruction 参数或对话内容本身来传递系统级指令
        return None 
    return {"role": "system", "content": content}

# === OpenAI Chat Function (Multimodal) ===
# core/chat.py

# ... (确保 from PIL import Image, import io, import base64 已存在) ...
# ... (_configure_gemini_if_needed 不变) ...

# core/chat.py

# ... (其他 import 和 _prepare_system_message 不变) ...

# === OpenAI Chat Function (Multimodal - Modified for Multiple Images) ===
def _chat_openai(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None # ✨ MODIFIED: Expect a list of base64 strings
) -> str:
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key not configured.")

    http_client_with_proxy = settings.get_httpx_client()
    client = openai.OpenAI(api_key=settings.openai_api_key, http_client=http_client_with_proxy)
    
    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.OPENAI)
    if not effective_model_id: # Fallback if still not determined
        effective_model_id = "gpt-4o" 
        log.warning(f"OpenAI model_id defaulted to '{effective_model_id}' as no specific or default was found.")

    messages: List[Dict[str, Any]] = []
    system_message = _prepare_system_message(ModelProvider.OPENAI)
    if system_message:
        messages.append(system_message)

    # Process history (assuming history turns are text for simplicity here)
    # If your history can contain images, this part needs to be more complex
    # to re-format those images for the OpenAI API.
    if history:
        for turn in history:
            role = turn.get("role")
            openai_role = "assistant" if role == "model" else role # Convert "model" to "assistant"
            
            text_content = None
            # Attempt to extract text from different possible history formats
            if isinstance(turn.get("parts"), list) and turn["parts"]:
                # Standard Gemini-like history part
                part_text_items = [p.get("text") for p in turn["parts"] if isinstance(p, dict) and "text" in p]
                if part_text_items:
                    text_content = " ".join(filter(None, part_text_items))
            elif isinstance(turn.get("content"), str): # OpenAI-like history or simple text
                text_content = turn.get("content", "")
            
            if openai_role in ["user", "assistant"] and text_content:
                 messages.append({"role": openai_role, "content": text_content}) # For text-only history turns

    # --- Construct content for the current user turn with text and multiple images ---
    current_user_content_parts: List[Dict[str, Any]] = []
    if prompt: # Text part should usually come first for OpenAI multimodal
        current_user_content_parts.append({"type": "text", "text": prompt})
    
    if images_base64 and isinstance(images_base64, list):
        for img_b64_string in images_base64:
            if isinstance(img_b64_string, str) and img_b64_string.strip():
                # For OpenAI, the API expects "data:[<mediatype>];base64,<data>"
                # We'll assume JPEG for now. For production, you might want to detect MIME type
                # or have it passed from the frontend.
                image_url_for_openai = f"data:image/jpeg;base64,{img_b64_string}"
                current_user_content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": image_url_for_openai}
                })
            else:
                log.warning(f"Skipped an invalid base64 string in images_base64 list for OpenAI.")
    # --- End of multi-image construction ---

    if current_user_content_parts:
        messages.append({"role": "user", "content": current_user_content_parts})
    elif not messages and not prompt : # If only prompt was empty but images might have been processed
        log.warning("OpenAI chat called with no history and no prompt, but potentially images.")
        if not current_user_content_parts: # Check if any valid image was added
             return "请输入您的问题或提供有效的图片。"

    num_images_sent = len(images_base64) if images_base64 else 0
    log.info(f"调用 OpenAI Chat (Model: {effective_model_id}). Images sent: {num_images_sent}. Prompt length: {len(prompt)}. Total messages in request: {len(messages)}")
    
    try:
        # Ensure OPENAI_MAX_TOKENS is defined in your settings.py
        openai_max_tokens = settings.OPENAI_MAX_TOKENS if hasattr(settings, 'OPENAI_MAX_TOKENS') else 2048
        
        chat_completion = client.chat.completions.create(
            model=effective_model_id,
            messages=messages, # type: ignore # OpenAI SDK has specific typing, this general dict usually works
            max_tokens=openai_max_tokens 
        )
        response_content = chat_completion.choices[0].message.content
        log.info("OpenAI Chat 调用成功。")
        return response_content.strip() if response_content else ""
    except openai.APIError as e:
        log.error(f"OpenAI API error (Model: {effective_model_id}): {e}", exc_info=True)
        raise # Re-raise the error to be caught by the dispatcher

def _chat_openai_stream(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None # ✨ MODIFIED: Expect a list
) -> str:
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key not configured.")
    http_client_with_proxy = settings.get_httpx_client()
    client = openai.OpenAI(api_key=settings.openai_api_key, http_client=http_client_with_proxy)
    
    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.OPENAI)
    if not effective_model_id: effective_model_id = "gpt-4o"

    messages: List[Dict[str, Any]] = []
    system_message = _prepare_system_message(ModelProvider.OPENAI)
    if system_message: messages.append(system_message)
    
    # Simplified history processing for stream (assuming text-only history turns)
    if history:
        for turn in history:
            role = turn.get("role")
            openai_role = "assistant" if role == "model" else role
            text_content = None
            if isinstance(turn.get("parts"), list) and turn["parts"]:
                text_content = turn["parts"][0].get("text", "")
            elif isinstance(turn.get("content"), str):
                text_content = turn.get("content", "")
            if openai_role in ["user", "assistant"] and text_content:
                 messages.append({"role": openai_role, "content": text_content})

    # --- ✨ MODIFIED: Construct content for the current user turn with multiple images ---
    current_user_content_parts: List[Dict[str, Any]] = []
    if prompt:
        current_user_content_parts.append({"type": "text", "text": prompt})
    
    if images_base64 and isinstance(images_base64, list):
        for img_b64_string in images_base64:
            if isinstance(img_b64_string, str) and img_b64_string.strip():
                image_url_for_openai = f"data:image/jpeg;base64,{img_b64_string}" # Assume JPEG
                current_user_content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": image_url_for_openai}
                })
    # --- End of modification ---

    if current_user_content_parts:
        messages.append({"role": "user", "content": current_user_content_parts})
    elif not messages and not prompt :
        if not current_user_content_parts:
            log.warning("OpenAI stream chat called with no history, no prompt, and no valid images.")
            if stream_callback: stream_callback("[ERROR: 请输入您的问题或提供有效的图片。]")
            return "请输入您的问题或提供有效的图片。"

    num_images_sent = len(images_base64) if images_base64 else 0
    log.info(f"调用 OpenAI Chat Stream (Model: {effective_model_id}). Images sent: {num_images_sent}. Prompt length: {len(prompt)}. Msgs: {len(messages)}")
    
    try:
        openai_max_tokens_stream = settings.OPENAI_MAX_TOKENS_STREAM if hasattr(settings, 'OPENAI_MAX_TOKENS_STREAM') else 2048
        stream = client.chat.completions.create(
            model=effective_model_id,
            messages=messages, # type: ignore
            max_tokens=openai_max_tokens_stream,
            stream=True
        )
        full_response_text = ""
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                content_chunk = chunk.choices[0].delta.content
                full_response_text += content_chunk
                if stream_callback:
                    stream_callback(content_chunk)
        log.info("OpenAI Chat Stream 调用成功。")
        return full_response_text.strip()
    except openai.APIError as e:
        log.error(f"OpenAI API stream error (Model: {effective_model_id}): {e}", exc_info=True)
        if stream_callback: stream_callback(f"[ERROR: OpenAI API Error - {str(e)}]")
        raise
    except Exception as e:
        log.error(f"Unexpected error during OpenAI stream (Model: {effective_model_id}): {e}", exc_info=True)
        if stream_callback: stream_callback(f"[ERROR: Unexpected error during stream - {str(e)}]")
        raise

# === Gemini Chat Function (Multimodal) ===
# core/chat.py

# 全局变量，用于存储单例实例
_gemini_client_instance = None

def get_gemini_client() -> GeminiClient:
    global _gemini_client_instance
    if _gemini_client_instance is None:
        if not settings.gemini_api_key:
            raise ValueError("Gemini API key not configured in settings.")
        try:
            # 配置http选项，如果需要使用代理，可以在这里设置
            client_config_args = {"api_key": settings.gemini_api_key}

            # 这里我们没有指定 http_options, 如果需要设置API版本等可以添加
            # 例如：client_config_args["http_options"] = genai_types.HttpOptions(api_version='v1beta')

            # 创建Gemini客户端实例
            _gemini_client_instance = GeminiClient(**client_config_args)
            log.debug("Gemini client (google-genai SDK) created successfully.")

            # 检查代理环境变量
            http_proxy_env = os.getenv('HTTP_PROXY') or os.getenv('http_proxy')
            https_proxy_env = os.getenv('HTTPS_PROXY') or os.getenv('https_proxy')
            log.debug(f"Gemini Client - HTTP_PROXY env: {http_proxy_env}, HTTPS_PROXY env: {https_proxy_env}")
            
            if not https_proxy_env and (http_proxy_env or https_proxy_env):
                log.warning("HTTPS_PROXY environment variable is not set. Gemini SDK might not use the V2Ray proxy correctly for HTTPS traffic.")

        except Exception as e_cfg:
            log.error(f"Failed to create Gemini client (google-genai SDK): {e_cfg}", exc_info=True)
            raise ConnectionError(f"Failed to create Gemini client: {e_cfg}") from e_cfg
    return _gemini_client_instance

# --- Helper to construct Gemini contents list ---
def _prepare_gemini_contents(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    images_base64: Optional[List[str]] = None
) -> tuple[list[genai_types.Content], int]:
    gemini_request_contents: list[genai_types.Content] = []
    num_images_processed = 0

    # Process history
    if history:
        for turn in history:
            role = turn.get("role")
            if role not in ["user", "model"]:
                continue
            
            current_turn_parts_for_history: list[genai_types.PartType] = []
            parts_data = turn.get("parts")

            if isinstance(parts_data, list):
                for part_item in parts_data:
                    if isinstance(part_item, dict) and "text" in part_item and str(part_item["text"]).strip():
                        current_turn_parts_for_history.append(genai_types.Part.from_text(text=str(part_item["text"])))
                    # TODO: Handle images in history if your format supports it.
                    # Example: if "image_bytes" in part_item:
                    #   pil_img = Image.open(io.BytesIO(part_item["image_bytes"]))
                    #   current_turn_parts_for_history.append(pil_img)
            elif isinstance(turn.get("content"), str) and str(turn.get("content")).strip(): # Compatibility with OpenAI like history
                current_turn_parts_for_history.append(genai_types.Part.from_text(text=str(turn.get("content"))))
            
            if current_turn_parts_for_history:
                gemini_request_contents.append(genai_types.Content(role=role, parts=current_turn_parts_for_history))

    # Process current user prompt and images
    current_user_prompt_parts: list[genai_types.PartType] = []
    if prompt:
        current_user_prompt_parts.append(genai_types.Part.from_text(text=prompt))

    if images_base64 and isinstance(images_base64, list):
        for img_b64_string in images_base64:
            if isinstance(img_b64_string, str) and img_b64_string.strip():
                try:
                    image_bytes = base64.b64decode(img_b64_string)
                    # TODO: Future enhancement - Determine MIME type dynamically or pass from frontend.
                    # For now, defaulting to image/png for Gemini.
                    current_mime_type = "image/png"
                    log.debug(f"Gemini: Using hardcoded MIME type '{current_mime_type}' for image part. img_b64_string length: {len(img_b64_string)}")
                    image_part = genai_types.Part.from_data(data=image_bytes, mime_type=current_mime_type)
                    current_user_prompt_parts.append(image_part)
                    num_images_processed += 1
                except Exception as e_img:
                    log.error(f"Failed to decode/open image for Gemini content: {e_img}", exc_info=True)
            else:
                log.warning("Skipped an invalid base64 string in images_base64 list for Gemini.")
    
    if current_user_prompt_parts:
        gemini_request_contents.append(genai_types.Content(role="user", parts=current_user_prompt_parts))
    elif not gemini_request_contents: # No history and no current valid input
        log.warning("Gemini: No history and no valid current input (prompt/images).")
        # Caller should handle this by returning an error or appropriate message

    return gemini_request_contents, num_images_processed
    if not settings.gemini_api_key: # 假设您的settings实例叫 settings
        raise ValueError("Gemini API 密钥未在settings中配置。")

    try:
        # 根据PyPI文档，API密钥可以直接传入Client，或者设置 GOOGLE_API_KEY 环境变量
        client = genai.Client(api_key=settings.gemini_api_key)
        log.debug("Gemini client (google-genai SDK) 创建成功。")

        # 打印代理环境变量，确认它们是否被Python环境感知
        http_proxy_env = os.getenv('HTTP_PROXY') or os.getenv('http_proxy')
        https_proxy_env = os.getenv('HTTPS_PROXY') or os.getenv('https_proxy')
        log.debug(f"Gemini Client - HTTP_PROXY env: {http_proxy_env}, HTTPS_PROXY env: {https_proxy_env}")
        if not https_proxy_env and (http_proxy_env or https_proxy_env):
             log.warning("警告：HTTPS_PROXY 环境变量未设置，但HTTP_PROXY可能已设置。Gemini SDK 可能无法正确通过V2Ray代理处理HTTPS流量。")
        return client
    except Exception as e_cfg:
        log.error(f"创建 Gemini client (google-genai SDK) 失败: {e_cfg}", exc_info=True)
        raise ConnectionError(f"创建 Gemini client 失败: {e_cfg}") from e_cfg

# core/chat.py

# ... (确保 from PIL import Image, import io, import base64 已存在) ...
# ... (_configure_gemini_if_needed 不变) ...

def _chat_gemini(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None
) -> str:
    client = get_gemini_client()

    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    if not effective_model_id:
        effective_model_id = "gemini-1.5-flash-latest"
        log.warning(f"Gemini non-stream model defaulted to absolute fallback: {effective_model_id}")

    if "gemini-" in effective_model_id and not effective_model_id.startswith("models/") and not effective_model_id.endswith(("-001", "-preview")):
        log.info(f"Prepending 'models/' to Gemini non-stream model ID: {effective_model_id}")
        effective_model_id = f"models/{effective_model_id}"

    gemini_request_contents, num_images_processed = _prepare_gemini_contents(prompt, history, images_base64)

    if not gemini_request_contents:
        log.warning("Gemini non-stream: No content to send after preparation.")
        return "请求内容为空，请输入问题或提供有效图片。"

    system_instruction_text = None
    raw_system_message = _prepare_system_message(ModelProvider.GEMINI)
    if raw_system_message and isinstance(raw_system_message, dict) and "content" in raw_system_message:
         system_instruction_text = raw_system_message["content"]

    generation_config_dict = {
        "max_output_tokens": settings.GEMINI_MAX_TOKENS,
        "temperature": settings.GEMINI_TEMPERATURE if hasattr(settings, 'GEMINI_TEMPERATURE') else 0.7
    }
    gen_config_args = {**generation_config_dict}
    if system_instruction_text:
        gen_config_args["system_instruction"] = system_instruction_text
    generation_config_payload = genai_types.GenerateContentConfig(**gen_config_args)

    log.info(f"调用 Gemini Chat (google-genai SDK) (Model: {effective_model_id}). Images: {num_images_processed}. Content blocks: {len(gemini_request_contents)}")

    try:
        response = client.models.generate_content(
            model=effective_model_id,
            contents=gemini_request_contents,
            
            # request_options for timeout if applicable
        )

        response_text = ""
        if hasattr(response, 'text') and response.text:
            response_text = response.text
        elif hasattr(response, 'parts') and response.parts:
            for part in response.parts:
                if hasattr(part, 'text') and part.text:
                    response_text += part.text
        
        if not response_text:
            prompt_feedback = getattr(response, 'prompt_feedback', None)
            if prompt_feedback and getattr(prompt_feedback, 'block_reason', None):
                reason = prompt_feedback.block_reason
                reason_name = getattr(reason, 'name', str(reason))
                log.warning(f"Gemini response blocked. Reason: {reason_name}. Feedback: {prompt_feedback}")
                return f"(内容因 {reason_name} 被阻止)"
            
            candidates = getattr(response, 'candidates', [])
            if candidates:
                candidate = candidates[0]
                finish_reason_enum = getattr(candidate, 'finish_reason', None)
                # Check against specific enum values from genai_types.Candidate.FinishReason
                if finish_reason_enum and \
                   finish_reason_enum != genai_types.Candidate.FinishReason.STOP and \
                   finish_reason_enum != genai_types.Candidate.FinishReason.UNSPECIFIED:
                    reason_name = getattr(finish_reason_enum, 'name', str(finish_reason_enum))
                    safety_ratings_str = str(getattr(candidate, 'safety_ratings', "N/A"))
                    log.warning(f"Gemini generation finished with non-STOP reason: {reason_name}. Safety: {safety_ratings_str}")
                    if finish_reason_enum == genai_types.Candidate.FinishReason.SAFETY:
                         return "(内容因安全原因被终止或过滤)"
                    return f"(AI回复因 {reason_name} 提前结束)"

        log.info("Gemini Chat (google-genai SDK) 调用成功。")
        return response_text.strip() if response_text else "(AI未能生成有效文本回复)"

    except Exception as e:
        log.error(f"Gemini API non-stream request blocked (Model {effective_model_id}): {e}", exc_info=True)
        return "(您的请求因包含不当内容被阻止)"
    except genai_types.StopCandidateException as e:
        log.error(f"Gemini API non-stream generation stopped (Model {effective_model_id}): {e}", exc_info=True)
        return f"(AI回复提前终止: {e})"
    except google_api_exceptions.GoogleAPIError as e:
        log.error(f"Gemini API non-stream error (Model {effective_model_id}): {e}", exc_info=True)
        return f"Gemini API 错误: {str(e)[:200]}"
    except Exception as e:
        log.error(f"调用Gemini API非流式时发生意外错误 (Model {effective_model_id}): {e}", exc_info=True)
        raise

# def _chat_gemini_stream(
#     prompt: str,
#     history: Optional[List[Dict[str, Any]]] = None,
#     stream_callback: Optional[Callable[[str], None]] = None,
#     model_id: Optional[str] = None,
#     images_base64: Optional[List[str]] = None
# ) -> str:
#     client = get_gemini_client()

#     effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
#     if not effective_model_id: # Should have a default from constants
#         effective_model_id = "gemini-1.5-flash-latest" # Absolute fallback
#         log.warning(f"Gemini stream model defaulted to absolute fallback: {effective_model_id}")

#     # Model name formatting for the new SDK (e.g., 'models/gemini-1.5-flash-latest')
#     # The PyPI examples show 'gemini-2.0-flash-001' working directly.
#     # However, for models like 'gemini-1.5-pro', the 'models/' prefix is often needed.
#     # Let's be cautious and add 'models/' if it's a common pattern and not a specific versioned ID like 'xxx-001'.
#     if "gemini-" in effective_model_id and not effective_model_id.startswith("models/") and not effective_model_id.endswith(("-001", "-preview")):
#         log.info(f"Prepending 'models/' to Gemini stream model ID: {effective_model_id}")
#         effective_model_id = f"models/{effective_model_id}"

#     gemini_request_contents, num_images_processed = _prepare_gemini_contents(prompt, history, images_base64)

#     if not gemini_request_contents:
#         log.warning("Gemini stream: No content to send after preparation.")
#         if stream_callback: stream_callback("[错误: 请求内容为空，请输入问题或提供有效图片。]")
#         return "请求内容为空，请输入问题或提供有效图片。"

#     # --- Generation Config ---
#     # System prompt for Gemini is part of GenerateContentConfig
#     system_instruction_text = None
#     raw_system_message = _prepare_system_message(ModelProvider.GEMINI) # This returns None currently
#     if raw_system_message and isinstance(raw_system_message, dict) and "content" in raw_system_message:
#          system_instruction_text = raw_system_message["content"]

#     generation_config_dict = {
#         "max_output_tokens": settings.GEMINI_MAX_TOKENS_STREAM,
#         "temperature": settings.GEMINI_TEMPERATURE_STREAM if hasattr(settings, 'GEMINI_TEMPERATURE_STREAM') else 0.7
#         # Add other parameters like top_k, top_p if needed
#     }
#     # PyPI docs: config=types.GenerateContentConfig(system_instruction='...', ...)
#     # So, we build the GenerateContentConfig object
#     gen_config_args = {**generation_config_dict}
#     if system_instruction_text:
#         gen_config_args["system_instruction"] = system_instruction_text

#     generation_config_payload = genai_types.GenerateContentConfig(**gen_config_args)

#     log.debug(f"Gemini Stream Request Contents: {gemini_request_contents}")
#     log.info(f"调用 Gemini Chat Stream (google-genai SDK) (Model: {effective_model_id}). Images: {num_images_processed}. Content blocks: {len(gemini_request_contents)}")

#     try:
#         response_stream = client.models.generate_content_stream(
#             model=effective_model_id,
#             contents=gemini_request_contents,
#             config=types.GenerateContentConfig(  # 使用 config 参数
#             max_output_tokens=8192,  # 根据需要调整输出最大令牌
#             temperature=0.7,  # 调整温度
#             )
#             # request_options in client.models.generate_content for timeout is not explicitly shown in PyPI for v1.15.0
#             # Timeout might be managed at the client level (genai.Client(http_options=...)) or via default httpx timeouts
#         )
#         log.debug(f"Gemini Stream Response: {response_stream}")

#         # accumulated_response_text = ""
#         # for chunk in response_stream:  # 迭代流响应
#         #     if hasattr(chunk, 'text') and chunk.text:
#         #         accumulated_response_text += chunk.text
#         #         print(f"Received chunk: {chunk.text}")  # 打印流式的每一部分
#         #     elif hasattr(chunk, 'parts') and chunk.parts:
#         #         for part in chunk.parts:
#         #             if hasattr(part, 'text') and part.text:
#         #                 accumulated_response_text += part.text

#         #     # 如果有其他处理需求，可以加入额外的判断，如是否触发阻止反馈等
#         #     if hasattr(chunk, 'prompt_feedback') and chunk.prompt_feedback:
#         #         block_reason = getattr(chunk.prompt_feedback, 'block_reason', None)
#         #         if block_reason:
#         #             reason_name = getattr(block_reason, 'name', str(block_reason))
#         #             log.warning(f"Gemini stream: Prompt blocked. Reason: {reason_name}. Feedback: {chunk.prompt_feedback}")
#         #             return accumulated_response_text.strip() or f"(内容因 {reason_name} 被阻止)"
#         # print(f"Final generated text: {accumulated_response_text}")  # 打印最终的生成文本
#         # log.info(f"Gemini Stream completed with {len(accumulated_response_text)} characters.")
#         # return accumulated_response_text.strip() 

#     # except Exception as e:
#     #     log.error(f"Error during Gemini stream: {e}", exc_info=True)
#     #     return f"Error: {str(e)}"
        
#         accumulated_response_text = ""
#         chunk_count = 0
#         log.debug(f"[Gemini Stream {effective_model_id}] Stream object obtained. Starting iteration...")

#         for chunk in response_stream:
#             chunk_count += 1
#             current_chunk_text = ""
            
#             if hasattr(chunk, 'text') and chunk.text: # Simplest way to get text if available
#                 current_chunk_text = chunk.text
#             elif hasattr(chunk, 'parts') and chunk.parts:
#                 for part in chunk.parts:
#                     if hasattr(part, 'text') and part.text:
#                          current_chunk_text += part.text
            
#             # Safety/Blocking checks (on each chunk as it might terminate the stream)
#             if hasattr(chunk, 'prompt_feedback') and chunk.prompt_feedback:
#                 block_reason = getattr(chunk.prompt_feedback, 'block_reason', None)
#                 if block_reason: # block_reason is an enum like BlockReason.SAFETY
#                     reason_name = getattr(block_reason, 'name', str(block_reason)) # Get enum name
#                     log.warning(f"Gemini stream: Prompt blocked after {chunk_count} chunks. Reason: {reason_name}. Feedback: {chunk.prompt_feedback}")
#                     if stream_callback: stream_callback(f"[内容因 {reason_name} 被阻止]")
#                     # Return what has been accumulated so far, or the block message
#                     return accumulated_response_text.strip() or f"(内容因 {reason_name} 被阻止)"


#             if hasattr(chunk, 'candidates') and chunk.candidates:
#                 candidate = chunk.candidates[0]
#                 finish_reason_enum = getattr(candidate, 'finish_reason', None)
#                 if finish_reason_enum: # This is Candidate.FinishReason enum
#                     # log.debug(f"[Gemini Stream Debug] Chunk {chunk_count} - Candidate Finish Reason: {finish_reason_enum.name if hasattr(finish_reason_enum, 'name') else finish_reason_enum}")
#                     if finish_reason_enum == genai_types.Candidate.FinishReason.SAFETY:
#                         safety_ratings_str = str(getattr(candidate, 'safety_ratings', "N/A"))
#                         log.warning(f"Gemini stream: Safety stop indicated in chunk {chunk_count}. Ratings: {safety_ratings_str}")
#                         if stream_callback: stream_callback("[内容因安全原因被终止或过滤]")
#                         return accumulated_response_text.strip() or "(内容因安全原因被终止或过滤)"
#                     # Other finish reasons like MAX_TOKENS might also appear on the last chunk.
#                     # If it's not STOP or UNSPECIFIED, and we got text, we usually continue accumulating.
#                     # The loop will break naturally if the stream ends.
            
#             if current_chunk_text:
#                 accumulated_response_text += current_chunk_text
#                 if stream_callback:
#                     try:
#                         stream_callback(current_chunk_text)
#                     except Exception as cb_exc:
#                         log.error(f"Stream callback error on chunk {chunk_count}: {cb_exc}", exc_info=True)
#             # else:
#                 # log.debug(f"[Gemini Stream {effective_model_id}] Chunk {chunk_count} had no processable text directly on .text or .parts[0].text.")

#         log.info(f"Gemini Chat Stream (google-genai SDK) iteration finished. Total chunks: {chunk_count}. Full text length: {len(accumulated_response_text)}")
        
#         # After the loop, one final check on the response_stream object itself, if the SDK populates final feedback there
#         final_prompt_feedback = getattr(response_stream, 'prompt_feedback', None) # This might not exist on the stream iterator directly after consumption
#         if final_prompt_feedback and getattr(final_prompt_feedback, 'block_reason', None):
#             reason = final_prompt_feedback.block_reason
#             log.warning(f"Gemini stream: Final prompt feedback indicates blocking. Reason: {getattr(reason, 'name', str(reason))}")
#             return accumulated_response_text.strip() or f"(内容因 {getattr(reason, 'name', str(reason))} 被阻止)"

#         if not accumulated_response_text.strip() and chunk_count == 0:
#             log.warning("Gemini stream returned no data and no explicit error or block reason identified from chunks.")
#             return "(AI未能生成有效文本回复或流为空)"
        
         

#         return accumulated_response_text.strip()

#     # except Exception as e: # Specific exception from the new SDK
#     #     log.error(f"Gemini API stream request blocked (Exception) (Model {effective_model_id}): {e}", exc_info=True)
#     #     if stream_callback: stream_callback("[错误: 您的请求因包含不当内容被阻止]")
#     #     return "(您的请求因包含不当内容被阻止)"
#     except genai_types.StopCandidateException as e: # If generation stops for non-standard reasons
#         log.error(f"Gemini API stream generation stopped unexpectedly (StopCandidateException) (Model {effective_model_id}): {e}", exc_info=True)
#         # This exception might contain more details about why it stopped.
#         # For now, a generic message.
#         error_message_detail = str(e) # Or inspect e.finish_reason if available
#         if stream_callback: stream_callback(f"[错误: AI回复提前终止 - {error_message_detail}]")
#         return f"(AI回复提前终止: {error_message_detail})"
#     except google_api_exceptions.GoogleAPIError as e: # General Google API errors
#         log.error(f"Gemini API stream error (GoogleAPIError) (Model {effective_model_id}): {e}", exc_info=True)
#         if stream_callback: stream_callback(f"[错误: Gemini API Stream Error - {str(e)}]")
#         # It's better to raise a more specific or caught exception if this happens
#         raise # Or return a user-friendly error message
#     except Exception as e:
#         log.error(f"调用Gemini API流时发生意外错误 (Model {effective_model_id}): {e}", exc_info=True)
#         if stream_callback: stream_callback(f"[错误: Gemini流意外错误 - {str(e)}]")
#         raise # Re-throw for the main dispatcher to catch



def _chat_gemini_stream(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None
) -> str:
    client = get_gemini_client()
    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    # ... (模型名称处理和内容准备逻辑 _prepare_gemini_contents 不变) ...
    gemini_request_contents, num_images_processed = _prepare_gemini_contents(prompt, history, images_base64)

    if not gemini_request_contents:
        # ... (处理空内容) ...
        if stream_callback: stream_callback("[错误: 请求内容为空。]")
        return "请求内容为空。"

    generation_config_payload = genai_types.GenerateContentConfig(
        # max_output_tokens 和 temperature 来自您的 settings
        max_output_tokens=settings.GEMINI_MAX_TOKENS_STREAM, 
        temperature=settings.GEMINI_TEMPERATURE_STREAM if hasattr(settings, 'GEMINI_TEMPERATURE_STREAM') else 0.7
        # 如果有 system_instruction，也应在此处设置
    )
    # system_instruction_text = _prepare_system_message(ModelProvider.GEMINI) # 这在您代码中返回 None
    # if system_instruction_text:
    #     generation_config_payload.system_instruction = system_instruction_text # 动态添加

    log.info(f"调用 Gemini Chat Stream (Model: {effective_model_id}). Images: {num_images_processed}. Contents len: {len(gemini_request_contents)}")

    accumulated_response_text = ""
    try:
        response_stream = client.models.generate_content_stream(
            model=effective_model_id,
            contents=gemini_request_contents,
            config=generation_config_payload, # 使用构建好的 config 对象
            # request_options={'timeout': 600} # 如果需要设置超时
        )

        for stream_chunk in response_stream:
            current_chunk_text = ""
        
            # Check if the chunk contains 'text' or any relevant field
            if hasattr(stream_chunk, 'text') and stream_chunk.text:
                current_chunk_text = stream_chunk.text
            elif hasattr(stream_chunk, 'parts'):  # Check if 'parts' exists
                for part in stream_chunk.parts:
                    if hasattr(part, 'text') and part.text:
                        current_chunk_text += part.text

            if current_chunk_text:
                accumulated_response_text += current_chunk_text
                if stream_callback:
                    stream_callback(current_chunk_text)
        
            # Check for block reason and handle it
            if hasattr(stream_chunk, 'prompt_feedback') and stream_chunk.prompt_feedback:
                block_reason = getattr(stream_chunk.prompt_feedback, 'block_reason', None)
                if block_reason:
                    reason_name = getattr(block_reason, 'name', 'Unknown reason')
                    log.warning(f"Gemini stream: Prompt blocked due to {reason_name}.")
                    return accumulated_response_text.strip() or f"[Content blocked due to {reason_name}]"

            
            # 检查 candidates 中的 finish_reason (通常在流的末尾或中断时出现)
            # 注意：SDK 的具体行为可能是在流结束时才通过 response_stream.candidates 提供最终的 finish_reason，
            # 或者在每次迭代的 chunk 中都提供。文档对此不总是非常明确，需要测试。
            # 如果在每个 chunk 都有 candidates，可以在这里检查。
            # if stream_chunk.candidates:
            #     for candidate in stream_chunk.candidates:
            #         if candidate.finish_reason:
            #             finish_reason_name = candidate.finish_reason.name
            #             if finish_reason_name != "STOP" and finish_reason_name != "UNSPECIFIED":
            #                 log.warning(f"Gemini stream: Candidate finished with reason: {finish_reason_name}")
            #                 if finish_reason_name == "SAFETY":
            #                     error_msg = "[内容因安全原因被终止或过滤]"
            #                     if stream_callback: stream_callback(error_msg)
            #                     return accumulated_response_text.strip() or error_msg
            #                 # 可以根据其他 finish_reason 做不同处理

        # 流正常结束后，可以检查整个响应对象的最终状态 (如果 SDK 设计如此)
        # resolved_response = response_stream.resolve() # 有些 SDK 有这样的方法获取完整响应对象
        # if resolved_response and resolved_response.prompt_feedback and resolved_response.prompt_feedback.block_reason:
        #     # ... 处理最终的阻塞信息 ...

        log.info(f"Gemini Chat Stream 迭代完成。累积文本长度: {len(accumulated_response_text)}")
        return accumulated_response_text.strip()

    # except genai_errors.BlockedPromptException as e: # 明确捕获请求被阻止的异常
    #     log.error(f"Gemini API stream: Prompt was blocked. (Model {effective_model_id}): {e}", exc_info=True)
    #     error_msg = f"[请求内容被阻止: {e.args[0] if e.args else '原因未知'}]"
    #     if stream_callback: stream_callback(error_msg)
    #     return error_msg
    # except genai_errors.StopCandidateException as e: # 尝试捕获这个（如果文档确认它存在于你的版本）
    #     log.error(f"Gemini API stream: Generation stopped by StopCandidateException. (Model {effective_model_id}): {e}", exc_info=True)
    #     error_msg = f"[AI回复终止于StopCandidate: {e.args[0] if e.args else '原因未知'}]"
    #     if stream_callback: stream_callback(error_msg)
    #     return accumulated_response_text.strip() or error_msg # 可能已经累积了一部分
    except genai_errors.APIError as e: # 这是 SDK 推荐捕获的通用 API 错误
        log.error(f"Gemini API stream error (APIError) (Model {effective_model_id}): {e}", exc_info=True)
        error_msg = f"[Gemini API 错误: {e.message or str(e)}]"
        if stream_callback: stream_callback(error_msg)
        return error_msg # 或者根据情况返回 accumulated_response_text
    except google_api_exceptions.GoogleAPIError as e: # 更底层的 Google API 错误
        log.error(f"Google API core error during Gemini stream (Model {effective_model_id}): {e}", exc_info=True)
        error_msg = f"[Google API核心错误: {str(e)}]"
        if stream_callback: stream_callback(error_msg)
        return error_msg
    except Exception as e:
        log.error(f"调用Gemini API流时发生未知错误 (Model {effective_model_id}): {e}", exc_info=True)
        error_msg = f"[错误: Gemini流处理中发生未知错误 - {str(e)}]"
        if stream_callback: stream_callback(error_msg)
        return error_msg


# === Main Chat Dispatcher Functions (Multimodal) ===
# (chat_only 和 chat_only_stream 函数保持与我上次提供的版本一致，它们调用上面修改过的内部函数)
# core/chat.py

# === Main Chat Dispatcher Functions (Multimodal - Modified for Multiple Images) ===
def chat_only(
    prompt: str, history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None, provider: Optional[str] = None,
    # ✨ MODIFIED: Expect 'images_base64' (plural) as a list
    images_base64: Optional[List[str]] = None
) -> Dict[str, Any]:
    current_provider = provider
    current_model_id = model_id
    
    # --- Provider and Model ID Determination ---
    if not current_provider:
        if current_model_id: # Try to infer provider from model_id
            for p_name, models_dict in ALL_AVAILABLE_MODELS.items():
                if current_model_id in models_dict: 
                    current_provider = p_name
                    log.debug(f"Inferred provider '{current_provider}' from model_id '{current_model_id}'.")
                    break
        if not current_provider: # Fallback to default chat provider or a general default
            current_provider = settings.DEFAULT_CHAT_PROVIDER or ModelProvider.OPENAI 
            log.warning(f"Provider not specified, falling back to DEFAULT_CHAT_PROVIDER or OpenAI: '{current_provider}'.")
    
    if not current_model_id: # If model_id is still not set, get default for the determined/fallback provider
        current_model_id = get_default_model_for_provider(current_provider) # type: ignore
        log.warning(f"Model_id not specified for provider '{current_provider}', using default: '{current_model_id}'.")
    
    # Final validation
    if not current_model_id or not current_provider or \
       current_provider not in ALL_AVAILABLE_MODELS or \
       current_model_id not in ALL_AVAILABLE_MODELS.get(current_provider, {}): # type: ignore
        err_msg = f"无法为聊天确定有效的模型或提供商。Provider: {current_provider}, Model: {current_model_id}"
        log.error(err_msg)
        return {"provider": "error", "model_id": current_model_id, "message": err_msg}

    num_images = len(images_base64) if images_base64 else 0
    log.info(f"Dispatching chat. Provider: {current_provider}, Model: {current_model_id}, Images: {num_images}, Prompt: '{prompt[:30]}...'")
    
    try:
        msg_text = ""
        if current_provider == ModelProvider.OPENAI:
            if not settings.openai_api_key: raise ValueError("OpenAI API Key missing.")
            # ✨ MODIFIED: Pass the images_base64 list
            msg_text = _chat_openai(prompt, history, current_model_id, images_base64)
        elif current_provider == ModelProvider.GEMINI:
            if not settings.gemini_api_key: raise ValueError("Gemini API Key missing.")
            # ✨ MODIFIED: Pass the images_base64 list
            msg_text = _chat_gemini(prompt, history, current_model_id, images_base64)
        # Add other providers here if any (e.g., Claude, Grok)
        # elif current_provider == ModelProvider.CLAUDE:
        #     if not settings.claude_api_key: raise ValueError("Claude API Key missing.")
        #     msg_text = _chat_claude(prompt, history, current_model_id, images_base64)
        else:
            log.warning(f"Provider '{current_provider}' not supported or API key missing for non-streaming chat.")
            return {"provider": "error", "model_id": current_model_id, "message": f"聊天功能未启用或提供商 '{current_provider}' 不支持。"}
        
        return {"provider": current_provider, "model_id": current_model_id, "message": msg_text}
    except ValueError as ve: # Catch config errors like missing API keys
        log.error(f"Configuration error for chat with {current_provider}/{current_model_id}: {ve}")
        return {"provider": "error", "model_id": current_model_id, "message": f"配置错误: {str(ve)}"}
    except Exception as exc: # Catch other API or unexpected errors
        log.exception(f"Chat failed. Provider: {current_provider}, Model: {current_model_id}")
        return {"provider": "error", "model_id": current_model_id, "message": f"与 AI ({current_provider}/{current_model_id}) 通信时出错: {str(exc)}"}

def chat_only_stream(
    prompt: str, history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None, provider: Optional[str] = None,
    # ✨ MODIFIED: Expect 'images_base64' (plural) as a list
    images_base64: Optional[List[str]] = None
) -> Dict[str, Any]:
    current_provider = provider
    current_model_id = model_id
    # ... (Provider and Model ID Determination logic - same as in chat_only) ...
    if not current_provider:
        if current_model_id:
            for p_name, models_dict in ALL_AVAILABLE_MODELS.items():
                if current_model_id in models_dict: current_provider = p_name; break
        if not current_provider: current_provider = settings.DEFAULT_CHAT_PROVIDER or ModelProvider.OPENAI
    if not current_model_id:
        current_model_id = get_default_model_for_provider(current_provider) # type: ignore
    if not current_model_id or not current_provider or \
       current_provider not in ALL_AVAILABLE_MODELS or \
       current_model_id not in ALL_AVAILABLE_MODELS.get(current_provider, {}): # type: ignore
        err_msg = f"无法为流式聊天确定有效的模型或提供商。Provider: {current_provider}, Model: {current_model_id}"
        log.error(err_msg)
        if stream_callback: stream_callback(f"[ERROR: {err_msg}]")
        return {"provider": "error", "model_id": current_model_id, "message": err_msg}

    num_images = len(images_base64) if images_base64 else 0
    log.info(f"Dispatching STREAM chat. Provider: {current_provider}, Model: {current_model_id}, Images: {num_images}, Prompt: '{prompt[:30]}...'")
    
    try:
        full_msg_text = ""
        if current_provider == ModelProvider.OPENAI:
            if not settings.openai_api_key: raise ValueError("OpenAI API Key missing.")
            # ✨ MODIFIED: Pass the images_base64 list
            full_msg_text = _chat_openai_stream(prompt, history, stream_callback, current_model_id, images_base64)
            print(f"Test generated text: {full_msg_text}") 
        elif current_provider == ModelProvider.GEMINI:
            if not settings.gemini_api_key: raise ValueError("Gemini API Key missing.")
            # ✨ MODIFIED: Pass the images_base64 list
            full_msg_text = _chat_gemini_stream(prompt, history, stream_callback, current_model_id, images_base64)
            print(f"Test generated text: {full_msg_text}") 
        # Add other providers here for streaming if any
        # elif current_provider == ModelProvider.CLAUDE:
        # ...
        else:
            log.warning(f"Stream: Provider '{current_provider}' not supported or API key missing.")
            if stream_callback: stream_callback(f"[ERROR: 流式聊天功能未启用或提供商 '{current_provider}' 不支持。]")
            return {"provider": "error", "model_id": current_model_id, "message": "流式聊天功能未启用或提供商不支持。"}
        
        return {"provider": current_provider, "model_id": current_model_id, "message": full_msg_text}
    except ValueError as ve:
        log.error(f"Configuration error for stream chat with {current_provider}/{current_model_id}: {ve}")
        if stream_callback: stream_callback(f"[ERROR: 配置错误 - {str(ve)}]")
        return {"provider": "error", "model_id": current_model_id, "message": f"配置错误: {str(ve)}"}
    except Exception as exc:
        log.exception(f"Stream chat failed. Provider: {current_provider}, Model: {current_model_id}")
        if stream_callback: stream_callback(f"[ERROR: 与 AI ({current_provider}/{current_model_id}) 流式通信时出错 - {str(exc)}]")
        return {"provider": "error", "model_id": current_model_id, "message": f"与 AI ({current_provider}/{current_model_id}) 流式通信时出错: {str(exc)}"}

__all__ = ["chat_only", "chat_only_stream"]

if __name__ == '__main__':
    print("测试 chat_only 函数 (多模态)...")
    dummy_image_b64_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    test_history_multi = [
        {'role': 'user', 'parts': [{'text': '你好，这是一张图片。'}]},
        {'role': 'model', 'parts': [{'text': '好的，请描述您希望我做什么。'}]}
    ]
    if settings.openai_api_key:
        print("\n--- 测试 OpenAI (多模态) ---")
        result_openai_txt = chat_only("你好，OpenAI吗?", history=None, provider=ModelProvider.OPENAI, model_id="gpt-4o")
        print(f"OpenAI Text Only: {result_openai_txt}")
    if settings.gemini_api_key:
        print("\n--- 测试 Gemini (多模态) ---")
        result_gemini_txt = chat_only_stream("河海大学", history=None, provider=ModelProvider.GEMINI, model_id="gemini-2.5-flash-preview-04-17") # 使用最新的 flash
        print(f"Gemini Text Only: {result_gemini_txt}")
    if settings.gemini_api_key:
        print("\n--- 测试 Gemini ---")
        result_gemini_txt = chat_only("你好，Gemini吗?", history=None, provider=ModelProvider.GEMINI, model_id="gemini-2.5-flash-preview-04-17")
        print(f"Gemini Text Only: {result_gemini_txt}")
