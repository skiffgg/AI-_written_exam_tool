# -*- coding: utf-8 -*-
"""
web_server.py (Refactored for Async Operations)

Flask web server and Socket.IO handling for the AI Assistant Dashboard.
All potentially blocking external calls (STT, AI Analysis, AI Chat) are
handled asynchronously using background tasks.
"""

# 修改这行代码
# sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import os
import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))  # 使用 insert(0, ...) 而不是 append

import os
import base64
import gevent
from gevent import monkey, lock
monkey.patch_all()
import io
import json
import logging
import sys
import os
import time
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
import uuid

from flask import Flask, jsonify, request, send_from_directory, render_template, abort
from flask_cors import CORS
from flask_socketio import SocketIO, emit

from PIL import Image
from werkzeug.utils import secure_filename

from core.settings import settings

from core.chat import chat_only, chat_only_stream
from core.analysis import analyze_image



try:
    from core.voice import transcribe_audio
except ImportError:
    log = logging.getLogger(__name__)
    log.warning("core.voice module or transcribe_audio function not found. Voice processing will use placeholders.")
    def transcribe_audio(audio_path: Path, language_code: str = "zh-CN") -> Optional[str]:
        log.error("transcribe_audio function is not available (ImportError). Returning placeholder.")
        return f"Placeholder STT for {audio_path.name}"

import logging

logging.basicConfig(level=logging.DEBUG)  # ✅ 设置全局日志级别为 DEBUG
log = logging.getLogger(__name__)        # ✅ 你的原 logger 获取


# 获取根 logger
root_logger = logging.getLogger()
root_logger.setLevel(logging.DEBUG)  # 强制设置日志等级

# 如果没有 handler（首次运行），手动添加一个控制台输出
if not root_logger.hasHandlers():
    handler = logging.StreamHandler()
    formatter = logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s')
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)

# 获取当前模块 logger
log = logging.getLogger(__name__)
log.setLevel(logging.DEBUG)  # 确保本模块输出 debug 级别


ROOT_DIR = Path(__file__).parent
SAVE_DIR = ROOT_DIR.parent / 'screenshots'
SAVE_DIR.mkdir(exist_ok=True)

ALLOWED_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
ALLOWED_TEXT_EXT = ['.txt', '.md', '.py', '.js', '.css', '.html', '.json', '.csv', '.log', '.xml', '.yaml', '.yml']
MAX_TEXT_FILE_CHARS = 4000

HISTORY: List[Dict[str, Any]] = []
HISTORY_LOCK = lock.BoundedSemaphore()
TOKEN =''
app = Flask(
    __name__,
    template_folder=str((ROOT_DIR / 'templates').resolve()),
    static_folder=str((ROOT_DIR / 'static').resolve())
)

_default_cors = ["http://127.0.0.1:5000", "http://localhost:5173","http://localhost:5000"]
if settings.external_url:
    _default_cors.append(settings.external_url)

cors_origins_to_use = _default_cors
if settings.cors_allowed_origins:
    if isinstance(settings.cors_allowed_origins, list):
        cors_origins_to_use = settings.cors_allowed_origins
    else:
        log.warning(f"CORS_ALLOWED_ORIGINS in settings is not a list, using defaults. Value: {settings.cors_allowed_origins}")
else:
    log.warning("CORS_ALLOWED_ORIGINS not found or empty in settings, using defaults.")

log.info(f"Configuring CORS with origins: {cors_origins_to_use}")
CORS(app, origins=cors_origins_to_use)

socketio = SocketIO(
    app,
    cors_allowed_origins=cors_origins_to_use,
    async_mode="gevent",
    ping_timeout=60,
    ping_interval=25
)

def check_token():
    if TOKEN and request.headers.get('Authorization') != f'Bearer {TOKEN}':
        log.warning(f"Unauthorized access attempt from {request.remote_addr}")
        abort(401, description="Unauthorized: Invalid or missing token.")

def _task_analyze_image(img_bytes: bytes, url: str, timestamp_ms: int, prompt: Optional[str] = None, request_id: Optional[str] = None, sid: Optional[str] = None):
    """后台任务：调用 AI 分析图片并通过 SocketIO 发送结果"""
    task_id = request_id or str(uuid.uuid4())
    log.info(f"[Task {task_id}] Started: Analyzing image for URL {url}, SID: {sid}")
    try:
        analysis_prompt = prompt or "Describe this screenshot and highlight anything unusual."
        result = analyze_image(img_bytes, prompt=analysis_prompt)
        analysis_text = str(result.get('message', 'Analysis did not return a message.'))
        provider = result.get('provider', 'unknown')

        entry = {
            'image_url': url,
            'analysis': analysis_text,
            'prompt': analysis_prompt,
            'timestamp': timestamp_ms / 1000
        }

        with HISTORY_LOCK:
            HISTORY.append(entry)
            log.info(f"[Task {task_id}] Analysis successful ({provider}). History items: {len(HISTORY)}")

        if sid:
            socketio.emit('analysis_result', {
                'request_id': task_id,
                'provider': provider,
                'image_url': url,
                'analysis': analysis_text,
                'prompt': analysis_prompt,
                'timestamp': entry['timestamp']
            }, to=sid)
            log.debug(f"[Task {task_id}] Emitted 'analysis_result' to SID {sid}")
        else:
            socketio.emit('analysis_result', {
                'request_id': task_id,
                'provider': provider,
                'image_url': url,
                'analysis': analysis_text,
                'prompt': analysis_prompt,
                'timestamp': entry['timestamp']
            })
            log.debug(f"[Task {task_id}] Emitted 'analysis_result' to all clients")

        socketio.emit('new_screenshot', entry)
        log.debug(f"[Task {task_id}] Emitted 'new_screenshot' to all clients")

    except Exception as e:
        log.exception(f"[Task {task_id}] Error: AI analysis failed for image {url}")
        if sid:
            socketio.emit('analysis_error', {'request_id': task_id, 'image_url': url, 'error': str(e)}, to=sid)
        else:
            socketio.emit('analysis_error', {'request_id': task_id, 'image_url': url, 'error': str(e)})

