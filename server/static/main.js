/**
 * main.js
 *
 * Frontend JavaScript logic for the AI Assistant Dashboard.
 * Includes Markdown and LaTeX rendering for chat messages.
 */

// --- Global Variables & State ---
let TOKEN = '';
let selection = { x: 0, y: 0, width: 0, height: 0 };
let isDragging = false;
let dragStartX, dragStartY;
let dragType = '';
let currentImage = null; // URL of image in overlay
let socket = null;
let uploadedFile = null; // File staged for chat upload
let mediaRecorder; // For voice recording
let audioChunks = []; // Store audio data chunks
let chatSessions = []; // Stores all chat session objects {id, title, history}
let currentChatSessionId = null; // ID of the currently active session

// Markdown-it instance (will be initialized in initAllFeatures)
let md = null;

// --- Utility Functions ---

/** Simple console logging wrapper. */
function debugLog(message) {
    console.log(`[DEBUG] ${message}`); // Using the user's preferred prefix
}

/** Formats file size. */
function formatFileSize(bytes) {
    if (bytes < 0) return 'Invalid size';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)));
    const fixed = (i === 0) ? 0 : 1;
    return parseFloat((bytes / Math.pow(k, i)).toFixed(fixed)) + ' ' + sizes[i];
}

/** Scrolls a chat history element to the bottom. */
function scrollToChatBottom(chatHistoryEl) {
    if (chatHistoryEl) {
        requestAnimationFrame(() => {
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        });
    }
}

/** Handles file selection for the AI Chat tab. */
function handleFileUpload(e) {
    debugLog("File input changed (handleFileUpload).");
    const fileInput = e.target;
    const uploadPreviewEl = document.getElementById('chat-upload-preview');

    if (!uploadPreviewEl) {
        console.error("Chat upload preview element (#chat-upload-preview) not found.");
        return;
    }
    uploadPreviewEl.innerHTML = ''; // Clear previous preview
    uploadedFile = null; // Reset global file variable

    if (fileInput.files && fileInput.files.length > 0) {
        const file = fileInput.files[0];
        uploadedFile = file; // Store globally for sendChatMessage
        debugLog(`File selected: ${file.name}, Size: ${file.size}`);

        const previewItem = document.createElement('div');
        previewItem.className = 'preview-item';
        const displayName = file.name.length > 40 ? file.name.substring(0, 37) + '...' : file.name;
        previewItem.innerHTML = `
            <div class="file-info" title="${file.name}">
                <i class="fas fa-file"></i>
                <span>${displayName} (${formatFileSize(file.size)})</span>
            </div>
            <button type="button" class="remove-file" title="取消选择此文件"><i class="fas fa-times"></i></button>
        `;
        previewItem.querySelector('.remove-file').onclick = () => {
            debugLog(`Removing file preview: ${file.name}`);
            uploadPreviewEl.innerHTML = '';
            uploadedFile = null;
            fileInput.value = ''; // Reset file input
        };
        uploadPreviewEl.appendChild(previewItem);
    } else {
        debugLog("File selection cancelled or no file chosen.");
    }
}

// --- LaTeX and Markdown Rendering ---

/**
 * Renders LaTeX within a given DOM element using KaTeX.
 * @param {HTMLElement} element The DOM element to scan for LaTeX.
 */
function renderLatexInElement(element) {
    if (!element) {
        // console.warn("renderLatexInElement: Element is null or undefined.");
        return;
    }
    if (typeof window.renderMathInElement === 'function') {
        try {
            window.renderMathInElement(element, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false,
                ignoredClasses: ["no-katex-render", "hljs", "no-math"] // Added "no-math"
            });
        } catch (error) {
            console.error("Error during KaTeX rendering:", error, "on element:", element);
        }
    } else {
         // This log can be very frequent if KaTeX hasn't loaded when this is called often.
         // console.warn("KaTeX auto-render function (renderMathInElement) not available at call time for element:", element.id || element.className);
    }
}

/**
 * 自定义 Markdown 渲染函数，处理特殊格式
 * @param {string} text - 要渲染的 Markdown 文本
 * @returns {string} - 渲染后的 HTML
 */
