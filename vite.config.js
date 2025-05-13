// F:\screenshot_ai\vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // 代理 Socket.IO 连接
      '/socket.io': {
        target: 'http://localhost:5000', // 你的 Python 后端地址和端口
        ws: true, // 重要：为 WebSocket 启用代理
        changeOrigin: true // 建议添加，改变请求头中的 Origin
      },
      // 代理所有以 /api 开头的 API 请求 (你可以根据实际情况调整前缀)
      // 如果你的 fetch URL 没有特定前缀，可能需要更具体的规则
      '/api_info': { // 直接代理 /api_info 路径
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
      '/chat_with_file': { // 代理文件上传请求
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
       '/crop_image': { // 代理截图裁剪请求
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
       '/process_voice': { // 代理语音处理请求
         target: 'http://localhost:5000',
         changeOrigin: true,
      }
      // 如果还有其他后端API路径，也需要类似地添加代理规则
    }
  },
  build: {
      outDir: 'dist', // 保留构建输出目录配置
      emptyOutDir: true,
  }
});