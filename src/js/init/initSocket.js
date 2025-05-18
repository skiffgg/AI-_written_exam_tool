// src/js/init/initSocket.js
import { connectSocket } from '../services/socketService.js';

export default function initSocket() {
  const socket = connectSocket();

  socket.on('connect', () => {
    console.log('[Socket] 已连接，id=' + socket.id);
  });
  socket.on('disconnect', () => {
    console.log('[Socket] 已断开连接');
  });
  // TODO: 根据需要注册全局事件，如：
  // socket.on('analysis_result', data => { … });
}
