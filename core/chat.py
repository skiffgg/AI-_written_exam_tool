# core/chat.py
"""
提供 chat_only 函数，用于根据 settings.image_analysis_provider
调用 OpenAI / Gemini 文本模型返回回复，并支持多轮对话历史。
"""
from __future__ import annotations
import logging
import logging
import json # <--- 添加缺失的导入
from typing import Any, Dict, List, Optional, Callable # 确保 Callable 被导入

# --- 标准库和第三方库导入 ---
import google.generativeai as genai
# import openai # 如果这个文件也处理 openai 调用

# --- 本地模块导入 ---
from core.settings import settings # 全局配置实例
from core.constants import DEFAULT_MODEL_GEMINI # 默认 Gemini 模型名称
from google.api_core import exceptions as google_api_exceptions

log = logging.getLogger(__name__)

# --- API Key 和代理的全局配置建议 ---
# 再次强调，genai.configure() 和环境变量的设置（用于代理）
# 最好在应用程序启动时（例如 main.py 或 app_setup.py）进行一次。
# 假设这已在外部完成。
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

def _chat_openai_stream(prompt: str, history: Optional[List[Dict[str, Any]]] = None, stream_callback=None) -> str:
    """
    调用 OpenAI Chat 模型，支持流式输出。

    Args:
        prompt: 当前用户的输入。
        history: 对话历史列表。
        stream_callback: 接收流式输出块的回调函数。

    Returns:
        模型生成的完整回复文本。
    """
    if not settings.openai_api_key:
        raise ValueError("OpenAI API key not configured.")

    client = openai.OpenAI(api_key=settings.openai_api_key, http_client=settings.get_httpx_client())
    
    # 构建 OpenAI messages 列表
    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    
    # 添加历史
    if history:
        for turn in history:
            role = turn.get("role")
            openai_role = "assistant" if role == "model" else role
            try:
                content = turn.get("parts", [{}])[0].get("text", "")
                if openai_role in ["user", "assistant"] and content:
                    messages.append({"role": openai_role, "content": content})
            except (IndexError, AttributeError, TypeError):
                log.warning(f"Skipping invalid history turn for OpenAI: {turn}")

    # 添加当前用户提示
    if prompt:
        messages.append({"role": "user", "content": prompt})

    log.info(f"调用 OpenAI Chat Stream ({DEFAULT_MODEL_OPENAI})... Messages count: {len(messages)}")
    
    try:
        # 创建流式响应
        stream = client.chat.completions.create(
            model=DEFAULT_MODEL_OPENAI,
            messages=messages,
            max_tokens=2048,
            stream=True  # 启用流式输出
        )
        
        full_response = ""
        
        # 处理流式响应
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                content = chunk.choices[0].delta.content
                full_response += content
                if stream_callback:
                    stream_callback(content)
        
        log.info("OpenAI Chat Stream 调用成功。")
        return full_response.strip()
        
    except Exception as e:
        log.error(f"OpenAI API error: {e}", exc_info=True)
        raise

# === Gemini Chat Function (with History) ===

# def _chat_gemini(prompt: str, history: Optional[List[Dict[str, Any]]] = None) -> str:
#     """
#     调用 Google Gemini 模型，并支持传入对话历史。
#     代理通过环境变量 HTTP_PROXY/HTTPS_PROXY 配置。
#     """
#     if not settings.gemini_api_key:
#         raise ValueError("Gemini API key not configured.")

#     # --- 移除显式的代理配置 ---
#     # proxies = settings.get_proxy_dict() # 不再需要调用这个方法获取字典
#     # genai.configure(
#     #    api_key=settings.gemini_api_key,
#     #    transport='rest',
#     #    client_options={"proxies": proxies} if proxies else None # <--- 删除这行或将其注释掉
#     # )
#     # --- End 移除 ---

#     # --- 简化配置：库应自动读取环境变量 ---
#     # 只需要配置 API Key。代理会从环境变量读取。
#     # 确保环境变量已通过 settings.py 中的 load_dotenv 加载
#     genai.configure(api_key=settings.gemini_api_key)
#     # transport='rest' 可能不再需要显式设置，库会选择合适的
#     # 如果遇到问题，可以尝试加回 transport='rest'
#     # genai.configure(api_key=settings.gemini_api_key, transport='rest')

#     # 确认环境变量是否真的设置了（可选的调试日志）
#     # log.debug(f"Gemini Check - HTTP_PROXY env var: {os.getenv('HTTP_PROXY')}")
#     # log.debug(f"Gemini Check - HTTPS_PROXY env var: {os.getenv('HTTPS_PROXY')}")


