# -*- coding: utf-8 -*-
"""
web_server.py (Refactored for Async Operations and Multimodal Support)
"""
import os
import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from gevent import monkey
monkey.patch_all()
import gevent # noqa E402
from gevent import lock # noqa E402

import base64
import io
import json
import logging
import time
import tempfile
from typing import Any, Dict, List, Optional # noqa E402
import uuid # noqa E402

from flask import Flask, jsonify, request, send_from_directory, render_template, abort, url_for# noqa E402
from flask_cors import CORS # noqa E402
from flask_socketio import SocketIO, emit # noqa E402
from gtts import gTTS

from PIL import Image # noqa E402
from werkzeug.utils import secure_filename # noqa E402

from core.settings import settings # noqa E402; settings 模块会负责日志的初始配置
from core.chat import chat_only, chat_only_stream # noqa E402
from core.analysis import analyze_image # noqa E402
from core.constants import ALL_AVAILABLE_MODELS, get_default_model_for_provider, ModelProvider # noqa E402

# --- 获取已配置的 logger ---
# settings.py 中已经用 force=True 配置了根 logger，这里获取的 log 会继承这些配置
log = logging.getLogger(__name__)

try:
    from core.voice import transcribe_audio
except ImportError:
    init_log = logging.getLogger(__name__ + "_voice_init_fallback")
    init_log.warning("core.voice module or transcribe_audio function not found. Voice processing will use placeholders.")
    def transcribe_audio(audio_path: Path, language_code: str = "zh-CN") -> Optional[str]: # type: ignore
        fallback_log = logging.getLogger(__name__ + ".voice_transcribe_fallback")
        fallback_log.error("transcribe_audio function is not available (ImportError). Returning placeholder.")
        return f"Placeholder STT for {audio_path.name}"

ROOT_DIR = Path(__file__).parent.resolve()
SAVE_DIR = PROJECT_ROOT / 'screenshots'
SAVE_DIR.mkdir(exist_ok=True)

ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
ALLOWED_TEXT_EXT = ['.txt', '.md', '.py', '.js', '.css', '.html', '.json', '.csv', '.log', '.xml', '.yaml', '.yml']
MAX_TEXT_FILE_CHARS = settings.MAX_TEXT_FILE_CHARS

HISTORY: List[Dict[str, Any]] = []
HISTORY_LOCK = lock.BoundedSemaphore()

app = Flask(
    __name__,
    template_folder=str(ROOT_DIR / 'templates'),
    static_folder=str(ROOT_DIR / 'static')
)

# --- CORS Configuration ---
_default_cors = ["http://127.0.0.1:5000", "http://localhost:5173"] # Vite dev server
if settings.external_url:
    _default_cors.append(settings.external_url.rstrip('/'))

cors_origins_to_use = list(set(_default_cors)) # Start with defaults, ensure uniqueness

if settings.cors_allowed_origins:
    env_cors_str = settings.cors_allowed_origins
    parsed_env_origins = []
    try:
        # Try to parse as JSON first (e.g., '["url1", "url2"]')
        loaded_json = json.loads(env_cors_str)
        if isinstance(loaded_json, list):
            parsed_env_origins = [str(origin).strip() for origin in loaded_json if isinstance(origin, str) and str(origin).strip()]
        else:
            log.warning(f"CORS_ALLOWED_ORIGINS ('{env_cors_str}') is valid JSON but not a list. Interpreting as comma-separated string.")
            parsed_env_origins = [origin.strip() for origin in env_cors_str.split(',') if origin.strip()]
    except json.JSONDecodeError:
        # If not valid JSON, assume it's a comma-separated string (e.g., "url1,url2")
        log.debug(f"CORS_ALLOWED_ORIGINS ('{env_cors_str}') is not JSON. Interpreting as comma-separated string.")
        parsed_env_origins = [origin.strip() for origin in env_cors_str.split(',') if origin.strip()]

    if parsed_env_origins:
        # You might want to merge with defaults or replace them.
        # For simplicity, let's say settings override defaults if provided and valid.
        cors_origins_to_use = list(set(parsed_env_origins + _default_cors)) # Merge and ensure uniqueness
        log.info(f"Processed CORS_ALLOWED_ORIGINS from settings. Combined with defaults: {cors_origins_to_use}")
    else:
        log.warning(f"CORS_ALLOWED_ORIGINS in settings ('{settings.cors_allowed_origins}') was empty or invalid after parsing. Using defaults: {cors_origins_to_use}")
else:
    log.info("CORS_ALLOWED_ORIGINS not defined in settings. Using default CORS origins.")

# Ensure the Vite dev server origin is always present if not already
vite_dev_origin = "http://localhost:5173"
if vite_dev_origin not in cors_origins_to_use:
    cors_origins_to_use.append(vite_dev_origin)
    log.info(f"Explicitly added Vite dev origin '{vite_dev_origin}' to final CORS list.")

log.info(f"--- Final effective CORS origins for Flask-CORS & Flask-SocketIO: {cors_origins_to_use} ---")
CORS(app, origins=cors_origins_to_use, supports_credentials=True)

socketio = SocketIO(
    app,
    cors_allowed_origins=cors_origins_to_use, # CRITICAL: This must be a list of origin strings
    async_mode="gevent",
    ping_timeout=60,
    ping_interval=25,
    logger=settings.debug_mode, # Enable socketio logs if debug_mode is true
    engineio_logger=settings.debug_mode # Enable engineio logs if debug_mode is true
)

def generate_tts(text: str, request_id: str) -> str:
    """
    用 gTTS 生成 MP3，返回静态文件 URL
    """
    out_dir = os.path.join(app.static_folder, 'tts')
    os.makedirs(out_dir, exist_ok=True)
    filename = f"{request_id}.mp3"
    path = os.path.join(out_dir, filename)
    # 生成 MP3
    tts = gTTS(text=text, lang='zh-cn')
    tts.save(path)
    # 直接用 settings.base_url 构造 URL，避免后台任务没有请求上下文
    base = settings.base_url.rstrip('/')
    return f"{base}/static/tts/{filename}"


# @socketio.on('chat_message')
# def handle_chat_message(payload):
#     request_id = payload['request_id']
#     # …调用你的 AI，得到完整回复 full_text …
#     full_text = call_your_ai(payload)