function renderMarkdown(text) {
    // 如果 marked 未加载，返回基本的 HTML 转义
    if (typeof marked === 'undefined') {
        console.warn('Markdown 解析器未加载，使用基本 HTML 转义');
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
    
    try {
        // 预处理：处理数字标题格式（如 "3. 收银员："）
        // 将其转换为适当的 HTML 结构，确保数字和文本在同一行
        text = text.replace(/^(\d+)\.\s+([^\n]+)$/gm, function(match, number, content) {
            return `<h3 class="numbered-heading">${number}.</h3> ${content}`;
        });
        
        // 使用 marked 解析 Markdown
        let html = marked.parse(text);
        
        // 后处理：修复列表项中的段落嵌套问题
        html = html.replace(/<li>\s*<p>(.*?)<\/p>\s*<\/li>/g, '<li>$1</li>');
        
        return html;
    } catch (error) {
        console.error('Markdown 渲染错误:', error);
        // 出错时返回基本的 HTML 转义
        return escapeHtml(text).replace(/\n/g, '<br>');
    }
}

/**
 * Renders Markdown text to HTML and then renders LaTeX within that HTML.
 * @param {string} markdownText The Markdown string.
 * @param {HTMLElement} targetElement The DOM element where the HTML will be inserted.
 */
function renderMarkdownAndLatex(markdownText, targetElement) {
    if (!targetElement) {
        console.error("Target element for Markdown/LaTeX rendering is not provided.");
        return;
    }
    
    // 确保 markdownText 是字符串
    markdownText = markdownText || "";
    
    // 使用 markdown-it 或 marked 渲染 Markdown
    let htmlContent = "";
    
    if (md) { // 优先使用 markdown-it (应该在 initAllFeatures 中初始化)
        try {
            htmlContent = md.render(markdownText);
            console.log("Rendered Markdown using markdown-it");
        } catch (error) {
            console.error("Error rendering Markdown with markdown-it:", error);
            // 回退到 marked 或基本 HTML 转义
        }
    } 
    
    // 如果 markdown-it 未初始化或失败，尝试使用 marked
    if (!htmlContent && typeof marked !== 'undefined') {
        try {
            htmlContent = marked.parse(markdownText);
            console.log("Rendered Markdown using marked");
        } catch (error) {
            console.error("Error rendering Markdown with marked:", error);
            // 回退到基本 HTML 转义
        }
    }
    
    // 如果两者都失败，使用基本的 HTML 转义
    if (!htmlContent) {
        htmlContent = escapeHtml(markdownText).replace(/\n/g, '<br>');
        console.warn("Falling back to basic HTML escaping for Markdown");
    }
    
    // 设置 HTML 内容
    targetElement.innerHTML = htmlContent;
    
    // 渲染 LaTeX
    renderLatexInElement(targetElement);
}


// --- Socket.IO Initialization --- (Restoring full function as per user's main.js structure)
function initSocketIO() {
    debugLog('Initializing Socket.IO connection...');
    const baseUrl = window.API_BASE_URL || window.location.origin;
    socket = io(baseUrl, { transports: ['websocket', 'polling'], reconnectionAttempts: 5, reconnectionDelay: 1000, timeout: 20000 });
    socket.on('connect', () => { debugLog('Socket.IO Connected'); updateConnectionStatus(true); getApiInfo(); socket.emit('request_history'); });
    socket.on('disconnect', (reason) => { debugLog(`Socket.IO Disconnected: ${reason}`); updateConnectionStatus(false); });
    socket.on('connect_error', (error) => { debugLog(`Socket.IO Connection Error: ${error.message}`); updateConnectionStatus(false); });
    socket.on('capture', () => { debugLog("Received 'capture' event."); alert("服务器请求截图 (客户端功能待实现)"); });
    socket.on('new_screenshot', (data) => addHistoryItem(data));
    socket.on('analysis_result', (data) => { const el = document.getElementById('ss-ai-analysis'); if (el && data?.analysis) { el.textContent = data.analysis; if (data.image_url) el.dataset.sourceUrl = data.image_url; } });
    socket.on('analysis_error', (errorData) => { console.error(`Analysis Error for ${errorData?.image_url}: ${errorData?.error}`); alert(`AI分析图片 ${errorData?.image_url || ''} 失败: ${errorData?.error || '未知错误'}`); const el = document.getElementById('ss-ai-analysis'); if (el && el.dataset.sourceUrl === errorData?.image_url) el.textContent = `分析失败: ${errorData?.error || '未知错误'}`; });
    socket.on('history', (historyData) => { const listEl = document.getElementById('ss-history-list'); if (listEl) { listEl.innerHTML = ''; historyData.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach(addHistoryItem); } });
    socket.on('api_info', (apiData) => updateApiInfo(apiData));

    function handleAiResponseMessage(data, isStreamEnd = false) {
        const chatHistoryEl = document.getElementById('chat-chat-history'); if (!chatHistoryEl) { console.error("Chat history element not found in handleAiResponseMessage"); return; }
        const messageText = isStreamEnd ? (data.full_message || "") : (data.message || "");
        const provider = data.provider || 'AI'; const requestId = data.request_id; const sessionIdFromEvent = data.session_id;
        let activeSession = chatSessions.find(s => s.id === (sessionIdFromEvent || currentChatSessionId));
        if (sessionIdFromEvent && currentChatSessionId !== sessionIdFromEvent && chatSessions.find(s => s.id === sessionIdFromEvent)) {
            currentChatSessionId = sessionIdFromEvent; activeSession = chatSessions.find(s => s.id === currentChatSessionId);
            const listEl = document.getElementById('chat-session-list'); listEl?.querySelectorAll('.history-item.active-session')?.forEach(item => item.classList.remove('active-session'));
            listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`)?.classList.add('active-session');
            if (activeSession) renderChatHistory(activeSession.history);
        }
        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${requestId}"]`); let messageContentEl;
        if (!aiDiv) {
            const thinkingDiv = requestId ? chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${requestId}"]`) : chatHistoryEl.querySelector('.ai-thinking');
            aiDiv = document.createElement('div'); aiDiv.className = 'ai-message'; if (requestId) aiDiv.dataset.requestId = requestId;
            const strongTag = document.createElement('strong'); strongTag.textContent = `${provider}: `; aiDiv.appendChild(strongTag);
            messageContentEl = document.createElement('div'); messageContentEl.className = 'message-content'; aiDiv.appendChild(messageContentEl);
            if (thinkingDiv && thinkingDiv.parentNode === chatHistoryEl) chatHistoryEl.replaceChild(aiDiv, thinkingDiv); else if (thinkingDiv) { thinkingDiv.remove(); chatHistoryEl.appendChild(aiDiv); } else chatHistoryEl.appendChild(aiDiv);
        } else {
            messageContentEl = aiDiv.querySelector('.message-content'); if (!messageContentEl) { messageContentEl = document.createElement('div'); messageContentEl.className = 'message-content'; aiDiv.appendChild(messageContentEl); }
            const strongTag = aiDiv.querySelector('strong'); if (strongTag && strongTag.textContent !== `${provider}: `) strongTag.textContent = `${provider}: `;
        }
        renderMarkdownAndLatex(messageText, messageContentEl); scrollToChatBottom(chatHistoryEl);
        if (activeSession && (messageText || isStreamEnd)) {
            const finalMsgText = isStreamEnd ? (data.full_message || "") : messageText;
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === requestId);
            if (tempMsgIndex > -1) { activeSession.history[tempMsgIndex] = { role: 'model', parts: [{ text: finalMsgText }], provider: provider }; delete activeSession.history[tempMsgIndex].temp_id; }
            else { const alreadyExists = activeSession.history.some(msg => msg.role === 'model' && msg.parts[0].text === finalMsgText && msg.provider === provider && !msg.temp_id); if (!alreadyExists || (isStreamEnd && finalMsgText)) activeSession.history.push({ role: 'model', parts: [{ text: finalMsgText }], provider: provider }); }
            saveChatSessionsToStorage();
        } else if (!activeSession) console.warn("No active session to save AI msg history.", data);
    }
    socket.on('chat_response', (data) => handleAiResponseMessage(data, false));
    socket.on('chat_stream_chunk', function(data) {
        console.log('Received chat_stream_chunk:', data);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        const aiThinkingDiv = chatHistoryEl?.querySelector('.ai-thinking');
        
        // 如果是第一个块，移除思考指示器并创建新的 AI 消息元素
        if (aiThinkingDiv) {
            // 替换思考指示器为实际的 AI 消息
            const aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            // Use provider from data if available, otherwise default
            const providerName = data.provider || 'AI';
            aiDiv.innerHTML = `<strong>${providerName}:</strong> <span class="ai-response-text">${data.chunk || ''}</span>`;
            aiDiv.dataset.requestId = data.request_id; // 存储请求 ID 以便后续更新
            chatHistoryEl.replaceChild(aiDiv, aiThinkingDiv);
        } else {
            // 查找现有的 AI 消息元素并追加内容
            let aiDiv = chatHistoryEl?.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
            if (aiDiv) {
                const textSpan = aiDiv.querySelector('.ai-response-text');
                if (textSpan) {
                    // 直接追加文本，不使用 textContent 以避免重新渲染整个内容
                    const chunk = data.chunk || '';
                    textSpan.insertAdjacentText('beforeend', chunk);
                }
            } else {
                // 如果找不到现有元素（不应该发生，但作为后备），创建一个新的
                console.log("Stream chunk received, but no existing AI message div found. Creating new one.");
                const newAiDiv = document.createElement('div');
                newAiDiv.className = 'ai-message';
                const providerName = data.provider || 'AI';
                newAiDiv.innerHTML = `<strong>${providerName}:</strong> <span class="ai-response-text">${data.chunk || ''}</span>`;
                newAiDiv.dataset.requestId = data.request_id;
                chatHistoryEl.appendChild(newAiDiv);
                aiDiv = newAiDiv; // For scrolling
            }
        }
        
        scrollToChatBottom(chatHistoryEl);
    });
    socket.on('chat_stream_end', function(data) {
        console.log('Received chat_stream_end:', data);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        
        // 查找当前活动的聊天会话
        let activeSession = null;
        if (currentChatSessionId) {
            activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        }
        
        // 查找消息元素
        const aiDiv = chatHistoryEl?.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
        if (!aiDiv) {
            console.warn(`No message element found for request ID: ${data.request_id}`);
            return;
        }
        
        // 获取最终消息文本
        const textSpan = aiDiv.querySelector('.ai-response-text');
        const finalMessageText = textSpan ? textSpan.textContent : '';
        
        // 将完整消息添加到历史记录
        if (activeSession) {
            // 查找临时消息并更新或添加新消息
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === data.request_id);
            if (tempMsgIndex > -1) {
                activeSession.history[tempMsgIndex] = { 
                    role: 'model', 
                    parts: [{ text: finalMessageText }],
                    provider: data.provider || 'AI'
                };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else {
                const aiMessageForHistory = { 
                    role: 'model', 
                    parts: [{ text: finalMessageText }],
                    provider: data.provider || 'AI'
                };
                activeSession.history.push(aiMessageForHistory);
            }
            
            saveChatSessionsToStorage();
        }
        
        // 在流式响应结束后应用 Markdown 渲染
        // 创建一个新的消息内容容器
        const messageContainer = document.createElement('div');
        messageContainer.className = 'message-content';
        
        // 使用 renderMarkdownAndLatex 函数渲染 Markdown 和 LaTeX
        aiDiv.appendChild(messageContainer);
        renderMarkdownAndLatex(finalMessageText, messageContainer);
        
        // 移除原始文本元素
        if (textSpan) {
            textSpan.remove();
        }
        
        // 确保滚动到底部
        scrollToChatBottom(chatHistoryEl);
    });
    socket.on('stt_result', (data) => { debugLog(`Received 'stt_result': ${JSON.stringify(data)}`); });
    socket.on('voice_chat_response', (data) => {
        debugLog(`Received 'voice_chat_response': ${JSON.stringify(data)}`);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data) {
            const transcript = data.transcript || '无法识别'; const aiResponseText = data.message || '无回答';
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> <span class="message-content-simple">${transcript}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong> <div class="message-content" id="voice-ai-response-content"></div></div>`;
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const voiceAiRespContentEl = document.getElementById('voice-ai-response-content');
            if (voiceAiRespContentEl) renderMarkdownAndLatex(aiResponseText, voiceAiRespContentEl);
            addVoiceHistoryItem({ transcript: transcript, response: aiResponseText });
        }
        const startBtn = document.getElementById('voice-start-recording'); const stopBtn = document.getElementById('voice-stop-recording');
        if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
    });
    socket.on('stt_error', (errorData) => { console.error("STT Error:", errorData); alert(`语音识别失败: ${errorData.error || '未知错误'}`); const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(t)t.disabled=true; if(document.getElementById('voice-result'))document.getElementById('voice-result').textContent=`语音识别失败: ${errorData.error||'未知错误'}`; });
    socket.on('chat_error', (errorData) => {
        console.error(`Received 'chat_error': ${JSON.stringify(errorData)}`);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        const thinkingDiv = errorData.request_id ? chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${errorData.request_id}"]`) : chatHistoryEl?.querySelector('.ai-thinking');
        if (thinkingDiv) removeThinkingIndicator(chatHistoryEl, thinkingDiv);
        if (chatHistoryEl && (currentChatSessionId === errorData.session_id || (!errorData.session_id && document.getElementById('ai-chat').classList.contains('active')) ) ) {
            const errorDiv = document.createElement('div'); errorDiv.className = 'ai-message error-message';
            errorDiv.innerHTML = `<strong>系统错误:</strong> <span>处理消息失败: ${errorData.message || '未知错误'}</span>`;
            chatHistoryEl.appendChild(errorDiv); scrollToChatBottom(chatHistoryEl);
        }
        if (document.getElementById('voice-answer').classList.contains('active')) {
             const voiceResultEl = document.getElementById('voice-result');
             if(voiceResultEl) voiceResultEl.textContent = `AI 处理失败: ${errorData.message || '未知错误'}`;
             const startBtn = document.getElementById('voice-start-recording'); const stopBtn = document.getElementById('voice-stop-recording');
             if(startBtn) startBtn.disabled = false; if(stopBtn) stopBtn.disabled = true;
        }
    });
    socket.on('task_error', (errorData) => { console.error("Task Error:", errorData); alert(`后台任务出错: ${errorData.error}`); const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(t)t.disabled=true; });
} // End of initSocketIO