#     # --- 构建 Gemini contents 列表 ---
#     full_conversation = history if history else []
#     if prompt:
#         current_user_content = {'role': 'user', 'parts': [{'text': prompt}]}
#         full_conversation.append(current_user_content)
#     else:
#          if not full_conversation:
#               log.warning("Gemini chat called with empty prompt and empty history.")
#               return "请输入您的问题。"

#     # --- 配置生成参数 ---
#     gen_cfg = genai.types.GenerationConfig(
#         max_output_tokens=2048,
#         temperature=0.7
#     )
#     model = genai.GenerativeModel(DEFAULT_MODEL_GEMINI)

#     log.info(f"调用 Gemini Chat ({DEFAULT_MODEL_GEMINI})... Turns: {len(full_conversation)}")
#     # log.debug(f"Gemini Contents Payload: {full_conversation}") # Keep for debugging if needed

#     try:
#         response = model.generate_content(
#             contents=full_conversation,
#             generation_config=gen_cfg,
#         )
#         # ... (处理 response 的代码不变) ...
#         if response.parts:
#              log.debug(f"Gemini response.parts content: {[part.text for part in response.parts]}")
#              response_text = "".join(part.text for part in response.parts)
#         else:
#             response_text = "(AI未能生成有效回复，可能已被安全设置阻止)"
#             log.warning(f"Gemini response missing parts. Finish reason: {response.prompt_feedback}")

#         log.info("Gemini Chat 调用成功。")
#         return response_text.strip()

#     except Exception as e:
#         log.error(f"Gemini API error: {e}", exc_info=True)
#         # 可以添加更具体的错误类型检查，比如 google.api_core.exceptions.PermissionDenied
#         if "API key not valid" in str(e):
#              return "Gemini API Key 无效，请检查配置。"
#         # 其他通用错误
#         raise # Re-raise the exception

# ... chat_only 函数 和 _chat_openai 函数 保持不变 (除非要移除 OpenAI 的代理调用) ...