#     # 1) 发送文字回复（非流式）
#     emit('chat_response', {
#         'request_id': request_id,
#         'message': full_text,
#         'provider': payload.get('provider'),
#         'model_id': payload.get('model_id'),
#         'session_id': payload.get('session_id'),
#         'full_message': full_text
#     })

#     # 2) 生成 TTS 音频，并推给前端
#     audio_url = generate_tts(full_text, request_id)
#     emit('voice_answer_audio', {
#         'request_id': request_id,
#         'audio_url': audio_url
#     })

def check_token():
    if settings.dashboard_token and request.headers.get('Authorization') != f'Bearer {settings.dashboard_token}':
        log.warning(f"Unauthorized access attempt from {request.remote_addr} to {request.path}")
        abort(401, description="Unauthorized: Invalid or missing token.")

def _determine_model_and_provider(
    requested_model_id: Optional[str],
    requested_provider: Optional[str],
    default_provider_type: str = ModelProvider.OPENAI
) -> tuple[Optional[str], Optional[str]]:
    final_provider = requested_provider
    final_model_id = requested_model_id
    if not final_provider:
        if final_model_id:
            for p_name, models in ALL_AVAILABLE_MODELS.items():
                if final_model_id in models:
                    final_provider = p_name
                    log.debug(f"Inferred provider '{final_provider}' from model_id '{final_model_id}'.")
                    break
        if not final_provider:
            final_provider = settings.image_analysis_provider or default_provider_type
            log.warning(f"Provider not specified, falling back to '{final_provider}'.")
    if not final_model_id:
        final_model_id = get_default_model_for_provider(final_provider)
        log.warning(f"Model_id not specified for provider '{final_provider}', using default: '{final_model_id}'.")
    if not final_model_id or not final_provider or \
       final_provider not in ALL_AVAILABLE_MODELS or \
       final_model_id not in ALL_AVAILABLE_MODELS.get(final_provider, {}):
        log.error(f"CRITICAL: Could not determine valid model/provider. Req P: {requested_provider}, M: {requested_model_id}. Det P: {final_provider}, M: {final_model_id}")
        return None, None
    return final_model_id, final_provider

@app.route('/api/available_models', methods=['GET'])
def get_available_models_route():
    check_token()
    log.info("Request /api/available_models received.")
    try:
        if not ALL_AVAILABLE_MODELS or not isinstance(ALL_AVAILABLE_MODELS, dict):
            log.warning("/api/available_models: ALL_AVAILABLE_MODELS empty/invalid.")
            return jsonify({"error": "模型列表为空或加载失败。"}), 500
        return jsonify(ALL_AVAILABLE_MODELS), 200
    except Exception as e:
        log.exception("Error in /api/available_models endpoint")
        return jsonify({"error": f"获取模型列表时发生服务器内部错误: {str(e)}"}), 500

def _task_analyze_image(
    img_bytes: bytes, url: str, timestamp_ms: int, prompt: Optional[str] = None,
    request_id: Optional[str] = None, sid: Optional[str] = None,
    model_id: Optional[str] = None, provider_name: Optional[str] = None):
    task_id = request_id or str(uuid.uuid4())
    final_model_id, final_provider = _determine_model_and_provider(model_id, provider_name, settings.image_analysis_provider)
    if not final_model_id or not final_provider:
        err_msg = f"无法为图像分析确定有效的模型或提供商。请求的模型: {model_id}, 提供商: {provider_name}"
        log.error(f"[Task {task_id}] {err_msg}")
        emit_error_data = {'request_id': task_id, 'image_url': url, 'error': err_msg}
        if sid: socketio.emit('analysis_error', emit_error_data, to=sid)
        else: socketio.emit('analysis_error', emit_error_data)
        return
    log.info(f"[Task {task_id}] Analyzing image '{url}'. Model: {final_provider}/{final_model_id}, Prompt: '{str(prompt)[:30]}...'")
    try:
        analysis_prompt_to_use = prompt or "详细描述这张图片中的内容，并指出任何不寻常或有趣的地方。"
        result = analyze_image(img_bytes, prompt=analysis_prompt_to_use, model_id=final_model_id, provider=final_provider)
        analysis_text = str(result.get('message', '分析未返回消息文本。'))
        provider_used = result.get('provider', final_provider)
        model_id_used = result.get('model_id', final_model_id)
        entry = {'image_url': url, 'analysis': analysis_text, 'prompt': analysis_prompt_to_use,
                   'timestamp': timestamp_ms / 1000, 'provider': provider_used, 'model_id': model_id_used}
        with HISTORY_LOCK:
            HISTORY.append(entry)
            log.info(f"[Task {task_id}] Analysis successful ({provider_used}/{model_id_used}). History: {len(HISTORY)}")
        emit_data = {'request_id': task_id, 'provider': provider_used, 'model_id': model_id_used,
                       'image_url': url, 'analysis': analysis_text, 'prompt': analysis_prompt_to_use,
                       'timestamp': entry['timestamp']}
        if sid: socketio.emit('analysis_result', emit_data, to=sid)
        else: socketio.emit('analysis_result', emit_data)
        socketio.emit('new_screenshot', entry)
        log.debug(f"[Task {task_id}] Emitted 'analysis_result' and 'new_screenshot'.")
    except Exception as e:
        log.exception(f"[Task {task_id}] AI analysis failed for {url} using {final_provider}/{final_model_id}")
        error_data = {'request_id': task_id, 'image_url': url, 'error': str(e),
                        'provider': final_provider, 'model_id': final_model_id}
        if sid: socketio.emit('analysis_error', error_data, to=sid)
        else: socketio.emit('analysis_error', error_data)

