// src/js/features/chat.js
import { getSocket } from '../services/socketService.js';
import { generateUUID } from '../utils/uuid.js';
import { escapeHtml } from '../utils/escapeHtml.js';


function initAiChatHandlers() {
    document.getElementById('chat-send-chat')?.addEventListener('click', sendChatMessage);
    document.getElementById('chat-chat-input')?.addEventListener('keypress', (e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage();}});
    document.getElementById('chat-file-upload')?.addEventListener('change', handleFileUpload);
    document.getElementById('chat-clear-current-chat')?.addEventListener('click', clearCurrentChatDisplay);
    document.getElementById('chat-clear-all-sessions')?.addEventListener('click', clearAllChatSessions);
    loadChatSessionsFromStorage();
    const streamingToggle = document.getElementById('streaming-toggle-checkbox');
    if (streamingToggle) {
        const saved = localStorage.getItem('useStreamingOutput');
        streamingToggle.checked = saved !== null ? saved === 'true' : true;
        if(saved === null) localStorage.setItem('useStreamingOutput', 'true');
        streamingToggle.addEventListener('change', function(){localStorage.setItem('useStreamingOutput',String(this.checked));});
    }
    const testRenderBtn = document.getElementById('test-render-btn');
    if (testRenderBtn) {
        testRenderBtn.addEventListener('click', () => {
            const chatHistoryEl = document.getElementById('chat-chat-history'); if(!chatHistoryEl)return;
            if(chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
            const testMsgDiv = document.createElement('div'); testMsgDiv.className = 'ai-message';
            const testMD = "### Test MD\n\n- List\n- KaTeX: $E=mc^2$ and $$\\sum_{i=0}^n i^2 = \\frac{n(n+1)(2n+1)}{6}$$";
            processAIMessage(testMsgDiv, testMD); // Use the main processing function
            chatHistoryEl.appendChild(testMsgDiv); scrollToChatBottom(chatHistoryEl);
        });
    } else {
        console.warn("Test render button #test-render-btn not found in HTML.");
    }
    // 允许粘贴图片
    const chatInput = document.getElementById('chat-chat-input');
    // chatInput.addEventListener('paste', e => {
    // const items = e.clipboardData && e.clipboardData.items;
    // if (!items) return;
    // for (const it of items) {
    //     if (it.kind === 'file' && it.type.startsWith('image/')) {
    //     e.preventDefault();                       // 阻止把图片作为 base64 文本粘进去
    //     const file = it.getAsFile();              // File 对象
    //     if (!file) return;

    //     // ===== 前端预览（可选） =====
    //     const url = URL.createObjectURL(file);
    //     const preview = document.createElement('img');
    //     preview.src   = url;
    //     preview.style.maxWidth = '120px';
    //     preview.style.maxHeight = '120px';
    //     document.getElementById('chat-upload-preview')
    //             .replaceChildren(preview);

    //     // ===== 发送给服务器分析 =====
    //     // const formData = new FormData();
    //     // formData.append('image', file, 'pasted.png');
    //     // fetch('/api/analyze_image', {              // 你后端的分析接口
    //     //     method: 'POST',
    //     //     body  : formData
    //     // }).then(r => r.json())
    //     //     .then(res => {
    //     //     // 把 AI 回答插回聊天窗口
    //     //     const aiDiv = document.createElement('div');
    //     //     aiDiv.className = 'ai-message';
    //     //     processAIMessage(aiDiv, res.message || '(无返回)', 'image_paste');
    //     //     document.getElementById('chat-chat-history')
    //     //             .appendChild(aiDiv);
    //     //     scrollToChatBottom(document.getElementById('chat-chat-history'));
    //     //     })
    //     //     .catch(err => console.error('Paste-image analyse error', err));

    //     // ===== 发送给服务器分析（Socket）=====
    //     const reader = new FileReader();
    //     reader.onload = () => {
    //     const base64 = reader.result.split(',')[1];
    //     const reqId  = generateUUID();

    //     // 在聊天窗口插入“用户图片”占位
    //     const msgDiv = document.createElement('div');
    //     msgDiv.className = 'user-message';
    //     msgDiv.dataset.requestId = reqId;
    //     msgDiv.innerHTML = `<strong>您: </strong><br>
    //         <img src="${url}" style="max-width:160px;max-height:160px;border-radius:4px;border:1px solid var(--bs-border-color);">`;
    //     document.getElementById('chat-chat-history').appendChild(msgDiv);
    //     scrollToChatBottom(document.getElementById('chat-chat-history'));

    //     // 通过 Socket 发送
    //     socket.emit('chat_message', {
    //         request_id : reqId,
    //         prompt     : chatInput.value.trim(),     // 输入框文字，可为空
    //         use_streaming : true,
    //         history    : getCurrentSessionHistory(),
    //         provider   : selectedModel.provider,
    //         model_id   : selectedModel.model_id,
    //         image_data : base64                      // 关键字段
    //     });

    //     chatInput.value = '';                      // 清空输入框
    //     };
    //     reader.readAsDataURL(file);

    //     break; // 只处理首个图片
    //     }
    // }
    // });
}