def _task_chat_only(prompt: str, history: Optional[List[Dict[str, Any]]], request_id: str, sid: Optional[str], use_streaming: bool = True):
    """
    后台任务：调用 AI 聊天并通过 SocketIO 将结果发送给指定客户端
    支持流式和非流式两种模式
    """
    response_text = ""  # ← 先初始化
    log.info(f"[Task {request_id}] Started: Processing chat for SID {sid}. Prompt: '{prompt[:50]}...'")
    
    try:
        if use_streaming:
            # 流式输出模式
            def stream_callback(chunk: str):
                if sid:
                    socketio.emit('chat_stream_chunk', {
                        'request_id': request_id,
                        'chunk': chunk
                    }, to=sid)
                else:
                    socketio.emit('chat_stream_chunk', {
                        'request_id': request_id,
                        'chunk': chunk
                    })
                # 给 socketio 一点时间发送数据
                socketio.sleep(0.01)
            
            # 调用支持流式输出的聊天函数
            result = chat_only_stream(prompt, history=history, stream_callback=stream_callback)
            message_text = result.get('message', '') or 'AI未返回有效内容'
            provider = result.get('provider', 'AI')
            
            # 发送完成信号
            if sid:
                socketio.emit('chat_stream_end', {
                    'request_id': request_id,
                    'provider': provider,
                    'full_message': message_text
                }, to=sid)
                log.debug(f"[Task {request_id}] Emitted 'chat_stream_end' to SID {sid}")
            else:
                socketio.emit('chat_stream_end', {
                    'request_id': request_id,
                    'provider': provider,
                    'full_message': message_text
                })
                log.debug(f"[Task {request_id}] Emitted 'chat_stream_end' to all clients")
        else:
            # 非流式输出模式（原始模式）
            result = chat_only(prompt, history=history)
            message_text = str(result.get('message')) or 'AI未返回有效内容'
            provider = result.get('provider', 'AI')
            
            # 发送完整响应
            if sid:
                socketio.emit('chat_response', {
                    'request_id': request_id,
                    'message': message_text,
                    'provider': provider
                }, to=sid)
                log.debug(f"[Task {request_id}] Emitted 'chat_response' to SID {sid}")
            else:
                socketio.emit('chat_response', {
                    'request_id': request_id,
                    'message': message_text,
                    'provider': provider
                })
                log.debug(f"[Task {request_id}] Emitted 'chat_response' to all clients")
    except Exception as e:
        log.exception(f"[Task {request_id}] Error in chat task: {str(e)}")
        error_message = f"处理聊天请求时出错: {str(e)}"
        
        # 发送错误消息
        if sid:
            socketio.emit('task_error', {
                'request_id': request_id,
                'error': error_message
            }, to=sid)
        else:
            socketio.emit('task_error', {
                'request_id': request_id,
                'error': error_message
            })