def _task_chat_only(
    prompt: str,
    history: Optional[List[Dict[str, Any]]],
    request_id: str,
    sid: Optional[str], # Socket ID, 仅当通过Socket调用时存在
    use_streaming: bool,
    model_id: Optional[str] = None,
    provider_name: Optional[str] = None,
    image_base64: Optional[str] = None, # 旧的单图参数 (可能来自旧的socket调用)
    all_images_base64: Optional[List[str]] = None # 新的，来自 /chat_with_file 的图片列表
                                                # 也可用于新的 socket 调用 (如果 socket 也发列表)
):
    log.info(f"[_TASK_CHAT_ONLY Start] request_id: {request_id}, use_streaming: {use_streaming}") # 添加日志
    final_model_id, final_provider = _determine_model_and_provider(model_id, provider_name, ModelProvider.OPENAI)
    if not final_model_id or not final_provider:
        err_msg = f"无法为聊天确定有效的模型或提供商。请求的模型: {model_id}, 提供商: {provider_name}"
        log.error(f"[Task {request_id}] {err_msg}")
        emit_error_data = {'request_id': request_id, 'error': err_msg}
        if sid: socketio.emit('task_error', emit_error_data, to=sid)
        # else: # 对于HTTP请求，错误通常在HTTP响应中处理，但也可以考虑通过某个机制通知
        # log.error(f"[Task {request_id}] Task error for HTTP request: {err_msg}")
        return

    # --- 关键改动：整合图片数据 ---
    # 优先使用 all_images_base64 (来自 /chat_with_file 或新的socket image_data_array)
    # 如果 all_images_base64 不存在，但旧的 image_base64 存在，则使用旧的 (保持向后兼容)
    images_to_send_to_core: Optional[List[str]] = None
    if all_images_base64:
        images_to_send_to_core = all_images_base64
    elif image_base64: # 如果 all_images_base64 为 None 或空列表，但 image_base64 有值
        images_to_send_to_core = [image_base64] # 将单个图片包装成列表

    num_images_being_sent = len(images_to_send_to_core) if images_to_send_to_core else 0
    log.info(f"[Task {request_id}] Processing chat. Model: {final_provider}/{final_model_id}, Streaming: {use_streaming}, Images: {num_images_being_sent}, Prompt: '{prompt[:30]}...'")

    try:
        if use_streaming:
            full_response_text = ""
            def stream_callback(chunk: str):
                nonlocal full_response_text
                full_response_text += chunk
                emit_data_chunk = {'request_id': request_id, 'chunk': chunk, 'provider': final_provider, 'model_id': final_model_id}
                if sid: socketio.emit('chat_stream_chunk', emit_data_chunk, to=sid)
                else:# HTTP 请求的流式响应需要在API层面设计，这里暂时不直接emit
                    socketio.emit('chat_stream_chunk', emit_data_chunk)
                    log.debug(f"[Task {request_id}] HTTP Stream chunk broadcasted for debugging: {chunk[:30]}...")
                socketio.sleep(0.01) # 保持 gevent 的友好性

            # **将整合后的图片列表传递给核心函数**
            # 假设 chat_only_stream 接受一个名为 'images_base64' (复数) 的参数，期望是 List[str] 或 None
            chat_only_stream(
                prompt,
                history=history,
                stream_callback=stream_callback,
                model_id=final_model_id,
                provider=final_provider,
                images_base64=images_to_send_to_core # 传递列表
            )
            emit_data_end = {'request_id': request_id, 'provider': final_provider, 'model_id': final_model_id,
                               'full_message': full_response_text}
            if sid: socketio.emit('chat_stream_end', emit_data_end, to=sid)
            else: # HTTP 请求
                socketio.emit('chat_stream_end', emit_data_end)
            # else: # 对于HTTP请求的流式结束，通常不需要特定事件，客户端通过流结束自行判断
            log.debug(f"[Task {request_id}] Stream ended. Emitted 'chat_stream_end' if SID present.")
        else: # 非流式
            # **将整合后的图片列表传递给核心函数**
            # 假设 chat_only 接受一个名为 'images_base64' (复数) 的参数
            result = chat_only(
                prompt,
                history=history,
                model_id=final_model_id,
                provider=final_provider,
                images_base64=images_to_send_to_core # 传递列表
            )
            message_text = str(result.get('message', '')) or 'AI未返回有效内容'
            emit_data_response = {'request_id': request_id, 'message': message_text,
                                    'provider': final_provider, 'model_id': final_model_id}
            if sid: socketio.emit('chat_response', emit_data_response, to=sid)
            else:   socketio.emit('chat_response', emit_data_response)
            # 我们当前的 /chat_with_file 接口是异步启动任务，不直接返回AI结果
            log.debug(f"[Task {request_id}] Non-streaming response generated. Emitted 'chat_response' if SID present.")
            
    except Exception as e:
        log.exception(f"[Task {request_id}] Error in chat task with {final_provider}/{final_model_id} (Images: {num_images_being_sent}): {str(e)}")
        error_message = f"处理聊天请求时出错 (模型: {final_provider}/{final_model_id}, 图片数: {num_images_being_sent}): {str(e)}"
        emit_error_data = {'request_id': request_id, 'error': error_message, 'provider': final_provider, 'model_id': final_model_id}
        if sid: socketio.emit('task_error', emit_error_data, to=sid)
        # else: log.error(f"Task error for HTTP request {request_id}: {error_message}")


