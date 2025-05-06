# # core/capture.py
# from __future__ import annotations
# import mss
# import mss.tools

# def grab_screen() -> bytes:
#     """抓取整个屏幕，返回 PNG bytes"""
#     with mss.mss() as sct:
#         img = sct.grab(sct.monitors[0])
#         # mss 10.x: to_png 直接返回 PNG 字节
#         return mss.tools.to_png(img.rgb, img.size)

# if __name__ == "__main__":
#     with open("test_capture.png", "wb") as f:
#         f.write(grab_screen())
#     print("Screenshot saved: test_capture.png")


#############################v2###############################################
# core/capture.py
from __future__ import annotations
import mss
import mss.tools
from core.settings import settings


def grab_fullscreen() -> bytes:
    """抓取整个屏幕，返回 PNG bytes"""
    with mss.mss() as sct:
        img = sct.grab(sct.monitors[0])
        return mss.tools.to_png(img.rgb, img.size)


def grab_region(bbox: tuple[int, int, int, int]) -> bytes:
    """抓取指定区域 (left, top, width, height)，返回 PNG bytes"""
    with mss.mss() as sct:
        img = sct.grab({
            'left': bbox[0], 'top': bbox[1],
            'width': bbox[2] - bbox[0], 'height': bbox[3] - bbox[1]
        })
        return mss.tools.to_png(img.rgb, img.size)

def optimize_image(img_bytes, quality=85, max_size=1920):
    """优化图片大小，减少传输时间"""
    from PIL import Image
    import io
    
    # 从字节加载图片
    img = Image.open(io.BytesIO(img_bytes))
    
    # 调整大小（如果需要）
    width, height = img.size
    if width > max_size or height > max_size:
        if width > height:
            new_width = max_size
            new_height = int(height * (max_size / width))
        else:
            new_height = max_size
            new_width = int(width * (max_size / height))
        img = img.resize((new_width, new_height), Image.LANCZOS)
    
    # 压缩图片
    output = io.BytesIO()
    img.save(output, format='JPEG', quality=quality, optimize=True)
    return output.getvalue()


def capture_screenshot():
    """捕获屏幕截图并返回字节数据"""
    with mss.mss() as sct:
        monitor = sct.monitors[0]  # 捕获主显示器
        sct_img = sct.grab(monitor)
        img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
        
        # 转换为字节
        img_byte_arr = io.BytesIO()
        img.save(img_byte_arr, format='JPEG')
        img_bytes = img_byte_arr.getvalue()
        
        # 优化图片
        optimized_img_bytes = optimize_image(
            img_bytes, 
            quality=settings.image_quality, 
            max_size=settings.image_max_size
        )
        
        return optimized_img_bytes