def _task_process_voice(temp_audio_path: Path, request_id: str, sid: Optional[str]):
    """后台任务：执行 STT (调用 core.voice) 并调用 AI 聊天"""
    log.info(f"[Task {request_id}] Started: Processing voice file {temp_audio_path.name} for SID {sid}")
    transcript = None
    final_result_sent = False
    stt_provider = "google"
    chat_provider = "unknown"

    try:
        try:
            transcript = transcribe_audio(temp_audio_path)
            if transcript is not None:
                log.info(f"[Task {request_id}] STT ({stt_provider}) successful: '{transcript[:100]}...'")
                if sid:
                    socketio.emit('stt_result', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'provider': stt_provider
                    }, to=sid)
                else:
                    socketio.emit('stt_result', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'provider': stt_provider
                    })
            else:
                log.warning(f"[Task {request_id}] STT ({stt_provider}) did not return transcript.")
                if sid:
                    socketio.emit('stt_error', {
                        'request_id': request_id,
                        'error': '语音识别未返回结果',
                        'provider': stt_provider
                    }, to=sid)
                else:
                    socketio.emit('stt_error', {
                        'request_id': request_id,
                        'error': '语音识别未返回结果',
                        'provider': stt_provider
                    })
                return
        except Exception as stt_err:
            log.exception(f"[Task {request_id}] Error during STT call for {temp_audio_path.name}")
            if sid:
                socketio.emit('stt_error', {
                    'request_id': request_id,
                    'error': f"语音识别过程中出错: {str(stt_err)}",
                    'provider': stt_provider
                }, to=sid)
            else:
                socketio.emit('stt_error', {
                    'request_id': request_id,
                    'error': f"语音识别过程中出错: {str(stt_err)}",
                    'provider': stt_provider
                })
            return

        if transcript:
            log.info(f"[Task {request_id}] Sending transcript to chat AI...")
            try:
                chat_result = chat_only(transcript, history=[])
                message_text = str(chat_result.get('message', 'AI 未返回有效回复。'))
                chat_provider = chat_result.get('provider', 'unknown')
                log.info(f"[Task {request_id}] Chat successful ({chat_provider}) for SID {sid}.")

                if sid:
                    socketio.emit('voice_chat_response', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'stt_provider': stt_provider,
                        'chat_provider': chat_provider,
                        'message': message_text
                    }, to=sid)
                    final_result_sent = True
                else:
                    socketio.emit('voice_chat_response', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'stt_provider': stt_provider,
                        'chat_provider': chat_provider,
                        'message': message_text
                    })
                    log.warning(f"[Task {request_id}] SID not available for voice chat task.")
                    final_result_sent = True
            except Exception as chat_err:
                log.exception(f"[Task {request_id}] Chat AI call failed after STT")
                if sid:
                    socketio.emit('chat_error', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'stt_provider': stt_provider,
                        'provider': 'error',
                        'message': f"AI 聊天处理失败: {str(chat_err)}"
                    }, to=sid)
                    final_result_sent = True
                else:
                    socketio.emit('chat_error', {
                        'request_id': request_id,
                        'transcript': transcript,
                        'stt_provider': stt_provider,
                        'provider': 'error',
                        'message': f"AI 聊天处理失败: {str(chat_err)}"
                    })
                    log.error(f"[Task {request_id}] Cannot send chat_error: SID unknown.")
                    final_result_sent = True

    except Exception as e:
        log.exception(f"[Task {request_id}] Unhandled error in voice task")
        if sid and not final_result_sent:
            socketio.emit('task_error', {
                'request_id': request_id,
                'error': '语音处理任务发生未知错误'
            }, to=sid)
        elif not final_result_sent:
            socketio.emit('task_error', {
                'request_id': request_id,
                'error': '语音处理任务发生未知错误'
            })

    finally:
        if temp_audio_path and temp_audio_path.exists():
            try:
                temp_audio_path.unlink()
                log.info(f"[Task {request_id}] Temp voice file deleted: {temp_audio_path}")
            except OSError as e:
                log.error(f"[Task {request_id}] Error deleting temp voice file {temp_audio_path}: {e}")

@socketio.on_error()
def error_handler(e):
    log.error(f"Socket.IO Error: {e}")

@socketio.on_error_default
def default_error_handler(e):
    log.error(f"Socket.IO Default Error: {e}")

@socketio.on('connect')
def handle_connect():
    sid = request.sid
    remote_addr = request.remote_addr
    print("✅ 连接事件触发")
    log.info(f"Client connected: {sid} from {remote_addr}")
    with HISTORY_LOCK:
        if HISTORY:
            log.debug(f"Sending history ({len(HISTORY)} items) to {sid}")
            socketio.emit('history', list(HISTORY), to=sid)
    try:
        provider = settings.image_analysis_provider
        socketio.emit('api_info', {'provider': provider or '未知'}, to=sid)
    except Exception as e:
        log.error(f"Error getting API info for {sid}: {e}")
        socketio.emit('api_info', {'provider': '获取失败'}, to=sid)

@socketio.on('disconnect')
def handle_disconnect():
    log.info(f"Client disconnected: {request.sid}.")

# --- 添加到 web_server.py ---

@socketio.on('request_screenshot_capture')
def handle_frontend_screenshot_request(sid=None): # sid 是可选的，代表发送请求的前端客户端ID
    """处理来自网页前端的截图请求"""
    log.info(f"服务器收到来自网页端 (SID: {sid if sid else 'Unknown'}) 的 'request_screenshot_capture' 事件。")
    # 确认收到请求后，向所有客户端广播 'capture' 命令，
    # app.py (GUI 客户端) 应该会监听到这个命令。
    log.info("正在向 GUI 客户端发送 'capture' 命令...")
    socketio.emit('capture') # 广播 capture 事件
    # 注意：这里不需要给前端发送即时响应，前端通过后续收到的 'new_screenshot' 事件来得知截图完成