def _task_process_voice(
    temp_audio_path: Path,
    request_id: str,
    sid: Optional[str],
    model_id: Optional[str] = None,
    provider_name: Optional[str] = None,
    stt_provider: Optional[str] = None  # 新增 stt_provider 参数
):
    """
    处理语音文件：STT -> Chat -> TTS（仅语音对话使用）
    根据 settings.stt_provider（或前端传入的 stt_provider）选择 Google STT 或 Whisper。
    """
    # 如果前端指定了 stt_provider，就临时覆盖全局设置
    if stt_provider:
        settings.stt_provider = stt_provider

    # 确定用于聊天的模型和提供商
    final_chat_model_id, final_chat_provider = _determine_model_and_provider(
        model_id, provider_name, ModelProvider.OPENAI
    )

    log.info(
        f"[Task {request_id}] Processing voice file {temp_audio_path.name}. "
        f"Chat: {final_chat_provider}/{final_chat_model_id}, "
        f"STT Provider: {settings.stt_provider}"
    )

    transcript = None
    final_result_sent = False
    # stt_provider 只用于 emit 元数据，真正调用取决于 settings.stt_provider
    emit_stt_provider = settings.stt_provider

    try:
        # --- 1. STT 语音转文字 ---
        try:
            transcript = transcribe_audio(temp_audio_path)
            if transcript:
                log.info(f"[Task {request_id}] STT ({emit_stt_provider}) successful: '{transcript[:100]}...'" )
                stt_emit_data = {
                    'request_id': request_id,
                    'transcript': transcript,
                    'provider': emit_stt_provider
                }
                socketio.emit('stt_result', stt_emit_data, to=sid) if sid else socketio.emit('stt_result', stt_emit_data)
            else:
                log.warning(f"[Task {request_id}] STT returned empty result.")
                err_data = {
                    'request_id': request_id,
                    'error': '语音识别未返回结果',
                    'provider': emit_stt_provider
                }
                socketio.emit('stt_error', err_data, to=sid) if sid else socketio.emit('stt_error', err_data)
                return
        except Exception as stt_err:
            log.exception(f"[Task {request_id}] Error during STT: {stt_err}")
            err_data = {
                'request_id': request_id,
                'error': f"语音识别出错: {stt_err}",
                'provider': emit_stt_provider
            }
            socketio.emit('stt_error', err_data, to=sid) if sid else socketio.emit('stt_error', err_data)
            return

        # --- 2. AI 聊天响应 ---
        if not final_chat_model_id or not final_chat_provider:
            err_msg = "无法为语音转文字后的聊天确定AI模型。"
            log.error(f"[Task {request_id}] {err_msg}")
            err_data = {
                'request_id': request_id,
                'transcript': transcript,
                'stt_provider': emit_stt_provider,
                'error': err_msg,
                'chat_provider': 'error',
                'chat_model_id': 'error'
            }
            socketio.emit('chat_error', err_data, to=sid) if sid else socketio.emit('chat_error', err_data)
            final_result_sent = True
            return

        log.info(
            f"[Task {request_id}] Sending transcript to chat AI ({final_chat_provider}/{final_chat_model_id})..."
        )
        try:
            chat_result = chat_only(
                transcript,
                history=[],
                model_id=final_chat_model_id,
                provider=final_chat_provider
            )
            message_text = str(chat_result.get('message', 'AI 未返回有效回复。'))
            provider_used = chat_result.get('provider', final_chat_provider)
            model_used = chat_result.get('model_id', final_chat_model_id)

            log.info(f"[Task {request_id}] Chat successful ({provider_used}/{model_used}).")

            # 发送语音聊天回复
            response_data = {
                'request_id': request_id,
                'transcript': transcript,
                'stt_provider': emit_stt_provider,
                'chat_provider': provider_used,
                'chat_model_id': model_used,
                'message': message_text
            }
            socketio.emit('voice_chat_response', response_data, to=sid) if sid else socketio.emit('voice_chat_response', response_data)

            # --- 3. 生成语音音频并发送 ---
            with app.app_context():
                audio_url = generate_tts(message_text, request_id)

            tts_data = {
                'request_id': request_id,
                'audio_url': audio_url
            }
            socketio.emit('voice_answer_audio', tts_data, to=sid) if sid else socketio.emit('voice_answer_audio', tts_data)

            final_result_sent = True

        except Exception as chat_err:
            log.exception(f"[Task {request_id}] Chat AI call failed: {chat_err}")
            err_data = {
                'request_id': request_id,
                'transcript': transcript,
                'stt_provider': emit_stt_provider,
                'chat_provider': final_chat_provider,
                'chat_model_id': final_chat_model_id,
                'error': f"AI 聊天处理失败: {chat_err}"
            }
            socketio.emit('chat_error', err_data, to=sid) if sid else socketio.emit('chat_error', err_data)
            final_result_sent = True

    except Exception as e:
        log.exception(f"[Task {request_id}] Unhandled error in voice task: {e}")
        if not final_result_sent:
            socketio.emit('task_error', {
                'request_id': request_id,
                'error': '语音处理任务发生未知错误'
            }, to=sid) if sid else socketio.emit('task_error', {
                'request_id': request_id,
                'error': '语音处理任务发生未知错误'
            })

    finally:
        # 删除临时语音文件
        if temp_audio_path.exists():
            try:
                temp_audio_path.unlink(missing_ok=True)
                log.info(f"[Task {request_id}] Temp voice file deleted: {temp_audio_path}")
            except OSError as e_unlink:
                log.error(f"[Task {request_id}] Error deleting temp voice file: {e_unlink}")


@socketio.on_error()
def error_handler_socketio(e):
    log.error(f"Socket.IO Application Error: {e} (Event: {request.event if request else 'N/A'})", exc_info=True)
@socketio.on_error_default
def default_error_handler_socketio(e):
    log.error(f"Socket.IO Default/Transport Error: {e}", exc_info=True)

@socketio.on('connect')
def handle_connect():
    sid = request.sid # type: ignore
    remote_addr = request.remote_addr # type: ignore
    log.info(f"Client connected: SID {sid} from {remote_addr}")
    with HISTORY_LOCK:
        if HISTORY:
            log.debug(f"Sending history ({len(HISTORY)} items) to SID {sid}")
            socketio.emit('history', list(HISTORY), to=sid)
    try:
        primary_provider = settings.image_analysis_provider or ModelProvider.OPENAI
        default_model_for_primary = get_default_model_for_provider(primary_provider)
        socketio.emit('api_info', {'provider': primary_provider, 'default_model_id': default_model_for_primary or "N/A"}, to=sid)
    except Exception as e_api_info:
        log.error(f"Error getting API info for SID {sid}: {e_api_info}", exc_info=True)
        socketio.emit('api_info', {'provider': '获取失败', 'default_model_id': '获取失败'}, to=sid)

@socketio.on('disconnect')
def handle_disconnect():
    log.info(f"Client disconnected: SID {request.sid}.") # type: ignore

@socketio.on('request_screenshot_capture')
def handle_frontend_screenshot_request_socket():
    log.info(f"Server received 'request_screenshot_capture' from web client SID: {request.sid}.") # type: ignore
    socketio.emit('capture')
    log.info("Broadcasted 'capture' command (intended for GUI app).")

# web_server.py

