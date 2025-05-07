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
    console.log(`[AI DEBUG] ${message}`); // Changed prefix slightly for clarity
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
        requestAnimationFrame(() => { // Use requestAnimationFrame for smoother scrolling
            chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        });
    }
}

/** Escapes HTML - a basic utility if needed, markdown-it handles most of this. */
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
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
                <span>${escapeHtml(displayName)} (${formatFileSize(file.size)})</span>
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
                ignoredClasses: ["no-katex-render", "hljs", "no-math", "highlight"] // Added "highlight" to ignore code blocks further
            });
        } catch (error) {
            console.error("Error during KaTeX rendering:", error, "on element:", element);
        }
    }
}


/**
 * Renders Markdown text to HTML using markdown-it and then renders LaTeX within that HTML.
 * @param {string} markdownText The Markdown string.
 * @param {HTMLElement} targetElement The DOM element where the HTML will be inserted.
 */
function renderMarkdownAndLatex(markdownText, targetElement) {
    if (!targetElement) {
        console.error("Target element for Markdown/LaTeX rendering is not provided.");
        return;
    }
    
    markdownText = String(markdownText || ""); // Ensure it's a string
    
    let htmlContent = "";
    
    if (md && typeof md.render === 'function') {
        try {
            htmlContent = md.render(markdownText);
            // debugLog("Rendered Markdown using markdown-it for renderMarkdownAndLatex");
        } catch (error) {
            console.error("Error rendering Markdown with markdown-it:", error);
            htmlContent = escapeHtml(markdownText).replace(/\n/g, '<br>'); // Fallback
        }
    } else if (typeof marked !== 'undefined' && typeof marked.parse === 'function') { // Fallback to marked if markdown-it is not ready
        try {
            htmlContent = marked.parse(markdownText);
            // debugLog("Rendered Markdown using marked (fallback) for renderMarkdownAndLatex");
        } catch (error) {
            console.error("Error rendering Markdown with marked:", error);
            htmlContent = escapeHtml(markdownText).replace(/\n/g, '<br>'); // Final fallback
        }
    } else { // Absolute fallback
        htmlContent = escapeHtml(markdownText).replace(/\n/g, '<br>');
        console.warn("Falling back to basic HTML escaping for Markdown in renderMarkdownAndLatex");
    }
    
    targetElement.innerHTML = htmlContent;
    renderLatexInElement(targetElement); // Render LaTeX after HTML is set
}


