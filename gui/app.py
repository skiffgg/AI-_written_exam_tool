import logging
import threading
import io
import queue
import base64
import requests
import socketio
import tkinter as tk
import tkinter.font as tkfont
import tkinter.simpledialog as simpledialog
from pathlib import Path
from PIL import Image, ImageTk
from core.capture import grab_fullscreen, grab_region
from core.uploader import upload
from core.analysis import analyze_image
from core.settings import settings
from tkinter.scrolledtext import ScrolledText
from gui.local_connection import LocalConnection
import subprocess
import os
import sys
import time
import logging

logger = logging.getLogger(__name__)
import os
import sys
import time
import logging

logger = logging.getLogger(__name__)

def start_server():
    """启动 web_server.py"""
    try:
        # 确定 web_server.py 的路径
        server_script = os.path.join(os.path.dirname(__file__), "../server/web_server.py")
        
        # 启动服务器进程
        logger.info("正在启动服务器...")
        server_process = subprocess.Popen(
            [sys.executable, server_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        time.sleep(2)  # 等待服务器启动完成
        logger.info("服务器已启动")
        return server_process
    except Exception as e:
        logger.error(f"启动服务器失败: {e}")
        sys.exit(1)

def stop_server(server_process):
    """停止服务器进程"""
    try:
        logger.info("正在停止服务器...")
        server_process.terminate()
        server_process.wait()
        logger.info("服务器已停止")
    except Exception as e:
        logger.error(f"停止服务器失败: {e}")



logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

sio = socketio.Client(
    logger=False,
    engineio_logger=False,
    reconnection=True,           # 启用重连
    reconnection_attempts=10,    # 重连尝试次数
    reconnection_delay=1,        # 初始重连延迟（秒）
    reconnection_delay_max=5,    # 最大重连延迟（秒）
    randomization_factor=0.5     # 随机因子
)
_task_queue = queue.Queue()
app = None
analysis_text: ScrolledText | None = None # 全局引用，后面初始化

def check_websocket_support():
    """检查环境是否支持 WebSocket"""
    try:
        import simple_websocket
        logger.info("WebSocket 支持: simple_websocket 已安装")
        
        # 检查 engineio 是否支持 WebSocket
        try:
            from engineio.async_drivers import _websocket_wsgi
            logger.info("WebSocket 支持: engineio WebSocket WSGI 驱动可用")
            return True
        except ImportError:
            logger.warning("WebSocket 支持: engineio WebSocket WSGI 驱动不可用")
            return False
    except ImportError:
        logger.warning("WebSocket 支持: simple_websocket 未安装，WebSocket 可能不可用")
        logger.warning("请运行 'pip install simple-websocket' 以启用 WebSocket 支持")
        return False

# 在应用启动时检查 WebSocket 支持
websocket_supported = check_websocket_support()

@sio.event
def connect():
    logger.info("Connected to %s", settings.base_url)
    _task_queue.put(lambda: app.status_var.set("Socket.IO 已连接"))
    _task_queue.put(app.refresh_history)

@sio.event
def disconnect():
    logger.warning("Disconnected")
    _task_queue.put(lambda: app.status_var.set("Socket.IO 已断开"))

@sio.on('capture')
def on_capture():
    logger.info("Remote capture request")
    _task_queue.put(app.trigger_capture)

@sio.on('new_screenshot')
def on_new_screenshot(data):
    # data = { image_url: "...", analysis: "解析文本" }
    text = data.get('analysis', '')
    # 将更新放到主线程队列
    _task_queue.put(lambda: analysis_text.delete('1.0', 'end') or analysis_text.insert('1.0', text))

class RegionSelector:
    def __init__(self, root: tk.Tk):
        self.bbox = None
        self.win = tk.Toplevel(root)
        self.win.attributes('-fullscreen', True)
        self.win.attributes('-alpha', 0.3)
        self.canvas = tk.Canvas(self.win, cursor='cross', bg='gray')
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind('<ButtonPress-1>', self.on_press)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<ButtonRelease-1>', self.on_release)

    def on_press(self, e):
        self.x0, self.y0 = e.x, e.y
        self.rect = self.canvas.create_rectangle(e.x, e.y, e.x, e.y, outline='red', width=2)

    def on_drag(self, e):
        self.canvas.coords(self.rect, self.x0, self.y0, e.x, e.y)

    def on_release(self, e):
        x1, y1 = self.x0, self.y0
        x2, y2 = e.x, e.y
        self.bbox = (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        self.win.destroy()

    def select(self):
        self.win.wait_window()
        return self.bbox

class App:
    THEMES = {
        'Light': {'bg': 'white', 'fg': 'black', 'insertbackground': 'black'},
        'Dark':  {'bg': '#2e2e2e', 'fg': 'white', 'insertbackground': 'white'}
    }

    def __init__(self):
        global app
        app = self
        self.root = tk.Tk()
        self.root.title("Screenshot Uploader")

        self.status_var = tk.StringVar(value="Ready")
        self.model_var = tk.StringVar(value=f"Provider: {settings.image_analysis_provider}")
        status_frame = tk.Frame(self.root)
        tk.Label(status_frame, textvariable=self.status_var).pack(side=tk.LEFT, padx=5)
        tk.Label(status_frame, textvariable=self.model_var).pack(side=tk.LEFT)
        status_frame.pack(side=tk.TOP, fill=tk.X)

        menubar = tk.Menu(self.root)
        setmenu = tk.Menu(menubar, tearoff=0)
        setmenu.add_command(label="Font...", command=self.choose_font)
        thememenu = tk.Menu(setmenu, tearoff=0)
        for t in self.THEMES:
            thememenu.add_command(label=t, command=lambda n=t: self.set_theme(n))
        setmenu.add_cascade(label="Theme", menu=thememenu)
        menubar.add_cascade(label="Settings", menu=setmenu)
        self.root.config(menu=menubar)

        self.text_font = tkfont.Font(family="Segoe UI", size=10)
        self.current_theme = 'Light'

        ctrl = tk.Frame(self.root)
        tk.Button(ctrl, text="Full (Ctrl+Shift+F)", command=self.set_fullscreen).pack(side=tk.LEFT, padx=5)
        tk.Button(ctrl, text="Region (Ctrl+Shift+R)", command=self.set_region).pack(side=tk.LEFT)
        tk.Button(ctrl, text="Capture (Ctrl+Shift+S)", command=self.trigger_capture).pack(side=tk.RIGHT, padx=5)
        ctrl.pack(fill=tk.X, pady=4)

        self.root.bind('<Control-Shift-F>', lambda e: self.set_fullscreen())
        self.root.bind('<Control-Shift-R>', lambda e: self.set_region())
        self.root.bind('<Control-Shift-S>', lambda e: self.trigger_capture())

        main = tk.Frame(self.root)
        main.pack(fill=tk.BOTH, expand=True)

        histf = tk.Frame(main)
        histf.pack(side=tk.LEFT, fill=tk.Y)
        tk.Label(histf, text="History").pack()
        self.history_list = tk.Listbox(histf, width=30)
        self.history_list.pack(fill=tk.Y, padx=5, pady=5)
        self.history_list.bind('<<ListboxSelect>>', self.show_selected)

        pvtxt = tk.Frame(main)
        pvtxt.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        self.preview_label = tk.Label(pvtxt, text="Preview", bd=1, relief='solid')
        self.preview_label.pack(pady=5)
        self.preview_label.bind('<MouseWheel>', self.zoom_preview)
        self.current_img = None

        txtf = tk.Frame(pvtxt)
        txtf.pack(fill=tk.BOTH, expand=True)
        vs = tk.Scrollbar(txtf, orient='vertical'); vs.pack(side=tk.RIGHT, fill=tk.Y)
        hs = tk.Scrollbar(txtf, orient='horizontal'); hs.pack(side=tk.BOTTOM, fill=tk.X)
        self.text = tk.Text(txtf, wrap='none', xscrollcommand=hs.set, yscrollcommand=vs.set)
        global analysis_text
        analysis_text = self.text


        self.text.config(font=self.text_font)
        self.text.pack(fill=tk.BOTH, expand=True)
        vs.config(command=self.text.yview)
        hs.config(command=self.text.xview)
        self.text.bind('<MouseWheel>', lambda e: self.text.yview_scroll(int(-1*(e.delta/120)),'units'))
        self.text.bind('<Shift-MouseWheel>', lambda e: self.text.xview_scroll(int(-1*(e.delta/120)),'units'))

        self.region_mode = False
        self.root.after(100, self.poll_queue)
        threading.Thread(target=self.start_socketio, daemon=True).start()
        self.set_theme(self.current_theme)

    def set_fullscreen(self):
        self.region_mode = False
        self.status_var.set("Mode: Full Screen")

    def set_region(self):
        self.region_mode = True
        self.status_var.set("Mode: Region Select")

    def choose_font(self):
        fam = simpledialog.askstring("Font Family", "Family:", initialvalue=self.text_font.cget('family'))
        sz = simpledialog.askinteger("Font Size", "Size:", initialvalue=self.text_font.cget('size'), minvalue=6, maxvalue=72)
        if fam and sz:
            self.text_font.config(family=fam, size=sz)

    def set_theme(self, name):
        cfg = self.THEMES[name]
        self.text.config(bg=cfg['bg'], fg=cfg['fg'], insertbackground=cfg['insertbackground'])
        self.history_list.config(bg=cfg['bg'], fg=cfg['fg'])
        self.preview_label.config(bg=cfg['bg'], fg=cfg['fg'])
        self.current_theme = name

    def start_socketio(self):
        """启动 Socket.IO 连接，使用本地连接工具"""
        try:
            # 获取本地服务器 URL
            local_server_url = LocalConnection.get_local_url()
            logger.info(f"尝试直接连接到本地服务器: {local_server_url}")
            
            # 清除代理环境变量
            original_env = LocalConnection.clear_proxy_env()
            
            # 连接到本地服务器，增加超时设置
            auth = {'token': settings.dashboard_token} if settings.dashboard_token else {}
            
            # 根据 WebSocket 支持情况选择传输模式
            if websocket_supported:
                logger.info("尝试使用 WebSocket 连接...")
                transports = ['websocket']
            else:
                logger.info("WebSocket 不可用，使用 polling 连接...")
                transports = ['polling']
            
            sio.connect(
                local_server_url,
                auth=auth,
                wait=True,
                wait_timeout=10,
                transports=transports
            )
            logger.info(f"成功连接到本地服务器 (使用 {transports[0]})")
            
            # 不恢复代理环境变量，保持直接连接
        except Exception as e:
            logger.error(f"Socket.IO 连接失败: {e}", exc_info=True)
            _task_queue.put(lambda: self.status_var.set("Socket.IO 连接失败"))
            
            # 添加重连逻辑
            _task_queue.put(lambda: self.schedule_reconnect())

    def schedule_reconnect(self):
        """安排重新连接尝试"""
        if not sio.connected:
            self.status_var.set("正在尝试重新连接...")
            # 5秒后尝试重连
            self.root.after(5000, lambda: threading.Thread(target=self.start_socketio, daemon=True).start())

    def trigger_capture(self):
        threading.Thread(target=self.capture_worker, daemon=True).start()

    def capture_worker(self):
        self.status_var.set("Capturing…")
        logger.info("开始截图过程")

        try:
            if self.region_mode:
                logger.info("使用区域截图模式")
                sel = RegionSelector(self.root)
                bbox = sel.select()
                logger.info(f"选择区域: {bbox}")
                img_bytes = grab_region(bbox)
            else:
                logger.info("使用全屏截图模式")
                img_bytes = grab_fullscreen()
            
            logger.info(f"截图成功，大小: {len(img_bytes)} 字节")
            
            # Base64 编码
            b64 = base64.b64encode(img_bytes).decode()
            logger.info("Base64编码完成")
            
            # 上传原始截图到 /upload_raw，后端会广播 raw_screenshot
            try:
                # 使用本地服务器地址，不使用 settings.base_url
                local_server_url = f"http://127.0.0.1:{settings.server_port}/upload_raw"
                logger.info(f"开始上传到本地服务器: {local_server_url}")
                
                # 清除代理环境变量
                # 清除代理环境变量
                # 或者如果你不需要恢复环境变量，直接调用 LocalConnection.clear_proxy_env()
                original_env = LocalConnection.clear_proxy_env()
                # 创建一个不使用代理的会话
                session = requests.Session()
                session.trust_env = False  # 不使用环境变量中的代理设置
                
                # 发送请求
                response = session.post(
                    local_server_url,
                    json={'image': b64},
                    headers={'Authorization': f"Bearer {settings.dashboard_token or ''}"}
                )
                
                logger.info(f"上传完成，状态码: {response.status_code}")
            except Exception as e:
                logger.error(f"上传原始截图失败: {e}")
        except Exception as e:
            logger.error(f"截图过程出错: {e}", exc_info=True)

    def _update_ui(self, img_bytes, text):
        self.current_img = img_bytes
        img = Image.open(io.BytesIO(img_bytes))
        thumb = img.copy(); thumb.thumbnail((200,200))
        self.thumb = ImageTk.PhotoImage(thumb)
        self.preview_label.config(image=self.thumb)
        self.status_var.set("Done")
        self.text.delete('1.0','end'); self.text.insert('1.0', text)
        self.history_list.insert(tk.END, text.splitlines()[0][:30])
        self.refresh_history()

    def refresh_history(self):
        self.history_list.update()

    def poll_queue(self):
        try:
            while True:
                fn = _task_queue.get_nowait(); fn()
        except queue.Empty:
            pass
        self.root.after(100, self.poll_queue)

    def show_selected(self, evt):
        idx = self.history_list.curselection()
        # 可在此根据索引加载对应截图及 AI 文本

    def zoom_preview(self, e):
        pass  # 可根据需要实现放大逻辑

    def run(self):
        self.root.mainloop()

if __name__ == '__main__':
    # 启动服务器
    # server_process = start_server()

    try:
        # 启动客户端应用
        App().run()
    finally:
        # 确保在退出时停止服务器
        stop_server(server_process)

##################################v1####################################


# import logging
# import threading
# import io
# import queue
# import base64
# import requests
# import socketio
# import tkinter as tk
# import tkinter.font as tkfont
# import tkinter.simpledialog as simpledialog
# from PIL import Image, ImageTk
# from core.capture import grab_fullscreen, grab_region
# #from core.analysis import analyze_image  # analysis moved server-side
# from core.settings import settings

# # 日志配置
# logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
# logger = logging.getLogger(__name__)

# # Socket.IO 客户端 & UI 队列
# sio = socketio.Client(logger=False, engineio_logger=False)
# _task_queue = queue.Queue()
# app = None

# class RegionSelector:
#     def __init__(self, root: tk.Tk):
#         self.win = tk.Toplevel(root)
#         self.win.attributes('-fullscreen', True)
#         self.win.attributes('-alpha', 0.3)
#         self.canvas = tk.Canvas(self.win, cursor='cross', bg='gray')
#         self.canvas.pack(fill=tk.BOTH, expand=True)
#         self.canvas.bind('<ButtonPress-1>', self.on_press)
#         self.canvas.bind('<B1-Motion>', self.on_drag)
#         self.canvas.bind('<ButtonRelease-1>', self.on_release)
#     def on_press(self, e):
#         self.x0, self.y0 = e.x, e.y
#         self.rect = self.canvas.create_rectangle(e.x, e.y, e.x, e.y, outline='red', width=2)
#     def on_drag(self, e):
#         self.canvas.coords(self.rect, self.x0, self.y0, e.x, e.y)
#     def on_release(self, e):
#         x1,y1,x2,y2 = self.x0,self.y0,e.x,e.y
#         self.bbox = (min(x1,x2),min(y1,y2),max(x1,x2),max(y1,y2))
#         self.win.destroy()
#     def select(self):
#         self.win.wait_window()
#         return self.bbox

# class App:
#     def __init__(self):
#         global app
#         app = self
#         self.root = tk.Tk()
#         self.root.title("Screenshot Uploader")
        
#         # 状态和控件
#         self.status_var = tk.StringVar(value="Ready")
#         status_frame = tk.Frame(self.root)
#         tk.Label(status_frame, textvariable=self.status_var).pack(side=tk.LEFT, padx=5)
#         status_frame.pack(fill=tk.X)

#         ctrl = tk.Frame(self.root)
#         tk.Button(ctrl, text="Full", command=self.set_full).pack(side=tk.LEFT)
#         tk.Button(ctrl, text="Region", command=self.set_region).pack(side=tk.LEFT)
#         tk.Button(ctrl, text="Capture", command=self.trigger_capture).pack(side=tk.LEFT)
#         ctrl.pack(pady=4)
        
#         self.region_mode = False

#         # 预览
#         self.preview = tk.Label(self.root, text="Preview")
#         self.preview.pack(pady=5)
#         self.current_img = None
        
#         # AI 文本
#         self.analysis_text = tk.Text(self.root, height=10)
#         self.analysis_text.pack(fill=tk.BOTH, expand=True)

#         # SocketIO
#         threading.Thread(target=self.start_socketio, daemon=True).start()
#         self.root.after(100, self.poll_queue)

#     def set_full(self):
#         self.region_mode = False
#         self.status_var.set("Mode: Full")
#     def set_region(self):
#         self.region_mode = True
#         self.status_var.set("Mode: Region")

#     def trigger_capture(self):
#         threading.Thread(target=self.capture_worker, daemon=True).start()

#     def capture_worker(self):
#         self.status_var.set("Capturing…")
#         if self.region_mode:
#             sel = RegionSelector(self.root)
#             bbox = sel.select()
#             img_bytes = grab_region(bbox)
#         else:
#             img_bytes = grab_fullscreen()
#         self.current_img = img_bytes
#         # 发送给服务器
#         b64 = base64.b64encode(img_bytes).decode()
#         try:
#             requests.post(f"{settings.base_url}/upload_screenshot", json={'image': b64}, headers={'Authorization': f"Bearer {settings.dashboard_token}"})
#         except Exception:
#             pass

#     def start_socketio(self):
#         auth = {'token': settings.dashboard_token} if settings.dashboard_token else {}
#         try:
#             sio.connect(settings.base_url, auth=auth)
#             sio.wait()
#         except Exception as e:
#             logger.error("Socket.IO 连接失败: %s", e)
#             _task_queue.put(lambda: self.status_var.set("Socket.IO Failed"))

#     def poll_queue(self):
#         try:
#             while True:
#                 fn = _task_queue.get_nowait()
#                 fn()
#         except queue.Empty:
#             pass
#         self.root.after(100, self.poll_queue)

#     def run(self):
#         self.root.mainloop()

# # Socket.IO 事件处理，把服务器推送的新截图和分析文本更新到客户端
# @sio.on('new_screenshot')
# def on_new(data):
#     img_url = data.get('image_url')
#     text = data.get('analysis','')
#     # 下载图片
#     try:
#         r = requests.get(f"{settings.base_url}{img_url}")
#         img = r.content
#         photo = ImageTk.PhotoImage(Image.open(io.BytesIO(img)))
#         # 新代码（捕获 self 和 photo）
#         # 新代码（捕获 self 和 photo）
#         _task_queue.put((lambda inst, img: (inst.preview.config(image=img), setattr(inst, 'photo', img)))
#                 (self, photo))

#     except:
#         pass
#     _task_queue.put(lambda: app.analysis_text.delete('1.0','end') or app.analysis_text.insert('1.0', text))

# if __name__ == '__main__':
#     App().run()