@socketio.on('chat_message')
def handle_chat_message(data):
    sid = request.sid
    log.info(f"Received 'chat_message' event from SID: {sid}")
    if not isinstance(data, dict):
        log.warning(f"Invalid chat data format from {sid}")
        socketio.emit('chat_error', {'message': 'Invalid request format.'}, to=sid)
        return
    
    prompt = data.get('prompt', '').strip()
    history_data = data.get('history', [])
    client_request_id = data.get('request_id')
    use_streaming = data.get('use_streaming', True)  # 从请求数据中获取 use_streaming 参数，默认为 True
    
    if not prompt:
        log.warning(f"Empty prompt in chat_message from {sid}")
        socketio.emit('chat_error', {
            'request_id': client_request_id,
            'message': 'Prompt cannot be empty.'
        }, to=sid)
        return
    
    request_id = client_request_id or str(uuid.uuid4())
    log.info(f"[Req {request_id}] Starting background task for chat from SID {sid}: '{prompt[:50]}...'")
    
    # 启动后台任务处理聊天请求
    socketio.start_background_task(
        target=_task_chat_only,      
        prompt=prompt,
        history=history_data,
        request_id=request_id,
        sid=sid,
        use_streaming=use_streaming
    )
    
    # 发送处理中的状态
    socketio.emit('chat_processing', {'request_id': request_id, 'status': 'processing'}, to=sid)

@app.route('/')
def index():
    return render_template('dashboard.html', token=TOKEN)

@app.route('/screenshots/<path:filename>')
def screenshots(filename: str):
    log.debug(f"Request screenshot: {filename}")
    safe_filename = secure_filename(filename)
    if not safe_filename:
        abort(400)
    directory = str(SAVE_DIR.resolve())
    file_path = SAVE_DIR / safe_filename
    if not file_path.is_file():
        abort(404)
    log.info(f"Serving: {safe_filename}")
    try:
        return send_from_directory(directory, safe_filename, as_attachment=False)
    except Exception as e:
        log.error(f"Error serving {safe_filename}: {e}")
        abort(500)

@app.route('/upload_raw', methods=['POST'])
def upload_raw():
    check_token()
    log.info("Request /upload_raw (async).")
    data = request.get_json(silent=True)
    request_id = str(uuid.uuid4())
    if not data or 'image' not in data:
        return jsonify({'error': 'Missing image data', 'request_id': request_id}), 400
    b64_string = data['image']
    header = None
    b64_data = b64_string
    if ',' in b64_string:
        header, b64_data = b64_string.split(',', 1)
    try:
        b64_padded = b64_data + '=' * (-len(b64_data) % 4)
        img_bytes = base64.b64decode(b64_padded)
    except Exception as e:
        log.error(f"[Req {request_id}] Base64 decode failed: {e}")
        return jsonify({'error': 'Invalid base64 data', 'request_id': request_id}), 400

    timestamp_ms = int(time.time() * 1000)
    filename = f'raw_{timestamp_ms}.png'
    save_path = SAVE_DIR / filename
    try:
        save_path.write_bytes(img_bytes)
        log.info(f"[Req {request_id}] Raw screenshot saved: {save_path}")
    except IOError as e:
        log.error(f"[Req {request_id}] Failed save raw screenshot: {e}")
        return jsonify({'error': 'Failed save image', 'request_id': request_id}), 500

    url = f'/screenshots/{filename}'
    log.info(f"[Req {request_id}] Starting AI analysis task: {filename}")
    socketio.start_background_task(
        target=_task_analyze_image,
        img_bytes=img_bytes,
        url=url,
        timestamp_ms=timestamp_ms,
        prompt=data.get('prompt'),
        request_id=request_id,
        sid=None
    )
    log.info(f"[Req {request_id}] Upload accepted, analysis started.")
    return jsonify({
        'status': 'processing',
        'message': 'Upload accepted, analysis started.',
        'request_id': request_id,
        'image_url': url
    }), 202
@app.route('/upload_screenshot', methods=['POST'])
def upload_screenshot():
    check_token()
    log.info("Request /upload_screenshot (async).")
    uploaded_file = request.files.get('image')
    prompt = request.form.get('prompt')
    request_id = str(uuid.uuid4())

    if not uploaded_file:
        return jsonify({'error': 'Missing image file', 'request_id': request_id}), 400

    original_filename = secure_filename(uploaded_file.filename or 'cropped.png')
    timestamp_ms = int(time.time() * 1000)
    base, ext = os.path.splitext(original_filename)
    save_ext = ext if ext.lower() in ALLOWED_IMAGE_EXT else '.png'
    filename = f'crop_{timestamp_ms}_{base[:20]}{save_ext}'
    save_path = SAVE_DIR / filename

    try:
        uploaded_file.save(save_path)
        log.info(f"[Req {request_id}] Cropped screenshot saved: {save_path}")
    except IOError as e:
        log.error(f"[Req {request_id}] Failed save cropped screenshot: {e}")
        return jsonify({'error': 'Failed save image', 'request_id': request_id}), 500

    url = f'/screenshots/{filename}'
    img_bytes = None
    try:
        img_bytes = save_path.read_bytes()
    except Exception as e:
        log.error(f"[Req {request_id}] Error read saved file {save_path}: {e}")
        return jsonify({'error': 'Failed read saved image', 'request_id': request_id}), 500

    if img_bytes:
        log.info(f"[Req {request_id}] Starting AI analysis task (cropped): {filename}")
        socketio.start_background_task(
            target=_task_analyze_image,
            img_bytes=img_bytes,
            url=url,
            timestamp_ms=timestamp_ms,
            prompt=prompt,
            request_id=request_id,
            sid=None
        )
        log.info(f"[Req {request_id}] Cropped upload accepted, analysis started.")
        return jsonify({
            'status': 'processing',
            'image_url': url,
            'message': 'Upload accepted, analysis started.',
            'request_id': request_id
        }), 202
    else:
        return jsonify({'error': 'Failed process image after save', 'request_id': request_id}), 500