function sendChatMessage() {
    const chatInputEl = document.getElementById('chat-chat-input'); const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatInputEl || !chatHistoryEl) { console.error("Chat input or history missing."); return; }
    const message = chatInputEl.value.trim(); const currentFileToSend = uploadedFile;
    if (!message && !currentFileToSend) { debugLog("Empty message/file."); return; }
    let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
    if (!activeSession) {
        const newId = Date.now(); let title = message.substring(0,30) || (currentFileToSend?`含${currentFileToSend.name.substring(0,20)}的对话`:'新对话');
        if((message.length>30&&title.length===30)||(currentFileToSend&&currentFileToSend.name.length>20&&title.length>=22))title+="...";
        activeSession={id:newId,title:title,history:[]}; chatSessions.unshift(activeSession); addChatHistoryItem(activeSession); currentChatSessionId=newId;
        setTimeout(()=>{const l=document.getElementById('chat-session-list');l?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));l?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML='';},0);
    }
    const histMsgTxt = message || (currentFileToSend?`[用户上传了文件: ${currentFileToSend.name}]`:"");
    if(histMsgTxt||currentFileToSend)activeSession.history.push({role:'user',parts:[{text:histMsgTxt}]});
    const uDiv=document.createElement('div');uDiv.className='user-message';uDiv.appendChild(document.createElement('strong')).textContent="您: ";
    const uMsgContentDiv=document.createElement('div');uMsgContentDiv.className='message-content';
    if(message){const ts=document.createElement('span');ts.textContent=message;uMsgContentDiv.appendChild(ts);}
    else if(currentFileToSend&&!message){uMsgContentDiv.textContent="(发送文件)";}
    if(currentFileToSend){const fD=document.createElement('div');fD.className='attached-file';fD.innerHTML=`<i class="fas fa-paperclip"></i> ${currentFileToSend.name} (${formatFileSize(currentFileToSend.size)})`;if(message)uMsgContentDiv.appendChild(document.createElement('br'));uMsgContentDiv.appendChild(fD);}
    uDiv.appendChild(uMsgContentDiv);
    if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML=''; chatHistoryEl.appendChild(uDiv);scrollToChatBottom(chatHistoryEl);
    chatInputEl.value='';const upPrevEl=document.getElementById('chat-upload-preview');if(upPrevEl)upPrevEl.innerHTML='';uploadedFile=null;const fInEl=document.getElementById('chat-file-upload');if(fInEl)fInEl.value='';
    const thinkingDiv=document.createElement('div');thinkingDiv.className='ai-message ai-thinking';const reqId=generateUUID();thinkingDiv.dataset.requestId=reqId;thinkingDiv.innerHTML='<i class="fas fa-spinner fa-spin"></i> AI正在思考...';chatHistoryEl.appendChild(thinkingDiv);scrollToChatBottom(chatHistoryEl);
    const streamToggle=document.getElementById('streaming-toggle-checkbox');const stream=streamToggle?streamToggle.checked:true;
    let histToSend=JSON.parse(JSON.stringify(activeSession.history));
    if(currentFileToSend){
        const fd=new FormData();fd.append('prompt',message);fd.append('file',currentFileToSend,currentFileToSend.name);fd.append('history',JSON.stringify(histToSend.slice(0,-1)));fd.append('use_streaming',false);fd.append('session_id',activeSession.id);fd.append('request_id',reqId);
        fetch('/chat_with_file',{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`},body:fd})
        .then(r=>{if(!r.ok)return r.json().catch(()=>({e:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.e||`HTTP ${r.status}`)});return r.json();})
        .then(d=>{if(d&&d.message&&d.request_id===reqId)handleAiResponseMessage({message:d.message,provider:d.provider,request_id:d.request_id,session_id:activeSession.id},false); else if(d?.request_id)debugLog("File upload ack, waiting for socket. Req ID: "+d.request_id); else {console.warn("Chat w/ file: unexpected server resp",d); removeThinkingIndicator(chatHistoryEl, thinkingDiv);}})
        .catch(e=>{console.error('Chat w/ file err:',e);const tD=chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);if(tD)removeThinkingIndicator(chatHistoryEl,tD);const errD=document.createElement('div');errD.className='ai-message error-message';errD.innerHTML=`<strong>系统错误:</strong><span>发送失败:${e.message}</span>`;chatHistoryEl.appendChild(errD);scrollToChatBottom(chatHistoryEl);});
    }else{socket.emit('chat_message',{prompt:message,history:histToSend,request_id:reqId,use_streaming:stream,session_id:activeSession.id});}
    saveChatSessionsToStorage();
}

function confirmCrop() {
    if (!currentImage) { alert('错误：没有当前图片。'); return; } const overlayImageEl = document.getElementById('overlay-image');
    if (!overlayImageEl || !overlayImageEl.naturalWidth) { alert('错误：图片未加载。'); return; }
    const scaleX = overlayImageEl.naturalWidth / overlayImageEl.width; const scaleY = overlayImageEl.naturalHeight / overlayImageEl.height;
    const oSel = { x: Math.round(selection.x*scaleX), y: Math.round(selection.y*scaleY), width: Math.round(selection.width*scaleX), height: Math.round(selection.height*scaleY) };
    const fd = new FormData(); fd.append('image_url', currentImage); fd.append('x', oSel.x); fd.append('y', oSel.y); fd.append('width', oSel.width); fd.append('height', oSel.height);
    const prmptEl = document.getElementById('prompt-input'); if (prmptEl?.value.trim()) fd.append('prompt', prmptEl.value.trim());
    const analysisEl = document.getElementById('ss-ai-analysis'); if (analysisEl) analysisEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 分析中...';
    hideImageOverlay();
    fetch('/crop_image', { method: 'POST', headers:{'Authorization':`Bearer ${TOKEN}`}, body:fd })
    .then(r=>{if(!r.ok)return r.json().catch(()=>({e:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.e||`HTTP ${r.status}`)});return r.json()}) // Ensure correct error prop
    .then(d=>debugLog(`Crop ack: ${JSON.stringify(d)}`))
    .catch(e=>{console.error('Crop error:',e);alert(`裁剪出错: ${e.message}`);if(analysisEl)analysisEl.textContent=`分析失败: ${e.message}`;});
}

function getApiInfo() {
    if (!TOKEN) { updateApiInfo({ provider: '未知 (Token未设置)' }); return; }
    fetch('/api_info', { headers: { 'Authorization': `Bearer ${TOKEN}` } })
    .then(r=>{if(r.status===401)throw new Error('Unauthorized');if(!r.ok)throw new Error(`API信息获取失败(${r.status})`);return r.json();})
    .then(updateApiInfo).catch(e=>{console.error('API info error:',e);updateApiInfo({provider:`错误(${e.message})`});});
}

function sendVoiceToServer(audioBlob) {
    const fd = new FormData(); fd.append('audio', audioBlob, `rec_${Date.now()}.wav`);
    const resEl = document.getElementById('voice-result'); if(resEl)resEl.innerHTML='<i class="fas fa-spinner fa-spin"></i> 处理中...';
    fetch('/process_voice',{method:'POST',body:fd,headers:{'Authorization':`Bearer ${TOKEN}`}})
    .then(r=>{if(!r.ok)return r.json().catch(()=>({e:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.e||`HTTP ${r.status}`)});return r.json()}) // Ensure correct error prop
    .then(d=>debugLog(`Voice ack: ${JSON.stringify(d)}`))
    .catch(e=>{console.error('Voice upload err:',e);if(resEl)resEl.textContent=`语音处理失败: ${e.message}`;const s=document.getElementById('voice-start-recording'),st=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(st)st.disabled=true;});
}

function addHistoryItem(item) { // For screenshot history
    const historyListEl = document.getElementById('ss-history-list');
    if (!historyListEl || !item || !item.image_url || historyListEl.querySelector(`[data-url="${item.image_url}"]`)) return;
    const li = document.createElement('li'); li.className = 'history-item'; li.setAttribute('data-url', item.image_url);
    const img = document.createElement('img'); img.src = item.image_url + '?t=' + Date.now(); img.alt = '历史截图'; img.loading = 'lazy';
    img.onerror = () => { li.innerHTML = `<div class="history-error">图片加载失败</div>`; li.appendChild(createDeleteButton(() => { if (confirm('删除此记录?')) li.remove(); })); };
    const timestampDiv = document.createElement('div'); timestampDiv.className = 'history-item-text';
    const date = item.timestamp ? new Date(item.timestamp * 1000) : new Date();
    timestampDiv.textContent = date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    timestampDiv.title = date.toLocaleString();
    const deleteBtn = createDeleteButton(() => {
        if (confirm('删除此截图记录?')) { li.remove(); const analysisEl = document.getElementById('ss-ai-analysis'); if (analysisEl && analysisEl.dataset.sourceUrl === item.image_url) { analysisEl.textContent = '请在左侧点击历史记录...'; delete analysisEl.dataset.sourceUrl; } }
    });
    li.appendChild(img); li.appendChild(timestampDiv); li.appendChild(deleteBtn);
    li.onclick = (e) => {
        if (e.target.closest('.delete-history')) return;
        showImageOverlay(item.image_url);
        const analysisEl = document.getElementById('ss-ai-analysis');
        if(analysisEl) { analysisEl.textContent = item.analysis || (item.analysis === "" ? '(AI分析为空)' : '(无分析或加载中)'); analysisEl.dataset.sourceUrl = item.image_url; }
    };
    historyListEl.insertBefore(li, historyListEl.firstChild);
}

function addVoiceHistoryItem(item) {
    const voiceHistoryListEl = document.getElementById('voice-history-list'); if (!voiceHistoryListEl) return;
    const li = document.createElement('li'); li.className = 'history-item voice-history-item';
    const timestamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    const transcript = item.transcript || '无法识别'; const responseText = item.response || '无回答';
    const transcriptDisplay = transcript.length > 30 ? transcript.substring(0, 27) + '...' : transcript;
    li.innerHTML = `<div class="history-item-text"><div><strong><i class="fas fa-clock"></i> ${timestamp}</strong></div><div title="${transcript}"><i class="fas fa-comment-dots"></i> ${transcriptDisplay}</div></div>`;
    const deleteBtn = createDeleteButton(() => { if (confirm('删除此语音记录?')) li.remove(); }); li.appendChild(deleteBtn);
    li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-history')) return;
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong><span class="message-content-simple">${transcript}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong><div class="message-content" id="v-hist-ai-resp"></div></div>`;
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const respContentEl = document.getElementById('v-hist-ai-resp');
            if (respContentEl) renderMarkdownAndLatex(responseText, respContentEl);
        }
        voiceHistoryListEl.querySelectorAll('.history-item.active-session').forEach(i => i.classList.remove('active-session'));
        li.classList.add('active-session');
    });
    voiceHistoryListEl.insertBefore(li, voiceHistoryListEl.firstChild);
}

