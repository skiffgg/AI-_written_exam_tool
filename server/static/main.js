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

let md = null; // Markdown-it instance

// --- Utility Functions ---
function debugLog(message) {
    console.log(`[AI DEBUG] ${message}`);
}

function formatFileSize(bytes) {
    if (bytes < 0) return 'Invalid size';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)));
    const fixed = (i === 0) ? 0 : 1;
    return parseFloat((bytes / Math.pow(k, i)).toFixed(fixed)) + ' ' + sizes[i];
}

function scrollToChatBottom(chatHistoryEl) {
    if (chatHistoryEl) {
        requestAnimationFrame(() => {
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        });
    }
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

function generateUUID(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);});}

function removeThinkingIndicator(chatHistoryEl, aiThinkingDiv) {
    if (aiThinkingDiv) {
        console.log("[removeThinkingIndicator] Attempting to remove:", aiThinkingDiv, "from parent:", chatHistoryEl);
        if (aiThinkingDiv.parentNode === chatHistoryEl) {
            chatHistoryEl.removeChild(aiThinkingDiv);
            console.log("[removeThinkingIndicator] Removed successfully (as direct child).");
        } else if (aiThinkingDiv.parentNode) {
            aiThinkingDiv.parentNode.removeChild(aiThinkingDiv);
            console.log("[removeThinkingIndicator] Removed successfully (from its parent).");
        } else {
            try { aiThinkingDiv.remove(); console.log("[removeThinkingIndicator] Removed successfully (direct remove).");}
            catch(e){console.warn("[removeThinkingIndicator] Failed to remove thinking indicator directly:",e);}
        }
    } else {
        // console.log("[removeThinkingIndicator] Called with null aiThinkingDiv or div already removed.");
    }
}

// --- File Upload Handling ---
function handleFileUpload(e) {
    debugLog("File input changed (handleFileUpload).");
    const fileInput = e.target;
    const uploadPreviewEl = document.getElementById('chat-upload-preview');
    if (!uploadPreviewEl) { console.error("Chat upload preview element (#chat-upload-preview) not found."); return; }
    uploadPreviewEl.innerHTML = '';
    uploadedFile = null;
    if (fileInput.files && fileInput.files.length > 0) {
        const file = fileInput.files[0];
        uploadedFile = file;
        debugLog(`File selected: ${file.name}, Size: ${file.size}`);
        const previewItem = document.createElement('div');
        previewItem.className = 'preview-item';
        const displayName = file.name.length > 40 ? file.name.substring(0, 37) + '...' : file.name;
        previewItem.innerHTML = `<div class="file-info" title="${escapeHtml(file.name)}"><i class="fas fa-file"></i><span>${escapeHtml(displayName)} (${formatFileSize(file.size)})</span></div><button type="button" class="remove-file" title="取消选择此文件"><i class="fas fa-times"></i></button>`;
        previewItem.querySelector('.remove-file').onclick = () => {
            debugLog(`Removing file preview: ${file.name}`);
            uploadPreviewEl.innerHTML = ''; uploadedFile = null; fileInput.value = '';
        };
        uploadPreviewEl.appendChild(previewItem);
    } else { debugLog("File selection cancelled or no file chosen."); }
}

// --- LaTeX and Markdown Rendering ---
function renderLatexInElement(element) {
    if (!element) { return; }
    if (typeof window.renderMathInElement === 'function') {
        // console.log("[KaTeX] Attempting to render math in element:", element);
        try {
            window.renderMathInElement(element, {
                delimiters: [
                    { left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }
                ],
                throwOnError: false,
                ignoredClasses: ["no-katex-render", "hljs", "no-math", "highlight", "language-"]
            });
            // if (element.querySelector('.katex')) { console.log("[KaTeX] KaTeX elements were created in:", element); }
            // else { console.log("[KaTeX] No KaTeX elements created (maybe no math) in:", element); }
        } catch (error) {
            console.error("[KaTeX] Error during renderMathInElement call:", error, "on element:", element);
        }
    } else {
        console.warn("[KaTeX] window.renderMathInElement is NOT available when trying to render for element:", element.id || element.className, element);
    }
}

function initMarkdownRenderer() {
    console.log("[MD RENDERER] Initializing markdown-it...");
    try {
        if (typeof window.markdownit === 'function') {
            md = window.markdownit({
                html: true, breaks: true, langPrefix: 'language-', linkify: true, typographer: true, quotes: '“”‘’',
                highlight: function (str, lang) {
                    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
                        try {
                            return '<pre class="hljs"><code>' +
                                   window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                                   '</code></pre>';
                        } catch (e) { console.error("[HLJS] Error highlighting:", e); }
                    }
                    return '<pre class="hljs"><code>' + (md && md.utils ? md.utils.escapeHtml(str) : escapeHtml(str)) + '</code></pre>';
                }
            });
            console.log("[MD RENDERER] ✅ markdown-it initialized successfully.");
        } else { throw new Error("window.markdownit is not a function."); }
    } catch (e) {
        console.error("[MD RENDERER] ❌ Failed to initialize markdown-it:", e);
        md = { render: function(text) { return escapeHtml(text).replace(/\n/g, '<br>'); }, utils: { escapeHtml: escapeHtml } };
        console.warn("[MD RENDERER] ⚠️ Using basic fallback markdown renderer.");
    }
}

