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
import google.generativeai as genai
from PIL import Image # For Gemini image processing

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
def _configure_gemini_if_needed():
    """Configures Gemini API key. Relies on env vars for proxies."""
    # This function assumes genai.configure might be called multiple times
    # but ideally it's called once at app startup.
    # This check is a bit heuristic and might not be perfectly robust
    # for all states of the genai library.
    configured_api_key = None
    try:
        # Attempt to get a model to see if it's configured; this is indirect
        # A more direct way to check if `configure` has been called with a key
        # is not readily available in the public API of google-generativeai.
        # We assume if we can get a model without error, it's likely configured.
        # This is not ideal, but avoids the 'अभीClient' error.
        genai.get_model("gemini-pro") # Try a common model
        # If the above doesn't raise an error about API key, it might be configured.
        # However, there's no direct way to get the currently configured key.
        # So, we will re-configure if settings.gemini_api_key is present,
        # as genai.configure can be called multiple times.
    except Exception: # pylint: disable=broad-except
        # Likely not configured or API key issue
        pass # We will configure below if key is present in settings

    if settings.gemini_api_key:
        try:
            genai.configure(api_key=settings.gemini_api_key) # Removed transport and client_options
            log.debug("Gemini API configured/re-configured with API key from settings.")
            # http_proxy_env = os.getenv('HTTP_PROXY') or os.getenv('http_proxy')
            # https_proxy_env = os.getenv('HTTPS_PROXY') or os.getenv('https_proxy')
            # log.debug(f"Gemini proxy check - HTTP_PROXY env: {http_proxy_env}, HTTPS_PROXY env: {https_proxy_env}")
        except Exception as e_cfg:
            log.error(f"Failed to configure Gemini API: {e_cfg}", exc_info=True)
            raise ConnectionError(f"Failed to configure Gemini API: {e_cfg}") from e_cfg
    else:
        raise ValueError("Gemini API key not found in settings for configuration.")


# core/chat.py

# ... (确保 from PIL import Image, import io, import base64 已存在) ...
# ... (_configure_gemini_if_needed 不变) ...

