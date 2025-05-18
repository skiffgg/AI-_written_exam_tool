// src/js/services/socketService.js
import io from 'socket.io-client';
let socket;

function connectSocket() {
  socket = io('http://localhost:5000'); // 或自定义 URL
  socket.on('connect', function() {
      console.log('[Socket] Connected to server');
      const statusEl = document.getElementById('connection-status');
      if (statusEl) statusEl.textContent = '已连接';
      if (typeof getApiInfo === 'function') getApiInfo(); 
  });

  socket.on('api_info', function(data) {
    console.log('<<<<< [Socket RECEIVED] api_info >>>>>', data);
    if (typeof updateApiInfo === 'function') {
        updateApiInfo(data); // data 应该包含 { provider: "..." }
    } else {
        console.error("updateApiInfo function is not defined.");
    }
  });

  socket.on('connect_error', function(error) {
    console.error('[Socket] Connection error:', error.message);
    const statusEl = document.getElementById('connection-status');
    if (statusEl) statusEl.textContent = '连接失败: ' + error.message;
  });

  socket.on("disconnect", (reason) => {
    console.log(`[Socket] 连接断开，ID: ${socket.id}, 原因: ${reason}`);
    
    // 如果是因为服务端关闭连接，尝试重新连接
    if (reason === 'io server disconnect') {
      console.log("[Socket] 服务端主动断开连接，尝试重新连接...");
      socket.connect();
    } else {
      console.log("[Socket] 客户端连接主动断开");
    }

    // 如果需要，可以在界面上给用户显示连接断开提示
    const notification = document.createElement('div');
    notification.classList.add('disconnect-notification');
    notification.textContent = '与服务器的连接已断开。正在尝试重新连接...';
    document.body.appendChild(notification);

    // 设置一个定时器，用于自动移除提示
    setTimeout(() => {
      notification.remove();
    }, 5000);
  });
}

export { connectSocket, socket };
