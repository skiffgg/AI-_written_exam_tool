# core/chat.py
"""
提供 chat_only 函数，用于根据 settings.image_analysis_provider
调用 OpenAI / Gemini 文本模型返回回复，并支持多轮对话历史。
"""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional # <-- Import List

# --- 标准库和第三方库导入 ---
import openai
import google.generativeai as genai

# --- 本地模块导入 ---
from core.settings import settings
from core.constants import DEFAULT_MODEL_GEMINI, DEFAULT_MODEL_OPENAI

# --- 日志配置 ---
# 使用 getLogger 获取命名的 logger，而不是直接用 basicConfig (通常在主入口或设置模块配置)
# 如果您在 web_server.py 或 settings.py 中已经配置了 basicConfig，这里就不需要了
# logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger(__name__) # 获取当前模块的 logger

# === OpenAI Chat Function (with History) ===

def _chat_openai(prompt: str, history: Optional[List[Dict[str, Any]]] = None) -> str:
    """
    调用 OpenAI Chat 模型，并支持传入对话历史。

    Args:
        prompt: 当前用户的输入。
        history: 对话历史列表，格式类似 [{'role': 'user'/'assistant', 'content': '...'}, ...]。
                 注意：Gemini 的 'model' role 需要映射到 OpenAI 的 'assistant' role。

    Returns:
        模型生成的回复文本。

    Raises:
        openai.APIError: 如果 API 调用失败。
    """
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key not configured.")

    client = openai.OpenAI(api_key=settings.openai_api_key, http_client=settings.get_httpx_client()) # Pass proxy client
    
    # --- 构建 OpenAI messages 列表 ---
    messages = [{"role": "system", "content": "You are a helpful assistant."}] # System prompt first
    
    # Add history, mapping roles
    if history:
        for turn in history:
            role = turn.get("role")
            # Gemini uses 'model', OpenAI uses 'assistant'
            openai_role = "assistant" if role == "model" else role
            # Gemini uses 'parts':[{'text':...}], OpenAI uses 'content'
            try:
                content = turn.get("parts", [{}])[0].get("text", "")
                if openai_role in ["user", "assistant"] and content: # Only add valid roles and non-empty content
                    messages.append({"role": openai_role, "content": content})
            except (IndexError, AttributeError, TypeError):
                 log.warning(f"Skipping invalid history turn for OpenAI: {turn}")


    # Add current user prompt
    if prompt: # Ensure prompt is not empty
       messages.append({"role": "user", "content": prompt})
    # ----------------------------------

    log.info(f"调用 OpenAI Chat ({DEFAULT_MODEL_OPENAI})... Messages count: {len(messages)}")
    log.debug(f"OpenAI Messages Payload: {messages}") # Log full payload only in debug

    try:
        # (可选) 定义生成参数，例如 max_tokens
        # generation_params = {
        #    "max_tokens": 2048, # 示例：增加 token 上限
        #    "temperature": 0.7,
        # }

        chat_completion = client.chat.completions.create(
            model=DEFAULT_MODEL_OPENAI,
            messages=messages,
            # **generation_params # Add other params if needed
            max_tokens=2048 # 直接在这里设置，覆盖默认值
        )
        response_content = chat_completion.choices[0].message.content
        log.info("OpenAI Chat 调用成功。")
        return response_content.strip() if response_content else "" # Handle empty response

    except openai.APIError as e:
        log.error(f"OpenAI API error: {e}", exc_info=True)
        raise # Re-raise the exception to be caught by chat_only

# === Gemini Chat Function (with History) ===

def _chat_gemini(prompt: str, history: Optional[List[Dict[str, Any]]] = None) -> str:
    """
    调用 Google Gemini 模型，并支持传入对话历史。
    代理通过环境变量 HTTP_PROXY/HTTPS_PROXY 配置。
    """
    if not settings.gemini_api_key:
        raise ValueError("Gemini API key not configured.")

    # --- 移除显式的代理配置 ---
    # proxies = settings.get_proxy_dict() # 不再需要调用这个方法获取字典
    # genai.configure(
    #    api_key=settings.gemini_api_key,
    #    transport='rest',
    #    client_options={"proxies": proxies} if proxies else None # <--- 删除这行或将其注释掉
    # )
    # --- End 移除 ---

    # --- 简化配置：库应自动读取环境变量 ---
    # 只需要配置 API Key。代理会从环境变量读取。
    # 确保环境变量已通过 settings.py 中的 load_dotenv 加载
    genai.configure(api_key=settings.gemini_api_key)
    # transport='rest' 可能不再需要显式设置，库会选择合适的
    # 如果遇到问题，可以尝试加回 transport='rest'
    # genai.configure(api_key=settings.gemini_api_key, transport='rest')

    # 确认环境变量是否真的设置了（可选的调试日志）
    # log.debug(f"Gemini Check - HTTP_PROXY env var: {os.getenv('HTTP_PROXY')}")
    # log.debug(f"Gemini Check - HTTPS_PROXY env var: {os.getenv('HTTPS_PROXY')}")


    # --- 构建 Gemini contents 列表 ---
    full_conversation = history if history else []
    if prompt:
        current_user_content = {'role': 'user', 'parts': [{'text': prompt}]}
        full_conversation.append(current_user_content)
    else:
         if not full_conversation:
              log.warning("Gemini chat called with empty prompt and empty history.")
              return "请输入您的问题。"

    # --- 配置生成参数 ---
    gen_cfg = genai.types.GenerationConfig(
        max_output_tokens=2048,
        temperature=0.7
    )
    model = genai.GenerativeModel(DEFAULT_MODEL_GEMINI)

    log.info(f"调用 Gemini Chat ({DEFAULT_MODEL_GEMINI})... Turns: {len(full_conversation)}")
    # log.debug(f"Gemini Contents Payload: {full_conversation}") # Keep for debugging if needed

    try:
        response = model.generate_content(
            contents=full_conversation,
            generation_config=gen_cfg,
        )
        # ... (处理 response 的代码不变) ...
        if response.parts:
             log.debug(f"Gemini response.parts content: {[part.text for part in response.parts]}")
             response_text = "".join(part.text for part in response.parts)
        else:
            response_text = "(AI未能生成有效回复，可能已被安全设置阻止)"
            log.warning(f"Gemini response missing parts. Finish reason: {response.prompt_feedback}")

        log.info("Gemini Chat 调用成功。")
        return response_text.strip()

    except Exception as e:
        log.error(f"Gemini API error: {e}", exc_info=True)
        # 可以添加更具体的错误类型检查，比如 google.api_core.exceptions.PermissionDenied
        if "API key not valid" in str(e):
             return "Gemini API Key 无效，请检查配置。"
        # 其他通用错误
        raise # Re-raise the exception