function processAIMessage(messageElement, messageText) {
    let strongTag = messageElement.querySelector('strong');
    if (!strongTag) {
        strongTag = document.createElement('strong');
        messageElement.insertBefore(strongTag, messageElement.firstChild);
    }
    const providerName = messageElement.dataset.provider || 'AI';
    strongTag.textContent = `${providerName}: `;

    let contentDiv = messageElement.querySelector('.message-content');
    const streamingSpan = messageElement.querySelector('.ai-response-text-streaming');

    if (streamingSpan) { streamingSpan.remove(); }

    if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        if(strongTag.nextSibling) messageElement.insertBefore(contentDiv, strongTag.nextSibling);
        else messageElement.appendChild(contentDiv);
    }
    contentDiv.innerHTML = '';

    if (md && typeof md.render === 'function') {
        contentDiv.innerHTML = md.render(String(messageText || ""));
    } else {
        contentDiv.innerHTML = escapeHtml(String(messageText || "")).replace(/\n/g, '<br>');
    }
    renderLatexInElement(contentDiv);
}

// --- Socket.IO Event Handlers & AI Message Processing ---
function handleAiResponseMessage(data, isStreamEndOrFullMessage = false) {
    // This function is now primarily a wrapper if needed, or its logic integrated into socket handlers.
    // For simplicity, socket handlers will call processAIMessage directly or manage text accumulation.
    // The main purpose here was to remove spinner and update history, which is now more distributed.
    console.warn("[handleAiResponseMessage] This function might be deprecated in favor of direct socket event logic. Data:", data);
     // The spinner removal and history update logic is now more tightly coupled with specific socket events.
}