// --- Socket.IO Initialization ---
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

    // Consolidated message handling logic from the original user file
    function handleAiResponseMessage(data, isStreamEnd = false) {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) {
            console.error("Chat history element not found in handleAiResponseMessage");
            return;
        }

        const messageText = isStreamEnd ? (data.full_message || "") : (data.message || "");
        const provider = data.provider || 'AI';
        const requestId = data.request_id;
        const sessionIdFromEvent = data.session_id;

        let activeSession = chatSessions.find(s => s.id === (sessionIdFromEvent || currentChatSessionId));

        if (sessionIdFromEvent && currentChatSessionId !== sessionIdFromEvent && chatSessions.find(s => s.id === sessionIdFromEvent)) {
            currentChatSessionId = sessionIdFromEvent;
            activeSession = chatSessions.find(s => s.id === currentChatSessionId);
            const listEl = document.getElementById('chat-session-list');
            listEl?.querySelectorAll('.history-item.active-session')?.forEach(item => item.classList.remove('active-session'));
            listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`)?.classList.add('active-session');
            if (activeSession) renderChatHistory(activeSession.history);
        }

        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${requestId}"]`);
        let messageContentEl;

        if (!aiDiv) {
            const thinkingDiv = requestId ? chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${requestId}"]`) : chatHistoryEl.querySelector('.ai-thinking');
            
            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            if (requestId) aiDiv.dataset.requestId = requestId;

            const strongTag = document.createElement('strong');
            strongTag.textContent = `${provider}: `;
            aiDiv.appendChild(strongTag);

            messageContentEl = document.createElement('div');
            messageContentEl.className = 'message-content'; // This is where Markdown HTML will go
            aiDiv.appendChild(messageContentEl);

            if (thinkingDiv && thinkingDiv.parentNode === chatHistoryEl) {
                chatHistoryEl.replaceChild(aiDiv, thinkingDiv);
            } else if (thinkingDiv) {
                thinkingDiv.remove();
                chatHistoryEl.appendChild(aiDiv);
            } else {
                chatHistoryEl.appendChild(aiDiv);
            }
        } else {
            messageContentEl = aiDiv.querySelector('.message-content');
            if (!messageContentEl) { // Should not happen if structure is consistent
                messageContentEl = document.createElement('div');
                messageContentEl.className = 'message-content';
                // Clear other children except strong tag if any, then append
                Array.from(aiDiv.children).forEach(child => {
                    if (child.tagName.toLowerCase() !== 'strong') child.remove();
                });
                aiDiv.appendChild(messageContentEl);
            }
            const strongTag = aiDiv.querySelector('strong');
            if (strongTag && strongTag.textContent !== `${provider}: `) {
                strongTag.textContent = `${provider}: `;
            }
        }
        
        // Use processAIMessage for full rendering at the end or for non-streamed.
        // For streaming chunks, textContent is updated, and then full render on stream end.
        if (isStreamEnd || !data.is_chunk) { // Assuming !data.is_chunk for non-streamed full messages
             processAIMessage(aiDiv, messageText); // processAIMessage handles both markdown and latex
        } else if (data.is_chunk && messageContentEl.classList.contains('ai-response-text')) { // If it's a streaming chunk and we are using the text span
             messageContentEl.textContent += messageText; // Append chunk text
        } else if (data.is_chunk) {
            // This case might happen if the structure was different initially for stream
            // Ensure messageContentEl exists and append
            if (!messageContentEl.classList.contains('ai-response-text')) { // If it's not the dedicated span
                 const textNode = document.createTextNode(messageText);
                 messageContentEl.appendChild(textNode); // Append chunk text
            }
        }


        scrollToChatBottom(chatHistoryEl);

        if (activeSession && (messageText || isStreamEnd)) {
            const finalMsgText = isStreamEnd ? (data.full_message || "") : messageText;
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === requestId);
            if (tempMsgIndex > -1 && isStreamEnd) { // Only update history on stream end or full message
                activeSession.history[tempMsgIndex] = { role: 'model', parts: [{ text: finalMsgText }], provider: provider };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else if (isStreamEnd || (!data.is_chunk && !activeSession.history.find(msg => msg.temp_id === requestId))) {
                // Add if it's a full message (not a chunk continuation) and not already added as temp
                const alreadyExists = activeSession.history.some(msg => msg.role === 'model' && msg.parts[0].text === finalMsgText && msg.provider === provider && !msg.temp_id);
                if (!alreadyExists) {
                     activeSession.history.push({ role: 'model', parts: [{ text: finalMsgText }], provider: provider });
                }
            }
            if (isStreamEnd) saveChatSessionsToStorage(); // Save history at the end of a stream
        } else if (!activeSession) {
            console.warn("No active session to save AI msg history.", data);
        }
    }
    
    // Using the provided socket event listeners
    socket.on('chat_response', (data) => { // For non-streaming responses or initial part of a file response
        handleAiResponseMessage(data, false); 
        // If this is a full message, save history here
        const activeSession = chatSessions.find(s => s.id === (data.session_id || currentChatSessionId));
        if (activeSession && data.message && !data.is_chunk) { // Ensure it's not a stream related call
             const alreadyExists = activeSession.history.some(msg => msg.role === 'model' && msg.parts[0].text === data.message && msg.provider === (data.provider || 'AI'));
             if (!alreadyExists) {
                 activeSession.history.push({ role: 'model', parts: [{ text: data.message }], provider: data.provider || 'AI' });
             }
             saveChatSessionsToStorage();
        }
    });

    socket.on('chat_stream_chunk', function(data) {
        // debugLog('Received chat_stream_chunk:' + JSON.stringify(data));
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;

        const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
        let textSpan;

        if (!aiDiv) { // First chunk, create the message structure
            if (thinkingDiv) thinkingDiv.remove(); // Remove "thinking..."

            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;

            const strongTag = document.createElement('strong');
            strongTag.textContent = `${data.provider || 'AI'}: `;
            aiDiv.appendChild(strongTag);

            // Create a span to hold the streaming text. This will be replaced by .message-content on stream_end
            textSpan = document.createElement('span');
            textSpan.className = 'ai-response-text'; // This class can be used for specific styling if needed
            textSpan.textContent = data.chunk || '';
            aiDiv.appendChild(textSpan);
            
            chatHistoryEl.appendChild(aiDiv);
        } else { // Subsequent chunks
            textSpan = aiDiv.querySelector('.ai-response-text');
            if (textSpan) {
                textSpan.textContent += (data.chunk || '');
            } else {
                // Fallback if the structure isn't as expected (e.g. if stream_end was missed)
                // This indicates a potential issue, ideally processAIMessage would have created .message-content
                const contentDiv = aiDiv.querySelector('.message-content') || document.createElement('div');
                if (!contentDiv.parentNode) {
                    contentDiv.className = 'message-content';
                    aiDiv.appendChild(contentDiv);
                }
                contentDiv.textContent += (data.chunk || ''); // Less ideal, as it mixes with rendered HTML
                console.warn("Streaming chunk appended to .message-content directly, structure might be off.");
            }
        }
        scrollToChatBottom(chatHistoryEl);
    });

    socket.on('chat_stream_end', function(data) {
        debugLog('Received chat_stream_end:' + JSON.stringify(data));
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;

        const aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
        if (!aiDiv) {
            console.warn(`Stream end: No message element found for request ID: ${data.request_id}`);
            // Potentially create the div if it's missing, using data.full_message
            // This is a recovery step, ideally aiDiv should exist from chat_stream_chunk
            handleAiResponseMessage({ ...data, message: data.full_message }, true); // Treat as a full message
            return;
        }

        const finalMessageText = data.full_message || '';
        
        // Now, use processAIMessage to render the complete Markdown and LaTeX
        processAIMessage(aiDiv, finalMessageText); // This will replace the temporary textSpan with proper .message-content

        scrollToChatBottom(chatHistoryEl);

        // Update and save history
        let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
        if (!activeSession && data.session_id) activeSession = chatSessions.find(s => s.id === data.session_id);

        if (activeSession) {
            const tempMsgIndex = activeSession.history.findIndex(msg => msg.temp_id === data.request_id);
            if (tempMsgIndex > -1) {
                activeSession.history[tempMsgIndex] = { 
                    role: 'model', 
                    parts: [{ text: finalMessageText }],
                    provider: data.provider || 'AI'
                };
                delete activeSession.history[tempMsgIndex].temp_id;
            } else {
                // Check if this exact message already exists (e.g., from a previous non-streaming response)
                const alreadyExists = activeSession.history.some(msg => 
                    msg.role === 'model' && 
                    msg.parts[0].text === finalMessageText &&
                    msg.provider === (data.provider || 'AI') &&
                    !msg.temp_id // Ensure it's not a temp message we're comparing against
                );
                if (!alreadyExists) {
                    activeSession.history.push({ 
                        role: 'model', 
                        parts: [{ text: finalMessageText }],
                        provider: data.provider || 'AI'
                    });
                }
            }
            saveChatSessionsToStorage();
        } else {
            console.warn("Stream end: No active session to save message history for request_id:", data.request_id);
        }
    });


    socket.on('stt_result', (data) => { debugLog(`Received 'stt_result': ${JSON.stringify(data)}`); });
    socket.on('voice_chat_response', (data) => {
        debugLog(`Received 'voice_chat_response': ${JSON.stringify(data)}`);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data) {
            const transcript = data.transcript || '无法识别'; const aiResponseText = data.message || '无回答';
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> <span class="message-content-simple">${escapeHtml(transcript)}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong> <div class="message-content" id="voice-ai-response-content"></div></div>`; // .message-content for styling
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const voiceAiRespContentEl = document.getElementById('voice-ai-response-content');
            if (voiceAiRespContentEl) renderMarkdownAndLatex(aiResponseText, voiceAiRespContentEl); // Use the main renderer
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
        
        // Check if this error corresponds to the current active chat tab and session
        const isChatTabActive = document.getElementById('ai-chat')?.classList.contains('active');
        const isCurrentSession = currentChatSessionId === errorData.session_id || (!errorData.session_id && isChatTabActive);

        if (chatHistoryEl && isCurrentSession) {
            const errorDiv = document.createElement('div'); errorDiv.className = 'ai-message error-message'; // Use consistent class for styling
            errorDiv.innerHTML = `<strong>系统错误:</strong> <span>处理消息失败: ${escapeHtml(errorData.message || '未知错误')}</span>`;
            chatHistoryEl.appendChild(errorDiv); scrollToChatBottom(chatHistoryEl);
        }
        if (document.getElementById('voice-answer').classList.contains('active')) { // Check if voice tab is active for voice errors
             const voiceResultEl = document.getElementById('voice-result');
             if(voiceResultEl) voiceResultEl.textContent = `AI 处理失败: ${escapeHtml(errorData.message || '未知错误')}`;
             const startBtn = document.getElementById('voice-start-recording'); const stopBtn = document.getElementById('voice-stop-recording');
             if(startBtn) startBtn.disabled = false; if(stopBtn) stopBtn.disabled = true;
        }
    });
    socket.on('task_error', (errorData) => { console.error("Task Error:", errorData); alert(`后台任务出错: ${errorData.error}`); const s=document.getElementById('voice-start-recording'),t=document.getElementById('voice-stop-recording');if(s)s.disabled=false;if(t)t.disabled=true; });

    // Add the new_message handler if it was meant to be used alongside stream/response
    // This seems to be from the user's original file, ensure it's correctly integrated or removed if redundant
    socket.on('new_message', function(data) { // This is likely for non-streaming full messages
        debugLog('Received new_message (non-streaming):' + JSON.stringify(data));
        handleAiResponseMessage(data, true); // Treat as a full message (isStreamEnd = true)
    });

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
        activeSession={id:newId,title:escapeHtml(title),history:[]}; chatSessions.unshift(activeSession); addChatHistoryItem(activeSession); currentChatSessionId=newId;
        setTimeout(()=>{const l=document.getElementById('chat-session-list');l?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));l?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML='';},0);
    }
    const histMsgTxt = message || (currentFileToSend?`[用户上传了文件: ${currentFileToSend.name}]`:"");
    if(histMsgTxt||currentFileToSend)activeSession.history.push({role:'user',parts:[{text:histMsgTxt}]});
    
    const uDiv=document.createElement('div');uDiv.className='user-message';
    const uStrong = document.createElement('strong'); uStrong.textContent="您: "; uDiv.appendChild(uStrong);
    const uMsgContentDiv=document.createElement('div');uMsgContentDiv.className='message-content'; // Use .message-content for user's HTML too
    
    if(message){
        // For user messages, we typically don't render Markdown, but display as typed.
        // If Markdown rendering for user messages is desired, call renderMarkdownAndLatex here.
        // For now, just text content.
        uMsgContentDiv.textContent=message; // Display raw text, no markdown for user input
    } else if(currentFileToSend&&!message){
        uMsgContentDiv.textContent="(发送文件)";
    }

    if(currentFileToSend){
        const fD=document.createElement('div');fD.className='attached-file';
        fD.innerHTML=`<i class="fas fa-paperclip"></i> ${escapeHtml(currentFileToSend.name)} (${formatFileSize(currentFileToSend.size)})`;
        if(message) uMsgContentDiv.appendChild(document.createElement('br')); // Add space if there's text before file
        uMsgContentDiv.appendChild(fD);
    }
    uDiv.appendChild(uMsgContentDiv);

    if(chatHistoryEl.querySelector(".system-message"))chatHistoryEl.innerHTML=''; chatHistoryEl.appendChild(uDiv);scrollToChatBottom(chatHistoryEl);
    chatInputEl.value='';const upPrevEl=document.getElementById('chat-upload-preview');if(upPrevEl)upPrevEl.innerHTML='';uploadedFile=null;const fInEl=document.getElementById('chat-file-upload');if(fInEl)fInEl.value='';
    
    const thinkingDiv=document.createElement('div');thinkingDiv.className='ai-message ai-thinking';const reqId=generateUUID();thinkingDiv.dataset.requestId=reqId;thinkingDiv.innerHTML='<i class="fas fa-spinner fa-spin"></i> AI正在思考...';chatHistoryEl.appendChild(thinkingDiv);scrollToChatBottom(chatHistoryEl);
    activeSession.history.push({ role: 'model', parts: [{text:''}], temp_id: reqId, provider: 'AI' }); // Add a temporary placeholder for AI response

    const streamToggle=document.getElementById('streaming-toggle-checkbox');const stream=streamToggle?streamToggle.checked:true;
    let histToSend=JSON.parse(JSON.stringify(activeSession.history.slice(0, -1))); // Send history up to the user's message

    if(currentFileToSend){
        const fd=new FormData();fd.append('prompt',message);fd.append('file',currentFileToSend,currentFileToSend.name);fd.append('history',JSON.stringify(histToSend));fd.append('use_streaming',stream); // Consistent streaming param
        fd.append('session_id',activeSession.id);fd.append('request_id',reqId);
        fetch('/chat_with_file',{method:'POST',headers:{'Authorization':`Bearer ${TOKEN}`},body:fd})
        .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json();})
        .then(d=>{
            if(d && d.request_id === reqId) {
                // If not streaming, handle full response. If streaming, socket events will handle it.
                if (!stream && d.message) { // Non-streaming file response
                    handleAiResponseMessage({message:d.message, provider:d.provider, request_id:d.request_id, session_id:activeSession.id, full_message: d.message}, true);
                } else if (stream) {
                    debugLog("File upload ack for streaming, waiting for socket events. Req ID: "+d.request_id);
                } else if (!d.message) { // Non-streaming but no message
                    removeThinkingIndicator(chatHistoryEl, thinkingDiv); // Remove thinking if no message
                    console.warn("Chat w/ file: Non-streaming response without message content.", d);
                }
            } else {
                console.warn("Chat w/ file: unexpected server resp or mismatched request ID",d); 
                removeThinkingIndicator(chatHistoryEl, thinkingDiv);
            }
        })
        .catch(e=>{console.error('Chat w/ file err:',e);const tD=chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);if(tD)removeThinkingIndicator(chatHistoryEl,tD);const errD=document.createElement('div');errD.className='ai-message error-message';errD.innerHTML=`<strong>系统错误:</strong><span>发送失败:${escapeHtml(e.message)}</span>`;chatHistoryEl.appendChild(errD);scrollToChatBottom(chatHistoryEl);});
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
    .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json()})
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
    .then(r=>{if(!r.ok)return r.json().catch(()=>({error:`HTTP ${r.status}`})).then(eD=>{throw new Error(eD.message||eD.error||`HTTP ${r.status}`)});return r.json()})
    .then(d=>debugLog(`Voice ack: ${JSON.stringify(d)}`)) // Server should emit voice_chat_response via socket
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
    li.innerHTML = `<div class="history-item-text"><div><strong><i class="fas fa-clock"></i> ${timestamp}</strong></div><div title="${escapeHtml(transcript)}"><i class="fas fa-comment-dots"></i> ${escapeHtml(transcriptDisplay)}</div></div>`;
    const deleteBtn = createDeleteButton(() => { if (confirm('删除此语音记录?')) li.remove(); }); li.appendChild(deleteBtn);
    li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-history')) return;
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong><span class="message-content-simple">${escapeHtml(transcript)}</span></div>`;
            const aiResponseHtml = `<div><strong><i class="fas fa-robot"></i> AI回答:</strong><div class="message-content" id="v-hist-ai-resp"></div></div>`;
            voiceResultEl.innerHTML = `${transcriptHtml}<hr>${aiResponseHtml}`;
            const respContentEl = document.getElementById('v-hist-ai-resp');
            if (respContentEl) renderMarkdownAndLatex(responseText, respContentEl); // Use main renderer
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
    li.innerHTML = `<div class="history-item-text"><div title="${escapeHtml(titleText)}" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fas fa-comment"></i> ${escapeHtml(titleText)}</div><div style="font-size:0.75em;color:#666;">${timestamp}</div></div>`;
    const deleteBtn = createDeleteButton(()=>{if(confirm(`删除对话 "${escapeHtml(titleText)}"?`)){chatSessions=chatSessions.filter(s=>s.id!==session.id);li.remove();if(currentChatSessionId===session.id)clearCurrentChatDisplay();saveChatSessionsToStorage();}});
    li.appendChild(deleteBtn);
    li.addEventListener('click',(e)=>{if(e.target.closest('.delete-history'))return;const sessionId=Number(li.getAttribute('data-session-id'));const clickedSession=chatSessions.find(s=>s.id===sessionId);if(clickedSession){currentChatSessionId=clickedSession.id;renderChatHistory(clickedSession.history);historyListEl.querySelectorAll('.history-item.active-session').forEach(item=>item.classList.remove('active-session'));li.classList.add('active-session');document.getElementById('chat-chat-input')?.focus();}});
    if(historyListEl.firstChild)historyListEl.insertBefore(li,historyListEl.firstChild);else historyListEl.appendChild(li);
}

function createDeleteButton(onClickCallback) { const btn=document.createElement('button');btn.className='delete-history';btn.innerHTML='<i class="fas fa-times"></i>';btn.title='删除';btn.type='button';btn.onclick=e=>{e.stopPropagation();onClickCallback();};return btn; }

function renderChatHistory(historyArray) {
    const chatHistoryEl=document.getElementById('chat-chat-history');
    if(!chatHistoryEl)return;
    chatHistoryEl.innerHTML=''; // Clear previous history
    
    if(!historyArray||historyArray.length===0){
        chatHistoryEl.innerHTML='<div class="system-message">对话为空...</div>';
        return;
    }
    
    historyArray.forEach(turn=>{
        if (!turn || !turn.role || !turn.parts || !turn.parts[0]) return; // Basic validation

        const role=turn.role;
        const text=(turn.parts?.[0]?.text)||"";
        const msgDiv=document.createElement('div');
        const strongTag=document.createElement('strong');
        
        const contentDiv=document.createElement('div');
        contentDiv.className='message-content'; // Common class for all message text

        if(role==='user'){
            msgDiv.className='user-message';
            strongTag.textContent="您: ";
            // User messages are typically not Markdown rendered, display as text
            contentDiv.textContent = text; 
            
            // Check for file upload info in user message (if it was stored this way)
            const fileMatch = text.match(/\[用户上传了文件: (.*?)\]/);
            if (fileMatch && fileMatch[1]) {
                contentDiv.textContent = text.replace(fileMatch[0], '').trim(); // Text part
                const fileInfo = document.createElement('div');
                fileInfo.className = 'attached-file';
                fileInfo.innerHTML = `<i class="fas fa-paperclip"></i> (文件: ${escapeHtml(fileMatch[1])})`;
                if (contentDiv.textContent) contentDiv.appendChild(document.createElement('br'));
                contentDiv.appendChild(fileInfo);
            }
        }
        else if(role==='model'){
            msgDiv.className='ai-message';
            strongTag.textContent=`${turn.provider||'AI'}: `;
            // AI messages are Markdown rendered
            renderMarkdownAndLatex(text, contentDiv);
        }
        else { // System or other roles, display as simple text
            msgDiv.className='system-message'; // Or a generic class if needed
            strongTag.textContent = `${role}: `; // Generic role display
            contentDiv.textContent = text;
        }
        
        msgDiv.appendChild(strongTag);
        msgDiv.appendChild(contentDiv);
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

function initTabs(){const c=document.querySelector('.tabs-container'),s=document.querySelectorAll('.tab-content-wrapper > .tab-content');if(!c||s.length===0)return;c.addEventListener('click',e=>{const t=e.target.closest('.tab-item');if(!t||t.classList.contains('active'))return;const id=t.dataset.tab,tc=document.getElementById(id);if(tc){c.querySelectorAll('.active').forEach(x=>x.classList.remove('active'));s.forEach(x=>x.classList.remove('active'));t.classList.add('active');tc.classList.add('active');if(id==='ai-chat')document.getElementById('chat-chat-input')?.focus();}});const aT=c.querySelector('.tab-item.active')||c.querySelector('.tab-item');if(aT){aT.classList.add('active');document.getElementById(aT.dataset.tab)?.classList.add('active');if(aT.dataset.tab === 'ai-chat')document.getElementById('chat-chat-input')?.focus();}}
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
        streamingToggle.checked = saved !== null ? saved === 'true' : true; // Default to true
        if(saved === null) localStorage.setItem('useStreamingOutput', 'true');
        streamingToggle.addEventListener('change', function(){localStorage.setItem('useStreamingOutput',String(this.checked));});
    }
    // Test button for rendering Markdown
    const testRenderBtn = document.getElementById('test-render-btn'); // Assume it exists or create it
    if (testRenderBtn) {
        testRenderBtn.addEventListener('click', () => {
            const chatHistoryEl = document.getElementById('chat-chat-history'); if(!chatHistoryEl)return;
            if(chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
            
            const testMsgDiv = document.createElement('div');
            testMsgDiv.className = 'ai-message'; // Use AI message style for test
            
            const testMD = "### Markdown Test\n\nThis is a test of **Markdown** rendering with `markdown-it`.\n\n- List item 1\n- List item 2\n  - Nested item\n\n```javascript\nfunction greet(name) {\n  console.log('Hello, ' + name + '!');\n}\ngreet('World');\n```\n\nA link to [Google](https://www.google.com).\n\nAn image:\n![Alt text](https://via.placeholder.com/150)\n\nBlockquote:\n> This is a blockquote.\n\nLaTeX行内公式: $E=mc^2$\n\nLaTeX行间公式:\n$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$";
            
            processAIMessage(testMsgDiv, testMD); // Use the main processing function
            chatHistoryEl.appendChild(testMsgDiv); 
            scrollToChatBottom(chatHistoryEl);
        });
    }
}
function initVoiceAnswerHandlers(){ initVoiceFeature(); document.getElementById('voice-clear-history')?.addEventListener('click',clearVoiceHistory); }

// Initialize markdown-it instance
function initMarkdownRenderer() {
    debugLog("Initializing markdown-it renderer...");
    try {
        if (typeof window.markdownit === 'function') {
            md = window.markdownit({
                html: true,        // Enable HTML tags in source
                xhtmlOut: false,   // Use '/' to close single tags (<br />)
                breaks: true,      // Convert '\n' in paragraphs into <br>
                langPrefix: 'language-', // CSS language prefix for fenced blocks
                linkify: true,     // Autoconvert URL-like text to links

                typographer: true, // Enable some language-neutral replacement + quotes beautification
                quotes: '“”‘’',

                // Highlighter function for fenced code blocks
                highlight: function (str, lang) {
                    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
                        try {
                            return '<pre class="hljs"><code>' +
                                   window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                                   '</code></pre>';
                        } catch (__) {}
                    }
                    // Fallback for no language or hljs not available/error
                    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
                }
            });
            // Add plugins if needed, e.g., markdown-it-footnote, markdown-it-abbr
            // md.use(window.markdownitFootnote); 
            debugLog("✅ markdown-it initialized successfully with highlight.js integration.");
        } else {
            throw new Error("window.markdownit is not a function. Markdown rendering will be basic.");
        }
    } catch (e) {
        console.error("❌ Failed to initialize markdown-it:", e);
        // Provide a very basic fallback if markdown-it fails completely
        md = {
            render: function(text) { return escapeHtml(text).replace(/\n/g, '<br>'); },
            utils: { escapeHtml: escapeHtml }
        };
        debugLog("⚠️ Using extremely basic fallback markdown renderer due to init error.");
    }
}

// Process AI Message (central function for rendering AI responses)
function processAIMessage(messageElement, messageText) {
    // debugLog("Processing AI message with Markdown for element:", messageElement);
    
    // Ensure the strong tag for "AI:" is present or created correctly
    let strongTag = messageElement.querySelector('strong');
    if (!strongTag) {
        strongTag = document.createElement('strong');
        messageElement.insertBefore(strongTag, messageElement.firstChild); // Add at the beginning
    }
    const providerName = messageElement.dataset.provider || 'AI'; // Get provider from data-attribute or default
    strongTag.textContent = `${providerName}: `;


    // Find or create the .message-content div
    let contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) { // If it exists, clear it for re-rendering
        contentDiv.innerHTML = ''; 
    } else { // If it doesn't exist, create and append it
        contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        // Remove any existing text nodes that might be direct children from streaming
        Array.from(messageElement.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
                node.remove();
            }
            // Remove old .ai-response-text span if it exists from previous streaming
            if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('ai-response-text')) {
                 node.remove();
            }
        });
        messageElement.appendChild(contentDiv);
    }
    
    // Render Markdown into the .message-content div
    if (md && typeof md.render === 'function') {
        contentDiv.innerHTML = md.render(String(messageText || "")); // Ensure text is a string
    } else {
        contentDiv.innerHTML = escapeHtml(String(messageText || "")).replace(/\n/g, '<br>'); // Basic fallback
    }
    
    // Apply KaTeX rendering to the .message-content div
    renderLatexInElement(contentDiv);

    // Apply code highlighting if hljs is available (markdown-it's highlight function should handle pre/code)
    // However, if a custom setup or direct HTML was injected, this can be a safeguard.
    if (window.hljs) {
        try {
            contentDiv.querySelectorAll('pre code').forEach((block) => {
                if (!block.classList.contains('hljs-highlighted')) { // Avoid re-highlighting
                    window.hljs.highlightElement(block);
                    block.classList.add('hljs-highlighted');
                }
            });
        } catch (e) {
            console.error("Error applying manual code highlighting:", e);
        }
    }
    // No return needed as it modifies element directly
}