@app.route('/crop_image', methods=['POST'])
def crop_image():
    check_token()
    log.info("Request /crop_image (async).")
    request_id = str(uuid.uuid4())
    try:
        image_url = request.form.get('image_url')
        custom_prompt = request.form.get('prompt')

        if not image_url or not image_url.startswith('/screenshots/'):
            return jsonify({'error': 'Missing or invalid image_url', 'request_id': request_id}), 400

        filename = secure_filename(os.path.basename(image_url))
        if not filename:
            return jsonify({'error': 'Invalid image filename', 'request_id': request_id}), 400

        image_path = (SAVE_DIR / filename).resolve()
        if not str(image_path).startswith(str(SAVE_DIR.resolve())):
            return jsonify({'error': 'Invalid image path', 'request_id': request_id}), 400
        if not image_path.is_file():
            return jsonify({'error': f'Image file not found: {filename}', 'request_id': request_id}), 404

        try:
            x = int(float(request.form.get('x', 0)))
            y = int(float(request.form.get('y', 0)))
            width = int(float(request.form.get('width', 0)))
            height = int(float(request.form.get('height', 0)))
            if width <= 0 or height <= 0 or x < 0 or y < 0:
                raise ValueError("Invalid crop dimensions")
        except (ValueError, TypeError) as e:
            return jsonify({'error': f'Invalid crop parameters: {e}', 'request_id': request_id}), 400

        crop_path = None
        img_bytes = None
        crop_url = None
        cropped_img = None
        timestamp_ms = int(time.time() * 1000)

        with Image.open(image_path) as img:
            img_width, img_height = img.size
            box_x1 = max(0, x)
            box_y1 = max(0, y)
            box_x2 = min(img_width, x + width)
            box_y2 = min(img_height, y + height)

            if box_x1 >= box_x2 or box_y1 >= box_y2:
                return jsonify({'error': 'Calculated crop area invalid', 'request_id': request_id}), 400

            cropped_img = img.crop((box_x1, box_y1, box_x2, box_y2))
            log.info(f"[Req {request_id}] Image cropped: {cropped_img.width}x{cropped_img.height}")

            base, ext = os.path.splitext(filename)
            save_ext = ext if ext.lower() in Image.registered_extensions() else '.png'
            crop_filename = f'{base[:20]}_crop_{timestamp_ms}{save_ext}'
            crop_path = SAVE_DIR / crop_filename
            save_format = Image.registered_extensions().get(save_ext.lower(), 'PNG')

            cropped_img.save(crop_path, format=save_format)
            log.info(f"[Req {request_id}] Cropped image saved: {crop_path} (Format: {save_format})")
            crop_url = f'/screenshots/{crop_filename}'

            with io.BytesIO() as output:
                cropped_img.save(output, format=save_format)
                img_bytes = output.getvalue()

        if img_bytes and crop_url:
            final_prompt = custom_prompt if custom_prompt else f'请解读这张裁剪自 {filename} 的图片'
            log.info(f"[Req {request_id}] Starting AI analysis task (cropped): {crop_filename}")
            socketio.start_background_task(
                target=_task_analyze_image,
                img_bytes=img_bytes,
                url=crop_url,
                timestamp_ms=timestamp_ms,
                prompt=final_prompt,
                request_id=request_id,
                sid=None
            )
            log.info(f"[Req {request_id}] Crop request accepted, analysis started.")
            return jsonify({
                'status': 'processing',
                'message': 'Crop successful, analysis started.',
                'image_url': crop_url,
                'width': cropped_img.width,
                'height': cropped_img.height,
                'original': image_url,
                'request_id': request_id
            }), 202
        else:
            log.error(f"[Req {request_id}] Failed get cropped bytes/URL.")
            return jsonify({'error': 'Failed process cropped image', 'request_id': request_id}), 500

    except FileNotFoundError:
        log.error(f"[Req {request_id}] Original image not found: {image_path}")
        return jsonify({'error': 'Original image file not found.', 'request_id': request_id}), 404
    except Exception as e:
        log.exception(f"[Req {request_id}] Error during cropping.")
        return jsonify({'error': f'Failed crop/analyze: {str(e)}', 'request_id': request_id}), 500