function initSocketIO() {
    debugLog('Initializing Socket.IO connection...');
    socket = io(window.API_BASE_URL || window.location.origin, { transports: ['websocket', 'polling'], reconnectionAttempts: 5, reconnectionDelay: 1000, timeout: 20000 });
    socket.on('connect', () => { debugLog('Socket.IO Connected'); updateConnectionStatus(true); getApiInfo(); socket.emit('request_history'); });
    socket.on('disconnect', (reason) => { debugLog(`Socket.IO Disconnected: ${reason}`); updateConnectionStatus(false); });
    socket.on('connect_error', (error) => { debugLog(`Socket.IO Connection Error: ${error.message}`); updateConnectionStatus(false); });
    // ... other basic socket event handlers: 'capture', 'new_screenshot', 'analysis_result', 'analysis_error', 'history', 'api_info'
    socket.on('new_screenshot', (data) => addHistoryItem(data));
    socket.on('analysis_result', (data) => { const el = document.getElementById('ss-ai-analysis'); if (el && data?.analysis) { el.textContent = data.analysis; if (data.image_url) el.dataset.sourceUrl = data.image_url; } });
    socket.on('analysis_error', (errorData) => { console.error(`Analysis Error for ${errorData?.image_url}: ${errorData?.error}`); alert(`AI分析图片 ${errorData?.image_url || ''} 失败: ${errorData?.error || '未知错误'}`); const el = document.getElementById('ss-ai-analysis'); if (el && el.dataset.sourceUrl === errorData?.image_url) el.textContent = `分析失败: ${errorData?.error || '未知错误'}`; });
    socket.on('history', (historyData) => { const listEl = document.getElementById('ss-history-list'); if (listEl) { listEl.innerHTML = ''; historyData.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach(addHistoryItem); } });
    socket.on('api_info', (apiData) => updateApiInfo(apiData));


    socket.on('chat_response', (data) => { // For non-streaming full responses
        console.log(`[Socket] Received 'chat_response' for requestId: ${data.request_id}`, data);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) { console.error("Chat history element not found for chat_response."); return; }

        const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
        if (thinkingDiv) { removeThinkingIndicator(chatHistoryEl, thinkingDiv); }

        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
        if (!aiDiv) {
            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;
            // Strong tag and content div will be added by processAIMessage
            chatHistoryEl.appendChild(aiDiv);
        }
        processAIMessage(aiDiv, data.full_message || data.message || "");

        // Update history
        let activeSession = chatSessions.find(s => s.id === (data.session_id || currentChatSessionId));
        if (activeSession) {
            const finalMsgText = data.full_message || data.message || "";
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === data.request_id);
            if (tempMsgIndex > -1) {
                activeSession.history[tempMsgIndex] = { role: 'model', parts: [{ text: finalMsgText }], provider: data.provider || 'AI' };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else {
                 activeSession.history.push({ role: 'model', parts: [{ text: finalMsgText }], provider: data.provider || 'AI' });
            }
            saveChatSessionsToStorage();
        }
        scrollToChatBottom(chatHistoryEl);
    });

    socket.on('chat_stream_chunk', function(data) {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;
        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
        let textSpan;

        if (!aiDiv) {
            const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
            if (thinkingDiv) { removeThinkingIndicator(chatHistoryEl, thinkingDiv); }
            else { console.warn(`[chat_stream_chunk] First chunk for ${data.request_id}, but NO specific thinkingDiv found to remove.`);}

            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;
            if(data.provider) aiDiv.dataset.provider = data.provider;


            const strongTag = document.createElement('strong');
            strongTag.textContent = `${data.provider || 'AI'}: `;
            aiDiv.appendChild(strongTag);

            textSpan = document.createElement('span');
            textSpan.className = 'ai-response-text-streaming';
            textSpan.textContent = data.chunk || '';
            aiDiv.appendChild(textSpan);
            chatHistoryEl.appendChild(aiDiv);
        } else {
            textSpan = aiDiv.querySelector('.ai-response-text-streaming');
            if (textSpan) {
                textSpan.textContent += (data.chunk || '');
            } else {
                // This case means stream_end might have already run or structure is broken
                // Try to append to .message-content if it exists, otherwise create it
                let contentDiv = aiDiv.querySelector('.message-content');
                if(!contentDiv) {
                    contentDiv = document.createElement('div');
                    contentDiv.className = 'message-content';
                    // Ensure strong tag exists if we are creating contentDiv here
                    if(!aiDiv.querySelector('strong')){
                        const strongTag = document.createElement('strong');
                        strongTag.textContent = `${data.provider || 'AI'}: `;
                        aiDiv.insertBefore(strongTag, aiDiv.firstChild);
                    }
                    aiDiv.appendChild(contentDiv);
                }
                console.warn(`[chat_stream_chunk] Appending chunk to .message-content for ${data.request_id} as streaming span was missing.`);
                contentDiv.textContent += (data.chunk || '');
            }
        }
        scrollToChatBottom(chatHistoryEl);
    });

    socket.on('chat_stream_end', function(data) {
        console.log(`[Socket] Received 'chat_stream_end' for requestId: ${data.request_id}`);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;

        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
        if (!aiDiv) { // Should have been created by first chunk
            console.warn(`[chat_stream_end] No message div found for ${data.request_id}. Creating one now.`);
            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;
            if(data.provider) aiDiv.dataset.provider = data.provider;
            chatHistoryEl.appendChild(aiDiv);
            // Remove thinking div if it somehow still exists
            const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
            if (thinkingDiv) removeThinkingIndicator(chatHistoryEl, thinkingDiv);
        }
        processAIMessage(aiDiv, data.full_message || '');
        scrollToChatBottom(chatHistoryEl);

        let activeSession = chatSessions.find(s => s.id === (data.session_id || currentChatSessionId));
        if (activeSession) {
            const finalMessageText = data.full_message || '';
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === data.request_id);
            if (tempMsgIndex > -1) {
                activeSession.history[tempMsgIndex] = { role: 'model', parts: [{ text: finalMessageText }], provider: data.provider || 'AI' };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else { // If no temp message, means it might be a new message or an orphaned stream_end
                 const existingMsgIndex = activeSession.history.findIndex(msg => msg.role === 'model' && msg.parts[0].text === finalMessageText && msg.provider === (data.provider || 'AI'));
                 if(existingMsgIndex === -1) { // Only add if not exactly identical to an existing one
                    activeSession.history.push({ role: 'model', parts: [{ text: finalMessageText }], provider: data.provider || 'AI' });
                 }
            }
            saveChatSessionsToStorage();
        }
    });
    
    socket.on('stt_result', (data) => { debugLog(`Received 'stt_result': ${JSON.stringify(data)}`); });
    socket.on('voice_chat_response', (data) => {
        debugLog(`Received 'voice_chat_response': ${JSON.stringify(data)}`);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data) {
            const transcript = data.transcript || '无法识别'; const aiResponseText = data.message || '无回答';
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> <span class="message-content-simple">${escapeHtml(transcript)}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong> <div class="message-content" id="voice-ai-response-content"></div></div>`;
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const voiceAiRespContentEl = document.getElementById('voice-ai-response-content');
            if (voiceAiRespContentEl) processAIMessage(voiceAiRespContentEl, aiResponseText); // Use processAIMessage
            addVoiceHistoryItem({ transcript: transcript, response: aiResponseText });
        }
        const startBtn = document.getElementById('voice-start-recording'); const stopBtn = document.getElementById('voice-stop-recording');
        if (startBtn) startBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
    });
    socket.on('stt_error', (errorData) => { console.error("STT Error:", errorData); alert(`语音识别失败: ${errorData.error || '未知错误'}`); const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(t)t.disabled=true; if(document.getElementById('voice-result'))document.getElementById('voice-result').textContent=`语音识别失败: ${errorData.error||'未知错误'}`; });
    socket.on('chat_error', (errorData) => {
        console.error(`[Socket] Received 'chat_error':`, errorData);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        const thinkingDiv = errorData.request_id 
            ? chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${errorData.request_id}"]`) 
            : chatHistoryEl?.querySelector('.ai-thinking');
        if (thinkingDiv) { removeThinkingIndicator(chatHistoryEl, thinkingDiv); }

        const isChatTabActive = document.getElementById('ai-chat')?.classList.contains('active');
        const isCurrentSession = currentChatSessionId === errorData.session_id || (!errorData.session_id && isChatTabActive);
        if (chatHistoryEl && isCurrentSession) {
            const errorDiv = document.createElement('div'); errorDiv.className = 'ai-message error-message';
            errorDiv.innerHTML = `<strong>系统错误:</strong> <span>处理消息失败: ${escapeHtml(errorData.message || '未知错误')}</span>`;
            chatHistoryEl.appendChild(errorDiv); scrollToChatBottom(chatHistoryEl);
        }
        // Voice tab error handling
    });
    socket.on('task_error', (errorData) => { console.error("Task Error:", errorData); alert(`后台任务出错: ${errorData.error}`);});

} // End of initSocketIO