def _chat_gemini(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None # ✨ MODIFIED: Expect a list
) -> str:
    _configure_gemini_if_needed()

    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    # Ensure a vision model is used if images are present
    if images_base64 and ("vision" not in effective_model_id and "flash" not in effective_model_id and not effective_model_id.startswith("gemini-1.5-pro")): # Adjusted check for 1.5 pro
        vision_default = get_default_model_for_provider(ModelProvider.GEMINI, vision_capable=True)
        log.warning(f"Gemini model '{effective_model_id}' might not support images or is not preferred for vision. Attempting to switch.")
        if vision_default:
            effective_model_id = vision_default
            log.info(f"Switched to vision-capable Gemini model: '{effective_model_id}'.")
        else: # Fallback if no vision default found from constants
            effective_model_id = "gemini-1.5-flash-latest" # A known good vision model
            log.warning(f"No specific vision default found, defaulted to '{effective_model_id}'.")
    if not effective_model_id: # Should have been set by now
        effective_model_id = "gemini-1.5-flash-latest" # Final fallback

    gemini_contents: List[Dict[str, Any]] = [] # For Gemini, this should be List[genai.types.ContentDict] or similar
                                             # but List[Dict] is used for broader compatibility before conversion
    
    # Process history (assuming text-only history for simplicity)
    if history:
        for turn in history:
            role = turn.get("role")
            if role not in ["user", "model"]: continue
            
            parts_data = turn.get("parts")
            gemini_history_parts = []
            if isinstance(parts_data, list):
                for part_item in parts_data:
                    if isinstance(part_item, dict) and "text" in part_item and str(part_item["text"]).strip():
                        gemini_history_parts.append(str(part_item["text"])) # Gemini parts can be just strings for text
            elif isinstance(parts_data, str) and parts_data.strip():
                gemini_history_parts.append(parts_data)
            elif isinstance(turn.get("content"), str) and str(turn.get("content")).strip(): # OpenAI history format
                gemini_history_parts.append(str(turn.get("content")))
            
            if gemini_history_parts:
                 gemini_contents.append({'role': role, 'parts': gemini_history_parts})


    # --- ✨ MODIFIED: Construct parts for the current user turn with multiple images ---
    current_user_parts_for_gemini: List[Any] = [] # Gemini parts can be str or PIL.Image
    if prompt:
        current_user_parts_for_gemini.append(prompt) # Text part
    
    num_images_processed_for_gemini = 0
    if images_base64 and isinstance(images_base64, list):
        for img_b64_string in images_base64:
            if isinstance(img_b64_string, str) and img_b64_string.strip():
                try:
                    image_bytes = base64.b64decode(img_b64_string)
                    pil_image = Image.open(io.BytesIO(image_bytes))
                    # Gemini API can take PIL.Image objects directly in the 'parts' list
                    current_user_parts_for_gemini.append(pil_image)
                    num_images_processed_for_gemini += 1
                except Exception as e_img:
                    log.error(f"Failed to decode/open image for Gemini: {e_img}", exc_info=True)
                    # current_user_parts_for_gemini.append("(Error: Could not process one of the images)") # Optional: add error text part
            else:
                log.warning(f"Skipped an invalid base64 string in images_base64 list for Gemini.")
    # --- End of multi-image construction ---
    
    if current_user_parts_for_gemini:
        gemini_contents.append({'role': 'user', 'parts': current_user_parts_for_gemini})
    elif not gemini_contents:
         log.warning("Gemini chat called with no history, no prompt, and no valid images.")
         return "请输入您的问题或提供有效的图片。"

    if not gemini_contents: # Final check
        log.warning("Gemini chat: No valid content to send after processing all inputs.")
        return "无法处理请求，对话内容为空或媒体处理失败。"

    model_params = {"model_name": effective_model_id}
    # system_instruction logic can be added here if needed for Gemini Pro models
    # system_instruction_content = _prepare_system_message(ModelProvider.GEMINI)
    # if system_instruction_content: # This is None in current _prepare_system_message
    #    model_params["system_instruction"] = system_instruction_content 
    
    model = genai.GenerativeModel(**model_params)
    
    gemini_max_tokens = settings.GEMINI_MAX_TOKENS if hasattr(settings, 'GEMINI_MAX_TOKENS') else 8192 # Default for Gemini 1.5 Flash
    gemini_temperature = settings.GEMINI_TEMPERATURE if hasattr(settings, 'GEMINI_TEMPERATURE') else 0.7

    generation_config = genai.types.GenerationConfig(
        max_output_tokens=gemini_max_tokens,
        temperature=gemini_temperature
        # top_p, top_k can also be added here from settings if desired
    )

    log.info(f"调用 Gemini Chat (Model: {effective_model_id}). Images sent: {num_images_processed_for_gemini}. Prompt length: {len(prompt)}. Turns: {len(gemini_contents)}")
    try:
        response = model.generate_content(
            contents=gemini_contents, # type: ignore # genai expects specific content types
            generation_config=generation_config,
            request_options={"timeout": settings.GEMINI_REQUEST_TIMEOUT if hasattr(settings, 'GEMINI_REQUEST_TIMEOUT') else 120}
        )
        # ... (rest of response processing and error handling from your _chat_gemini) ...
        response_text = ""
        if hasattr(response, 'parts') and response.parts:
            for part in response.parts:
                if hasattr(part, 'text'): response_text += part.text
        elif hasattr(response, 'text') and response.text:
            response_text = response.text
        
        if not response_text: 
            if hasattr(response, 'prompt_feedback') and response.prompt_feedback.block_reason:
                reason = response.prompt_feedback.block_reason.name
                log.warning(f"Gemini response blocked. Reason: {reason}. Feedback: {response.prompt_feedback}")
                return f"(内容因 {reason} 被阻止)"
            if hasattr(response, 'candidates') and response.candidates and \
               response.candidates[0].finish_reason != genai.types.FinishReason.STOP: # Check if not normal stop
                finish_reason_name = response.candidates[0].finish_reason.name
                safety_ratings_str = str(response.candidates[0].safety_ratings) if hasattr(response.candidates[0], 'safety_ratings') else "N/A"
                log.warning(f"Gemini generation finished with non-STOP reason: {finish_reason_name}. Safety: {safety_ratings_str}")
                if response.candidates[0].finish_reason == genai.types.FinishReason.SAFETY:
                     return "(内容因安全原因被终止或过滤)"
        log.info("Gemini Chat 调用成功 (或API调用完成).")
        return response_text.strip() if response_text else "(AI未能生成有效文本回复)"

    # ... (keep your existing specific Gemini error handling: InvalidArgument, PermissionDenied etc.) ...
    except google_api_exceptions.InvalidArgument as e:
        log.error(f"Gemini API InvalidArgument (Model {effective_model_id}): {e}", exc_info=True)
        return f"AI请求参数错误 (Gemini): {str(e)[:200]}"
    except google_api_exceptions.PermissionDenied as e:
        log.error(f"Gemini API PermissionDenied (Model {effective_model_id}): {e}", exc_info=True)
        return f"Gemini API密钥无效或权限不足。请检查配置。"
    except google_api_exceptions.ResourceExhausted as e:
        log.error(f"Gemini API ResourceExhausted (Model {effective_model_id}): {e}", exc_info=True)
        return f"Gemini API资源用尽 (例如达到配额)。请稍后再试。"
    except google_api_exceptions.FailedPrecondition as e:
        log.error(f"Gemini API FailedPrecondition (Model {effective_model_id}): {e}", exc_info=True)
        return f"调用Gemini API的前提条件不满足 (例如API未启用): {str(e)[:200]}"
    except google_api_exceptions.GoogleAPIError as e:
        log.error(f"Gemini API error (Model {effective_model_id}): {e}", exc_info=True)
        raise
    except Exception as e:
        log.error(f"Unexpected error during Gemini API call (Model {effective_model_id}): {e}", exc_info=True)
        raise