# ... chat_only 函数 和 _chat_openai 函数 保持不变 (除非要移除 OpenAI 的代理调用) ...



# === Main Chat Dispatcher Function ===

# 修改函数签名以接受 history
def chat_only(prompt: str, history: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    根据 settings.image_analysis_provider 调用对应的聊天模型 (OpenAI 或 Gemini)，
    并传递对话历史记录。

    Args:
        prompt: 当前用户的输入。
        history: 对话历史列表 (可选)。

    Returns:
        一个包含 'provider' 和 'message' 的字典。
        如果出错，'provider' 为 'error'，'message' 包含错误信息。
        如果未配置，'provider' 为 'none'。
    """
    # 确定使用哪个提供商 (优先使用配置，其次根据 API Key 是否存在判断)
    provider = settings.image_analysis_provider # 假设这个配置也决定了文本聊天提供商
    if not provider or provider not in ['openai', 'gemini']:
         # Fallback logic if provider setting is invalid or missing
         provider = "openai" if settings.openai_api_key else ("gemini" if settings.gemini_api_key else "none")
         log.warning(f"Invalid or missing image_analysis_provider setting. Falling back to '{provider}'.")


    log.info(f"Dispatching chat request to provider: {provider}")

    try:
        msg = ""
        # 调用相应的带历史记录的聊天函数
        if provider == "openai" and settings.openai_api_key:
            msg = _chat_openai(prompt, history)
        elif provider == "gemini" and settings.gemini_api_key:
            msg = _chat_gemini(prompt, history)
        else:
            log.warning("No chat provider configured or API key missing.")
            return {"provider": "none", "message": "聊天功能未启用或未配置 API Key。"}

        return {"provider": provider, "message": msg} # 返回成功结果

    except Exception as exc:
        # 捕获来自 _chat_openai 或 _chat_gemini 的异常
        log.exception(f"Chat failed using provider '{provider}': {exc}") # Log with traceback
        # 返回包含错误信息的字典
        return {"provider": "error", "message": f"与 AI ({provider}) 通信时出错: {str(exc)}"}

# --- 导出 ---
# 确保外部模块只能导入 chat_only 函数
__all__ = ["chat_only"]

# (可选) 添加一些基本的直接运行测试代码
if __name__ == '__main__':
    print("测试 chat_only 函数...")
    # 注意：直接运行此文件需要确保 settings 能正确加载，可能需要设置环境变量

    # --- Test Gemini ---
    if settings.gemini_api_key:
        print("\n--- 测试 Gemini ---")
        test_history_gemini = [
            {'role': 'user', 'parts': [{'text': '你好'}]},
            {'role': 'model', 'parts': [{'text': '你好！有什么可以帮你的吗？'}]}
        ]
        test_prompt_gemini = "请用一句话解释什么是Python？"
        result_gemini = chat_only(test_prompt_gemini, history=test_history_gemini)
        print(f"Prompt: {test_prompt_gemini}")
        print(f"History Len: {len(test_history_gemini)}")
        print(f"Result (Gemini): {result_gemini}")
    else:
        print("\n--- Gemini API Key 未配置，跳过测试 ---")

    # --- Test OpenAI ---
    # if settings.openai_api_key:
    #     print("\n--- 测试 OpenAI ---")
    #     test_history_openai = [
    #         {'role': 'user', 'content': 'Hello'}, # OpenAI format
    #         {'role': 'assistant', 'content': 'Hi there! How can I help?'}
    #     ]
    #     test_prompt_openai = "In one sentence, what is Python?"
    #     result_openai = chat_only(test_prompt_openai, history=test_history_openai) # Need mapping inside _chat_openai
    #     print(f"Prompt: {test_prompt_openai}")
    #     print(f"History Len: {len(test_history_openai)}")
    #     print(f"Result (OpenAI): {result_openai}")
    # else:
    #      print("\n--- OpenAI API Key 未配置，跳过测试 ---")