def _chat_gemini_stream(
    prompt: str,
    history: Optional[List[Dict[str, Any]]] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    # model_name: Optional[str] = None # 如果仍然希望调用时能覆盖模型，可以保留此参数
                                     # 否则，将始终使用 constants.py 中的 DEFAULT_MODEL_GEMINI
) -> str:
    """
    调用 Gemini Chat 模型，支持流式输出。
    使用 settings.py 中配置的 API 密钥和 constants.py 中定义的默认模型。

    Args:
        prompt: 当前用户的输入。
        history: 对话历史列表。
        stream_callback: 接收流式输出块的回调函数。
        # model_name: (可选) 如果提供，则覆盖 constants.py 中的 DEFAULT_MODEL_GEMINI。

    Returns:
        模型生成的完整回复文本，如果发生错误或内容被阻止，则返回相应的提示信息。
    """
    if not settings.gemini_api_key:
        log.error("Gemini API key not configured in settings.")
        # 在实际应用中，可能希望向上层抛出自定义异常或返回特定错误对象
        raise ValueError("Gemini API 密钥未在设置中配置。")

    # API Key 配置应该在应用启动时完成。
    # 此处不再调用 genai.configure()，假设它已在应用级别完成。
    # 如果没有全局配置，并且您希望每次调用都确保配置，需要取消注释下一行
    # 并在应用级别配置和此处配置之间做出选择。
    # genai.configure(api_key=settings.gemini_api_key)


    # 获取模型名称
    # 如果希望允许函数参数覆盖常量，则使用下面注释掉的行
    # current_model_name = model_name if model_name else DEFAULT_MODEL_GEMINI
    current_model_name = DEFAULT_MODEL_GEMINI # 直接使用 constants.py 中定义的默认模型

    # 构建 Gemini contents 列表
    # Gemini API 要求 'user' 和 'model'角色交替，且第一条通常是 'user'
    # 如果 history 直接来自 Gemini 的输出，它应该已经是正确的格式
    full_conversation: List[Dict[str, Any]] = []
    if history:
        for entry in history:
            # 基本验证，确保 entry 是字典且包含期望的键
            if isinstance(entry, dict) and 'role' in entry and 'parts' in entry:
                # 确保 parts 是一个列表
                if isinstance(entry['parts'], list) and all(isinstance(p, dict) and 'text' in p for p in entry['parts']):
                    full_conversation.append(entry)
                elif isinstance(entry['parts'], str): # 兼容 parts 直接是字符串的情况 (不标准但可能遇到)
                    full_conversation.append({'role': entry['role'], 'parts': [{'text': entry['parts']}]})
                else:
                    log.warning(f"Skipping history entry with invalid 'parts' format: {entry}")
            else:
                log.warning(f"Skipping invalid history entry: {entry}")

    if prompt: # 只有当 prompt 非空且非 None 时才添加
        # 检查最后一条消息的角色，确保不会连续发送两条 'user' 消息 (如果历史的最后一条也是 'user')
        # 虽然 Gemini API 可能能处理，但最佳实践是交替角色。
        # 不过，如果 prompt 是对 model 最后回复的响应，直接添加 'user' 消息是正确的。
        current_user_content = {'role': 'user', 'parts': [{'text': prompt}]}
        full_conversation.append(current_user_content)
    elif not full_conversation: # 如果 prompt 为空且历史也为空
        log.warning("Gemini chat called with empty prompt and empty history.")
        return "请输入您的问题或提供对话历史。"
    
    # 如果 full_conversation 为空（例如，prompt 为空，history 也为空或无效）
    if not full_conversation:
        log.warning("Cannot call Gemini: conversation history is empty after processing inputs.")
        return "无法处理请求，对话内容为空。"


    # 配置生成参数
    gen_cfg_params = {
        "max_output_tokens": 2048, # 根据您的需求调整
        "temperature": 0.7,        # 调整创造性与事实性之间的平衡
        # "top_p": 0.9,            # 如果需要，可以添加 top_p
        # "top_k": 40,             # 如果需要，可以添加 top_k
        # "candidate_count": 1    # 流式输出通常只处理第一个候选
    }
    generation_config = genai.types.GenerationConfig(**gen_cfg_params)

    # 代理配置：如前所述，依赖于应用启动时通过环境变量设置的代理。
    # 检查 settings.py 中的 get_proxy_dict() 和应用启动时的 os.environ 设置。

    try:
        model = genai.GenerativeModel(current_model_name)
        log.info(f"调用 Gemini Chat Stream ({current_model_name})... Turns: {len(full_conversation)}")
        log.debug(f"Conversation content being sent to Gemini: {json.dumps(full_conversation, indent=2, ensure_ascii=False)}")


        response_stream = model.generate_content(
            contents=full_conversation,
            generation_config=generation_config,
            stream=True
        )

        accumulated_response_text = ""
        for chunk in response_stream:
            chunk_text = ""
            # Gemini 1.5 Pro/Flash 及更新版本通常将文本放在 chunk.parts 中
            if chunk.parts:
                for part in chunk.parts:
                    if hasattr(part, 'text') and part.text: # 确保 part 有 text 属性且不为 None
                        chunk_text += part.text
            # 兼容旧版或某些模型可能直接在 chunk 上有 text 属性
            elif hasattr(chunk, 'text') and chunk.text:
                chunk_text = chunk.text
            
            # 安全评级处理 (可以在每个块中检查，也可以在最后检查)
            # chunk.prompt_feedback 包含对提示的安全评估
            # chunk.candidates[0].finish_reason (如果有 candidates 属性)
            # chunk.candidates[0].safety_ratings

            if hasattr(chunk, 'prompt_feedback') and chunk.prompt_feedback and chunk.prompt_feedback.block_reason:
                reason = chunk.prompt_feedback.block_reason
                reason_msg = chunk.prompt_feedback.block_reason_message or f"输入内容因安全原因 ({reason}) 被阻止。"
                log.warning(f"Gemini API: Prompt or part of it was blocked during streaming. Reason: {reason_msg}")
                if not accumulated_response_text: # 如果是第一个块就被阻止
                    return reason_msg # 提前返回

            if chunk_text:
                accumulated_response_text += chunk_text
                if stream_callback:
                    try:
                        stream_callback(chunk_text)
                    except Exception as cb_exc:
                        log.error(f"Stream callback error: {cb_exc}", exc_info=True)
            
            # 更细致地检查候选者的完成原因和安全评级 (如果可用)
            if hasattr(chunk, 'candidates') and chunk.candidates:
                for candidate in chunk.candidates:
                    if candidate.finish_reason == genai.types.FinishReason.SAFETY:
                        safety_message = "内容生成因安全原因被终止。"
                        # 尝试获取更详细的安全信息
                        # ratings_info = ", ".join([f"{rating.category.name}: {rating.probability.name}" for rating in candidate.safety_ratings])
                        # if ratings_info:
                        #     safety_message += f" 安全评级: [{ratings_info}]"
                        log.warning(safety_message)
                        # 根据策略，可以选择在这里停止并返回，或者继续处理已累积的文本
                        if not accumulated_response_text: # 如果还没有任何文本，则返回安全信息
                            return safety_message
                        # 否则，可能已经通过 stream_callback 发送了部分内容
                        # 可以在累积文本后附加一个警告

        log.info("Gemini Chat Stream 调用成功。")
        if not accumulated_response_text.strip() and len(full_conversation) > 0:
            log.warning("Gemini stream returned no text content, though the call seemed successful.")
            # 这种情况可能表示所有生成的内容都被静默过滤，或者是一个非常简短的、无意义的回复
            # 可以返回一个通用提示，或者根据具体情况进一步分析 response_stream (如果 API 允许)
            return "模型没有返回可显示的文本内容。"
            
        return accumulated_response_text.strip()

        # 使用 genai.types 访问 Gemini 特定的异常，或者显式导入它们
    except genai.types.BlockedPromptException as bpe: # <--- 修改：使用 genai.types
        log.error(f"Gemini API error: Prompt was blocked before generation. {bpe.args}", exc_info=False)
        return "您的提问内容因安全原因被完全阻止。"
    except genai.types.StopCandidateException as sce: # <--- 修改：使用 genai.types
        log.error(f"Gemini API error: Candidate generation stopped. {sce.args}", exc_info=False)
        if accumulated_response_text:
            return accumulated_response_text.strip() + "\n[内容可能因安全或其他原因被截断]"
        return "内容生成因故停止。"
    # 使用导入的 google_api_exceptions 别名访问核心 API 异常
    except google_api_exceptions.InvalidArgument as iae: # <--- 修改
        log.error(f"Gemini API error: Invalid argument. {iae}", exc_info=True)
        if "contents" in str(iae).lower() or "role" in str(iae).lower():
            return f"请求格式错误，请检查对话历史和提示的结构。错误: {iae}"
        return f"请求参数无效。错误: {iae}"
    except google_api_exceptions.PermissionDenied as pde: # <--- 修改
        log.error(f"Gemini API error: Permission denied. Check API key and API enablement. {pde}", exc_info=True)
        return "Gemini API 密钥无效或权限不足，或者API未在项目中启用。"
    except google_api_exceptions.ResourceExhausted as ree: # <--- 修改
        log.error(f"Gemini API error: Resource exhausted (e.g., quota). {ree}", exc_info=True)
        return "Gemini API 资源不足（例如已达到配额），请稍后再试或检查您的配额。"
    except google_api_exceptions.DeadlineExceeded as dee: # <--- 修改
        log.error(f"Gemini API error: Deadline exceeded. {dee}", exc_info=True)
        return "连接 Gemini 服务超时，请检查网络连接或稍后再试。"
    except google_api_exceptions.ServiceUnavailable as sue: # <--- 修改
        log.error(f"Gemini API error: Service unavailable. {sue}", exc_info=True)
        return "Gemini 服务当前不可用，请稍后再试。"
    except Exception as e:
        log.error(f"Unexpected error during Gemini API call: {e}", exc_info=True)
        return f"调用 Gemini 服务时发生未知错误: {type(e).__name__}"










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