function initAllFeatures() {
    console.log("--- Initializing All Features ---");
    const tokenMeta = document.querySelector('meta[name="token"]');
    if (tokenMeta?.content) TOKEN = tokenMeta.content; else console.warn('Token meta tag missing.');

    initMarkdownRenderer(); // Initialize markdown-it first

    initBaseButtonHandlers(); 
    initTabs(); 
    initScreenshotAnalysisHandlers(); 
    initAiChatHandlers(); 
    initVoiceAnswerHandlers(); 
    initSocketIO(); // Socket.IO after other UI elements are ready

    // Initial KaTeX render for any pre-existing static content if necessary.
    // Dynamic content (like chat messages) will be rendered when added.
    setTimeout(() => {
        if (typeof window.renderMathInElement === 'function') {
            // debugLog("Performing initial full-body KaTeX render pass (delayed)...");
            // renderLatexInElement(document.body); // Could be too broad, better to target specific areas if needed.
        } else {
            console.warn("KaTeX auto-render (renderMathInElement) not available for initial pass.");
        }
    }, 1500); 
    console.log("--- Application initialization complete ---");
}

document.addEventListener('DOMContentLoaded', initAllFeatures);

// Touch active state for buttons for better mobile UX
document.addEventListener('DOMContentLoaded', ()=>{ const btns=document.querySelectorAll('button,.btn,.tab-item');btns.forEach(b=>{let touchTimer;const clearTimer=()=>{if(touchTimer){clearTimeout(touchTimer);touchTimer=null;this.classList.remove('touch-active');}};b.addEventListener('touchstart',function(){this.classList.add('touch-active');touchTimer=setTimeout(clearTimer,300);},{passive:true});b.addEventListener('touchend',clearTimer);b.addEventListener('touchcancel',clearTimer);});if(!document.querySelector('style#touch-active-style')){const s=document.createElement('style');s.id='touch-active-style';s.textContent='.touch-active{opacity:0.7 !important; transform:scale(0.98) !important;}';document.head.appendChild(s);}});

