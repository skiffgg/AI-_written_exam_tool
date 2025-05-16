import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // 代理 Socket.IO (WebSocket)
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
        changeOrigin: true
      },
      // 单独代理特定接口
      '/api_info': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/chat_with_file': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/crop_image': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/process_voice': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false
      },
      // 通用 API 代理
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