def chat_only_stream(prompt: str, history: Optional[List[Dict[str, Any]]] = None, stream_callback=None) -> Dict[str, Any]:
    """
    根据 settings.image_analysis_provider 调用对应的聊天模型，支持流式输出。

    Args:
        prompt: 当前用户的输入。
        history: 对话历史列表 (可选)。
        stream_callback: 接收流式输出块的回调函数。

    Returns:
        包含 provider 和 message 的字典。
    """
    provider = settings.image_analysis_provider or "none"
    log.info(f"Dispatching stream chat request to provider: {provider}")

    try:
        msg = ""
        if provider == "openai" and settings.openai_api_key:
            msg = _chat_openai_stream(prompt, history, stream_callback)
        elif provider == "gemini" and settings.gemini_api_key:
            msg = _chat_gemini_stream(prompt, history, stream_callback)
        else:
            log.warning("No chat provider configured or API key missing.")
            return {"provider": "none", "message": "聊天功能未启用或未配置 API Key。"}

        return {"provider": provider, "message": msg}

    except Exception as exc:
        log.exception(f"Stream chat failed using provider '{provider}': {exc}")
        return {"provider": "error", "message": f"与 AI ({provider}) 通信时出错: {str(exc)}"}

# --- 导出 ---
# 确保外部模块只能导入 chat_only 函数
__all__ = ["chat_only", "chat_only_stream"]

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