@app.route('/process_voice', methods=['POST'])
def process_voice():
    check_token()
    log.info("Request /process_voice (async).")
    request_id = str(uuid.uuid4())
    if 'audio' not in request.files:
        return jsonify({'error': 'Missing audio file', 'request_id': request_id}), 400

    audio_file = request.files['audio']
    if not audio_file.filename:
        original_filename = f"audio_{int(time.time() * 1000)}.wav"
    else:
        original_filename = secure_filename(audio_file.filename)

    temp_filename = f'voice_{int(time.time() * 1000)}_{original_filename}'
    temp_path = SAVE_DIR / temp_filename

    log.debug(f"[Req {request_id}] Saving temp voice file: {temp_path}")
    try:
        audio_file.save(str(temp_path))
        log.info(f"[Req {request_id}] Temp voice file saved: {temp_path}")
    except Exception as e:
        log.exception(f"[Req {request_id}] Failed save temp voice file")
        return jsonify({'error': f'保存语音文件失败: {str(e)}', 'request_id': request_id}), 500

    log.info(f"[Req {request_id}] Starting voice processing task: {temp_path.name}")
    socketio.start_background_task(
        target=_task_process_voice,
        temp_audio_path=temp_path,
        request_id=request_id,
        sid=None
    )
    log.info(f"[Req {request_id}] Voice upload accepted, processing started.")
    return jsonify({
        'status': 'processing',
        'message': '语音已接收，正在后台处理...',
        'request_id': request_id,
        'temp_filename': temp_path.name
    }), 202

@app.route('/chat', methods=['POST'])
def chat():
    check_token()
    log.info("Received text-only chat request via HTTP (async).")
    data = request.get_json(silent=True)
    request_id = str(uuid.uuid4())

    if not data or 'prompt' not in data:
        return jsonify({'error': 'Missing prompt', 'request_id': request_id}), 400

    prompt = data.get('prompt', '').strip()
    history_data = data.get('history', [])
    use_streaming = data.get('use_streaming', False)  # HTTP 请求默认不使用流式输出

    if not prompt:
        return jsonify({'error': 'Empty prompt', 'request_id': request_id}), 400

    log.info(f"[Req {request_id}] Starting background task for HTTP chat: '{prompt[:50]}...'")
    socketio.start_background_task(
        target=_task_chat_only,
        prompt=prompt,
        history=history_data,
        request_id=request_id,
        sid=None,
        use_streaming=use_streaming
    )
    
    return jsonify({
        'status': 'processing',
        'message': '请求已收到，AI正在后台处理...',
        'request_id': request_id
    }), 202