function addChatHistoryItem(session) {
    const historyListEl = document.getElementById('chat-session-list'); if (!historyListEl || !session) return;
    const existingLi = historyListEl.querySelector(`[data-session-id="${session.id}"]`); if (existingLi) existingLi.remove();
    const li = document.createElement('li'); li.className = 'history-item chat-history-item'; li.setAttribute('data-session-id', String(session.id));
    const titleText = session.title || '无标题对话'; const timestamp = new Date(session.id).toLocaleString([],{dateStyle:'short',timeStyle:'short',hour12:false});
    li.innerHTML = `<div class="history-item-text"><div title="${titleText}" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fas fa-comment"></i> ${titleText}</div><div style="font-size:0.75em;color:#666;">${timestamp}</div></div>`;
    const deleteBtn = createDeleteButton(()=>{if(confirm(`删除对话 "${titleText}"?`)){chatSessions=chatSessions.filter(s=>s.id!==session.id);li.remove();if(currentChatSessionId===session.id)clearCurrentChatDisplay();saveChatSessionsToStorage();}});
    li.appendChild(deleteBtn);
    li.addEventListener('click',(e)=>{if(e.target.closest('.delete-history'))return;const sessionId=Number(li.getAttribute('data-session-id'));const clickedSession=chatSessions.find(s=>s.id===sessionId);if(clickedSession){currentChatSessionId=clickedSession.id;renderChatHistory(clickedSession.history);historyListEl.querySelectorAll('.history-item.active-session').forEach(item=>item.classList.remove('active-session'));li.classList.add('active-session');document.getElementById('chat-chat-input')?.focus();}});
    if(historyListEl.firstChild)historyListEl.insertBefore(li,historyListEl.firstChild);else historyListEl.appendChild(li);
}

