// src/js/init/initSocket.js
import { connectSocket } from '../services/socketService.js';
import { handleChatStreamChunk, handleChatStreamEnd, handleTaskError } from '../features/chat.js';

export default function initSocket() {
  const socket = connectSocket();

  socket.on('connect', () => {
    console.log('[Socket] 已连接，id=' + socket.id);
  });
  socket.on('disconnect', () => {
    console.log('[Socket] 已断开连接');
  });

  socket.on('chat_stream_chunk', handleChatStreamChunk);
  socket.on('chat_stream_end', handleChatStreamEnd);
  socket.on('task_error', handleTaskError); 
  
  return socket; 
}