export function initChat() {
  // TODO: 绑定聊天按钮、输入回车；调用 sendChatMessage；渲染历史会话
}

export function sendChatMessage() {
  const socket = getSocket();
  const reqId = generateUUID();
  // TODO: 读取输入框值、历史记录，发 socket.emit('chat_message', {...})
}


function saveCurrentChatSessionId() {
    if (currentChatSessionId) { 
        localStorage.setItem('currentChatSessionId', currentChatSessionId); 
    } else { 
        localStorage.removeItem('currentChatSessionId'); 
    }
}


// ------------------------------------------------------------------
//  renderChatHistory — 唯一正式实现
//  依赖工具: escapeHtml, processAIMessage, scrollToChatBottom
// ------------------------------------------------------------------
function renderChatHistory(historyArray) {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;

    chatHistoryEl.innerHTML = '';
    if (!historyArray || !historyArray.length) {
        chatHistoryEl.innerHTML =
            '<div class="system-message">对话为空...</div>';
        return;
    }

    historyArray.forEach(turn => {
        if (!turn || !turn.role || !turn.parts || !turn.parts[0]) return;
        const role = turn.role;
        const text = (turn.parts[0].text) || '';
        const msgDiv = document.createElement('div');

        if (role === 'user') {
            msgDiv.className = 'user-message';
            const strong = document.createElement('strong');
            strong.textContent = '您: ';
            msgDiv.appendChild(strong);

            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = text;

            // 若文本里携带「用户上传了文件」占位，替换为附件样式
            const fileMatch = text.match(/\[用户上传了文件: (.*?)\]/);
            if (fileMatch && fileMatch[1]) {
                content.textContent = text.replace(fileMatch[0], '').trim();
                const fileInfo = document.createElement('div');
                fileInfo.className = 'attached-file';
                fileInfo.innerHTML =
                    `<i class="fas fa-paperclip"></i> (文件: ${escapeHtml(fileMatch[1])})`;
                if (content.textContent) content.appendChild(document.createElement('br'));
                content.appendChild(fileInfo);
            }
            msgDiv.appendChild(content);

        } else if (role === 'model') {
            msgDiv.className = 'ai-message';
            // 交给 processAIMessage 渲染 Markdown / LaTeX
            processAIMessage(msgDiv, text, 'history_load');

        } else { // system / function 之类
            msgDiv.className = 'system-message';
            const strong = document.createElement('strong');
            strong.textContent = `${role}: `;
            msgDiv.appendChild(strong);

            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = text;
            msgDiv.appendChild(content);
        }

        chatHistoryEl.appendChild(msgDiv);
    });

    scrollToChatBottom(chatHistoryEl);
}


/**
 * 在指定的聊天历史元素中追加一条系统消息或错误提示。
 * @param {string} message 要显示的消息文本。
 * @param {HTMLElement} chatHistoryElRef 可选，聊天历史的DOM元素。如果未提供，则尝试获取 #chat-chat-history。
 * @param {string} messageType 可选，消息类型，用于CSS样式，例如 'error', 'info', 'success'。默认为 'system' 或 'error'。
 */
function appendSystemMessage(message, chatHistoryElRef, messageType = 'system') {
    const chatHistoryElement = chatHistoryElRef || document.getElementById('chat-chat-history');
    if (!chatHistoryElement) {
        console.error("appendSystemMessage: Chat history element not found.");
        return;
    }

    const messageDiv = document.createElement('div');
    // 根据 messageType 设置不同的CSS类，以便自定义样式
    if (messageType === 'error') {
        messageDiv.className = 'system-message error-text p-2 my-1 text-danger border border-danger rounded bg-light-danger'; // 示例CSS类
    } else if (messageType === 'info') {
        messageDiv.className = 'system-message info-text p-2 my-1 text-info border border-info rounded bg-light-info';
    } else { // 'system' or default
        messageDiv.className = 'system-message p-2 my-1 text-muted'; // 默认的系统消息样式
    }
    messageDiv.textContent = message;

    chatHistoryElement.appendChild(messageDiv);
    if (typeof scrollToChatBottom === "function") { // 确保 scrollToChatBottom 已定义
        scrollToChatBottom(chatHistoryElement);
    }

    @param {string | number | null} sessionId 要激活的会话的ID。如果为 null，则取消所有高亮。
}