function createDeleteButton(onClickCallback) { const btn=document.createElement('button');btn.className='delete-history';btn.innerHTML='<i class="fas fa-times"></i>';btn.title='删除';btn.type='button';btn.onclick=e=>{e.stopPropagation();onClickCallback();};return btn; }

function renderChatHistory(historyArray) {
    const chatHistoryEl=document.getElementById('chat-chat-history');
    if(!chatHistoryEl)return;
    chatHistoryEl.innerHTML='';
    
    if(!historyArray||historyArray.length===0){
        chatHistoryEl.innerHTML='<div class="system-message">对话为空...</div>';
        return;
    }
    
    historyArray.forEach(turn=>{
        const role=turn.role;
        const text=(turn.parts?.[0]?.text)||"";
        const msgDiv=document.createElement('div');
        const strongTag=document.createElement('strong');
        strongTag.textContent=role==='user'?"您: ":`${turn.provider||'AI'}: `;
        msgDiv.appendChild(strongTag);
        
        if(role==='user'){
            msgDiv.className='user-message';
            const contentDiv=document.createElement('div');
            contentDiv.className='message-content';
            contentDiv.textContent=text;
            
            const fileMatch=text.match(/\[用户上传了文件: (.*?)\]/);
            if(fileMatch?.[1]){
                contentDiv.textContent=text.replace(fileMatch[0],'').trim();
                const fileInfo=document.createElement('div');
                fileInfo.className='attached-file';
                fileInfo.innerHTML=`<i class="fas fa-paperclip"></i> (文件: ${fileMatch[1]})`;
                if(contentDiv.textContent)contentDiv.appendChild(document.createElement('br'));
                contentDiv.appendChild(fileInfo);
            }
            msgDiv.appendChild(contentDiv);
        }
        else if(role==='model'){
            msgDiv.className='ai-message';
            const contentDiv=document.createElement('div');
            contentDiv.className='message-content';
            renderMarkdownAndLatex(text, contentDiv);
            msgDiv.appendChild(contentDiv);
        }
        else{
            msgDiv.className='system-message';
            const contentDiv=document.createElement('div');
            contentDiv.className='message-content';
            contentDiv.textContent=text;
            msgDiv.appendChild(contentDiv);
        }
        
        chatHistoryEl.appendChild(msgDiv);
    });
    
    scrollToChatBottom(chatHistoryEl);
}

