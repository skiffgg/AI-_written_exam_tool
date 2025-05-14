// F:\screenshot_ai\vite.config.js
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // 代理 Socket.IO 连接 (只保留一个定义)
      '/socket.io': {
        target: 'http://localhost:5000', // 你的 Python 后端地址和端口
        ws: true,                         // 重要：为 WebSocket 启用代理
        changeOrigin: true                // 建议添加，改变请求头中的 Origin
      },
      // 代理特定的非 /api/ 前缀路径
      '/api_info': { 
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
      '/chat_with_file': { 
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
       '/crop_image': { 
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
       '/process_voice': { 
         target: 'http://localhost:5000',
         changeOrigin: true,
      },
      // --- 通用API代理规则 ---
      // 这个规则会捕获所有以 /api 开头的请求，例如 /api/available_models
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      }
    }
  },
  build: {
      outDir: 'dist', 
      emptyOutDir: true,
  }
});