// --- Chat Message Sending ---
function sendChatMessage() {
    const chatInputEl = document.getElementById('chat-chat-input');
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatInputEl || !chatHistoryEl) { console.error("Chat input or history missing."); return; }
    const message = chatInputEl.value.trim();
    const currentFileToSend = uploadedFile;
    if (!message && !currentFileToSend) { debugLog("Empty message/file."); return; }

    let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
    if (!activeSession) {
        const newId = Date.now();
        let title = message.substring(0,30) || (currentFileToSend ? `含${currentFileToSend.name.substring(0,20)}的对话` : '新对话');
        if((message.length>30&&title.length===30)||(currentFileToSend&&currentFileToSend.name.length>20&&title.length>=22))title+="...";
        activeSession={id:newId,title:escapeHtml(title),history:[]}; chatSessions.unshift(activeSession); addChatHistoryItem(activeSession); currentChatSessionId=newId;
        setTimeout(()=>{const l=document.getElementById('chat-session-list');l?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));l?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML='';},0);
    }
    const histMsgTxt = message || (currentFileToSend?`[用户上传了文件: ${currentFileToSend.name}]`:"");
    if(histMsgTxt || currentFileToSend) activeSession.history.push({role:'user',parts:[{text:histMsgTxt}]});
    
    const uDiv=document.createElement('div'); uDiv.className='user-message';
    const uStrong = document.createElement('strong'); uStrong.textContent="您: "; uDiv.appendChild(uStrong);
    const uMsgContentDiv=document.createElement('div'); uMsgContentDiv.className='message-content';
    uMsgContentDiv.textContent = message; // User message as plain text
    if(currentFileToSend){
        const fD=document.createElement('div');fD.className='attached-file';
        fD.innerHTML=`<i class="fas fa-paperclip"></i> ${escapeHtml(currentFileToSend.name)} (${formatFileSize(currentFileToSend.size)})`;
        if(message) uMsgContentDiv.appendChild(document.createElement('br'));
        uMsgContentDiv.appendChild(fD);
    }
    uDiv.appendChild(uMsgContentDiv);
    if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML='';
    chatHistoryEl.appendChild(uDiv);

    const reqId = generateUUID();
    console.log(`[sendChatMessage] Generated reqId: ${reqId}`);
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'ai-message ai-thinking';
    thinkingDiv.dataset.requestId = reqId;
    thinkingDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI正在思考...';
    chatHistoryEl.appendChild(thinkingDiv);
    scrollToChatBottom(chatHistoryEl);

    activeSession.history.push({ role: 'model', parts: [{text:''}], temp_id: reqId, provider: 'AI' });

    const streamToggle=document.getElementById('streaming-toggle-checkbox');
    const stream=streamToggle?streamToggle.checked:true;
    let histToSend=JSON.parse(JSON.stringify(activeSession.history.slice(0, -1))); 

    if(currentFileToSend){
        const fd=new FormData();fd.append('prompt',message);fd.append('file',currentFileToSend,currentFileToSend.name);
        fd.append('history',JSON.stringify(histToSend));fd.append('use_streaming',stream); 
        fd.append('session_id',activeSession.id);fd.append('request_id',reqId);
        fetch('/chat_with_file',{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`},body:fd})
        .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json();})
        .then(d=>{
            if(d && d.request_id === reqId) {
                if (!stream && d.message) {
                    // Call the socket chat_response handler for consistency
                    socket.emit('chat_response', { message:d.message, provider:d.provider, request_id:d.request_id, session_id:activeSession.id, full_message: d.message });
                } else if (stream) { debugLog("File upload ack for streaming, Req ID: "+d.request_id); }
                else if (!d.message && !stream) {
                    const currentThinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                    removeThinkingIndicator(chatHistoryEl, currentThinkingDiv);
                }
            } else {
                const currentThinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                removeThinkingIndicator(chatHistoryEl, currentThinkingDiv);
            }
        })
        .catch(e=>{
            console.error('Chat w/ file err:',e);
            const currentThinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
            removeThinkingIndicator(chatHistoryEl, currentThinkingDiv);
            const errD=document.createElement('div');errD.className='ai-message error-message';errD.innerHTML=`<strong>系统错误:</strong><span>发送失败:${escapeHtml(e.message)}</span>`;chatHistoryEl.appendChild(errD);scrollToChatBottom(chatHistoryEl);
        });
    } else {
        socket.emit('chat_message',{prompt:message,history:histToSend,request_id:reqId,use_streaming:stream,session_id:activeSession.id});
    }
    saveChatSessionsToStorage();
    chatInputEl.value='';const upPrevEl=document.getElementById('chat-upload-preview');if(upPrevEl)upPrevEl.innerHTML='';uploadedFile=null;const fInEl=document.getElementById('chat-file-upload');if(fInEl)fInEl.value='';
}

// --- Image Overlay & Cropping ---
function hideImageOverlay(){
    const o=document.getElementById('overlay'); if(o)o.style.display='none';
    currentImage=null; const p=document.getElementById('prompt-input'); if(p)p.value='';
}
function showImageOverlay(imageUrl) {
    const overlay=document.getElementById('overlay'),imgEl=document.getElementById('overlay-image'),selBox=document.getElementById('selection-box'),cropInf=document.getElementById('crop-info');
    if(!overlay||!imgEl||!selBox||!cropInf)return;currentImage=imageUrl;imgEl.src='';imgEl.src=`${imageUrl}?t=${Date.now()}`;overlay.style.display='flex';
    imgEl.onload=()=>{selection={x:0,y:0,width:imgEl.width,height:imgEl.height};updateSelectionBox();initSelectionControls();cropInf.textContent='拖拽调整区域或确认全图';};
    imgEl.onerror=()=>{alert('图片预览加载失败');hideImageOverlay();};
}
function updateSelectionBox(){
    const sB=document.getElementById('selection-box'),cI=document.getElementById('crop-info'),iE=document.getElementById('overlay-image');if(!sB||!cI||!iE||!iE.width||!iE.naturalWidth)return;selection.x=Math.max(0,Math.min(selection.x,iE.width));selection.y=Math.max(0,Math.min(selection.y,iE.height));selection.width=Math.max(10,Math.min(selection.width,iE.width-selection.x));selection.height=Math.max(10,Math.min(selection.height,iE.height-selection.y));sB.style.left=`${selection.x}px`;sB.style.top=`${selection.y}px`;sB.style.width=`${selection.width}px`;sB.style.height=`${selection.height}px`;const sX_=iE.naturalWidth/iE.width,sY_=iE.naturalHeight/iE.height;cI.textContent=`选择(原图):${Math.round(selection.x*sX_)},${Math.round(selection.y*sY_)}, ${Math.round(selection.width*sX_)}x${Math.round(selection.height*sY_)}`;
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
    .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json()})
    .then(d=>debugLog(`Crop ack: ${JSON.stringify(d)}`))
    .catch(e=>{console.error('Crop error:',e);alert(`裁剪出错: ${e.message}`);if(analysisEl)analysisEl.textContent=`分析失败: ${e.message}`;});
}
function initSelectionControls(){/* ... (selection controls logic as provided in original user file, ensure it's complete) ... */
    const sb=document.getElementById('selection-box'),oi=document.getElementById('overlay-image');if(!sb||!oi)return;let sx_s,sy_s,isx_s,isy_s,isr_s;function hs(e){e.preventDefault();isDragging=true;const tE=e.type.startsWith('touch'),cX=tE?e.touches[0].clientX:e.clientX,cY=tE?e.touches[0].clientY:e.clientY,iR=oi.getBoundingClientRect();sx_s=cX-iR.left;sy_s=cY-iR.top;isx_s=cX;isy_s=cY;isr_s={...selection};const br=sb.getBoundingClientRect(),rx=cX-br.left,ry=cY-br.top,et=15;dragType=rx>=isr_s.width-et&&ry>=isr_s.height-et?'resize-se':sx_s>=isr_s.x&&sx_s<=isr_s.x+isr_s.width&&sy_s>=isr_s.y&&sy_s<=isr_s.y+isr_s.height?'move':(dragType='draw',selection={x:sx_s,y:sy_s,width:0,height:0},updateSelectionBox(),undefined);if(!isDragging&&dragType!='draw')return;if(tE){document.addEventListener('touchmove',hm,{passive:false});document.addEventListener('touchend',he);document.addEventListener('touchcancel',he);}else{document.addEventListener('mousemove',hm);document.addEventListener('mouseup',he);}}function hm(e){if(!isDragging)return;e.preventDefault();const tE=e.type.startsWith('touch'),cX=tE?e.touches[0].clientX:e.clientX,cY=tE?e.touches[0].clientY:e.clientY,iR=oi.getBoundingClientRect(),currXimg=cX-iR.left,currYimg=cY-iR.top,dcx=cX-isx_s,dcy=cY-isy_s;if(dragType==='move'){selection.x=isr_s.x+dcx;selection.y=isr_s.y+dcy;}else if(dragType==='resize-se'){selection.width=isr_s.width+dcx;selection.height=isr_s.height+dcy;}else if(dragType==='draw'){selection.width=currXimg-selection.x;selection.height=currYimg-selection.y;if(selection.width<0){selection.x=currXimg;selection.width=-selection.width;}if(selection.height<0){selection.y=currYimg;selection.height=-selection.height;}}updateSelectionBox();}function he(){if(!isDragging)return;isDragging=false;dragType='';document.removeEventListener('mousemove',hm);document.removeEventListener('mouseup',he);document.removeEventListener('touchmove',hm,{passive:false});document.removeEventListener('touchend',he);document.removeEventListener('touchcancel',he);}oi.replaceWith(oi.cloneNode(true));document.getElementById('overlay-image').addEventListener('mousedown',hs);document.getElementById('overlay-image').addEventListener('touchstart',hs,{passive:false});sb.replaceWith(sb.cloneNode(true));document.getElementById('selection-box').addEventListener('mousedown',hs);document.getElementById('selection-box').addEventListener('touchstart',hs,{passive:false});const nsb=document.getElementById('selection-box');if('ontouchstart'in window&&!nsb.querySelector('.resize-handle-se')){const rh=document.createElement('div');rh.className='resize-handle resize-handle-se';nsb.appendChild(rh);}}

// --- History & UI Update Functions ---
function addHistoryItem(item) { /* ... (screenshot history item add logic) ... */
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
function addVoiceHistoryItem(item) { /* ... (voice history item add logic, use processAIMessage for responseText) ... */
    const voiceHistoryListEl = document.getElementById('voice-history-list'); if (!voiceHistoryListEl) return;
    const li = document.createElement('li'); li.className = 'history-item voice-history-item';
    const timestamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    const transcript = item.transcript || '无法识别'; const responseText = item.response || '无回答';
    const transcriptDisplay = transcript.length > 30 ? transcript.substring(0, 27) + '...' : transcript;
    li.innerHTML = `<div class="history-item-text"><div><strong><i class="fas fa-clock"></i> ${timestamp}</strong></div><div title="${escapeHtml(transcript)}"><i class="fas fa-comment-dots"></i> ${escapeHtml(transcriptDisplay)}</div></div>`;
    const deleteBtn = createDeleteButton(() => { if (confirm('删除此语音记录?')) li.remove(); }); li.appendChild(deleteBtn);
    li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-history')) return;
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong><span class="message-content-simple">${escapeHtml(transcript)}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong><div class="message-content" id="v-hist-ai-resp"></div></div>`; // Placeholder for message-content
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const respContentEl = document.getElementById('v-hist-ai-resp'); // This is now the .message-content div
            if (respContentEl) processAIMessage(respContentEl, responseText); // Use processAIMessage
        }
        voiceHistoryListEl.querySelectorAll('.history-item.active-session').forEach(i => i.classList.remove('active-session'));
        li.classList.add('active-session');
    });
    voiceHistoryListEl.insertBefore(li, voiceHistoryListEl.firstChild);
}
function addChatHistoryItem(session) { /* ... (chat history item add logic) ... */
    const historyListEl = document.getElementById('chat-session-list'); if (!historyListEl || !session) return;
    const existingLi = historyListEl.querySelector(`[data-session-id="${session.id}"]`); if (existingLi) existingLi.remove();
    const li = document.createElement('li'); li.className = 'history-item chat-history-item'; li.setAttribute('data-session-id', String(session.id));
    const titleText = session.title || '无标题对话'; const timestamp = new Date(session.id).toLocaleString([],{dateStyle:'short',timeStyle:'short',hour12:false});
    li.innerHTML = `<div class="history-item-text"><div title="${escapeHtml(titleText)}" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fas fa-comment"></i> ${escapeHtml(titleText)}</div><div style="font-size:0.75em;color:#666;">${timestamp}</div></div>`;
    const deleteBtn = createDeleteButton(()=>{if(confirm(`删除对话 "${escapeHtml(titleText)}"?`)){chatSessions=chatSessions.filter(s=>s.id!==session.id);li.remove();if(currentChatSessionId===session.id)clearCurrentChatDisplay();saveChatSessionsToStorage();}});
    li.appendChild(deleteBtn);
    li.addEventListener('click',(e)=>{if(e.target.closest('.delete-history'))return;const sessionId=Number(li.getAttribute('data-session-id'));const clickedSession=chatSessions.find(s=>s.id===sessionId);if(clickedSession){currentChatSessionId=clickedSession.id;renderChatHistory(clickedSession.history);historyListEl.querySelectorAll('.history-item.active-session').forEach(item=>item.classList.remove('active-session'));li.classList.add('active-session');document.getElementById('chat-chat-input')?.focus();saveCurrentChatSessionId();}});
    if(historyListEl.firstChild)historyListEl.insertBefore(li,historyListEl.firstChild);else historyListEl.appendChild(li);
}
function createDeleteButton(onClickCallback) { const btn=document.createElement('button');btn.className='delete-history';btn.innerHTML='<i class="fas fa-times"></i>';btn.title='删除';btn.type='button';btn.onclick=e=>{e.stopPropagation();onClickCallback();};return btn; }
function renderChatHistory(historyArray) { /* ... (render chat history, use processAIMessage for model turns) ... */
    const chatHistoryEl=document.getElementById('chat-chat-history');
    if(!chatHistoryEl)return;
    chatHistoryEl.innerHTML='';
    if(!historyArray||historyArray.length===0){ chatHistoryEl.innerHTML='<div class="system-message">对话为空...</div>'; return; }
    historyArray.forEach(turn=>{
        if (!turn || !turn.role || !turn.parts || !turn.parts[0]) return;
        const role=turn.role; const text=(turn.parts?.[0]?.text)||"";
        const msgDiv=document.createElement('div');
        // Strong tag and contentDiv will be handled by processAIMessage for AI, or created directly for user
        if(role==='user'){
            msgDiv.className='user-message';
            const strongTag=document.createElement('strong'); strongTag.textContent="您: "; msgDiv.appendChild(strongTag);
            const contentDiv=document.createElement('div'); contentDiv.className='message-content';
            contentDiv.textContent = text; // User messages are plain text
            const fileMatch = text.match(/\[用户上传了文件: (.*?)\]/);
            if (fileMatch && fileMatch[1]) {
                contentDiv.textContent = text.replace(fileMatch[0], '').trim();
                const fileInfo = document.createElement('div'); fileInfo.className = 'attached-file';
                fileInfo.innerHTML = `<i class="fas fa-paperclip"></i> (文件: ${escapeHtml(fileMatch[1])})`;
                if (contentDiv.textContent) contentDiv.appendChild(document.createElement('br'));
                contentDiv.appendChild(fileInfo);
            }
            msgDiv.appendChild(contentDiv);
        } else if(role==='model'){
            msgDiv.className='ai-message';
            // processAIMessage will add the strong tag and contentDiv internally
            processAIMessage(msgDiv, text);
        } else { 
            msgDiv.className='system-message'; // Or some other class
            const strongTag=document.createElement('strong'); strongTag.textContent = `${role}: `; msgDiv.appendChild(strongTag);
            const contentDiv=document.createElement('div'); contentDiv.className='message-content';
            contentDiv.textContent = text;
            msgDiv.appendChild(contentDiv);
        }
        chatHistoryEl.appendChild(msgDiv);
    });
    scrollToChatBottom(chatHistoryEl);
}
function updateConnectionStatus(isConnected){const ind=document.getElementById('connection-indicator'),st=document.getElementById('connection-status');if(ind&&st){ind.className=`status-indicator ${isConnected?'connected':'disconnected'}`;st.textContent=`实时连接: ${isConnected?'已连接':'未连接'}`;ind.title=`Socket.IO ${isConnected?'Connected':'Disconnected'}`;}}
function updateApiInfo(d){const el=document.getElementById('api-provider');if(el){el.textContent=`AI模型: ${d?.provider||'未知'}`;el.title=d?.provider?`Using ${d.provider}`:'AI Provider Info Unavailable';}}
function clearScreenshotHistory(){if(confirm('清空所有截图历史?')){const el=document.getElementById('ss-history-list');if(el)el.innerHTML='';const anEl=document.getElementById('ss-ai-analysis');if(anEl){anEl.textContent='点击历史查看分析...';delete anEl.dataset.sourceUrl;}}}
function clearCurrentChatDisplay(){const el=document.getElementById('chat-chat-history');if(el)el.innerHTML='<div class="system-message">选择记录或开始新对话...</div>';currentChatSessionId=null;document.getElementById('chat-session-list')?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));document.getElementById('chat-chat-input')?.focus(); saveCurrentChatSessionId();}
function clearAllChatSessions(){if(confirm('永久删除所有对话?')){chatSessions=[];currentChatSessionId=null;const el=document.getElementById('chat-session-list');if(el)el.innerHTML='';clearCurrentChatDisplay();saveChatSessionsToStorage();saveCurrentChatSessionId();}}
function clearVoiceHistory(){if(confirm('清空所有语音历史?')){const el=document.getElementById('voice-history-list');if(el)el.innerHTML='';const resEl=document.getElementById('voice-result');if(resEl)resEl.textContent='点击开始录音...';}}