function showImageOverlay(imageUrl) {
    const overlay=document.getElementById('overlay'),imgEl=document.getElementById('overlay-image'),selBox=document.getElementById('selection-box'),cropInf=document.getElementById('crop-info');
    if(!overlay||!imgEl||!selBox||!cropInf)return;currentImage=imageUrl;imgEl.src='';imgEl.src=`${imageUrl}?t=${Date.now()}`;overlay.style.display='flex';
    imgEl.onload=()=>{selection={x:0,y:0,width:imgEl.width,height:imgEl.height};updateSelectionBox();initSelectionControls();cropInf.textContent='拖拽调整区域或确认全图';};
    imgEl.onerror=()=>{alert('图片预览加载失败');hideImageOverlay();};
}
function hideImageOverlay(){const o=document.getElementById('overlay');if(o)o.style.display='none';currentImage=null;const p=document.getElementById('prompt-input');if(p)p.value='';}
function updateSelectionBox(){const sB=document.getElementById('selection-box'),cI=document.getElementById('crop-info'),iE=document.getElementById('overlay-image');if(!sB||!cI||!iE||!iE.width||!iE.naturalWidth)return;selection.x=Math.max(0,Math.min(selection.x,iE.width));selection.y=Math.max(0,Math.min(selection.y,iE.height));selection.width=Math.max(10,Math.min(selection.width,iE.width-selection.x));selection.height=Math.max(10,Math.min(selection.height,iE.height-selection.y));sB.style.left=`${selection.x}px`;sB.style.top=`${selection.y}px`;sB.style.width=`${selection.width}px`;sB.style.height=`${selection.height}px`;const sX_=iE.naturalWidth/iE.width,sY_=iE.naturalHeight/iE.height;cI.textContent=`选择(原图):${Math.round(selection.x*sX_)},${Math.round(selection.y*sY_)}, ${Math.round(selection.width*sX_)}x${Math.round(selection.height*sY_)}`;}
function updateConnectionStatus(isConnected){const ind=document.getElementById('connection-indicator'),st=document.getElementById('connection-status');if(ind&&st){ind.className=`status-indicator ${isConnected?'connected':'disconnected'}`;st.textContent=`实时连接: ${isConnected?'已连接':'未连接'}`;ind.title=`Socket.IO ${isConnected?'Connected':'Disconnected'}`;}}
function updateApiInfo(d){const el=document.getElementById('api-provider');if(el){el.textContent=`AI模型: ${d?.provider||'未知'}`;el.title=d?.provider?`Using ${d.provider}`:'AI Provider Info Unavailable';}}
function clearScreenshotHistory(){if(confirm('清空所有截图历史?')){const el=document.getElementById('ss-history-list');if(el)el.innerHTML='';const anEl=document.getElementById('ss-ai-analysis');if(anEl){anEl.textContent='点击历史查看分析...';delete anEl.dataset.sourceUrl;}}}
function clearCurrentChatDisplay(){const el=document.getElementById('chat-chat-history');if(el)el.innerHTML='<div class="system-message">选择记录或开始新对话...</div>';currentChatSessionId=null;document.getElementById('chat-session-list')?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));document.getElementById('chat-chat-input')?.focus();}
function clearAllChatSessions(){if(confirm('永久删除所有对话?')){chatSessions=[];currentChatSessionId=null;const el=document.getElementById('chat-session-list');if(el)el.innerHTML='';clearCurrentChatDisplay();saveChatSessionsToStorage();}}
function clearVoiceHistory(){if(confirm('清空所有语音历史?')){const el=document.getElementById('voice-history-list');if(el)el.innerHTML='';const resEl=document.getElementById('voice-result');if(resEl)resEl.textContent='点击开始录音...';}}

function initTabs(){const c=document.querySelector('.tabs-container'),s=document.querySelectorAll('.tab-content-wrapper > .tab-content');if(!c||s.length===0)return;c.addEventListener('click',e=>{const t=e.target.closest('.tab-item');if(!t||t.classList.contains('active'))return;const id=t.dataset.tab,tc=document.getElementById(id);if(tc){c.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));s.forEach(x=>x.classList.remove('active'));t.classList.add('active');tc.classList.add('active');if(id==='ai-chat')document.getElementById('chat-chat-input')?.focus();}});const aT=c.querySelector('.tab-item.active')||c.querySelector('.tab-item');if(aT){aT.classList.add('active');document.getElementById(aT.dataset.tab)?.classList.add('active');}}
function initSelectionControls(){const sb=document.getElementById('selection-box'),oi=document.getElementById('overlay-image');if(!sb||!oi)return;let sx_s,sy_s,isx_s,isy_s,isr_s;function hs(e){e.preventDefault();isDragging=true;const tE=e.type.startsWith('touch'),cX=tE?e.touches[0].clientX:e.clientX,cY=tE?e.touches[0].clientY:e.clientY,iR=oi.getBoundingClientRect();sx_s=cX-iR.left;sy_s=cY-iR.top;isx_s=cX;isy_s=cY;isr_s={...selection};const br=sb.getBoundingClientRect(),rx=cX-br.left,ry=cY-br.top,et=15;dragType=rx>=isr_s.width-et&&ry>=isr_s.height-et?'resize-se':sx_s>=isr_s.x&&sx_s<=isr_s.x+isr_s.width&&sy_s>=isr_s.y&&sy_s<=isr_s.y+isr_s.height?'move':(dragType='draw',selection={x:sx_s,y:sy_s,width:0,height:0},updateSelectionBox(),undefined);if(!isDragging&&dragType!='draw')return;if(tE){document.addEventListener('touchmove',hm,{passive:false});document.addEventListener('touchend',he);document.addEventListener('touchcancel',he);}else{document.addEventListener('mousemove',hm);document.addEventListener('mouseup',he);}}function hm(e){if(!isDragging)return;e.preventDefault();const tE=e.type.startsWith('touch'),cX=tE?e.touches[0].clientX:e.clientX,cY=tE?e.touches[0].clientY:e.clientY,iR=oi.getBoundingClientRect(),currXimg=cX-iR.left,currYimg=cY-iR.top,dcx=cX-isx_s,dcy=cY-isy_s;if(dragType==='move'){selection.x=isr_s.x+dcx;selection.y=isr_s.y+dcy;}else if(dragType==='resize-se'){selection.width=isr_s.width+dcx;selection.height=isr_s.height+dcy;}else if(dragType==='draw'){selection.width=currXimg-selection.x;selection.height=currYimg-selection.y;if(selection.width<0){selection.x=currXimg;selection.width=-selection.width;}if(selection.height<0){selection.y=currYimg;selection.height=-selection.height;}}updateSelectionBox();}function he(){if(!isDragging)return;isDragging=false;dragType='';document.removeEventListener('mousemove',hm);document.removeEventListener('mouseup',he);document.removeEventListener('touchmove',hm,{passive:false});document.removeEventListener('touchend',he);document.removeEventListener('touchcancel',he);}oi.replaceWith(oi.cloneNode(true));document.getElementById('overlay-image').addEventListener('mousedown',hs);document.getElementById('overlay-image').addEventListener('touchstart',hs,{passive:false});sb.replaceWith(sb.cloneNode(true));document.getElementById('selection-box').addEventListener('mousedown',hs);document.getElementById('selection-box').addEventListener('touchstart',hs,{passive:false});const nsb=document.getElementById('selection-box');if('ontouchstart'in window&&!nsb.querySelector('.resize-handle-se')){const rh=document.createElement('div');rh.className='resize-handle resize-handle-se';nsb.appendChild(rh);}}
function initVoiceFeature(){const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording'),v=document.getElementById('voice-result');if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){if(s)s.disabled=true;if(t)t.disabled=true;if(v)v.textContent='浏览器不支持录音。';return;}if(!s||!t||!v)return;s.addEventListener('click',async()=>{audioChunks=[];try{const st=await navigator.mediaDevices.getUserMedia({audio:true}),mt=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm','audio/ogg','audio/wav'].find(ty=>MediaRecorder.isTypeSupported(ty));if(!mt){alert("无支持录音格式。");return;}mediaRecorder=new MediaRecorder(st,{mimeType:mt});mediaRecorder.ondataavailable=ev=>{if(ev.data.size>0)audioChunks.push(ev.data);};mediaRecorder.onstop=()=>{if(audioChunks.length===0){v.textContent="未录到音频。";s.disabled=false;t.disabled=true;st.getTracks().forEach(tr=>tr.stop());return;}sendVoiceToServer(new Blob(audioChunks,{type:mediaRecorder.mimeType}));audioChunks=[];st.getTracks().forEach(tr=>tr.stop());};mediaRecorder.onerror=ev=>{alert(`录音出错:${ev.error.name||'未知'}`);s.disabled=false;t.disabled=true;if(v)v.textContent='录音错误。';try{st.getTracks().forEach(tr=>tr.stop());}catch(ex){}};mediaRecorder.start();s.disabled=true;t.disabled=false;v.innerHTML='<i class="fas fa-microphone-alt fa-beat" style="color:red;"></i> 录音中...';}catch(er){alert(`无法访问麦克风:${er.message}`);s.disabled=false;t.disabled=true;}});t.addEventListener('click',()=>{if(mediaRecorder?.state==='recording')mediaRecorder.stop();s.disabled=false;t.disabled=true;});}
function requestScreenshot(){if(socket?.connected)socket.emit('request_screenshot_capture');else alert('无法请求截图：未连接');}
function initBaseButtonHandlers(){document.getElementById('close-overlay')?.addEventListener('click',hideImageOverlay);document.getElementById('confirm-selection')?.addEventListener('click',confirmCrop);document.getElementById('cancel-selection')?.addEventListener('click',hideImageOverlay);}
function initScreenshotAnalysisHandlers(){document.getElementById('ss-capture-btn')?.addEventListener('click',requestScreenshot);document.getElementById('ss-clear-history')?.addEventListener('click',clearScreenshotHistory);}

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
        streamingToggle.addEventListener('change', function(){localStorage.setItem('useStreamingOutput',this.checked);});
    }
    const testBtn = document.createElement('button'); testBtn.id='test-render-btn'; testBtn.className='btn btn-sm btn-secondary';
    testBtn.title='测试渲染'; testBtn.innerHTML='<i class="fas fa-flask"></i> 测试'; testBtn.style.marginLeft='10px';
    const chatBtnsContainer = document.querySelector('#ai-chat .chat-controls .chat-buttons');
    const sendBtn = document.getElementById('chat-send-chat');
    if(chatBtnsContainer&&sendBtn) chatBtnsContainer.insertBefore(testBtn,sendBtn); else if(chatBtnsContainer) chatBtnsContainer.appendChild(testBtn);
    testBtn.addEventListener('click', () => {
        const chatHistoryEl = document.getElementById('chat-chat-history'); if(!chatHistoryEl)return;
        if(chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
        const tDiv = document.createElement('div'); tDiv.className = 'ai-message';
        tDiv.innerHTML = '<strong>测试渲染:</strong> <div class="message-content"></div>';
        const cDiv = tDiv.querySelector('.message-content');
        const testMD = "这是 **Markdown**!\n\n- 列表 1\n- 列表 2\n\n```javascript\nconsole.log('Hello');\n```\n\n行内公式: $E=mc^2$\n\n行间公式:\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$";
        if(cDiv) renderMarkdownAndLatex(testMD, cDiv);
        chatHistoryEl.appendChild(tDiv); scrollToChatBottom(chatHistoryEl);
    });
}
function initVoiceAnswerHandlers(){ initVoiceFeature(); document.getElementById('voice-clear-history')?.addEventListener('click',clearVoiceHistory); }