@socketio.on('chat_message')
def handle_chat_message_socket(data: Dict[str, Any]):
    sid = request.sid
    log.info(f"Received 'chat_message' from SID: {sid}. Data Keys: {list(data.keys())}")
    if not isinstance(data, dict):
        log.warning(f"Invalid chat data format from SID {sid}")
        socketio.emit('task_error', {'message': 'Invalid request format.'}, to=sid); return # Changed from chat_error

    prompt = data.get('prompt', '').strip()
    history_data = data.get('history', [])
    client_request_id = data.get('request_id')
    
    # 正确处理前端传来的 use_streaming 参数：确保转换为布尔值
    use_streaming_str = str(data.get('use_streaming', 'true')).lower()
    use_streaming = use_streaming_str == 'true' or use_streaming_str == 'yes' or use_streaming_str == '1'
    
    log.info(f"聊天流式/非流式设置: use_streaming={use_streaming} (原始值：{data.get('use_streaming')})")
    
    selected_model_id = data.get('model_id')
    selected_provider = data.get('provider')

    # 旧的单图 image_data (保留，但优先用 image_data_array)
    single_image_base64_data = data.get('image_data')
    # 新的多图 image_data_array
    image_array_from_socket = data.get('image_data_array') # 前端发送的是 image_data_array

    # 整合图片数据
    images_for_task: Optional[List[str]] = None
    if image_array_from_socket and isinstance(image_array_from_socket, list):
        images_for_task = image_array_from_socket
        log.info(f"Chat (socket): Using image_data_array with {len(images_for_task)} images.")
    elif single_image_base64_data and isinstance(single_image_base64_data, str):
        images_for_task = [single_image_base64_data]
        log.info(f"Chat (socket): Using single image_data, wrapped into a list.")

    num_images = len(images_for_task) if images_for_task else 0
    log.info(f"Chat details (socket): SID={sid}, Prompt='{prompt[:30]}...', Streaming={use_streaming}, Model={selected_provider}/{selected_model_id}, Images: {num_images}")

    if not prompt and not images_for_task: # 如果没有文本也没有任何图片
        log.warning(f"Empty prompt and no images in chat_message from SID {sid}")
        socketio.emit('task_error', {'request_id': client_request_id, 'error': 'Prompt or images cannot be empty.'}, to=sid); return

    request_id_to_use = client_request_id or str(uuid.uuid4())
    log.info(f"[Req {request_id_to_use}] Starting background task for chat from SID {sid} (via socket)")

    socketio.start_background_task(
        target=_task_chat_only,
        prompt=prompt,
        history=history_data,
        request_id=request_id_to_use,
        sid=sid,
        use_streaming=use_streaming,
        model_id=selected_model_id,
        provider_name=selected_provider,
        # 传递整合后的图片列表给 _task_chat_only 的 all_images_base64 参数
        all_images_base64=images_for_task,
        image_base64=None # 因为已经包含在 all_images_base64 中（如果只有一个的话）
    )
    socketio.emit('chat_processing', {'request_id': request_id_to_use, 'status': 'processing'}, to=sid)
@app.route('/')
def index_route():
    return render_template('dashboard.html', token=settings.dashboard_token or "")

@app.route('/screenshots/<path:filename>')
def screenshots_route(filename: str):
    log.debug(f"Request for screenshot: {filename}")
    safe_filename = secure_filename(Path(filename).name)
    if not safe_filename: abort(400, "Invalid filename.")
    file_path = (SAVE_DIR / safe_filename).resolve()
    if not file_path.is_file() or not str(file_path).startswith(str(SAVE_DIR.resolve())):
        abort(404, "Screenshot not found.")
    log.info(f"Serving screenshot: {safe_filename}")
    try:
        return send_from_directory(str(SAVE_DIR.resolve()), safe_filename, as_attachment=False)
    except Exception as e_serve:
        log.error(f"Error serving screenshot {safe_filename}: {e_serve}", exc_info=True)
        abort(500, "Error serving file.")

@app.route('/upload_raw', methods=['POST'])
def upload_raw_route():
    check_token()
    request_id = str(uuid.uuid4())
    log.info(f"[Req {request_id}] Request /upload_raw received.")
    data = request.get_json(silent=True)
    if not data or 'image' not in data:
        log.warning(f"[Req {request_id}] /upload_raw: Missing JSON image data.")
        return jsonify({'error': 'Missing image data in JSON', 'request_id': request_id}), 400
    b64_string = data['image']
    selected_model_id = data.get('model_id')
    selected_provider = data.get('provider')
    user_prompt = data.get('prompt')
    try:
        if ',' in b64_string: b64_data = b64_string.split(',', 1)[1]
        else: b64_data = b64_string
        b64_padded = b64_data + '=' * (-len(b64_data) % 4)
        img_bytes = base64.b64decode(b64_padded)
    except Exception as e_b64:
        log.error(f"[Req {request_id}] /upload_raw: Invalid base64: {e_b64}", exc_info=True)
        return jsonify({'error': 'Invalid base64 image data', 'request_id': request_id}), 400
    timestamp_ms = int(time.time() * 1000)
    filename = f'raw_{timestamp_ms}.png'
    save_path = SAVE_DIR / filename
    try:
        save_path.write_bytes(img_bytes)
        log.info(f"[Req {request_id}] Raw screenshot saved: {save_path}")
    except IOError as e_io:
        log.error(f"[Req {request_id}] Failed to save raw screenshot: {e_io}", exc_info=True)
        return jsonify({'error': 'Failed to save image file', 'request_id': request_id}), 500
    url = f'/screenshots/{filename}'
    log.info(f"[Req {request_id}] AI analysis for {filename}. Model: {selected_provider}/{selected_model_id}, Prompt: '{str(user_prompt)[:30]}...'")
    socketio.start_background_task(
        target=_task_analyze_image, img_bytes=img_bytes, url=url, timestamp_ms=timestamp_ms,
        prompt=user_prompt, request_id=request_id, sid=None,
        model_id=selected_model_id, provider_name=selected_provider)
    return jsonify({'status': 'processing', 'message': 'Upload accepted, analysis started.', 'request_id': request_id, 'image_url': url}), 202

