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
def _chat_openai(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    image_base64: Optional[str] = None
) -> str:
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key not configured.")

    # 使用 settings.get_httpx_client() 获取配置了代理的 client
    http_client_with_proxy = settings.get_httpx_client()
    client = openai.OpenAI(api_key=settings.openai_api_key, http_client=http_client_with_proxy)
    
    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.OPENAI)
    if not effective_model_id:
        effective_model_id = "gpt-4o" 
        log.warning(f"OpenAI model_id defaulted to '{effective_model_id}' due to no specific or default found.")

    messages: List[Dict[str, Any]] = []
    system_message = _prepare_system_message(ModelProvider.OPENAI)
    if system_message:
        messages.append(system_message)

    if history:
        for turn in history:
            role = turn.get("role")
            openai_role = "assistant" if role == "model" else role
            text_content = None
            if isinstance(turn.get("parts"), list) and turn["parts"]:
                text_content = turn["parts"][0].get("text", "")
            elif isinstance(turn.get("content"), str):
                text_content = turn.get("content", "")
            
            current_turn_content_parts = []
            if text_content:
                current_turn_content_parts.append({"type": "text", "text": text_content})
            # TODO: If history turns can contain images, process them here for OpenAI

            if openai_role in ["user", "assistant"] and current_turn_content_parts:
                messages.append({"role": openai_role, "content": current_turn_content_parts})
            elif openai_role in ["user", "assistant"] and text_content: # Fallback for simple text
                 messages.append({"role": openai_role, "content": text_content})

    current_user_content_parts: List[Dict[str, Any]] = []
    if prompt:
        current_user_content_parts.append({"type": "text", "text": prompt})
    if image_base64:
        image_url_content = {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
        current_user_content_parts.append(image_url_content)

    if current_user_content_parts:
        messages.append({"role": "user", "content": current_user_content_parts})
    elif not messages:
        log.warning("OpenAI chat called with no history, no prompt, and no image.")
        return "请输入您的问题或提供图片。"

    log.info(f"调用 OpenAI Chat (Model: {effective_model_id}). Image: {'Yes' if image_base64 else 'No'}. Msgs: {len(messages)}")
    try:
        # openai_max_tokens = getattr(settings, 'OPENAI_MAX_TOKENS', 2048) # Safer access
        openai_max_tokens = settings.MAX_TEXT_FILE_CHARS # Or a specific OpenAI token limit from settings
        chat_completion = client.chat.completions.create(
            model=effective_model_id,
            messages=messages,
            max_tokens=openai_max_tokens 
        )
        response_content = chat_completion.choices[0].message.content
        log.info("OpenAI Chat 调用成功。")
        return response_content.strip() if response_content else ""
    except openai.APIError as e:
        log.error(f"OpenAI API error (Model: {effective_model_id}): {e}", exc_info=True)
        raise

def _chat_openai_stream(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None,
    image_base64: Optional[str] = None
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

    current_user_content_parts: List[Dict[str, Any]] = []
    if prompt:
        current_user_content_parts.append({"type": "text", "text": prompt})
    if image_base64:
        image_url_content = {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
        current_user_content_parts.append(image_url_content)

    if current_user_content_parts:
        messages.append({"role": "user", "content": current_user_content_parts})
    elif not messages:
        log.warning("OpenAI stream chat called with no history, no prompt, and no image.")
        if stream_callback: stream_callback("[ERROR: 请输入您的问题或提供图片。]")
        return "请输入您的问题或提供图片。"

    log.info(f"调用 OpenAI Chat Stream (Model: {effective_model_id}). Image: {'Yes' if image_base64 else 'No'}. Msgs: {len(messages)}")
    try:
        # openai_max_tokens_stream = getattr(settings, 'OPENAI_MAX_TOKENS_STREAM', 2048)
        openai_max_tokens_stream = settings.MAX_TEXT_FILE_CHARS # Or specific stream token limit
        stream = client.chat.completions.create(
            model=effective_model_id,
            messages=messages,
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
        if stream_callback: stream_callback(f"[ERROR: Unexpected error - {str(e)}]")
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


def _chat_gemini(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    image_base64: Optional[str] = None
) -> str:
    _configure_gemini_if_needed() # Ensure API key is configured

    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    if not effective_model_id: effective_model_id = "gemini-1.5-flash-latest" # Ensure this is a vision model
    
    gemini_contents: List[Dict[str, Any]] = []
    if history:
        for turn in history:
            role = turn.get("role")
            if role not in ["user", "model"]: continue
            parts_data = turn.get("parts")
            gemini_parts = []
            if isinstance(parts_data, list):
                for part_item in parts_data:
                    if isinstance(part_item, dict) and "text" in part_item and str(part_item["text"]).strip():
                        gemini_parts.append({"text": str(part_item["text"])})
            elif isinstance(parts_data, str) and parts_data.strip():
                gemini_parts.append({"text": parts_data})
            elif isinstance(turn.get("content"), str) and str(turn.get("content")).strip(): # OpenAI history format
                gemini_parts.append({"text": str(turn.get("content"))})
            if gemini_parts: gemini_contents.append({'role': role, 'parts': gemini_parts})

    current_user_parts: List[Any] = []
    if prompt:
        current_user_parts.append(prompt)
    pil_image = None
    if image_base64:
        try:
            image_bytes = base64.b64decode(image_base64)
            pil_image = Image.open(io.BytesIO(image_bytes))
            current_user_parts.append(pil_image)
        except Exception as e_img:
            log.error(f"Failed to decode/open image for Gemini: {e_img}", exc_info=True)
            current_user_parts.append("(Error processing provided image)")
    
    if current_user_parts:
        # Simplified logic: always append new user turn if there's content
        gemini_contents.append({'role': 'user', 'parts': current_user_parts})
    elif not gemini_contents: # No history and no current input
         log.warning("Gemini chat called with no history, no prompt, and no image.")
         return "请输入您的问题或提供图片。"

    if not gemini_contents: # Final check if somehow still empty
        log.warning("Gemini chat: No valid content to send.")
        return "无法处理请求，对话内容为空。"

    model_params = {"model_name": effective_model_id}
    # system_instruction = _prepare_system_message(ModelProvider.GEMINI) # Returns None currently
    # if system_instruction and system_instruction.get('parts'):
    #     model_params["system_instruction"] = system_instruction['parts']

    model = genai.GenerativeModel(**model_params)
    
    # gemini_max_tokens = getattr(settings, 'GEMINI_MAX_TOKENS', 2048)
    # gemini_temperature = getattr(settings, 'GEMINI_TEMPERATURE', 0.7)
    gemini_max_tokens = settings.MAX_TEXT_FILE_CHARS
    gemini_temperature = 0.7

    generation_config = genai.types.GenerationConfig(
        max_output_tokens=gemini_max_tokens,
        temperature=gemini_temperature
    )

    log.info(f"调用 Gemini Chat (Model: {effective_model_id}). Image: {'Yes' if pil_image else 'No'}. Turns: {len(gemini_contents)}")
    try:
        response = model.generate_content(
            contents=gemini_contents,
            generation_config=generation_config,
            # request_options={"timeout": getattr(settings, 'GEMINI_REQUEST_TIMEOUT', 120)}
        )
        response_text = ""
        if hasattr(response, 'parts') and response.parts:
            for part in response.parts:
                if hasattr(part, 'text'): response_text += part.text
        elif hasattr(response, 'text') and response.text:
            response_text = response.text
        
        if not response_text: # Check for blocking or other finish reasons
            if hasattr(response, 'prompt_feedback') and response.prompt_feedback.block_reason:
                reason = response.prompt_feedback.block_reason.name
                log.warning(f"Gemini response blocked. Reason: {reason}. Feedback: {response.prompt_feedback}")
                return f"(内容因 {reason} 被阻止)"
            if hasattr(response, 'candidates') and response.candidates and \
               response.candidates[0].finish_reason != genai.types.FinishReason.STOP:
                finish_reason_name = response.candidates[0].finish_reason.name
                log.warning(f"Gemini generation finished with non-STOP reason: {finish_reason_name}. Safety: {response.candidates[0].safety_ratings}")
                if response.candidates[0].finish_reason == genai.types.FinishReason.SAFETY:
                     return "(内容因安全原因被终止或过滤)"
                # return f"(内容生成因 {finish_reason_name} 停止)" # Potentially too verbose

        log.info("Gemini Chat 调用成功 (或API调用完成).")
        return response_text.strip() if response_text else "(AI未能生成有效文本回复)"

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
    except google_api_exceptions.GoogleAPIError as e: # Catch other Google API errors
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
    image_base64: Optional[str] = None
) -> str:
    _configure_gemini_if_needed()

    effective_model_id = model_id or get_default_model_for_provider(ModelProvider.GEMINI)
    if not effective_model_id: effective_model_id = "gemini-1.5-flash-latest"

    gemini_contents: List[Dict[str, Any]] = []
    # (History and current_user_parts construction as in _chat_gemini)
    if history:
        for turn in history:
            role = turn.get("role")
            if role not in ["user", "model"]: continue
            parts_data = turn.get("parts")
            gemini_parts = []
            if isinstance(parts_data, list):
                for part_item in parts_data:
                    if isinstance(part_item, dict) and "text" in part_item and str(part_item["text"]).strip():
                        gemini_parts.append({"text": str(part_item["text"])})
            elif isinstance(parts_data, str) and parts_data.strip():
                gemini_parts.append({"text": parts_data})
            elif isinstance(turn.get("content"), str) and str(turn.get("content")).strip():
                gemini_parts.append({"text": str(turn.get("content"))})
            if gemini_parts: gemini_contents.append({'role': role, 'parts': gemini_parts})

    current_user_parts: List[Any] = []
    if prompt:
        current_user_parts.append(prompt)
    pil_image = None
    if image_base64:
        try:
            image_bytes = base64.b64decode(image_base64)
            pil_image = Image.open(io.BytesIO(image_bytes))
            current_user_parts.append(pil_image)
        except Exception as e_img:
            log.error(f"Failed to decode/open image for Gemini stream: {e_img}", exc_info=True)
            current_user_parts.append("(Error processing image for stream)")
    if current_user_parts:
        gemini_contents.append({'role': 'user', 'parts': current_user_parts})
    elif not gemini_contents:
        log.warning("Gemini stream: No content to send.")
        if stream_callback: stream_callback("[ERROR: 请输入问题或提供图片。]")
        return "请输入问题或提供图片。"
    if not gemini_contents:
        log.warning("Gemini stream: No valid content to send.")
        if stream_callback: stream_callback("[ERROR: 无法处理请求，对话内容为空。]")
        return "无法处理请求，对话内容为空。"


    model_params = {"model_name": effective_model_id}
    model = genai.GenerativeModel(**model_params)
    
    # gemini_max_tokens_stream = getattr(settings, 'GEMINI_MAX_TOKENS_STREAM', 2048)
    # gemini_temperature_stream = getattr(settings, 'GEMINI_TEMPERATURE_STREAM', 0.7)
    gemini_max_tokens_stream = settings.MAX_TEXT_FILE_CHARS
    gemini_temperature_stream = 0.7

    generation_config = genai.types.GenerationConfig(
        max_output_tokens=gemini_max_tokens_stream,
        temperature=gemini_temperature_stream
    )
    log.info(f"调用 Gemini Chat Stream (Model: {effective_model_id}). Image: {'Yes' if pil_image else 'No'}. Turns: {len(gemini_contents)}")
    try:
        response_stream = model.generate_content(
            contents=gemini_contents,
            generation_config=generation_config,
            stream=True,
            # request_options={"timeout": getattr(settings, 'GEMINI_REQUEST_TIMEOUT_STREAM', 180)}
        )
        accumulated_response_text = ""
        for chunk in response_stream:
            chunk_text = ""
            if hasattr(chunk, 'parts') and chunk.parts:
                for part in chunk.parts:
                    if hasattr(part, 'text') and part.text: chunk_text += part.text
            elif hasattr(chunk, 'text') and chunk.text:
                chunk_text = chunk.text
            
            if hasattr(chunk, 'prompt_feedback') and chunk.prompt_feedback.block_reason:
                reason = chunk.prompt_feedback.block_reason.name
                log.warning(f"Gemini stream: Prompt blocked. Reason: {reason}")
                if stream_callback: stream_callback(f"[内容因 {reason} 被阻止]")
                if not accumulated_response_text: return f"(内容因 {reason} 被阻止)"
            if hasattr(chunk, 'candidates') and chunk.candidates and \
               chunk.candidates[0].finish_reason == genai.types.FinishReason.SAFETY:
                log.warning(f"Gemini stream: Safety stop. Ratings: {chunk.candidates[0].safety_ratings}")
                if stream_callback: stream_callback("[内容因安全原因被终止]")
                if not accumulated_response_text: return "(内容因安全原因被终止)"
                break
            if chunk_text:
                accumulated_response_text += chunk_text
                if stream_callback:
                    try: stream_callback(chunk_text)
                    except Exception as cb_exc: log.error(f"Stream callback error: {cb_exc}", exc_info=True)
        
        log.info("Gemini Chat Stream 调用成功。")
        if not accumulated_response_text.strip() and not (hasattr(response_stream, '_error') or \
           (hasattr(response_stream, 'prompt_feedback') and response_stream.prompt_feedback.block_reason)): # type: ignore
            log.warning("Gemini stream returned no text, no explicit error/block.")
            return "(AI未能生成有效文本回复)"
        return accumulated_response_text.strip()
    except Exception as e:
        log.error(f"Error during Gemini stream (Model {effective_model_id}): {e}", exc_info=True)
        if stream_callback: stream_callback(f"[ERROR: Gemini Stream Error - {str(e)}]")
        raise

# === Main Chat Dispatcher Functions (Multimodal) ===
# (chat_only 和 chat_only_stream 函数保持与我上次提供的版本一致，它们调用上面修改过的内部函数)
def chat_only(
    prompt: str, history: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None, provider: Optional[str] = None,
    image_base64: Optional[str] = None
) -> Dict[str, Any]:
    current_provider = provider
    current_model_id = model_id
    if not current_provider:
        if current_model_id:
            for p_name, models in ALL_AVAILABLE_MODELS.items():
                if current_model_id in models: current_provider = p_name; break
        if not current_provider: current_provider = settings.image_analysis_provider or ModelProvider.OPENAI
    if not current_model_id:
        current_model_id = get_default_model_for_provider(current_provider) # type: ignore
    if not current_model_id or not current_provider:
        log.error(f"Could not determine model/provider. P: {current_provider}, M: {current_model_id}")
        return {"provider": "error", "message": "无法确定AI模型或提供商。"}
    if current_provider not in ALL_AVAILABLE_MODELS or \
       current_model_id not in ALL_AVAILABLE_MODELS.get(current_provider, {}): # type: ignore
        log.error(f"Model '{current_model_id}' invalid for provider '{current_provider}'.")
        return {"provider": "error", "model_id": current_model_id, "message": f"模型 {current_model_id} 对提供商 {current_provider} 无效。"}
    log.info(f"Dispatching chat. Provider: {current_provider}, Model: {current_model_id}, Image: {'Yes' if image_base64 else 'No'}")
    try:
        msg_text = ""
        if current_provider == ModelProvider.OPENAI:
            if not settings.openai_api_key: raise ValueError("OpenAI API Key missing.")
            msg_text = _chat_openai(prompt, history, current_model_id, image_base64)
        elif current_provider == ModelProvider.GEMINI:
            if not settings.gemini_api_key: raise ValueError("Gemini API Key missing.")
            msg_text = _chat_gemini(prompt, history, current_model_id, image_base64)
        else:
            log.warning(f"Provider '{current_provider}' not supported or API key missing.")
            return {"provider": "none", "model_id": current_model_id, "message": f"聊天功能未启用或提供商 '{current_provider}' 不支持。"}
        return {"provider": current_provider, "model_id": current_model_id, "message": msg_text}
    except ValueError as ve:
        log.error(f"Config error for chat with {current_provider}/{current_model_id}: {ve}", exc_info=True)
        return {"provider": "error", "model_id": current_model_id, "message": f"配置错误: {str(ve)}"}
    except Exception as exc:
        log.exception(f"Chat failed. Provider: {current_provider}, Model: {current_model_id}")
        return {"provider": "error", "model_id": current_model_id, "message": f"与 AI ({current_provider}/{current_model_id}) 通信时出错: {str(exc)}"}

def chat_only_stream(
    prompt: str, history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model_id: Optional[str] = None, provider: Optional[str] = None,
    image_base64: Optional[str] = None
) -> Dict[str, Any]:
    current_provider = provider
    current_model_id = model_id
    if not current_provider:
        if current_model_id:
            for p_name, models in ALL_AVAILABLE_MODELS.items():
                if current_model_id in models: current_provider = p_name; break
        if not current_provider: current_provider = settings.image_analysis_provider or ModelProvider.OPENAI
    if not current_model_id:
        current_model_id = get_default_model_for_provider(current_provider) # type: ignore

    if not current_model_id or not current_provider:
        log.error(f"Stream: Could not determine model/provider. P: {current_provider}, M: {current_model_id}")
        if stream_callback: stream_callback("[ERROR: 无法确定AI模型或提供商。]")
        return {"provider": "error", "message": "无法确定AI模型或提供商。"}
    if current_provider not in ALL_AVAILABLE_MODELS or \
       current_model_id not in ALL_AVAILABLE_MODELS.get(current_provider, {}): # type: ignore
        log.error(f"Stream: Model '{current_model_id}' invalid for provider '{current_provider}'.")
        if stream_callback: stream_callback(f"[ERROR: 模型 {current_model_id} 对提供商 {current_provider} 无效。]")
        return {"provider": "error", "model_id": current_model_id, "message": f"模型 {current_model_id} 对提供商 {current_provider} 无效。"}
    log.info(f"Dispatching STREAM chat. Provider: {current_provider}, Model: {current_model_id}, Image: {'Yes' if image_base64 else 'No'}")
    try:
        full_msg_text = ""
        if current_provider == ModelProvider.OPENAI:
            if not settings.openai_api_key: raise ValueError("OpenAI API Key missing.")
            full_msg_text = _chat_openai_stream(prompt, history, stream_callback, current_model_id, image_base64)
        elif current_provider == ModelProvider.GEMINI:
            if not settings.gemini_api_key: raise ValueError("Gemini API Key missing.")
            full_msg_text = _chat_gemini_stream(prompt, history, stream_callback, current_model_id, image_base64)
        else:
            log.warning(f"Stream: Provider '{current_provider}' not supported or API key missing.")
            if stream_callback: stream_callback(f"[ERROR: 流式聊天功能未启用或提供商 '{current_provider}' 不支持。]")
            return {"provider": "none", "model_id": current_model_id, "message": "流式聊天功能未启用或提供商不支持。"}
        return {"provider": current_provider, "model_id": current_model_id, "message": full_msg_text}
    except ValueError as ve:
        log.error(f"Config error for stream chat with {current_provider}/{current_model_id}: {ve}", exc_info=True)
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