function saveChatSessionsToStorage() { try {localStorage.setItem('chatSessions',JSON.stringify(chatSessions));}catch(e){console.error("Failed to save chat sessions:",e);} }
function loadChatSessionsFromStorage() {
    try {
        const saved = localStorage.getItem('chatSessions');
        if (saved) {
            chatSessions = JSON.parse(saved);
            const listEl = document.getElementById('chat-session-list');
            if (listEl) { listEl.innerHTML = ''; chatSessions.sort((a,b)=>(b.id||0)-(a.id||0)).forEach(addChatHistoryItem); }
            // Check if there's an active session ID stored and try to restore it
            const lastSessionId = localStorage.getItem('currentChatSessionId');
            if (lastSessionId && chatSessions.find(s => s.id === Number(lastSessionId))) {
                currentChatSessionId = Number(lastSessionId);
                const activeSessionItem = listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`);
                if (activeSessionItem) activeSessionItem.click(); // Simulate click to load history
                else clearCurrentChatDisplay();
            } else {
                 clearCurrentChatDisplay();
            }
        } else { clearCurrentChatDisplay(); }
    } catch (e) { console.error("Failed to load chat sessions:", e); chatSessions=[]; clearCurrentChatDisplay(); }
}
// Save currentChatSessionId as well
function saveCurrentChatSessionId() {
    if (currentChatSessionId) {
        localStorage.setItem('currentChatSessionId', currentChatSessionId);
    } else {
        localStorage.removeItem('currentChatSessionId');
    }
}
// Modify addChatHistoryItem and clearCurrentChatDisplay to call saveCurrentChatSessionId
// (This part is assumed to be handled if logic for currentChatSessionId saving is added)


function generateUUID(){return'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{var r=Math.random()*16|0,v=c=='x'?r:(r&0x3|0x8);return v.toString(16);});}
function removeThinkingIndicator(chatHistoryEl,aiThinkingDiv){if(aiThinkingDiv){if(aiThinkingDiv.parentNode===chatHistoryEl)chatHistoryEl.removeChild(aiThinkingDiv);else if(aiThinkingDiv.parentNode)aiThinkingDiv.parentNode.removeChild(aiThinkingDiv);else try{aiThinkingDiv.remove()}catch(e){console.warn("Failed to remove thinking indicator directly:",e);}}}

// The original content's specific socket event handlers for 'new_message', 'chat_stream', 'chat_stream_end'
// were integrated into the main initSocketIO function above using handleAiResponseMessage and processAIMessage.
// The duplicate DOMContentLoaded listener for markdown-it init is also covered by initAllFeatures.