// --- API & Server Communication ---
function getApiInfo() {
    if (!TOKEN) { updateApiInfo({ provider: '未知 (Token未设置)' }); return; }
    fetch('/api_info', { headers: { 'Authorization': `Bearer ${TOKEN}` } })
    .then(r=>{if(r.status===401)throw new Error('Unauthorized');if(!r.ok)throw new Error(`API信息获取失败(${r.status})`);return r.json();})
    .then(updateApiInfo).catch(e=>{console.error('API info error:',e);updateApiInfo({provider:`错误(${e.message})`});});
}
function sendVoiceToServer(audioBlob) { /* ... (send voice to server logic) ... */
    const fd = new FormData(); fd.append('audio', audioBlob, `rec_${Date.now()}.wav`);
    const resEl = document.getElementById('voice-result'); if(resEl)resEl.innerHTML='<i class="fas fa-spinner fa-spin"></i> 处理中...';
    fetch('/process_voice',{method:'POST',body:fd,headers:{'Authorization':`Bearer ${TOKEN}`}})
    .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json()})
    .then(d=>debugLog(`Voice ack: ${JSON.stringify(d)}`)) // Server emits voice_chat_response
    .catch(e=>{console.error('Voice upload err:',e);if(resEl)resEl.textContent=`语音处理失败: ${e.message}`;const s=document.getElementById('voice-start-recording'),st=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(st)st.disabled=true;});
}
function requestScreenshot(){if(socket?.connected)socket.emit('request_screenshot_capture');else alert('无法请求截图：未连接');}

