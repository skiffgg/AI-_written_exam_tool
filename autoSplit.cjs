#!/usr/bin/env node
/**
 * autoSplit.js
 * 自动化生成模块化项目结构及文件
 */

const fs = require('fs');
const path = require('path');

const files = {
  'src/js/main.js': `// src/js/main.js
import initSocket from './init/initSocket.js';
import initAllFeatures from './init/initFeatures.js';

document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  initAllFeatures();
});
`,
  'src/js/init/initSocket.js': `// src/js/init/initSocket.js
export default function initSocket() {
  // TODO: 初始化 Socket.IO 连接，监听所有 socket 事件
}
`,
  'src/js/init/initMarkdown.js': `// src/js/init/initMarkdown.js
export function initMarkdown() {
  // TODO: 初始化 markdown-it + highlight.js + KaTeX
}
`,
  'src/js/init/initTheme.js': `// src/js/init/initTheme.js
export function initTheme() {
  // TODO: 初始化主题选择器，应用初始主题
}
`,
  'src/js/init/initNavigation.js': `// src/js/init/initNavigation.js
export function initNavigation() {
  // TODO: 初始化主导航下拉、feature 切换逻辑
}
`,
  'src/js/init/initFeatures.js': `// src/js/init/initFeatures.js
import { initMarkdown } from './initMarkdown.js';
import { initTheme }    from './initTheme.js';
import { initNavigation } from './initNavigation.js';
import initSocket       from './initSocket.js';

export default function initAllFeatures() {
  initMarkdown();
  initTheme();
  initNavigation();
  // TODO: 调用其它 initXxx，如聊天、截图、语音模块的初始化
}
`,
  'src/js/services/socketService.js': `// src/js/services/socketService.js
import io from 'socket.io-client';

let socket;
export function connectSocket() {
  socket = io(); // 或自定义 URL
  return socket;
}

export function getSocket() {
  return socket;
}
`,
  'src/js/services/apiService.js': `// src/js/services/apiService.js
export async function fetchAvailableModels(token) {
  const res = await fetch('/api/available_models', {
    headers: token ? { 'Authorization': \`Bearer \${token}\` } : {}
  });
  if (!res.ok) throw new Error(\`加载模型失败：\${res.status}\`);
  return res.json();
}

export async function sendVoice(blob, token) {
  const fd = new FormData();
  fd.append('audio', blob);
  const headers = {};
  if (token) headers['Authorization'] = \`Bearer \${token}\`;
  const res = await fetch('/process_voice', { method: 'POST', body: fd, headers });
  if (!res.ok) throw new Error(\`语音发送失败：\${res.status}\`);
  return res.json();
}
`,
  'src/js/features/chat.js': `// src/js/features/chat.js
import { getSocket } from '../services/socketService.js';
import { generateUUID } from '../utils/uuid.js';
import { escapeHtml } from '../utils/escapeHtml.js';

export function initChat() {
  // TODO: 绑定聊天按钮、输入回车；调用 sendChatMessage；渲染历史会话
}

export function sendChatMessage() {
  const socket = getSocket();
  const reqId = generateUUID();
  // TODO: 读取输入框值、历史记录，发 socket.emit('chat_message', {...})
}
`,
  'src/js/features/voice.js': `// src/js/features/voice.js
import { getSocket } from '../services/socketService.js';
import { generateUUID }  from '../utils/uuid.js';

export function initVoice() {
  // TODO: 录音按钮逻辑、mediaRecorder、历史记录渲染
}
`,
  'src/js/features/screenshot.js': `// src/js/features/screenshot.js
import { getSocket } from '../services/socketService.js';

export function initScreenshot() {
  // TODO: 截图请求、裁剪 overlay、历史管理、流式切换
}
`,
  'src/js/utils/dom.js': `// src/js/utils/dom.js
export function createDeleteButton(onClick) {
  const btn = document.createElement('button');
  btn.className = 'delete-history btn btn-xs btn-outline-danger py-0 px-1 ms-auto';
  btn.title = '删除此条记录';
  btn.type = 'button';
  btn.innerHTML = '<i class="fas fa-times small"></i>';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}
`,
  'src/js/utils/format.js': `// src/js/utils/format.js
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return 'N/A';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return \`\${size.toFixed(1)} \${sizes[i]}\`;
}
`,
  'src/js/utils/storage.js': `// src/js/utils/storage.js
export function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn(\`[Storage] Save error: \${e}\`);
  }
}

export function load(key, defaultValue = null) {
  try {
    const item = localStorage.getItem(key);
    return item !== null ? JSON.parse(item) : defaultValue;
  } catch (e) {
    console.warn(\`[Storage] Load error: \${e}\`);
    return defaultValue;
  }
}
`,
  'src/js/utils/uuid.js': `// src/js/utils/uuid.js
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
`,
  'src/js/utils/escapeHtml.js': `// src/js/utils/escapeHtml.js
const escapeMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
};
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => escapeMap[m]);
}
`
};

Object.keys(files).forEach(relativePath => {
  const targetPath = path.resolve(__dirname, '..', relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, files[relativePath]);
  console.log(`Generated ${relativePath}`);
});

console.log('模块化文件自动生成完成！');