@app.route('/chat_with_file', methods=['POST'])
def chat_with_file():
    check_token() # 检查认证 Token
    log.info("===> Entering /chat_with_file (request received)")
    prompt = request.form.get('prompt', '')
    uploaded_file = request.files.get('file')
    history_json = request.form.get('history', '[]')

    # --- 使用前端传递的 request_id ---
    request_id = request.form.get('request_id')
    if not request_id:
        log.warning("Missing request_id in /chat_with_file form data from client.")
        return jsonify({'error': 'Missing request_id in form data'}), 400
    log.info(f"[Req {request_id}] Processing /chat_with_file request.")
    # --- request_id 处理结束 ---

    # 解析历史记录
    history_data = []
    try:
        history_data = json.loads(history_json)
        if not isinstance(history_data, list):
             log.warning(f"[Req {request_id}] Invalid history format (not a list). Treating as empty.")
             history_data = []
    except (json.JSONDecodeError, TypeError):
        log.warning(f"[Req {request_id}] Invalid history JSON format. Treating as empty.")
        history_data = []

    # 必须有 prompt 或 文件 之一
    if not prompt.strip() and not uploaded_file:
        log.warning(f"[Req {request_id}] Request needs prompt or file.")
        return jsonify({'error': 'Request needs prompt or file.', 'request_id': request_id}), 400

    temp_path = None          # 用于保存临时文件的路径
    task_to_run = None        # 要运行的后台任务函数
    task_args = {}            # 传递给后台任务的参数字典
    file_type = "none"        # 文件类型标记
    url_for_task = None       # 如果是图片，生成的 URL
    final_prompt_for_ai = prompt # 初始化 AI prompt

    try:
        if uploaded_file:
            # --- 处理上传的文件 ---
            if not uploaded_file.filename:
                log.warning(f"[Req {request_id}] Uploaded file has no filename.")
                return jsonify({'error': 'Uploaded file has no filename', 'request_id': request_id}), 400

            filename = secure_filename(uploaded_file.filename)
            file_ext = os.path.splitext(filename)[1].lower()
            log.info(f"[Req {request_id}] Processing file: {filename} (Ext: {file_ext})")

            # 创建临时文件来保存上传内容
            with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext, dir=str(SAVE_DIR.resolve())) as temp:
                uploaded_file.save(temp.name)
                temp_path = Path(temp.name)
                log.debug(f"[Req {request_id}] File saved temporarily: {temp_path}")

            # 根据文件类型准备不同的任务
            if file_ext in ALLOWED_IMAGE_EXT:
                file_type = "image"
                log.debug(f"[Req {request_id}] File type: IMAGE. Preparing analysis task.")
                try:
                    img_bytes = temp_path.read_bytes() # 读取图片内容
                except Exception as read_err:
                    log.exception(f"[Req {request_id}] Failed to read saved image file: {temp_path}")
                    raise ValueError(f"无法读取保存的图片文件: {filename}") from read_err
                
                # 生成可访问此图片的 URL (假设 /screenshots/<filename> 路由有效)
                url_for_task = f'/screenshots/{temp_path.name}' 
                # 设置要运行的任务和参数
                task_to_run = _task_analyze_image
                task_args = {
                    'img_bytes': img_bytes,
                    'url': url_for_task,
                    'timestamp_ms': int(time.time() * 1000),
                    'prompt': prompt, # 使用用户原始输入的 prompt
                    'request_id': request_id,
                    'sid': None, # HTTP 请求没有 sid，除非特殊处理
                    '_cleanup_path': temp_path # 将临时路径传递给任务以便后续清理
                }

            elif file_ext in ALLOWED_TEXT_EXT:
                file_type = "text"
                log.debug(f"[Req {request_id}] File type: TEXT. Preparing chat task.")
                file_content_snippet = ""
                try:
                    # 读取文本文件内容（限制长度）
                    with open(temp_path, 'r', encoding='utf-8', errors='ignore') as f:
                        file_content_snippet = f.read(MAX_TEXT_FILE_CHARS)
                        # 检查是否因为达到最大长度而截断
                        if len(file_content_snippet) == MAX_TEXT_FILE_CHARS and f.read(1):
                            file_content_snippet += "\n[...文件内容过长，已截断...]"
                    log.debug(f"[Req {request_id}] Read {len(file_content_snippet)} chars from '{filename}'.")
                    # 构建包含文件上下文的 prompt
                    file_prompt_header = f"[上下文：用户上传了文件: {filename}]\n文件内容:\n```\n"
                    file_prompt_footer = "\n```"
                    # 如果用户也有输入 prompt，将文件内容附加上去
                    final_prompt_for_ai = f"{prompt}\n\n{file_prompt_header}{file_content_snippet}{file_prompt_footer}" if prompt else f"{file_prompt_header}{file_content_snippet}{file_prompt_footer}"
                except Exception as read_err:
                    log.exception(f"[Req {request_id}] Error reading text file {filename}")
                    final_prompt_for_ai = f"{prompt}\n\n[用户上传了文件: {filename}，但在读取时出错。]" if prompt else f"[用户上传了文件: {filename}，但在读取时出错。]"
                
                # 设置要运行的任务和参数
                task_to_run = _task_chat_only
                task_args = {
                    'prompt': final_prompt_for_ai, # 使用包含文件内容的 prompt
                    'history': history_data,      # 传入对话历史
                    'request_id': request_id,
                    'sid': None,
                    # !! 注意: 文件聊天强制非流式，因为 _task_chat_only 非流式会发 chat_response !!
                    # 如果希望文件聊天也流式，需要调整 _task_chat_only 和前端逻辑
                    'use_streaming': False  
                }
            else:
                file_type = "unsupported"
                log.warning(f"[Req {request_id}] Unsupported file type: {filename} ({file_ext})")
                # 构建提示，告知 AI 文件类型不支持分析
                final_prompt_for_ai = f"{prompt}\n\n[用户上传了文件: {filename} (类型: {file_ext})。此文件类型内容分析不支持。]" if prompt else f"[用户上传了文件: {filename} (类型: {file_ext})。此文件类型内容分析不支持。]"
                # 仍然调用聊天任务，只是 prompt 不同
                task_to_run = _task_chat_only
                task_args = {
                    'prompt': final_prompt_for_ai,
                    'history': history_data,
                    'request_id': request_id,
                    'sid': None
                    # use_streaming 使用 _task_chat_only 的默认值 True
                }
        else:
            # --- 没有上传文件，只有 prompt ---
            log.debug(f"[Req {request_id}] Processing text-only via /chat_with_file. History turns: {len(history_data)}")
            # 设置要运行的任务和参数
            task_to_run = _task_chat_only # <--- **修正：之前这里漏了设置 task_to_run**
            task_args = {
                'prompt': prompt,          # 使用原始 prompt
                'history': history_data,
                'request_id': request_id,
                'sid': None
                # use_streaming 使用 _task_chat_only 的默认值 True
            }

        # --- 启动后台任务 ---
        if task_to_run and task_args:
            log.info(f"[Req {request_id}] Preparing background task. Target: {task_to_run.__name__}")
            # 打印将要传递的参数的键和部分值，用于调试
            log.debug(f"[Req {request_id}] Task Args Dict Keys: {list(task_args.keys())}")
            log.debug(f"[Req {request_id}] Task Args Dict Values (partial): "
                      f"prompt_len={len(task_args.get('prompt', '')) if 'prompt' in task_args else 'N/A'}, "
                      f"history_len={len(task_args.get('history', [])) if 'history' in task_args else 'N/A'}, "
                      f"request_id={task_args.get('request_id')}, sid={task_args.get('sid')}, "
                      f"use_streaming={task_args.get('use_streaming', 'Default')}")

            # 检查并显式传递参数给 _task_chat_only
            if task_to_run == _task_chat_only:
                 required_keys = ['prompt', 'history', 'request_id', 'sid'] # use_streaming 是可选的
                 if not all(key in task_args for key in ['prompt', 'history', 'request_id']): # 确保核心参数存在
                     log.error(f"[Req {request_id}] Missing required keys in task_args for _task_chat_only! Keys: {list(task_args.keys())}")
                     return jsonify({'error': 'Internal error preparing background task arguments', 'request_id': request_id}), 500
                 
                 socketio.start_background_task(
                     target=_task_chat_only,
                     prompt=task_args['prompt'],
                     history=task_args['history'],
                     request_id=task_args['request_id'],
                     sid=task_args.get('sid'), # sid 可能为 None
                     use_streaming=task_args.get('use_streaming', True) # 获取 use_streaming，若不存在则用默认值 True
                 )
            elif task_to_run == _task_analyze_image:
                 # 假设 _task_analyze_image 参数设置正确，仍用 **task_args
                 socketio.start_background_task(target=_task_analyze_image, **task_args)
            else:
                 # 处理未知的任务类型
                 log.error(f"[Req {request_id}] Unknown task type for background execution: {task_to_run.__name__}")
                 return jsonify({'error': 'Internal error: Unknown background task', 'request_id': request_id}), 500

            log.info(f"[Req {request_id}] Background task started for request.")
            # 返回 202 Accepted 响应给前端
            return jsonify({
                'status': 'processing',
                'message': '请求已收到，AI正在后台处理...',
                'request_id': request_id # 返回使用的 request_id
            }), 202
        else:
            # 如果 task_to_run 或 task_args 未被正确设置
            log.error(f"[Req {request_id}] No background task scheduled for chat_with_file (task_to_run or task_args missing).")
            return jsonify({'error': 'Internal server error processing request', 'request_id': request_id}), 500

    except Exception as e:
        # 捕获准备阶段发生的任何其他异常
        log.exception(f"[Req {request_id}] Unhandled error preparing chat_with_file task.")
        # 清理可能已创建的临时文件
        if temp_path and temp_path.exists():
             try:
                 temp_path.unlink()
                 log.debug(f"[Req {request_id}] Cleaned up temp file {temp_path} due to error.")
             except OSError as unlink_err:
                 log.error(f"[Req {request_id}] Error deleting temp file {temp_path} after error: {unlink_err}")
        return jsonify({"provider": "error", "message": f"处理文件上传时发生内部错误: {type(e).__name__}", 'request_id': request_id}), 500
    # finally: # finally 块在这里可能不合适，因为后台任务可能还需要临时文件
        # # 确保非图片类型的临时文件被删除 (图片类型的由 _task_analyze_image 清理)
        # if temp_path and file_type != "image" and temp_path.exists():
        #     try:
        #         temp_path.unlink()
        #         log.debug(f"[Req {request_id}] Temp file (type: {file_type}) deleted in finally: {temp_path}")
        #     except OSError as e:
        #         log.error(f"[Req {request_id}] Error deleting temp file {temp_path} in finally: {e}")