@app.route('/upload_screenshot', methods=['POST'])
def upload_screenshot_route():
    check_token()
    request_id = str(uuid.uuid4())
    log.info(f"[Req {request_id}] Request /upload_screenshot received.")
    if 'image' not in request.files:
        return jsonify({'error': 'Missing image file', 'request_id': request_id}), 400
    uploaded_file = request.files['image']
    prompt = request.form.get('prompt')
    selected_model_id = request.form.get('model_id')
    selected_provider = request.form.get('provider')
    original_filename = secure_filename(uploaded_file.filename or 'uploaded.png')
    timestamp_ms = int(time.time() * 1000)
    base, ext = os.path.splitext(original_filename)
    save_ext = ext.lower() if ext.lower() in ALLOWED_IMAGE_EXT else '.png'
    filename = f'form_upload_{timestamp_ms}_{base[:20].replace(" ", "_")}{save_ext}'
    save_path = SAVE_DIR / filename
    try: uploaded_file.save(str(save_path))
    except IOError as e_io:
        log.error(f"Save error for /upload_screenshot: {e_io}", exc_info=True)
        return jsonify({'error': 'Failed to save image', 'request_id': request_id}), 500
    img_bytes_content = save_path.read_bytes()
    url = f'/screenshots/{filename}'
    if img_bytes_content:
        log.info(f"[Req {request_id}] AI analysis for form-uploaded {filename}. Model: {selected_provider}/{selected_model_id}, Prompt: '{str(prompt)[:30]}...'")
        socketio.start_background_task(
            target=_task_analyze_image, img_bytes=img_bytes_content, url=url, timestamp_ms=timestamp_ms,
            prompt=prompt, request_id=request_id, sid=None,
            model_id=selected_model_id, provider_name=selected_provider)
        return jsonify({'status': 'processing', 'image_url': url, 'message': 'Upload accepted, analysis started.', 'request_id': request_id}), 202
    return jsonify({'error': 'Failed to process image after save', 'request_id': request_id}), 500

@app.route('/crop_image', methods=['POST'])
def crop_image_route():
    check_token()
    request_id = str(uuid.uuid4())
    log.info(f"[Req {request_id}] Request /crop_image received.")
    try:
        image_url_path = request.form.get('image_url')
        custom_prompt = request.form.get('prompt')
        selected_model_id = request.form.get('model_id')
        selected_provider = request.form.get('provider')
        if not image_url_path or not image_url_path.startswith('/screenshots/'):
            return jsonify({'error': 'Missing or invalid image_url', 'request_id': request_id}), 400
        original_filename = secure_filename(Path(image_url_path).name)
        if not original_filename: return jsonify({'error': 'Invalid image filename', 'request_id': request_id}), 400
        original_image_path = (SAVE_DIR / original_filename).resolve()
        if not str(original_image_path).startswith(str(SAVE_DIR.resolve())) or not original_image_path.is_file():
            return jsonify({'error': f'Image file not found or invalid path: {original_filename}', 'request_id': request_id}), 404
        x,y,w,h = (int(float(request.form.get(k,0))) for k in ['x','y','width','height'])
        if w <= 0 or h <= 0 : return jsonify({'error': 'Invalid crop dimensions', 'request_id': request_id}), 400
        with Image.open(original_image_path) as img:
            box_x1,box_y1,box_x2,box_y2 = max(0,x), max(0,y), min(img.width, x+w), min(img.height, y+h)
            if box_x1 >= box_x2 or box_y1 >= box_y2:
                 return jsonify({'error': 'Calculated crop area invalid', 'request_id': request_id}), 400
            cropped_img_obj = img.crop((box_x1, box_y1, box_x2, box_y2))
        timestamp_ms_crop = int(time.time() * 1000)
        base_name, orig_ext = os.path.splitext(original_filename)
        save_ext_crop = orig_ext.lower() if orig_ext.lower() in Image.registered_extensions() else '.png' # type: ignore
        crop_filename_new = f'{base_name[:20].replace(" ", "_")}_crop_{timestamp_ms_crop}{save_ext_crop}'
        crop_save_path = SAVE_DIR / crop_filename_new
        save_format_pillow = Image.EXTENSION.get(save_ext_crop.lower(), 'PNG') # type: ignore
        cropped_img_obj.save(crop_save_path, format=save_format_pillow)
        crop_image_url = f'/screenshots/{crop_filename_new}'
        with io.BytesIO() as output_buffer:
            cropped_img_obj.save(output_buffer, format=save_format_pillow)
            cropped_img_bytes = output_buffer.getvalue()
        if cropped_img_bytes and crop_image_url:
            final_analysis_prompt = custom_prompt or f'请解读这张裁剪自 {original_filename} 的图片区域。'
            log.info(f"[Req {request_id}] AI analysis for cropped {crop_filename_new}. Model: {selected_provider}/{selected_model_id}, Prompt: '{str(final_analysis_prompt)[:30]}...'")
            socketio.start_background_task(
                target=_task_analyze_image, img_bytes=cropped_img_bytes, url=crop_image_url,
                timestamp_ms=timestamp_ms_crop, prompt=final_analysis_prompt, request_id=request_id, sid=None,
                model_id=selected_model_id, provider_name=selected_provider)
            return jsonify({'status': 'processing', 'message': 'Crop successful, analysis started.', 'image_url': crop_image_url,
                            'width': cropped_img_obj.width, 'height': cropped_img_obj.height,
                            'original_image_url': image_url_path, 'request_id': request_id}), 202
        return jsonify({'error': 'Failed to process cropped image', 'request_id': request_id}), 500
    except Exception as e_crop:
        log.exception(f"[Req {request_id}] Error during /crop_image for {request.form.get('image_url', 'Unknown image')}")
        return jsonify({'error': f'Failed crop/analyze: {str(e_crop)}', 'request_id': request_id}), 500

@app.route('/process_voice', methods=['POST'])
def process_voice_route():
    check_token()
    client_req_id = request.form.get('request_id')
    request_id = client_req_id or str(uuid.uuid4())

    # 读取前端可选的 STT 提供商参数
    stt_provider = request.form.get('stt_provider', None)
    log.info(f"[Req {request_id}] Request /process_voice received. stt_provider={stt_provider}")

    if 'audio' not in request.files:
        return jsonify({'error': 'Missing audio file', 'request_id': request_id}), 400

    audio_file = request.files['audio']
    selected_model_id = request.form.get('model_id')
    selected_provider = request.form.get('provider')
    client_socket_id = request.form.get('socket_id')

    original_fn_base = secure_filename(Path(audio_file.filename).stem if audio_file.filename else "audio")
    timestamp_ms_str = str(int(time.time() * 1000))
    temp_filename = f'voice_{timestamp_ms_str}_{request_id[:8]}_{original_fn_base[:30]}.wav'
    temp_save_path = SAVE_DIR / temp_filename

    try:
        audio_file.save(str(temp_save_path))
    except Exception as e_save_audio:
        log.exception(f"Save error for /process_voice: {e_save_audio}")
        return jsonify({
            'error': f'保存语音文件失败: {str(e_save_audio)}',
            'request_id': request_id
        }), 500

    log.info(
        f"[Req {request_id}] Voice processing for {temp_save_path.name}. "
        f"Chat Model: {selected_provider}/{selected_model_id}, "
        f"STT Provider: {stt_provider}, Target SID: {client_socket_id or 'None'}"
    )

    socketio.start_background_task(
        target=_task_process_voice,
        temp_audio_path=temp_save_path,
        request_id=request_id,
        sid=client_socket_id,
        model_id=selected_model_id,
        provider_name=selected_provider,
        stt_provider=stt_provider    # 传递 STT 提供商
    )

    return jsonify({
        'status': 'processing',
        'message': '语音已接收，正在后台处理...',
        'request_id': request_id,
        'temp_filename': temp_save_path.name
    }), 202