def _chat_gemini_stream(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None,
    images_base64: Optional[List[str]] = None # ✨ MODIFIED: Expect a list
) -> str:
    _configure_gemini_if_needed()

    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    # (Ensure vision model logic similar to _chat_gemini)
    if images_base64 and ("vision" not in effective_model_id and "flash" not in effective_model_id and not effective_model_id.startswith("gemini-1.5-pro")):
        vision_default = get_default_model_for_provider(ModelProvider.GEMINI, vision_capable=True)
        if vision_default: effective_model_id = vision_default
        else: effective_model_id = "gemini-1.5-flash-latest" # Fallback
    if not effective_model_id: effective_model_id = "gemini-1.5-flash-latest"


    gemini_contents: List[Dict[str, Any]] = []
    # (History processing as in _chat_gemini - simplified for brevity, ensure it's robust)
    if history:
        for turn in history:
            role = turn.get("role")
            if role not in ["user", "model"]: continue
            parts_data = turn.get("parts")
            gemini_history_parts = []
            if isinstance(parts_data, list): # Gemini format
                for part_item in parts_data:
                    if isinstance(part_item, dict) and "text" in part_item and str(part_item["text"]).strip():
                        gemini_history_parts.append(str(part_item["text"]))
            elif isinstance(parts_data, str) and parts_data.strip(): # Simpler text part
                 gemini_history_parts.append(parts_data)
            elif isinstance(turn.get("content"), str) and str(turn.get("content")).strip(): # OpenAI format
                gemini_history_parts.append(str(turn.get("content")))
            if gemini_history_parts:
                 gemini_contents.append({'role': role, 'parts': gemini_history_parts})


    # --- ✨ MODIFIED: Construct parts for the current user turn with multiple images ---
    current_user_parts_for_gemini: List[Any] = []
    if prompt:
        current_user_parts_for_gemini.append(prompt)
    
    num_images_processed_for_gemini_stream = 0
    if images_base64 and isinstance(images_base64, list):
        for img_b64_string in images_base64:
            if isinstance(img_b64_string, str) and img_b64_string.strip():
                try:
                    image_bytes = base64.b64decode(img_b64_string)
                    pil_image = Image.open(io.BytesIO(image_bytes))
                    current_user_parts_for_gemini.append(pil_image)
                    num_images_processed_for_gemini_stream +=1
                except Exception as e_img:
                    log.error(f"Failed to decode/open image for Gemini stream: {e_img}", exc_info=True)
            else:
                log.warning(f"Skipped an invalid base64 string in images_base64 list for Gemini stream.")
    # --- End of multi-image construction ---

    if current_user_parts_for_gemini:
        gemini_contents.append({'role': 'user', 'parts': current_user_parts_for_gemini})
    elif not gemini_contents: # No history and no current input
        log.warning("Gemini stream: No history, no prompt, no valid images.")
        if stream_callback: stream_callback("[ERROR: 请输入问题或提供有效的图片。]")
        return "请输入问题或提供有效的图片。"
    if not gemini_contents: # Final check if somehow still empty
        log.warning("Gemini stream: No valid content to send after processing all inputs.")
        if stream_callback: stream_callback("[ERROR: 无法处理请求，对话内容为空或媒体处理失败。]")
        return "无法处理请求，对话内容为空或媒体处理失败。"

    model_params = {"model_name": effective_model_id}
    model = genai.GenerativeModel(**model_params)
    
    gemini_max_tokens_stream = settings.GEMINI_MAX_TOKENS_STREAM if hasattr(settings, 'GEMINI_MAX_TOKENS_STREAM') else 8192
    gemini_temperature_stream = settings.GEMINI_TEMPERATURE_STREAM if hasattr(settings, 'GEMINI_TEMPERATURE_STREAM') else 0.7

    generation_config = genai.types.GenerationConfig(
        max_output_tokens=gemini_max_tokens_stream,
        temperature=gemini_temperature_stream
    )
    log.info(f"调用 Gemini Chat Stream (Model: {effective_model_id}). Images sent: {num_images_processed_for_gemini_stream}. Turns: {len(gemini_contents)}")
    try:
        response_stream = model.generate_content(
            contents=gemini_contents, # type: ignore
            generation_config=generation_config,
            stream=True,
            request_options={"timeout": settings.GEMINI_REQUEST_TIMEOUT_STREAM if hasattr(settings, 'GEMINI_REQUEST_TIMEOUT_STREAM') else 180}
        )
        accumulated_response_text = ""
        for chunk in response_stream:
            chunk_text = ""
            # (Robust chunk text extraction as in _chat_gemini_stream - ensure this is correct)
            if hasattr(chunk, 'parts') and chunk.parts:
                for part in chunk.parts:
                    if hasattr(part, 'text') and part.text: chunk_text += part.text
            elif hasattr(chunk, 'text') and chunk.text: 
                chunk_text = chunk.text
            
            # (Safety/blocking checks as in _chat_gemini_stream - ensure this is correct)
            if hasattr(chunk, 'prompt_feedback') and chunk.prompt_feedback.block_reason:
                reason = chunk.prompt_feedback.block_reason.name
                log.warning(f"Gemini stream: Prompt blocked. Reason: {reason}")
                if stream_callback: stream_callback(f"[内容因 {reason} 被阻止]")
                if not accumulated_response_text.strip(): return f"(内容因 {reason} 被阻止)" 
                break 
            if hasattr(chunk, 'candidates') and chunk.candidates and \
               hasattr(chunk.candidates[0], 'finish_reason') and \
               chunk.candidates[0].finish_reason == genai.types.FinishReason.SAFETY:
                safety_ratings_str = str(chunk.candidates[0].safety_ratings) if hasattr(chunk.candidates[0], 'safety_ratings') else "N/A"
                log.warning(f"Gemini stream: Safety stop. Ratings: {safety_ratings_str}")
                if stream_callback: stream_callback("[内容因安全原因被终止或过滤]")
                if not accumulated_response_text.strip(): return "(内容因安全原因被终止或过滤)"
                break

            if chunk_text:
                accumulated_response_text += chunk_text
                if stream_callback:
                    try:
                        stream_callback(chunk_text)
                    except Exception as cb_exc:
                        log.error(f"Stream callback error: {cb_exc}", exc_info=True)
        
        log.info("Gemini Chat Stream 调用成功。")
        if not accumulated_response_text.strip() and not (
            (hasattr(response_stream, '_error') and response_stream._error) or # type: ignore
            (hasattr(response_stream, 'prompt_feedback') and response_stream.prompt_feedback.block_reason) or # type: ignore
            (hasattr(response_stream, 'candidates') and response_stream.candidates and response_stream.candidates[0].finish_reason == genai.types.FinishReason.SAFETY) # type: ignore
        ):
            log.warning("Gemini stream returned no text, and no explicit error or block/safety reason identified.")
            return "(AI未能生成有效文本回复)"
        return accumulated_response_text.strip()
        
    except google_api_exceptions.GoogleAPIError as e:
        log.error(f"Gemini API stream error (Model {effective_model_id}): {e}", exc_info=True)
        if stream_callback: stream_callback(f"[ERROR: Gemini Stream Error - {str(e)}]")
        raise
    except Exception as e:
        log.error(f"Unexpected error during Gemini stream (Model {effective_model_id}): {e}", exc_info=True)
        if stream_callback: stream_callback(f"[ERROR: Unexpected error during stream - {str(e)}]")
        raise

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
        elif current_provider == ModelProvider.GEMINI:
            if not settings.gemini_api_key: raise ValueError("Gemini API Key missing.")
            # ✨ MODIFIED: Pass the images_base64 list
            full_msg_text = _chat_gemini_stream(prompt, history, stream_callback, current_model_id, images_base64)
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
        result_gemini_txt = chat_only("你好，Gemini吗?", history=None, provider=ModelProvider.GEMINI, model_id="gemini-1.5-flash-latest") # 使用最新的 flash
        print(f"Gemini Text Only: {result_gemini_txt}")