function initAllFeatures() {
    console.log("--- Initializing All Features ---");
    const tokenMeta = document.querySelector('meta[name="token"]');
    if (tokenMeta?.content) TOKEN = tokenMeta.content; else console.warn('Token meta tag missing.');

    // 初始化 Markdown 渲染器
    initMarkdownRenderer();

    initBaseButtonHandlers(); initTabs(); initScreenshotAnalysisHandlers(); initAiChatHandlers(); initVoiceAnswerHandlers(); initSocketIO();

    // Initial KaTeX render for any pre-existing static content.
    // Dynamic content (like chat messages) will be rendered when added to the DOM.
    setTimeout(() => {
        if (typeof window.renderMathInElement === 'function') {
            console.log("Performing initial full-body KaTeX render pass...");
            renderLatexInElement(document.body); // Render for the whole body once
        } else {
            console.warn("KaTeX auto-render (renderMathInElement) not available for initial pass. It might have been blocked or not loaded yet.");
        }
    }, 1500); // Delay to ensure KaTeX scripts are likely loaded and DOM is stable
    console.log("--- Application initialization complete ---");
}

document.addEventListener('DOMContentLoaded', initAllFeatures);

document.addEventListener('DOMContentLoaded', ()=>{ const btns=document.querySelectorAll('button,.btn,.tab-item');btns.forEach(b=>{b.addEventListener('touchstart',function(){this.classList.add('touch-active')},{passive:true});b.addEventListener('touchend',function(){this.classList.remove('touch-active')});b.addEventListener('touchcancel',function(){this.classList.remove('touch-active')});});if(!document.querySelector('style#touch-active-style')){const s=document.createElement('style');s.id='touch-active-style';s.textContent='.touch-active{opacity:0.7;transform:scale(0.98);}';document.head.appendChild(s);}});

function saveChatSessionsToStorage() { try {localStorage.setItem('chatSessions',JSON.stringify(chatSessions));}catch(e){console.error("Failed to save chat sessions:",e);} }
function loadChatSessionsFromStorage() {
    try {
        const saved = localStorage.getItem('chatSessions');
        if (saved) {
            chatSessions = JSON.parse(saved);
            const listEl = document.getElementById('chat-session-list');
            if (listEl) { listEl.innerHTML = ''; chatSessions.sort((a,b)=>(b.id||0)-(a.id||0)).forEach(addChatHistoryItem); }
            clearCurrentChatDisplay();
        } else { clearCurrentChatDisplay(); }
    } catch (e) { console.error("Failed to load chat sessions:", e); chatSessions=[]; clearCurrentChatDisplay(); }
}

function generateUUID(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);});}
function removeThinkingIndicator(chatHistoryEl,aiThinkingDiv){if(aiThinkingDiv?.parentNode===chatHistoryEl)chatHistoryEl.removeChild(aiThinkingDiv);else if(aiThinkingDiv?.parentNode)aiThinkingDiv.parentNode.removeChild(aiThinkingDiv);else if(aiThinkingDiv)try{aiThinkingDiv.remove()}catch(e){console.warn("Failed to remove thinking indicator directly:",e);}}

// Removed the duplicate renderMathWithKaTeX and safeRenderMath, and the extra DOMContentLoaded listener
// as these functionalities are now consolidated.