@app.route('/chat', methods=['POST'])
def http_chat_route():
    check_token()
    request_id = str(uuid.uuid4())
    log.info(f"[Req {request_id}] HTTP POST to /chat received.")
    data = request.get_json(silent=True)
    if not data or not data.get('prompt','').strip():
        return jsonify({'error': 'Missing or empty prompt in JSON', 'request_id': request_id}), 400
    prompt = data['prompt'].strip()
    history_data = data.get('history', [])
    use_streaming = data.get('use_streaming', False)
    selected_model_id = data.get('model_id')
    selected_provider = data.get('provider')
    image_base64_data = data.get('image_data')
    log.info(f"[Req {request_id}] HTTP chat. Model: {selected_provider}/{selected_model_id}, Img: {'Yes' if image_base64_data else 'No'}, Streaming: {use_streaming}, Prompt: '{prompt[:30]}...'")
    socketio.start_background_task(
        target=_task_chat_only, prompt=prompt, history=history_data, request_id=request_id, sid=None,
        use_streaming=use_streaming, model_id=selected_model_id, provider_name=selected_provider,
        image_base64=image_base64_data)
    return jsonify({'status': 'processing', 'message': '请求已收到，AI正在后台处理...', 'request_id': request_id}), 202

@app.route('/chat_with_file', methods=['POST'])
def chat_with_file_route():
    check_token()
    form_request_id = request.form.get('request_id')
    if not form_request_id:
        log.warning("/chat_with_file: Missing 'request_id' in form data.")
        return jsonify({'error': "Missing 'request_id' in form data"}), 400
    
    log.info(f"[Req {form_request_id}] HTTP POST to /chat_with_file received (unified media).")

    # --- 在这里添加日志 ---
    log.info(f"[CHAT WITH FILE ROUTE] Received form_request_id: {form_request_id}")
    # --- 日志添加结束 ---
    
    log.info(f"[Req {form_request_id}] HTTP POST to /chat_with_file received (unified media).")

    prompt_from_user = request.form.get('prompt', '').strip()
    history_json_str = request.form.get('history', '[]')
    selected_model_id = request.form.get('model_id')
    selected_provider = request.form.get('provider')
    use_streaming = request.form.get('use_streaming') == 'true'  # This checks if the checkbox is checked
    log.info(f"[CHAT_WITH_FILE] Received use_streaming_raw: '{use_streaming}', Converted use_streaming: {use_streaming}") # 添加日志
    # session_id_from_form = request.form.get('session_id') # 可选

    history_data = []
    try:
        history_data = json.loads(history_json_str)
        if not isinstance(history_data, list):
            history_data = []
    except json.JSONDecodeError:
        history_data = []
        log.warning(f"[Req {form_request_id}] Invalid history JSON: {history_json_str[:100]}")

    # 1. 处理上传的文件 (来自 <input type="file" name="files" multiple>)
    uploaded_file_objects = request.files.getlist("files")
    
    # 2. 处理粘贴的图片Base64数据 (来自 FormData 的 pasted_images_base64_json_array)
    pasted_images_base64_json = request.form.get("pasted_images_base64_json_array", "[]")
    direct_pasted_images_base64 = []
    try:
        parsed_pasted_images = json.loads(pasted_images_base64_json)
        if isinstance(parsed_pasted_images, list) and all(isinstance(item, str) for item in parsed_pasted_images):
            direct_pasted_images_base64 = parsed_pasted_images
        elif parsed_pasted_images: # 如果不是空列表但格式不对
             log.warning(f"[Req {form_request_id}] 'pasted_images_base64_json_array' was not a list of strings. Content: {pasted_images_base64_json[:200]}")
    except json.JSONDecodeError:
        if pasted_images_base64_json != "[]": # 避免空数组解析也报警告
            log.warning(f"[Req {form_request_id}] Invalid JSON for 'pasted_images_base64_json_array'. Content: {pasted_images_base64_json[:200]}")

    log.info(f"[Req {form_request_id}] Files from upload: {len(uploaded_file_objects)}, Base64 images from paste: {len(direct_pasted_images_base64)}, Prompt: '{prompt_from_user[:30]}...'")

    if not prompt_from_user and not uploaded_file_objects and not direct_pasted_images_base64:
        log.warning(f"[Req {form_request_id}] Request is empty (no prompt, files, or pasted images).")
        return jsonify({'error': 'Request needs a prompt, files, or pasted images.', 'request_id': form_request_id}), 400

    temp_file_paths_to_cleanup: List[Path] = []
    
    # 用于收集所有图片 (Base64格式) 和所有文本内容
    final_all_images_base64: List[str] = list(direct_pasted_images_base64) # 直接加入粘贴的图片
    additional_text_parts_for_prompt: List[str] = []

    try:
        if uploaded_file_objects:
            for file_obj in uploaded_file_objects:
                if file_obj and file_obj.filename:
                    original_filename = secure_filename(file_obj.filename)
                    file_ext = os.path.splitext(original_filename)[1].lower()
                    log.debug(f"[Req {form_request_id}] Processing uploaded file '{original_filename}' (Ext: {file_ext})")

                    # 使用 with 确保临时文件在作用域结束时（如果delete=True）或出错时能尝试关闭
                    # 但我们需要路径列表，所以用 delete=False，并在 finally 中清理
                    with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext, dir=str(SAVE_DIR.resolve())) as temp_f:
                        file_obj.save(temp_f.name)
                        temp_file_path = Path(temp_f.name)
                        temp_file_paths_to_cleanup.append(temp_file_path)
                    
                    log.debug(f"[Req {form_request_id}] Temp file saved: {temp_file_path}")

                    if file_ext in ALLOWED_IMAGE_EXT:
                        log.debug(f"[Req {form_request_id}] Uploaded file '{original_filename}' is IMAGE. Converting to base64.")
                        img_bytes_content = temp_file_path.read_bytes()
                        image_base64_for_item = base64.b64encode(img_bytes_content).decode('utf-8')
                        final_all_images_base64.append(image_base64_for_item)
                    elif file_ext in ALLOWED_TEXT_EXT:
                        log.debug(f"[Req {form_request_id}] Uploaded file '{original_filename}' is TEXT. Reading content.")
                        file_content_str = temp_file_path.read_text(encoding='utf-8', errors='ignore')[:MAX_TEXT_FILE_CHARS]
                        if len(file_content_str) == MAX_TEXT_FILE_CHARS and temp_file_path.stat().st_size > MAX_TEXT_FILE_CHARS:
                            file_content_str += "\n[...文件内容过长，已截断...]"
                        
                        text_file_header = f"\n\n--- 用户上传的文本文件: {original_filename} ---\n"
                        text_file_content = file_content_str
                        additional_text_parts_for_prompt.append(f"{text_file_header}{text_file_content}\n--- 文件结束 ---")
                    else:
                        log.warning(f"[Req {form_request_id}] Unsupported uploaded file type: {original_filename}")
                        unsupported_file_info = f"\n\n[用户上传了文件: {original_filename} (类型: {file_ext}, 不支持内容预览)]"
                        additional_text_parts_for_prompt.append(unsupported_file_info)
        
        # 整合所有文本内容
        final_prompt_for_ai = prompt_from_user
        if additional_text_parts_for_prompt:
            final_prompt_for_ai += "".join(additional_text_parts_for_prompt)
            
        log.info(f"[Req {form_request_id}] Starting AI task. Total images: {len(final_all_images_base64)}. Final prompt snippet: '{final_prompt_for_ai[:100]}...'")
        
        socketio.start_background_task(
            target=_task_chat_only,
            prompt=final_prompt_for_ai,
            history=history_data,
            request_id=form_request_id,
            sid=None, # HTTP 请求没有 sid
            use_streaming=use_streaming, # 假设统一使用流式，或从请求参数获取
            model_id=selected_model_id,
            provider_name=selected_provider,
            # **传递整合后的图片Base64列表**
            all_images_base64=final_all_images_base64 if final_all_images_base64 else None
        )
        return jsonify({'status': 'processing', 'message': '请求已收到，AI正在后台处理...', 'request_id': form_request_id}), 202

    except Exception as e_unified_chat:
        log.exception(f"[Req {form_request_id}] Error in unified /chat_with_file processing")
        return jsonify({"error": f"处理请求时发生内部错误: {type(e_unified_chat).__name__} - {str(e_unified_chat)}", 'request_id': form_request_id}), 500
    finally:
        for path_to_delete in temp_file_paths_to_cleanup:
            if path_to_delete and path_to_delete.exists():
                try:
                    path_to_delete.unlink(missing_ok=True)
                    log.debug(f"[Req {form_request_id}] Cleaned up temp file {path_to_delete}.")
                except OSError as e_unlink:
                    log.error(f"[Req {form_request_id}] Error deleting temp file {path_to_delete}: {e_unlink}")