// --- Initialization Functions for Features & Event Handlers ---
function initBaseButtonHandlers(){
    document.getElementById('close-overlay')?.addEventListener('click', hideImageOverlay);
    document.getElementById('confirm-selection')?.addEventListener('click', confirmCrop);
    document.getElementById('cancel-selection')?.addEventListener('click', hideImageOverlay);
}
function initTabs(){
    const c=document.querySelector('.tabs-container'),s=document.querySelectorAll('.tab-content-wrapper > .tab-content');if(!c||s.length===0)return;c.addEventListener('click',e=>{const t=e.target.closest('.tab-item');if(!t||t.classList.contains('active'))return;const id=t.dataset.tab,tc=document.getElementById(id);if(tc){c.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));s.forEach(x=>x.classList.remove('active'));t.classList.add('active');tc.classList.add('active');if(id==='ai-chat')document.getElementById('chat-chat-input')?.focus();}});const aT=c.querySelector('.tab-item.active')||c.querySelector('.tab-item');if(aT){aT.classList.add('active');const activeTabContent = document.getElementById(aT.dataset.tab); if(activeTabContent) activeTabContent.classList.add('active'); if(aT.dataset.tab === 'ai-chat')document.getElementById('chat-chat-input')?.focus();}
}
function initScreenshotAnalysisHandlers(){
    document.getElementById('ss-capture-btn')?.addEventListener('click', requestScreenshot);
    document.getElementById('ss-clear-history')?.addEventListener('click', clearScreenshotHistory);
}
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
}
function initVoiceFeature(){ /* ... (voice feature init as in original user file) ... */
    const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording'),v=document.getElementById('voice-result');if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){if(s)s.disabled=true;if(t)t.disabled=true;if(v)v.textContent='浏览器不支持录音。';return;}if(!s||!t||!v)return;s.addEventListener('click',async()=>{audioChunks=[];try{const st=await navigator.mediaDevices.getUserMedia({audio:true}),mt=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm','audio/ogg','audio/wav'].find(ty=>MediaRecorder.isTypeSupported(ty));if(!mt){alert("无支持录音格式。");return;}mediaRecorder=new MediaRecorder(st,{mimeType:mt});mediaRecorder.ondataavailable=ev=>{if(ev.data.size>0)audioChunks.push(ev.data);};mediaRecorder.onstop=()=>{if(audioChunks.length===0){v.textContent="未录到音频。";s.disabled=false;t.disabled=true;st.getTracks().forEach(tr=>tr.stop());return;}sendVoiceToServer(new Blob(audioChunks,{type:mediaRecorder.mimeType}));audioChunks=[];st.getTracks().forEach(tr=>tr.stop());};mediaRecorder.onerror=ev=>{alert(`录音出错:${ev.error.name||'未知'}`);s.disabled=false;t.disabled=true;if(v)v.textContent='录音错误。';try{st.getTracks().forEach(tr=>tr.stop());}catch(ex){}};mediaRecorder.start();s.disabled=true;t.disabled=false;v.innerHTML='<i class="fas fa-microphone-alt fa-beat" style="color:red;"></i> 录音中...';}catch(er){alert(`无法访问麦克风:${er.message}`);s.disabled=false;t.disabled=true;}});t.addEventListener('click',()=>{if(mediaRecorder?.state==='recording')mediaRecorder.stop();s.disabled=false;t.disabled=true;});}