// 初始化 markdown-it 实例 - 确保在页面加载时调用
function initMarkdownRenderer() {
    console.log("Initializing markdown-it renderer...");
    try {
        // 直接检查 window.markdownit 是否存在
        if (typeof window.markdownit === 'function') {
            md = window.markdownit({
                html: true,           // 启用 HTML 标签
                breaks: true,         // 转换换行符为 <br>
                linkify: true,        // 自动转换 URL 为链接
                typographer: true,    // 启用一些语言中立的替换和引号
                highlight: function (str, lang) {
                    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
                        try {
                            return '<pre class="hljs"><code>' + 
                                   window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + 
                                   '</code></pre>';
                        } catch (__) {}
                    }
                    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
                }
            });
            console.log("✅ markdown-it initialized successfully");
            
            // 测试 markdown-it 是否正常工作
            const testMd = "**Bold** and *Italic*";
            const testResult = md.render(testMd);
            console.log(`Test markdown-it: "${testMd}" -> "${testResult}"`);
        } else {
            throw new Error("window.markdownit is not a function");
        }
    } catch (e) {
        console.error("❌ Failed to initialize markdown-it:", e);
        // 创建一个简单的替代对象，避免后续代码出错
        md = {
            render: function(text) {
                return text
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.*?)\*/g, '<em>$1</em>')
                    .replace(/#{3,6}\s+(.*?)$/gm, '<h3>$1</h3>')
                    .replace(/\n/g, '<br>');
            },
            utils: {
                escapeHtml: function(text) {
                    return text
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                }
            }
        };
        console.log("⚠️ Using fallback markdown renderer");
    }
}

// 处理 AI 消息的 Markdown 渲染
function processAIMessage(messageElement, messageText) {
    console.log("Processing AI message with Markdown...");
    
    // 清除现有内容
    while (messageElement.firstChild) {
        messageElement.removeChild(messageElement.firstChild);
    }
    
    // 添加角色标签
    const roleLabel = document.createElement('strong');
    roleLabel.textContent = 'AI: ';
    messageElement.appendChild(roleLabel);
    
    // 创建内容容器
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // 渲染 Markdown
    try {
        if (md) {
            contentDiv.innerHTML = md.render(messageText);
            console.log("✅ Rendered with markdown-it");
        } else {
            // 回退到基本的 HTML 转义和简单的 Markdown 替换
            contentDiv.innerHTML = basicMarkdownToHtml(messageText);
            console.log("⚠️ Rendered with basic markdown fallback");
        }
    } catch (error) {
        console.error("❌ Error rendering markdown:", error);
        contentDiv.textContent = messageText; // 最后的回退：纯文本
    }
    
    // 添加到消息元素
    messageElement.appendChild(contentDiv);
    
    // 应用代码高亮
    if (window.hljs) {
        try {
            const codeBlocks = contentDiv.querySelectorAll('pre code');
            codeBlocks.forEach(block => {
                window.hljs.highlightElement(block);
            });
        } catch (e) {
            console.error("Error applying code highlighting:", e);
        }
    }
    
    return contentDiv;
}

// 基本的 Markdown 到 HTML 转换（作为回退）
function basicMarkdownToHtml(text) {
    return text
        // 标题
        .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
        .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
        .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
        // 粗体和斜体
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // 列表
        .replace(/^\s*- (.*?)$/gm, '<ul><li>$1</li></ul>')
        .replace(/^\s*\d+\. (.*?)$/gm, '<ol><li>$1</li></ol>')
        // 代码块
        .replace(/```(.*?)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
        // 内联代码
        .replace(/`(.*?)`/g, '<code>$1</code>')
        // 换行
        .replace(/\n/g, '<br>');
}

// 修改 socket.io 消息处理函数
socket.on('new_message', function(data) {
    console.log('Received new_message:', data);
    
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;
    
    // 创建新消息元素
    const msgDiv = document.createElement('div');
    msgDiv.className = 'ai-message';
    msgDiv.dataset.requestId = data.request_id || '';
    
    // 处理 AI 消息，应用 Markdown 渲染
    processAIMessage(msgDiv, data.message || '');
    
    // 添加到聊天历史
    chatHistoryEl.appendChild(msgDiv);
    scrollToChatBottom(chatHistoryEl);
    
    // 更新会话历史
    if (currentChatSessionId) {
        const activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        if (activeSession) {
            activeSession.history.push({
                role: 'model',
                parts: [{ text: data.message || '' }],
                provider: data.provider || 'AI'
            });
            saveChatSessionsToStorage();
        }
    }
});

// 修改流式响应处理
socket.on('chat_stream', function(data) {
    console.log('Received chat_stream chunk:', data);
    
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;
    
    // 查找或创建消息元素
    let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
    if (!aiDiv) {
        aiDiv = document.createElement('div');
        aiDiv.className = 'ai-message';
        aiDiv.dataset.requestId = data.request_id;
        
        // 添加角色标签
        const roleLabel = document.createElement('strong');
        roleLabel.textContent = `${data.provider || 'AI'}: `;
        aiDiv.appendChild(roleLabel);
        
        // 添加响应文本容器
        const textSpan = document.createElement('span');
        textSpan.className = 'ai-response-text';
        textSpan.textContent = '';
        aiDiv.appendChild(textSpan);
        
        chatHistoryEl.appendChild(aiDiv);
    }
    
    // 更新文本内容
    const textSpan = aiDiv.querySelector('.ai-response-text');
    if (textSpan) {
        textSpan.textContent += data.chunk || '';
    }
    
    scrollToChatBottom(chatHistoryEl);
});

// 修改流式响应结束处理
socket.on('chat_stream_end', function(data) {
    console.log('Received chat_stream_end:', data);
    
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;
    
    // 查找消息元素
    const aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
    if (!aiDiv) {
        console.warn(`No message element found for request ID: ${data.request_id}`);
        return;
    }
    
    // 获取最终消息文本
    const textSpan = aiDiv.querySelector('.ai-response-text');
    const finalMessageText = textSpan ? textSpan.textContent : '';
    
    // 应用 Markdown 渲染
    processAIMessage(aiDiv, finalMessageText);
    
    // 更新会话历史
    if (currentChatSessionId) {
        const activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        if (activeSession) {
            // 查找临时消息并更新或添加新消息
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === data.request_id);
            if (tempMsgIndex > -1) {
                activeSession.history[tempMsgIndex] = { 
                    role: 'model', 
                    parts: [{ text: finalMessageText }],
                    provider: data.provider || 'AI'
                };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else {
                activeSession.history.push({
                    role: 'model', 
                    parts: [{ text: finalMessageText }],
                    provider: data.provider || 'AI'
                });
            }
            saveChatSessionsToStorage();
        }
    }
    
    scrollToChatBottom(chatHistoryEl);
});

// 确保在页面加载时初始化 Markdown 渲染器
document.addEventListener('DOMContentLoaded', function() {
    console.log("DOMContentLoaded - Initializing features");
    
    // 初始化 Markdown 渲染器
    initMarkdownRenderer();
    
    // 其他初始化...
}