@app.route('/request_screenshot', methods=['POST'])
def request_screenshot_post_route():
    check_token()
    log.info("HTTP POST to /request_screenshot received.")
    socketio.emit('capture'); return '', 204

@app.route('/api_info', methods=['GET'])
def api_info_route():
    check_token()
    primary_provider = settings.image_analysis_provider or ModelProvider.OPENAI
    default_model_id = get_default_model_for_provider(primary_provider)
    log.info(f"Returning API info (primary: {primary_provider}, default_model: {default_model_id}) via /api_info (GET).")
    return jsonify({'provider': primary_provider, 'default_model_id': default_model_id or "N/A"})

def main():
    host = settings.server_host
    port = settings.server_port
    debug_flask = settings.debug_mode
    if host == "0.0.0.0" and not settings.dashboard_token:
        log.warning("⚠️ SECURITY WARNING: Server on 0.0.0.0 without token!")
    
    # 确保在应用启动时，settings 已经加载并且日志已基于其配置
    log.info(f"--- Starting Flask-SocketIO Server (PID: {os.getpid()}) ---")
    log.info(f"Flask Host: {host}, Port: {port}, Flask Debug Mode: {debug_flask}")
    log.info(f"Dashboard Auth: {'ENABLED' if settings.dashboard_token else 'DISABLED'}")
    log.info(f"Screenshot Dir: {SAVE_DIR.resolve()}")
    log.info(f"CORS Origins (used by SocketIO & Flask-CORS): {cors_origins_to_use}")
    log.info(f"OpenAI Key: {'Set' if settings.openai_api_key else 'Not Set'}. Gemini Key: {'Set' if settings.gemini_api_key else 'Not Set'}.")
    log.info(f"Primary Img Analysis Provider: {settings.image_analysis_provider}")
    log.info(f"MAX_TEXT_FILE_CHARS (from settings): {settings.MAX_TEXT_FILE_CHARS}")


    if host == "0.0.0.0":
        import socket
        try:
            s_ip = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s_ip.settimeout(0.1); s_ip.connect(("8.8.8.8", 80))
            local_ip = s_ip.getsockname()[0]; s_ip.close()
            log.info(f"Server accessible on local network at: http://{local_ip}:{port}")
        except Exception: log.info(f"Could not determine local network IP. Server likely at http://<your-machine-ip>:{port}")
    log.info(f"Listening on http://{host}:{port}")
    try:
        socketio.run(app, host=host, port=port, debug=debug_flask, use_reloader=debug_flask, allow_unsafe_werkzeug=(True if debug_flask else False))
    except Exception as e_run:
        log.critical(f"Failed to start Flask-SocketIO server: {e_run}", exc_info=True)
        sys.exit(1)

if __name__ == '__main__':
    # Settings and logging are configured when core.settings is imported.
    # Any pre-main logic that needs settings should be careful about import order.
    main()

@app.before_request
def log_request_info_before_request():
    if not request.path.startswith(('/static/', '/screenshots/')):
        log.debug(f"Req: {request.method} {request.path} from {request.remote_addr}")