function initVoiceAnswerHandlers(){ initVoiceFeature(); document.getElementById('voice-clear-history')?.addEventListener('click',clearVoiceHistory); }

// --- Storage Functions ---
function saveChatSessionsToStorage() { try {localStorage.setItem('chatSessions',JSON.stringify(chatSessions));}catch(e){console.error("Failed to save chat sessions:",e);} }
function loadChatSessionsFromStorage() {
    try {
        const saved = localStorage.getItem('chatSessions');
        if (saved) {
            chatSessions = JSON.parse(saved);
            const listEl = document.getElementById('chat-session-list');
            if (listEl) { listEl.innerHTML = ''; chatSessions.sort((a,b)=>(b.id||0)-(a.id||0)).forEach(addChatHistoryItem); }
            const lastSessionId = localStorage.getItem('currentChatSessionId');
            if (lastSessionId && chatSessions.find(s => s.id === Number(lastSessionId))) {
                currentChatSessionId = Number(lastSessionId);
                const activeSessionItem = listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`);
                if (activeSessionItem) activeSessionItem.click();
                else clearCurrentChatDisplay();
            } else { clearCurrentChatDisplay(); }
        } else { clearCurrentChatDisplay(); }
    } catch (e) { console.error("Failed to load chat sessions:", e); chatSessions=[]; clearCurrentChatDisplay(); }
}
function saveCurrentChatSessionId() {
    if (currentChatSessionId) { localStorage.setItem('currentChatSessionId', currentChatSessionId); }
    else { localStorage.removeItem('currentChatSessionId'); }
}

// --- Main Initialization ---
function initAllFeatures() {
    console.log("--- Initializing All Features ---");
    const tokenMeta = document.querySelector('meta[name="token"]');
    if (tokenMeta?.content) TOKEN = tokenMeta.content; else console.warn('Token meta tag missing.');
    console.log('[KaTeX] Initial check for renderMathInElement at page load:', typeof window.renderMathInElement);
    if (document.querySelector('script[src*="katex"][src*="auto-render.min.js"]')) {
        console.log('[KaTeX] auto-render.min.js script tag is present in HTML.');
    }

    initMarkdownRenderer();
    initBaseButtonHandlers(); // MUST BE DEFINED BEFORE THIS
    initTabs();
    initScreenshotAnalysisHandlers();
    initAiChatHandlers();
    initVoiceAnswerHandlers();
    initSocketIO();
    
    console.log("--- Application initialization complete ---");
}

document.addEventListener('DOMContentLoaded', initAllFeatures);
document.addEventListener('DOMContentLoaded', ()=>{ const btns=document.querySelectorAll('button,.btn,.tab-item');btns.forEach(b=>{let touchTimer;const clearTimer=()=>{if(touchTimer){clearTimeout(touchTimer);touchTimer=null;this.classList.remove('touch-active');}};b.addEventListener('touchstart',function(){this.classList.add('touch-active');touchTimer=setTimeout(clearTimer,300);},{passive:true});b.addEventListener('touchend',clearTimer);b.addEventListener('touchcancel',clearTimer);});if(!document.querySelector('style#touch-active-style')){const s=document.createElement('style');s.id='touch-active-style';s.textContent='.touch-active{opacity:0.7 !important; transform:scale(0.98) !important;}';document.head.appendChild(s);}});