@app.route('/request_screenshot', methods=['POST'])
def request_screenshot():
    check_token()
    log.info("Request /request_screenshot")
    socketio.emit('capture')
    log.debug("Emitted 'capture'")
    return '', 204


@app.route('/api_info', methods=['GET'])
def api_info():
    check_token()
    provider = '未知'
    try:
        provider = settings.image_analysis_provider
        if not provider:
            provider = '未知 (配置为空)'
    except AttributeError:
        log.warning("Config 'image_analysis_provider' missing.")
        provider = '未知 (配置项缺失)'
    except Exception as e:
        log.exception("Error retrieving API provider.")
        provider = f'错误 ({type(e).__name__})'
    log.info(f"Returning API info. Provider: {provider}")
    return jsonify({'provider': provider})


def main():
    host = settings.server_host
    port = settings.server_port
    debug = settings.debug_mode

    if host == "0.0.0.0" and not TOKEN:
        log.warning("⚠️ SECURITY WARNING: Server on 0.0.0.0 without token!")

    log.info(f"--- Starting Flask-SocketIO Server ---")
    log.info(f" Host: {host}, Port: {port}, Debug: {debug}")
    log.info(f" Auth: {'ENABLED' if TOKEN else 'DISABLED'}, Screenshot Dir: {SAVE_DIR.resolve()}")

    if host == "0.0.0.0":
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            log.info(f" Local Network URL: http://{s.getsockname()[0]}:{port}")
            s.close()
        except:
            log.info(f" Local Network URL: Unable to determine local IP")

    log.info(f" Listening on http://{host}:{port}")
    socketio.run(app, host=host, port=port, debug=debug, use_reloader=debug, allow_unsafe_werkzeug=(True if debug else False))


if __name__ == '__main__':
    main()


@app.before_request
def log_request_info():
    log.debug(f"Request: {request.method} {request.path} from {request.remote_addr}")
    # log.debug(f"Headers: {dict(request.headers)}")  # Can be very verbose
