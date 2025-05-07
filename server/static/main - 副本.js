/**
 * main.js
 *
 * Frontend JavaScript logic for the AI Assistant Dashboard.
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
// let conversationHistory = []; // Replaced by session-based history
let mediaRecorder; // For voice recording
let audioChunks = []; // Store audio data chunks
let chatSessions = []; // Stores all chat session objects {id, title, history}
let currentChatSessionId = null; // ID of the currently active session

// --- Utility Functions ---

/** Simple console logging wrapper. */
function debugLog(message) {
    console.log(`[DEBUG] ${message}`);
}

/** Formats file size. */
function formatFileSize(bytes) {
    if (bytes < 0) return 'Invalid size';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)));
    // Ensure at least one decimal place for KB and above, unless it's exactly 0
    const fixed = (i === 0) ? 0 : 1;
    return parseFloat((bytes / Math.pow(k, i)).toFixed(fixed)) + ' ' + sizes[i];
}


/** Scrolls a chat history element to the bottom. */
function scrollToChatBottom(chatHistoryEl) {
    if (chatHistoryEl) {
        // Use requestAnimationFrame for smoother scrolling after content update
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
        // Truncate long filenames in preview
        const displayName = file.name.length > 40 ? file.name.substring(0, 37) + '...' : file.name;
        previewItem.innerHTML = `
            <div class="file-info" title="${file.name}">
                <i class="fas fa-file"></i>
                <span>${displayName} (${formatFileSize(file.size)})</span>
            </div>
            <button type="button" class="remove-file" title="取消选择此文件"><i class="fas fa-times"></i></button>
        `;
        const removeBtn = previewItem.querySelector('.remove-file');
        removeBtn.onclick = () => {
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


// --- Socket.IO Initialization ---
function initSocketIO() {
    debugLog('Initializing Socket.IO connection...');
    const baseUrl = window.API_BASE_URL || window.location.origin;
    debugLog(`Using base URL: ${baseUrl}`);

    socket = io(baseUrl, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 20000
    });

    // --- Connection Event Handlers ---
    socket.on('connect', () => {
        debugLog('Socket.IO Connected');
        updateConnectionStatus(true);
        getApiInfo(); // Get API info on connect
        // Optional: Request initial history if needed, e.g., for screenshots
        debugLog('Requesting initial screenshot history...');
        socket.emit('request_history'); // Assuming server listens for this
    });

    socket.on('disconnect', (reason) => {
        debugLog(`Socket.IO Disconnected: ${reason}`);
        updateConnectionStatus(false);
    });

    socket.on('connect_error', (error) => {
        debugLog(`Socket.IO Connection Error: ${error.message}`);
        updateConnectionStatus(false);
    });

    // --- Custom Application Event Handlers ---

    // Screenshot & Analysis Events
    socket.on('capture', () => {
        debugLog("Received 'capture' event - Screenshot requested by server.");
        alert("服务器请求截图 (客户端功能待实现)"); // Placeholder
    });

    socket.on('new_screenshot', (data) => {
        debugLog(`Received 'new_screenshot' event: ${JSON.stringify(data)}`);
        addHistoryItem(data); // Updates ss-history-list
    });

    socket.on('analysis_result', (data) => {
        debugLog(`Received 'analysis_result' event: ${JSON.stringify(data)}`);
        const analysisEl = document.getElementById('ss-ai-analysis');
        if (analysisEl && data && data.analysis) {
            // Use setTimeout to potentially avoid race conditions if updates happen too quickly
            setTimeout(() => {
                debugLog(`Attempting to update #ss-ai-analysis for ${data.image_url || 'unknown image'}`);
                analysisEl.textContent = data.analysis;
                if (data.image_url) {
                    analysisEl.dataset.sourceUrl = data.image_url;
                }
                debugLog(`Updated #ss-ai-analysis.`);
            }, 100); // Small delay
        } else {
            console.warn("Received 'analysis_result' but couldn't update UI/invalid data.", data);
        }
    });

    socket.on('analysis_error', (errorData) => {
        console.error(`Received 'analysis_error' event for ${errorData?.image_url}: ${errorData?.error}`);
        alert(`AI分析图片 ${errorData?.image_url || ''} 时发生错误: ${errorData?.error || '未知错误'}`);
        // Optionally update the analysis area with the error
        const analysisEl = document.getElementById('ss-ai-analysis');
        if(analysisEl && analysisEl.dataset.sourceUrl === errorData?.image_url) {
            analysisEl.textContent = `分析失败: ${errorData?.error || '未知错误'}`;
        }
    });

    // Screenshot History Event (Initial Load)
    socket.on('history', (historyData) => {
        debugLog(`Received 'history' event with ${historyData.length} screenshot items.`);
        const historyListEl = document.getElementById('ss-history-list');
        if(historyListEl) {
            historyListEl.innerHTML = ''; // Clear existing list
            // Sort history data by timestamp descending before adding
            historyData.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            historyData.forEach(item => addHistoryItem(item));
            debugLog("Screenshot history list populated.");
        }
    });

    // API Info Event
    socket.on('api_info', (apiData) => {
        debugLog(`Received 'api_info' event: ${JSON.stringify(apiData)}`);
        updateApiInfo(apiData);
    });

    // Chat Events (Response managed per session now)
    socket.on('chat_response', function(data) {
        console.log('Received chat_response:', data);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        const aiThinkingDiv = chatHistoryEl?.querySelector('.ai-thinking');

        if (aiThinkingDiv && chatHistoryEl) {
            chatHistoryEl.removeChild(aiThinkingDiv);
        } else if (aiThinkingDiv) {
            aiThinkingDiv.remove();
        }

        let activeSession = null;
        if (currentChatSessionId) {
            activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        }

        if (!activeSession) {
            console.error("Received chat response but no active session found. Message lost from history.", data);
        }

        const aiMessageText = data.message || '(AI没有返回消息)';
        const aiProvider = data.provider || '未知';

        if (activeSession) {
            const aiMessageForHistory = { role: 'model', parts: [{ text: aiMessageText }] };
            activeSession.history.push(aiMessageForHistory);
            debugLog(`AI Response added to history for session ${currentChatSessionId}`);
            saveChatSessionsToStorage();
        }

        if (chatHistoryEl) {
            const aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.innerHTML = `<strong>AI (${aiProvider}):</strong> `;
            
            // 创建一个容器来放置消息内容，而不是直接使用 textContent
            const messageContainer = document.createElement('div');
            messageContainer.className = 'message-content';
            
            // 使用 innerHTML 而不是 textContent，这样 LaTeX 标记不会被转义
            // 但首先需要处理可能的 HTML 标签以防止 XSS
            const safeMessage = aiMessageText
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                // 保留换行符
                .replace(/\n/g, '<br>');
            
            messageContainer.innerHTML = safeMessage;
            aiDiv.appendChild(messageContainer);
            chatHistoryEl.appendChild(aiDiv);
            scrollToChatBottom(chatHistoryEl);
            
            // 在添加消息后渲染 LaTeX
            console.log("Rendering LaTeX after adding AI message");
            setTimeout(() => renderMathWithKaTeX(aiDiv), 100);
        }
        // 在消息添加到 DOM 后安全地尝试渲染 LaTeX
        setTimeout(safeRenderMath, 200);
    });

    // Voice Events
    socket.on('stt_result', (data) => {
        debugLog(`Received 'stt_result': ${JSON.stringify(data)}`);
        // Optional: Display intermediate result
        // const voiceResultEl = document.getElementById('voice-result');
        // if (voiceResultEl && data.transcript) {
        //      voiceResultEl.innerHTML = `<div><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> ${data.transcript}</div><hr><div><i>AI正在思考...</i></div>`;
        // }
    });

    socket.on('voice_chat_response', (data) => {
        debugLog(`Received 'voice_chat_response': ${JSON.stringify(data)}`);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data) {
            const transcript = data.transcript || '无法识别';
            const aiResponse = data.message || '无回答'; // Server sends AI response in 'message'
            voiceResultEl.innerHTML = `
                <div style="margin-bottom: 0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> ${transcript}</div>
                <hr>
                <div><strong><i class="fas fa-robot"></i> AI回答:</strong> ${aiResponse}</div>
            `;
            addVoiceHistoryItem({ transcript: transcript, response: aiResponse }); // Add to history
        } else {
            console.warn("Received 'voice_chat_response' but couldn't update UI/invalid data.", data);
        }
        const startBtn = document.getElementById('voice-start-recording');
        const stopBtn = document.getElementById('voice-stop-recording');
        if(startBtn) startBtn.disabled = false;
        if(stopBtn) stopBtn.disabled = true;
    });

    socket.on('stt_error', (errorData) => {
        console.error(`Received 'stt_error': ${JSON.stringify(errorData)}`);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            voiceResultEl.textContent = `语音识别失败: ${errorData.error || '未知错误'}`;
        }
        const startBtn = document.getElementById('voice-start-recording');
        const stopBtn = document.getElementById('voice-stop-recording');
        if(startBtn) startBtn.disabled = false;
        if(stopBtn) stopBtn.disabled = true;
    });

    socket.on('chat_error', (errorData) => { // Generic chat error, could be from voice task
        console.error(`Received 'chat_error': ${JSON.stringify(errorData)}`);
        const voiceResultEl = document.getElementById('voice-result');
        // Check if the error belongs to the voice tab, maybe based on a request_id if added?
        // For now, display in voice area if received.
        if (voiceResultEl && document.getElementById('voice-answer').classList.contains('active')) {
            voiceResultEl.textContent = `AI 处理失败: ${errorData.message || '未知错误'}`;
            const startBtn = document.getElementById('voice-start-recording');
            const stopBtn = document.getElementById('voice-stop-recording');
            if(startBtn) startBtn.disabled = false;
            if(stopBtn) stopBtn.disabled = true;
        }
        // Also check if it belongs to chat tab? Difficult without context ID.
        // If it's a general chat error, it might also need to remove thinking indicator in chat
        const chatHistoryEl = document.getElementById('chat-chat-history');
        const aiThinkingDiv = chatHistoryEl?.querySelector('.ai-thinking');
        if (aiThinkingDiv && errorData.request_id && aiThinkingDiv.dataset.requestId === errorData.request_id) {
             removeThinkingIndicator(chatHistoryEl, aiThinkingDiv);
             const errorDiv = document.createElement('div');
             errorDiv.className = 'ai-message error-message';
             errorDiv.innerHTML = `<strong>系统错误:</strong> <span>处理消息失败: ${errorData.message || '未知错误'}</span>`;
             chatHistoryEl.appendChild(errorDiv);
             scrollToChatBottom(chatHistoryEl);
        } else if (aiThinkingDiv && !errorData.request_id && document.getElementById('ai-chat').classList.contains('active')) {
            // Generic error display if no request_id match but chat tab is active
            removeThinkingIndicator(chatHistoryEl, aiThinkingDiv);
            const errorDiv = document.createElement('div');
            errorDiv.className = 'ai-message error-message';
            errorDiv.innerHTML = `<strong>系统错误:</strong> <span>处理消息失败: ${errorData.message || '未知错误'}</span>`;
            chatHistoryEl.appendChild(errorDiv);
            scrollToChatBottom(chatHistoryEl);
        }
    });

    socket.on('task_error', (errorData) => { // General task error
        console.error(`Received 'task_error': ${JSON.stringify(errorData)}`);
        // Determine which tab the error belongs to if possible, otherwise show generic alert
        alert(`后台任务出错: ${errorData.error || '未知错误'}`);
        // Reset voice buttons just in case
        const startBtn = document.getElementById('voice-start-recording');
        const stopBtn = document.getElementById('voice-stop-recording');
        if(startBtn) startBtn.disabled = false;
        if(stopBtn) stopBtn.disabled = true;
    });

    // 添加流式响应处理
    socket.on('chat_stream_chunk', (data) => {
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
            aiDiv.innerHTML = `<strong>${providerName}:</strong> <span class="ai-response-text">${data.chunk}</span>`;
            aiDiv.dataset.requestId = data.request_id; // 存储请求 ID 以便后续更新
            chatHistoryEl.replaceChild(aiDiv, aiThinkingDiv);
        } else {
            // 查找现有的 AI 消息元素并追加内容
            let aiDiv = chatHistoryEl?.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
            if (aiDiv) {
                const textSpan = aiDiv.querySelector('.ai-response-text');
                if (textSpan) {
                    textSpan.textContent += data.chunk;
                }
            } else {
                // 如果找不到现有元素（不应该发生，但作为后备），创建一个新的
                // This case might happen if the 'ai-thinking' was somehow removed by another path
                // or if stream starts without 'ai-thinking' (e.g. reconnect)
                debugLog("Stream chunk received, but no existing AI message div found. Creating new one.");
                const newAiDiv = document.createElement('div');
                newAiDiv.className = 'ai-message';
                const providerName = data.provider || 'AI';
                newAiDiv.innerHTML = `<strong>${providerName}:</strong> <span class="ai-response-text">${data.chunk}</span>`;
                newAiDiv.dataset.requestId = data.request_id;
                chatHistoryEl.appendChild(newAiDiv);
                aiDiv = newAiDiv; // For scrolling
            }
        }
        
        scrollToChatBottom(chatHistoryEl);
    });

    // 处理流式响应结束事件
    socket.on('chat_stream_end', function(data) {
        console.log('Received chat_stream_end:', data);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        
        // 查找当前活动的聊天会话
        let activeSession = null;
        if (currentChatSessionId) {
            activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        }
        
        // 将完整消息添加到历史记录
        if (activeSession) {
            // Ensure the full message and provider are correctly used/updated
            const finalMessageText = data.full_message || "";
            const provider = data.provider || 'AI'; // Get provider from end stream if available

            // Update the displayed message with the provider from the stream end data, if different
            const aiDiv = chatHistoryEl?.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
            if(aiDiv) {
                const strongTag = aiDiv.querySelector('strong');
                if (strongTag && strongTag.textContent !== `${provider}:`) {
                    strongTag.textContent = `${provider}:`;
                }
                // Also ensure the text content is the full message if it somehow differs
                const textSpan = aiDiv.querySelector('.ai-response-text');
                if (textSpan && textSpan.textContent !== finalMessageText) {
                    textSpan.textContent = finalMessageText;
                }
            }

            const aiMessageForHistory = { role: 'model', parts: [{ text: finalMessageText }] };
            // Prevent adding duplicate history entries if logic is complex
            // This assumes the last message in history is the one being potentially duplicated or needs update.
            // A more robust way would be to mark history entries with request_id if possible.
            // For now, simple push assuming `chat_response` non-streaming handler isn't also firing.
            if (!activeSession.history.find(msg => msg.role === 'model' && msg.parts[0].text === finalMessageText && !msg.temp_id)) {
                 // Check if last model message was a partial one from a previous chunk and update it, or add new.
                let lastModelMessage = activeSession.history.length > 0 ? activeSession.history[activeSession.history.length -1] : null;
                if(lastModelMessage && lastModelMessage.role === 'model' && lastModelMessage.temp_id === data.request_id) {
                    lastModelMessage.parts = [{ text: finalMessageText }];
                    delete lastModelMessage.temp_id; // Finalize it
                } else {
                    activeSession.history.push(aiMessageForHistory);
                }
            }

            debugLog(`AI Response (streamed) added/updated in history for session ${currentChatSessionId}`);
            saveChatSessionsToStorage();
        }
        
        // 在流式响应结束后渲染 LaTeX
        const aiDiv = chatHistoryEl?.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);
        if (aiDiv) {
            console.log("Rendering LaTeX after stream end");
            setTimeout(() => renderMathWithKaTeX(aiDiv), 100); // 短暂延迟确保 DOM 已更新
        }
        
        // 确保滚动到底部
        scrollToChatBottom(chatHistoryEl);
        // 在流式响应完成后安全地尝试渲染 LaTeX
        setTimeout(safeRenderMath, 200);
    });
} // End of initSocketIO

/** Sends chat message to AI. Handles new session creation. */
function sendChatMessage() {
    debugLog("Attempting to send chat message...");
    const chatInputEl = document.getElementById('chat-chat-input');
    const chatHistoryEl = document.getElementById('chat-chat-history');
    const uploadPreviewEl = document.getElementById('chat-upload-preview');
    const fileInputEl = document.getElementById('chat-file-upload'); // Make sure this ID is correct in HTML

    if (!chatInputEl || !chatHistoryEl) {
        console.error("Chat input or history element not found.");
        return;
    }

    const message = chatInputEl.value.trim();
    const currentFileToSend = uploadedFile; // Use the global 'uploadedFile'

    if (!message && !currentFileToSend) {
        debugLog("Empty message and no file, not sending.");
        return;
    }

    let activeSession = null;

    // --- Session Handling (New or Existing) ---
    if (!currentChatSessionId) { // Start new session
        const newSessionId = Date.now(); // Simple unique ID for session
        let sessionTitle = message.substring(0, 30) || (currentFileToSend ? `Chat with ${currentFileToSend.name.substring(0, 20)}` : 'New Chat');
        if (message.length > 30 && message.substring(0,30) !== message) sessionTitle += "...";
        else if (currentFileToSend && currentFileToSend.name.length > 20 && `Chat with ${currentFileToSend.name.substring(0,20)}` !== sessionTitle) sessionTitle += "...";


        activeSession = { id: newSessionId, title: sessionTitle, history: [] };
        chatSessions.push(activeSession);
        // Sort sessions by ID (timestamp) descending before adding to ensure new one is at top
        chatSessions.sort((a, b) => b.id - a.id); 
        addChatHistoryItem(activeSession); // Adds to UI list (and this function should handle correct placement)
        currentChatSessionId = newSessionId;
        debugLog(`New chat session created: ${newSessionId} with title "${sessionTitle}"`);

        // Highlight the new session in the list
        // addChatHistoryItem prepends, so it should be the first.
        // The active class is usually set when clicking or by addChatHistoryItem itself if it's the only one.
        // Let's ensure it's correctly highlighted.
        setTimeout(() => {
            const listEl = document.getElementById('chat-session-list');
            listEl?.querySelectorAll('.history-item.active-session')?.forEach(item => item.classList.remove('active-session'));
            const newSessionElement = listEl?.querySelector(`[data-session-id="${activeSession.id}"]`);
            newSessionElement?.classList.add('active-session');
        }, 100); // Timeout to allow DOM update

        if (chatHistoryEl) {
             if (chatHistoryEl.textContent.includes("选择左侧记录或开始新对话...") || chatHistoryEl.innerHTML.includes("system-message")) {
                chatHistoryEl.innerHTML = ''; // Clear "Select session..." placeholder
            }
        }
    } else { // Continue existing session
        activeSession = chatSessions.find(s => s.id === currentChatSessionId);
        if (!activeSession) {
            console.error("Active session not found! ID:", currentChatSessionId);
            alert("错误：找不到当前对话会话。请尝试开始新对话。");
            clearCurrentChatDisplay();
            return;
        }
        debugLog(`Continuing chat session: ${currentChatSessionId}`);
    }

    // --- Add User Message to History (for the active session) ---
    const userParts = [];
    if (message) {
        userParts.push({ text: message });
    }
    // If a file is being sent, the backend will handle it.
    // For history, we include the text prompt. If no text, maybe a placeholder.
    const historyMessageText = message || (currentFileToSend ? `[用户上传了文件: ${currentFileToSend.name}]` : "");

    if (historyMessageText || currentFileToSend) { // Only add if there's something to add
        const userMessageForHistory = { role: 'user', parts: [{ text: historyMessageText }] };
        // If file is involved and Gemini expects specific format, adjust here.
        // Example: if (currentFileToSend) userMessageForHistory.parts.push({ fileData: ...})
        // But current code sends file separately via HTTP POST.
        activeSession.history.push(userMessageForHistory);
    }


    // --- Add User Message to Display ---
    const userDiv = document.createElement('div');
    userDiv.className = 'user-message';
    let userContentHTML = `<strong>您:</strong> `;
    if (message) {
        const messageNode = document.createElement('span');
        messageNode.textContent = message;
        userContentHTML += messageNode.outerHTML; // Use outerHTML to keep span for structure, or just textContent
    } else if (currentFileToSend) { // Only show file info if no text message
        userContentHTML += `(发送文件)`;
    }

    if (currentFileToSend) {
        const fileNameNode = document.createElement('span');
        fileNameNode.textContent = currentFileToSend.name;
        // Add a line break if there's also a text message
        if (message) userContentHTML += "<br>";
        userContentHTML += `<div class="attached-file" title="${currentFileToSend.name}"><i class="fas fa-paperclip"></i> ${fileNameNode.outerHTML} (${formatFileSize(currentFileToSend.size)})</div>`;
    }
    userDiv.innerHTML = userContentHTML;

    if (chatHistoryEl.textContent.includes("选择左侧记录或开始新对话...") || chatHistoryEl.innerHTML.includes("system-message")) {
        chatHistoryEl.innerHTML = '';
    }
    chatHistoryEl.appendChild(userDiv);
    scrollToChatBottom(chatHistoryEl);

    // --- Clear Inputs ---
    if (chatInputEl) chatInputEl.value = '';
    if (uploadPreviewEl) uploadPreviewEl.innerHTML = '';
    uploadedFile = null; // Reset global uploadedFile
    if (fileInputEl) fileInputEl.value = ''; // Reset the actual file input field

    // --- Show Thinking Indicator ---
    const aiThinkingDiv = document.createElement('div');
    aiThinkingDiv.className = 'ai-message ai-thinking';
    const requestIdForThinking = generateUUID(); // For matching stream if used
    aiThinkingDiv.dataset.requestId = requestIdForThinking;
    aiThinkingDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI正在思考...';
    chatHistoryEl.appendChild(aiThinkingDiv);
    scrollToChatBottom(chatHistoryEl);

    // --- Determine Streaming ---
    const streamingToggle = document.getElementById('streaming-toggle-checkbox');
    const shouldUseStreaming = streamingToggle ? streamingToggle.checked : true;

    let historyToSend = [...activeSession.history];
    // Remove the last message if it's the one we just added (user's current message)
    // The server usually expects history *before* the current prompt.
    // However, Gemini API often expects history to *include* the user's latest message.
    // The provided code keeps the user message in `historyToSend`. Let's stick to that.

    if (currentFileToSend) {
        // File upload uses HTTP POST
        const formData = new FormData();
        formData.append('prompt', message); // Send the text prompt along with the file
        formData.append('file', currentFileToSend, currentFileToSend.name);
        formData.append('history', JSON.stringify(historyToSend.slice(0, -1))); // Send history *before* current message for file uploads
        formData.append('use_streaming', false); // File upload responses are typically not streamed in this setup
        formData.append('session_id', activeSession.id); // Send session ID
        formData.append('request_id', requestIdForThinking); // Send request ID for matching response


        fetch('/chat_with_file', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TOKEN}` },
            body: formData
        })
        .then(response => {
            debugLog(`Chat with file response status: ${response.status}`);
            if (!response.ok) {
                return response.json().catch(() => ({
                    error: `HTTP error ${response.status} (${response.statusText})`
                })).then(errData => {
                    throw new Error(errData.message || errData.error || `HTTP error ${response.status}`);
                });
            }
            return response.json();
        })
        .then(data => {
            debugLog(`Chat with file request acknowledged: ${JSON.stringify(data)}`);
            // Response will be handled by 'chat_response' socket event if server sends it that way
            // OR the fetch directly returns the AI response. If direct, update UI here.
            // Assuming server sends a socket event, so no direct UI update here for AI response.
            // If server returns response directly in 'data':
            if (data && data.message) {
                 removeThinkingIndicator(chatHistoryEl, aiThinkingDiv);
                 const aiMessageText = data.message || '(AI没有返回消息)';
                 const aiProvider = data.provider || '未知';
                 const aiMessageForHistory = { role: 'model', parts: [{ text: aiMessageText }] };
                 activeSession.history.push(aiMessageForHistory);
                 saveChatSessionsToStorage();

                 const aiDiv = document.createElement('div');
                 aiDiv.className = 'ai-message';
                 aiDiv.innerHTML = `<strong>AI (${aiProvider}):</strong> `;
                 const aiMessageNode = document.createElement('span');
                 aiMessageNode.textContent = aiMessageText;
                 aiDiv.appendChild(aiMessageNode);
                 chatHistoryEl.appendChild(aiDiv);
                 scrollToChatBottom(chatHistoryEl);
            } else if (data && data.request_id) {
                // Server acknowledged, waiting for socket event.
            }
        })
        .catch(err => {
            console.error('Chat with file request error:', err);
            removeThinkingIndicator(chatHistoryEl, aiThinkingDiv);
            const errorDiv = document.createElement('div');
            errorDiv.className = 'ai-message error-message';
            errorDiv.innerHTML = `<strong>系统错误:</strong> <span>发送消息失败: ${err.message}</span>`;
            chatHistoryEl.appendChild(errorDiv);
            scrollToChatBottom(chatHistoryEl);
            // Remove user message from history if send failed catastrophically?
            // activeSession.history.pop(); // Consider this
        });
    } else {
        // Pure text聊天使用 Socket.IO
        // const requestId = generateUUID(); // Already generated as requestIdForThinking

        socket.emit('chat_message', {
            prompt: message,
            history: historyToSend, // Includes current user message
            request_id: requestIdForThinking,
            use_streaming: shouldUseStreaming,
            session_id: activeSession.id // Send session ID
        });
        debugLog(`Sent chat_message via Socket.IO (streaming: ${shouldUseStreaming}, request_id: ${requestIdForThinking})`);
        if (shouldUseStreaming) {
            // Add a temporary message to history for streaming, to be replaced by full message on 'chat_stream_end'
            // This helps if 'chat_stream_end' needs to update/replace an entry.
            // activeSession.history.push({ role: 'model', parts: [{ text: "" }], temp_id: requestIdForThinking });
        }
    }
    saveChatSessionsToStorage(); // Save session history after user turn
}


/** Send selected crop area for analysis. */
function confirmCrop() {
    debugLog('Confirming crop selection...');
    if (!currentImage) { console.error('No current image for cropping.'); alert('错误：没有当前图片。'); return; }
    const overlayImageEl = document.getElementById('overlay-image');
    if (!overlayImageEl || !overlayImageEl.naturalWidth) { console.error('Overlay image not loaded.'); alert('错误：图片未加载。'); return; }

    const scaleX = overlayImageEl.naturalWidth / overlayImageEl.width;
    const scaleY = overlayImageEl.naturalHeight / overlayImageEl.height;
    const originalSelection = {
        x: Math.round(selection.x * scaleX), y: Math.round(selection.y * scaleY),
        width: Math.round(selection.width * scaleX), height: Math.round(selection.height * scaleY)
    };
    debugLog(`Calculated original crop area: ${JSON.stringify(originalSelection)}`);

    const formData = new FormData();
    formData.append('image_url', currentImage);
    formData.append('x', originalSelection.x);
    formData.append('y', originalSelection.y);
    formData.append('width', originalSelection.width);
    formData.append('height', originalSelection.height);
    const promptInputEl = document.getElementById('prompt-input');
    const customPrompt = promptInputEl ? promptInputEl.value.trim() : '';
    if (customPrompt) { formData.append('prompt', customPrompt); }


    const aiAnalysisEl = document.getElementById('ss-ai-analysis');
    if (aiAnalysisEl) aiAnalysisEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在分析裁剪区域...';
    hideImageOverlay();

    fetch('/crop_image', { method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: formData })
    .then(response => {
        debugLog(`Crop request response status: ${response.status}`);
        if (!response.ok) { return response.json().catch(() => ({ error: `HTTP error ${response.status}` })).then(errData => { throw new Error(errData.error || `HTTP error ${response.status}`); }); }
        // return response.status; // Or response.json() if server sends back useful info
        return response.json(); // Assuming server might send back task ID or immediate small result
    })
    .then(data => {
        debugLog(`Crop request acknowledged: ${JSON.stringify(data)}`);
        debugLog('Crop HTTP request finished. Waiting for analysis result via Socket.IO...');
        // Analysis result display is handled by the 'analysis_result' socket listener
    })
    .catch(err => {
        console.error('Crop request error:', err);
        alert('处理裁剪图片时出错: ' + err.message);
        if (aiAnalysisEl) aiAnalysisEl.textContent = "分析失败: " + err.message;
    });
}


/** Fetch AI provider info. */
function getApiInfo() {
    if (!TOKEN) { console.warn('TOKEN not set, cannot get API info'); updateApiInfo({ provider: '未知 (Token未设置)' }); return; }
    debugLog('Fetching API provider info...');
    fetch('/api_info', { headers: { 'Authorization': `Bearer ${TOKEN}` } })
    .then(response => { if (response.status === 401) throw new Error('Unauthorized'); if (!response.ok) throw new Error(`获取API信息失败 (${response.status})`); return response.json(); })
    .then(data => { updateApiInfo(data); })
    .catch(err => { console.error('Error fetching API info:', err); updateApiInfo({ provider: `错误 (${err.message})` }); });
}


/** Sends recorded audio blob to the server. */
function sendVoiceToServer(audioBlob) {
    debugLog(`Sending voice data (${formatFileSize(audioBlob.size)})...`);
    const formData = new FormData();
    formData.append('audio', audioBlob, `recording_${Date.now()}.wav`); // Ensure .wav or appropriate extension

    const voiceResultEl = document.getElementById('voice-result');
    if (voiceResultEl) voiceResultEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在处理语音...';

    fetch('/process_voice', {
        method: 'POST',
        body: formData,
        headers: { 'Authorization': `Bearer ${TOKEN}` }
    })
    .then(response => {
        debugLog(`Process voice response status: ${response.status}`);
        if (!response.ok) {
            return response.json().catch(() => ({ error: `HTTP error ${response.status}` })).then(errData => {
                throw new Error(errData.message || errData.error || `HTTP error ${response.status}`);
            });
        }
        // return { status: response.status, ok: response.ok }; // Return status
        return response.json(); // Assume server sends back task ID or acknowledgement
    })
    .then(data => {
        debugLog(`Voice upload acknowledged: ${JSON.stringify(data)}`);
        // Final result display is handled by 'voice_chat_response' socket listener
    })
    .catch(err => {
        console.error('Error processing voice upload request:', err);
        if (voiceResultEl) {
            voiceResultEl.textContent = '处理语音请求失败: ' + err.message;
        }
        const startBtn = document.getElementById('voice-start-recording');
        const stopBtn = document.getElementById('voice-stop-recording');
        if(startBtn) startBtn.disabled = false;
        if(stopBtn) stopBtn.disabled = true;
    });
}

// --- UI Update Functions ---

/** Adds item to screenshot history list. */
function addHistoryItem(item) {
    const historyListEl = document.getElementById('ss-history-list');
    if (!historyListEl) { console.error('Screenshot history list element (#ss-history-list) not found.'); return; }
    if (!item || !item.image_url) { console.error('Invalid history item data:', item); return; }

    // Prevent adding duplicates
    if (historyListEl.querySelector(`[data-url="${item.image_url}"]`)) {
        debugLog(`History item for ${item.image_url} already exists. Skipping.`);
        return;
    }

    const li = document.createElement('li');
    li.className = 'history-item';
    li.setAttribute('data-url', item.image_url);

    const img = document.createElement('img');
    img.src = item.image_url + '?t=' + Date.now();
    img.alt = '历史截图';
    img.loading = 'lazy';
    img.onerror = () => {
        console.error(`Failed to load history image: ${img.src}`);
        li.innerHTML = `<div class="history-error">图片加载失败</div>`;
        const deleteBtnOnError = createDeleteButton(() => {
            if (confirm('确定要删除这个截图历史记录吗？')) {
                li.remove();
                // Optional: server-side delete
            }
        });
        li.appendChild(deleteBtnOnError);
    };

    const timestampDiv = document.createElement('div');
    timestampDiv.className = 'history-item-text';
    const date = item.timestamp ? new Date(item.timestamp * 1000) : new Date();
    timestampDiv.textContent = date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    timestampDiv.title = date.toLocaleString();

    const deleteBtn = createDeleteButton(() => {
        if (confirm('确定要删除这个截图历史记录吗？')) {
            // Optional: Send request to server to delete file/record
            // Example: socket.emit('delete_screenshot_history', { image_url: item.image_url });
            li.remove();
            debugLog(`Removed screenshot history item UI for: ${item.image_url}`);
            const analysisEl = document.getElementById('ss-ai-analysis');
            if (analysisEl && analysisEl.dataset.sourceUrl === item.image_url) {
                analysisEl.textContent = '请在左侧点击历史记录查看分析结果...';
                delete analysisEl.dataset.sourceUrl;
            }
        }
    });

    li.appendChild(img);
    li.appendChild(timestampDiv);
    li.appendChild(deleteBtn);

    li.onclick = (e) => {
        if (e.target.closest('.delete-history')) return;

        debugLog(`History item clicked: ${item.image_url}`);
        showImageOverlay(item.image_url);
        const analysisEl = document.getElementById('ss-ai-analysis');
        if(analysisEl && item.analysis) {
            analysisEl.textContent = item.analysis;
            analysisEl.dataset.sourceUrl = item.image_url;
        } else if (analysisEl) {
            analysisEl.textContent = item.analysis === "" ? '(AI分析为空)' : '(无分析结果或正在加载)'; // Clarify if analysis is empty string
            // If analysis is pending, server should send 'analysis_result' or it should be fetched.
            // For now, if item.analysis is not present, we assume no result.
            // if (!item.analysis && socket.connected) { // Optionally request analysis if not present
            // socket.emit('request_analysis', { image_url: item.image_url });
            // analysisEl.textContent = '正在请求分析结果...';
            // }
            analysisEl.dataset.sourceUrl = item.image_url; // Still set source URL
        }
    };
    historyListEl.insertBefore(li, historyListEl.firstChild);
}

/** Adds item to voice history list. */
function addVoiceHistoryItem(item) {
    const voiceHistoryListEl = document.getElementById('voice-history-list');
    if (!voiceHistoryListEl) { console.error("Voice history list (#voice-history-list) not found."); return; }

    const li = document.createElement('li');
    li.className = 'history-item voice-history-item';
    const timestamp = new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    const transcript = item.transcript || '无法识别';
    const response = item.response || '无回答';

    li.innerHTML = `
        <div class="history-item-text">
            <div><strong><i class="fas fa-clock"></i> ${timestamp}</strong></div>
            <div title="${transcript}"><i class="fas fa-comment-dots"></i> ${transcript.substring(0, 30)}${transcript.length > 30 ? '...' : ''}</div>
        </div>
    `;

    const deleteBtn = createDeleteButton(() => {
        if (confirm('确定要删除这个语音历史记录吗？')) {
            li.remove();
            debugLog('Removed voice history item.');
        }
    });
    li.appendChild(deleteBtn);


    li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-history')) return;

        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            voiceResultEl.innerHTML = `
                <div style="margin-bottom: 0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong> ${transcript}</div>
                <hr>
                <div><strong><i class="fas fa-robot"></i> AI回答:</strong> ${response}</div>
            `;
        }
        voiceHistoryListEl.querySelectorAll('.history-item').forEach(i => i.classList.remove('active-session'));
        li.classList.add('active-session');
    });

    voiceHistoryListEl.insertBefore(li, voiceHistoryListEl.firstChild);
}

/** Adds a chat session item to the history list UI. */
function addChatHistoryItem(session) {
    const historyListEl = document.getElementById('chat-session-list');
    if (!historyListEl || !session) return;

    // Remove existing item for this session ID before adding, to prevent duplicates if re-adding/sorting
    const existingLi = historyListEl.querySelector(`[data-session-id="${session.id}"]`);
    if (existingLi) {
        existingLi.remove();
    }

    const li = document.createElement('li');
    li.className = 'history-item chat-history-item';
    li.setAttribute('data-session-id', session.id);

    const titleText = session.title || '无标题对话';
    const timestamp = new Date(session.id).toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });

    li.innerHTML = `
        <div class="history-item-text">
            <div title="${titleText}" style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <i class="fas fa-comment"></i> ${titleText}
            </div>
            <div style="font-size: 0.75em; color: #666;">${timestamp}</div>
        </div>
    `;

    const deleteBtn = createDeleteButton(() => {
        if (confirm(`确定要删除对话 "${titleText}" 吗？`)) {
            chatSessions = chatSessions.filter(s => s.id !== session.id);
            li.remove();
            debugLog(`Deleted chat session: ${session.id}`);
            if (currentChatSessionId === session.id) {
                clearCurrentChatDisplay(); // Resets currentChatSessionId and clears display
            }
            saveChatSessionsToStorage();
        }
    });
    li.appendChild(deleteBtn);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.delete-history')) return;

        const sessionId = li.getAttribute('data-session-id');
        // Ensure sessionId is treated as a number if session.id is a number
        const clickedSession = chatSessions.find(s => s.id.toString() === sessionId);


        if (clickedSession) {
            debugLog(`Loading chat session: ${sessionId}`);
            currentChatSessionId = clickedSession.id;
            renderChatHistory(clickedSession.history);

            historyListEl.querySelectorAll('.history-item').forEach(item => item.classList.remove('active-session'));
            li.classList.add('active-session');
        }
    });

    historyListEl.insertBefore(li, historyListEl.firstChild); // Add to top
}

/** Helper to create a delete button */
function createDeleteButton(onClickCallback) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-history';
    deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
    deleteBtn.title = '删除此项';
    deleteBtn.type = 'button';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        onClickCallback();
    };
    return deleteBtn;
}

/** Renders a chat history array into the chat display area. */
function renderChatHistory(historyArray) {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;
    chatHistoryEl.innerHTML = '';

    if (!historyArray || historyArray.length === 0) {
        chatHistoryEl.innerHTML = '<div class="system-message">对话内容为空...</div>';
        return;
    }

    historyArray.forEach(messageTurn => {
        const role = messageTurn.role;
        const parts = messageTurn.parts || [];
        let textContent = '';
        let fileInfoFromName = null; // For display from "[用户上传了文件: name]" tag

        parts.forEach(part => {
            if (part.text) {
                const cleanedText = part.text; // Keep original for display
                textContent += cleanedText + '\n';
                const fileMatch = cleanedText.match(/\[用户上传了文件: (.*?)\]/);
                if (fileMatch) {
                    fileInfoFromName = fileMatch[1];
                }
            }
        });
        textContent = textContent.trim();

        const messageDiv = document.createElement('div');
        if (role === 'user') {
            messageDiv.className = 'user-message';
            let userTextToDisplay = textContent.replace(/\[用户上传了文件:.*?\]\s*/g, '').trim();
            let userContentHTML = `<strong>您:</strong> `;

            const userTextNode = document.createElement('span');
            userTextNode.textContent = userTextToDisplay || (fileInfoFromName ? '(发送文件)' : '');
            userContentHTML += userTextNode.outerHTML;

            if (fileInfoFromName && !userTextToDisplay) { // If only file was "sent" via text tag
                 // userContentHTML += ` (文件: ${fileInfoFromName.length > 25 ? fileInfoFromName.substring(0, 22)+'...' : fileInfoFromName})`;
            } else if (fileInfoFromName && userTextToDisplay) { // If text accompanies the file tag
                 userContentHTML += `<br><div class="attached-file" title="${fileInfoFromName}"><i class="fas fa-paperclip"></i> (文件: ${fileInfoFromName.length > 25 ? fileInfoFromName.substring(0, 22)+'...' : fileInfoFromName})</div>`;
            }
            messageDiv.innerHTML = userContentHTML;

        } else if (role === 'model') {
            messageDiv.className = 'ai-message';
            // Provider info might be stored with the message turn or use a default
            const providerName = messageTurn.provider || 'AI';
            messageDiv.innerHTML = `<strong>${providerName}:</strong> `;
            const aiMessageNode = document.createElement('span');
            aiMessageNode.textContent = textContent;
            messageDiv.appendChild(aiMessageNode);
        } else {
            messageDiv.className = 'system-message';
            messageDiv.textContent = textContent;
        }
        chatHistoryEl.appendChild(messageDiv);
    });
    scrollToChatBottom(chatHistoryEl);
}


/** Show image overlay with cropping controls. */
function showImageOverlay(imageUrl) {
    const overlay = document.getElementById('overlay');
    const overlayImage = document.getElementById('overlay-image');
    const selectionBox = document.getElementById('selection-box');
    const cropInfo = document.getElementById('crop-info');

    if (!overlay || !overlayImage || !selectionBox || !cropInfo) {
        console.error('Overlay elements not found'); return;
    }
    debugLog('Showing image overlay: ' + imageUrl);

    currentImage = imageUrl;
    overlayImage.src = '';
    overlayImage.src = imageUrl + '?t=' + Date.now();
    overlay.style.display = 'flex';

    overlayImage.onload = () => {
        debugLog(`Overlay image loaded: ${overlayImage.naturalWidth}x${overlayImage.naturalHeight} (Displayed: ${overlayImage.width}x${overlayImage.height})`);
        selection = { x: 0, y: 0, width: overlayImage.width, height: overlayImage.height };
        updateSelectionBox();
        initSelectionControls(); // Re-init here to ensure listeners are on correct, visible elements
        cropInfo.textContent = '拖拽选框调整区域';
    };
    overlayImage.onerror = () => {
        console.error('Failed to load image into overlay:', imageUrl);
        alert('错误：无法加载图片预览。');
        hideImageOverlay();
    };
}


/** Hide image overlay. */
function hideImageOverlay() {
    debugLog('Hiding image overlay.');
    const overlayEl = document.getElementById('overlay');
    if (overlayEl) overlayEl.style.display = 'none';
    currentImage = null;
    const promptInputEl = document.getElementById('prompt-input');
    if(promptInputEl) promptInputEl.value = '';
}

/** Update selection box UI and info text. */
function updateSelectionBox() {
    const selectionBoxEl = document.getElementById('selection-box');
    const cropInfoEl = document.getElementById('crop-info');
    const overlayImageEl = document.getElementById('overlay-image');

    if (!selectionBoxEl || !cropInfoEl || !overlayImageEl || !overlayImageEl.width || !overlayImageEl.naturalWidth || overlayImageEl.naturalWidth === 0) {
         // If naturalWidth is 0, image might not be fully loaded or is invalid.
        return;
    }


    selection.x = Math.max(0, Math.min(selection.x, overlayImageEl.width));
    selection.y = Math.max(0, Math.min(selection.y, overlayImageEl.height));
    const minSize = 10;
    selection.width = Math.max(minSize, Math.min(selection.width, overlayImageEl.width - selection.x));
    selection.height = Math.max(minSize, Math.min(selection.height, overlayImageEl.height - selection.y));

    selectionBoxEl.style.left = `${selection.x}px`;
    selectionBoxEl.style.top = `${selection.y}px`;
    selectionBoxEl.style.width = `${selection.width}px`;
    selectionBoxEl.style.height = `${selection.height}px`;

    const scaleX = overlayImageEl.naturalWidth / overlayImageEl.width;
    const scaleY = overlayImageEl.naturalHeight / overlayImageEl.height;
    const originalX = Math.round(selection.x * scaleX);
    const originalY = Math.round(selection.y * scaleY);
    const originalWidth = Math.round(selection.width * scaleX);
    const originalHeight = Math.round(selection.height * scaleY);

    cropInfoEl.textContent = `选择区域 (原图): ${originalX}, ${originalY}, ${originalWidth}x${originalHeight}`;
}


/** Update connection status UI. */
function updateConnectionStatus(isConnected) {
    const indicatorEl = document.getElementById('connection-indicator');
    const statusTextEl = document.getElementById('connection-status');
    if (indicatorEl && statusTextEl) {
        indicatorEl.className = `status-indicator ${isConnected ? 'connected' : 'disconnected'}`;
        statusTextEl.textContent = `实时连接: ${isConnected ? '已连接' : '未连接'}`;
        indicatorEl.title = `Socket.IO ${isConnected ? 'Connected' : 'Disconnected'}`;
    }
}

/** Update AI provider UI. */
function updateApiInfo(apiData) {
    const apiProviderEl = document.getElementById('api-provider');
    if (apiProviderEl && apiData && apiData.provider) {
        apiProviderEl.textContent = `AI模型: ${apiData.provider}`;
        apiProviderEl.title = `Using ${apiData.provider}`;
    } else if (apiProviderEl) {
        apiProviderEl.textContent = 'AI模型: 未知';
        apiProviderEl.title = 'AI provider information unavailable';
    }
}

/** Clears screenshot history UI. */
function clearScreenshotHistory() {
    const historyListEl = document.getElementById('ss-history-list');
    if (historyListEl) {
        if (confirm('确定要清空所有截图历史记录吗？')) {
            historyListEl.innerHTML = '';
            // Optional: socket.emit('clear_all_screenshot_history');
            debugLog('Screenshot history list cleared.');
            const analysisEl = document.getElementById('ss-ai-analysis');
            if (analysisEl) {
                analysisEl.textContent = '请在左侧点击历史记录查看分析结果...';
                delete analysisEl.dataset.sourceUrl;
            }
        }
    }
}

/** Clears only the chat display area and resets the active session ID. */
function clearCurrentChatDisplay() {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (chatHistoryEl) {
        chatHistoryEl.innerHTML = '<div class="system-message">选择左侧记录或开始新对话...</div>';
    }
    currentChatSessionId = null;
    const listEl = document.getElementById('chat-session-list');
    listEl?.querySelectorAll('.history-item.active-session')?.forEach(item => item.classList.remove('active-session'));
    debugLog("Chat display cleared, ready for new session or loading existing.");
    document.getElementById('chat-chat-input')?.focus();
}

/** Clears all chat sessions from memory and UI. */
function clearAllChatSessions() {
    if (confirm('确定要永久删除所有对话记录吗？此操作无法撤销。')) {
        chatSessions = [];
        currentChatSessionId = null;
        const listEl = document.getElementById('chat-session-list');
        if (listEl) {
            listEl.innerHTML = '';
        }
        clearCurrentChatDisplay(); // Clears right panel and resets ID
        debugLog("All chat sessions cleared.");
        saveChatSessionsToStorage(); // Update localStorage
    }
}


/** Clears voice history UI. */
function clearVoiceHistory() {
    const voiceHistoryListEl = document.getElementById('voice-history-list');
    if (voiceHistoryListEl) {
        if (confirm('确定要清空所有语音历史记录吗？')) {
            voiceHistoryListEl.innerHTML = '';
            debugLog('Voice history list cleared.');
            const voiceResultEl = document.getElementById('voice-result');
            if (voiceResultEl) voiceResultEl.textContent = '点击下方按钮开始录音...';
        }
    }
}

// --- START: Tab and Voice Functions ---

/** Initializes tab switching functionality. */
function initTabs() {
    debugLog("Initializing tabs...");
    const tabsContainer = document.querySelector('.tabs-container');
    const tabContents = document.querySelectorAll('.tab-content-wrapper > .tab-content');

    if (!tabsContainer || tabContents.length === 0) {
        console.error("Tabs container or tab contents not found!"); return;
    }

    tabsContainer.addEventListener('click', (event) => {
        const clickedTab = event.target.closest('.tab-item');
        if (!clickedTab || clickedTab.classList.contains('active')) return;

        const targetTabId = clickedTab.getAttribute('data-tab');
        const targetContent = document.getElementById(targetTabId);

        if (targetContent) {
            debugLog(`Switching to tab: ${targetTabId}`);
            tabsContainer.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            clickedTab.classList.add('active');
            targetContent.classList.add('active');

            if (targetTabId === 'ai-chat') {
                document.getElementById('chat-chat-input')?.focus();
            }
        } else {
            console.error(`Tab content with ID ${targetTabId} not found.`);
        }
    });

    const initialActiveTab = tabsContainer.querySelector('.tab-item.active');
    if (!initialActiveTab && tabsContainer.querySelector('.tab-item')) {
        tabsContainer.querySelector('.tab-item').classList.add('active');
        if (tabContents[0]) tabContents[0].classList.add('active');
        debugLog('No initial active tab found in HTML, activating the first one.');
    } else if (initialActiveTab) {
        // Ensure corresponding content is active
        const targetTabId = initialActiveTab.getAttribute('data-tab');
        document.getElementById(targetTabId)?.classList.add('active');
    }
}

/** Initializes event listeners for the image overlay selection box. */
function initSelectionControls() {
    debugLog('Initializing selection controls (mousedown/mousemove/mouseup + touch)');
    const selectionBox = document.getElementById('selection-box');
    const overlayImage = document.getElementById('overlay-image');
    // const overlay = document.getElementById('overlay'); // Not directly used in handlers but good for context

    if (!selectionBox || !overlayImage) {
        console.error('Selection control elements missing.'); return;
    }

    // It's good practice to remove old listeners if this can be called multiple times
    // However, without a robust way to manage named functions for removal,
    // this might lead to issues if not handled carefully.
    // For simplicity, we assume it's called in a controlled way (e.g., once on overlay show).
    // If re-init is frequent, a more robust listener management is needed.

    let startX, startY, initialSelectionClientX, initialSelectionClientY, initialSelectionRect;

    function handleStart(e) {
        e.preventDefault();
        isDragging = true;
        const isTouchEvent = e.type.startsWith('touch');
        const clientX = isTouchEvent ? e.touches[0].clientX : e.clientX;
        const clientY = isTouchEvent ? e.touches[0].clientY : e.clientY;

        const imageRect = overlayImage.getBoundingClientRect();
        startX = clientX - imageRect.left; // Click position relative to image
        startY = clientY - imageRect.top;

        initialSelectionClientX = clientX;
        initialSelectionClientY = clientY;
        initialSelectionRect = { ...selection }; // Copy current selection state (which is relative to image)

        const boxRect = selectionBox.getBoundingClientRect(); // For handle detection
        const relativeXToBox = clientX - boxRect.left;
        const relativeYToBox = clientY - boxRect.top;
        const edgeThreshold = 15;

        const onRightEdge = relativeXToBox >= initialSelectionRect.width - edgeThreshold;
        const onBottomEdge = relativeYToBox >= initialSelectionRect.height - edgeThreshold;

        if (onRightEdge && onBottomEdge) {
            dragType = 'resize-se';
        } else {
            // Check if click is inside the box for moving
            // Use initialSelectionRect for this check as selectionBox bounds might be slightly off during rapid drag
            if (startX >= initialSelectionRect.x && startX <= initialSelectionRect.x + initialSelectionRect.width &&
                startY >= initialSelectionRect.y && startY <= initialSelectionRect.y + initialSelectionRect.height) {
               dragType = 'move';
            } else {
                // If outside the current box, but close, it might be an attempt to draw a new box or other resize
                // For now, we only support move or SE-resize from within/on the box.
                // If you want to draw a new box by dragging on the image:
                // dragType = 'draw';
                // selection = { x: startX, y: startY, width: 0, height: 0 };
                // For this implementation, we assume drag starts on the selection box or its handles.
                // If not strictly on SE corner, default to move if inside, otherwise ignore.
                isDragging = false; // Ignore if not a valid drag start point on the box
                return;
            }
        }
        debugLog(`Drag start: type=${dragType}, startX (img rel)=${startX}, startY (img rel)=${startY}`);

        if (isTouchEvent) {
            document.addEventListener('touchmove', handleMove, { passive: false });
            document.addEventListener('touchend', handleEnd);
            document.addEventListener('touchcancel', handleEnd);
        } else {
            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleEnd);
        }
    }

    function handleMove(e) {
        if (!isDragging) return;
        e.preventDefault();

        const isTouchEvent = e.type.startsWith('touch');
        const clientX = isTouchEvent ? e.touches[0].clientX : e.clientX;
        const clientY = isTouchEvent ? e.touches[0].clientY : e.clientY;

        const imageRect = overlayImage.getBoundingClientRect(); // Get current image rect
        // Current mouse/touch position relative to the image container
        const currentXInImage = clientX - imageRect.left;
        const currentYInImage = clientY - imageRect.top;

        // Delta of mouse movement in client coordinates
        const deltaClientX = clientX - initialSelectionClientX;
        const deltaClientY = clientY - initialSelectionClientY;


        if (dragType === 'move') {
            selection.x = initialSelectionRect.x + deltaClientX;
            selection.y = initialSelectionRect.y + deltaClientY;
        } else if (dragType === 'resize-se') {
            selection.width = initialSelectionRect.width + deltaClientX;
            selection.height = initialSelectionRect.height + deltaClientY;
            // selection.x remains initialSelectionRect.x
            // selection.y remains initialSelectionRect.y
        }
        updateSelectionBox();
    }

    function handleEnd() {
        if (!isDragging) return;
        isDragging = false;
        dragType = '';
        debugLog('Drag end.');
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleEnd);
        document.removeEventListener('touchmove', handleMove);
        document.removeEventListener('touchend', handleEnd);
        document.removeEventListener('touchcancel', handleEnd);
    }

    // Remove previous listeners before adding new ones to prevent accumulation if called multiple times.
    // A more robust way is to name these handlers and use removeEventListener with the named handlers.
    // For now, this direct approach works if initSelectionControls is managed carefully.
    selectionBox.replaceWith(selectionBox.cloneNode(true)); // Quick way to remove all listeners
    document.getElementById('selection-box').addEventListener('mousedown', handleStart);
    document.getElementById('selection-box').addEventListener('touchstart', handleStart, { passive: false });

    const newSelectionBox = document.getElementById('selection-box');
    if ('ontouchstart' in window && !newSelectionBox.querySelector('.resize-handle')) {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle'; // Style this for visibility
        newSelectionBox.appendChild(resizeHandle);
    }
}


/** Initializes voice recording features. */
function initVoiceFeature() {
    debugLog("Initializing voice features...");
    const startBtn = document.getElementById('voice-start-recording');
    const stopBtn = document.getElementById('voice-stop-recording');
    const voiceResultEl = document.getElementById('voice-result');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        console.warn('MediaRecorder API not supported.');
        if(startBtn) startBtn.disabled = true;
        if(stopBtn) stopBtn.disabled = true;
        if(voiceResultEl) voiceResultEl.textContent = '您的浏览器不支持录音功能。';
        return;
    }

    if (!startBtn || !stopBtn || !voiceResultEl) {
        console.error('Voice elements not found.'); return;
    }

    startBtn.addEventListener('click', async () => {
        debugLog("Start recording clicked.");
        audioChunks = [];
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeTypes = [
                'audio/webm;codecs=opus', 'audio/ogg;codecs=opus',
                'audio/mp4', // Try mp4 as it's common on Safari if webm/opus not available
                'audio/webm', 'audio/ogg', 'audio/wav'
            ];
            const supportedType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
            if (!supportedType) {
                console.error("No supported audio mime type found for MediaRecorder.");
                alert("无法找到支持的录音格式。");
                return;
            }
            debugLog(`Using supported mimeType: ${supportedType}`);
            mediaRecorder = new MediaRecorder(stream, { mimeType: supportedType });

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                    debugLog(`Audio chunk received: ${event.data.size} bytes`);
                }
            };

            mediaRecorder.onstop = () => {
                debugLog("Recording stopped.");
                if (audioChunks.length === 0) {
                    debugLog("No audio chunks recorded.");
                    voiceResultEl.textContent = "未录制到音频。请重试。";
                    startBtn.disabled = false;
                    stopBtn.disabled = true;
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }
                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                sendVoiceToServer(audioBlob);
                audioChunks = [];
                stream.getTracks().forEach(track => track.stop());
                debugLog("Microphone stream stopped.");
            };

            mediaRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event.error);
                alert(`录音出错: ${event.error.name || event.error.message || '未知错误'}`);
                startBtn.disabled = false;
                stopBtn.disabled = true;
                if(voiceResultEl) voiceResultEl.textContent = '录音时发生错误。';
                try { stream.getTracks().forEach(track => track.stop()); } catch(e) {}
            };

            mediaRecorder.start();
            debugLog(`Recording started (State: ${mediaRecorder.state})`);
            startBtn.disabled = true;
            stopBtn.disabled = false;
            voiceResultEl.innerHTML = '<i class="fas fa-microphone-alt fa-beat" style="color: red;"></i> 正在录音...';
        } catch (err) {
            console.error('Error getting user media:', err);
            alert('无法访问麦克风，请检查权限。错误: ' + err.message);
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    });

    stopBtn.addEventListener('click', () => {
        debugLog("Stop recording clicked.");
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            startBtn.disabled = false;
            stopBtn.disabled = true;
            // voiceResultEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在处理语音...'; // Set in sendVoiceToServer
        } else {
            debugLog("Stop clicked but not recording or recorder invalid.");
             // If stop is clicked but not recording (e.g. error occurred), ensure buttons are reset
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    });
    debugLog("Voice feature handlers attached.");
}

// --- Event Handlers & Initialization ---

/** Placeholder for requesting a screenshot from the server. */
function requestScreenshot() {
    debugLog("Requesting screenshot from server via Socket.IO...");
    if (socket && socket.connected) {
        socket.emit('request_screenshot_capture'); // Server should listen for this
        const analysisEl = document.getElementById('ss-ai-analysis');
        if (analysisEl) {
            analysisEl.textContent = '正在请求截图...';
            delete analysisEl.dataset.sourceUrl;
        }
    } else {
        alert('无法请求截图：未连接到服务器。');
        console.warn('Cannot request screenshot: Socket not connected.');
    }
}


/** Sets up initial event listeners for static elements (overlay buttons). */
function initBaseButtonHandlers() {
    debugLog("Initializing base button handlers (overlay)...");
    document.getElementById('close-overlay')?.addEventListener('click', hideImageOverlay);
    document.getElementById('confirm-selection')?.addEventListener('click', confirmCrop);
    document.getElementById('cancel-selection')?.addEventListener('click', hideImageOverlay);
}

/** Initializes handlers specific to the Screenshot Analysis tab. */
function initScreenshotAnalysisHandlers() {
    debugLog("Initializing Screenshot Analysis tab handlers...");
    document.getElementById('ss-capture-btn')?.addEventListener('click', requestScreenshot);
    document.getElementById('ss-clear-history')?.addEventListener('click', clearScreenshotHistory);
}

/** Initializes handlers specific to the AI Chat tab. */
function initAiChatHandlers() {
    debugLog("Initializing AI Chat tab handlers...");
    document.getElementById('chat-send-chat')?.addEventListener('click', sendChatMessage);
    const chatInputEl = document.getElementById('chat-chat-input');
    if (chatInputEl) {
        chatInputEl.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
    document.getElementById('chat-file-upload')?.addEventListener('change', handleFileUpload);
    document.getElementById('chat-clear-current-chat')?.addEventListener('click', clearCurrentChatDisplay);
    document.getElementById('chat-clear-all-sessions')?.addEventListener('click', clearAllChatSessions);
    
    loadChatSessionsFromStorage(); // Load existing chat sessions

    const streamingToggle = document.getElementById('streaming-toggle-checkbox');
    if (streamingToggle) {
        const savedSetting = localStorage.getItem('useStreamingOutput');
        if (savedSetting !== null) {
            streamingToggle.checked = savedSetting === 'true';
        } else {
             streamingToggle.checked = true; // Default to true if no setting saved
             localStorage.setItem('useStreamingOutput', 'true');
        }
        streamingToggle.addEventListener('change', function() {
            localStorage.setItem('useStreamingOutput', this.checked);
            debugLog(`Streaming output ${this.checked ? 'enabled' : 'disabled'}`);
        });
    }
}

/** Initializes handlers specific to the Voice Answer tab. */
function initVoiceAnswerHandlers() {
    debugLog("Initializing Voice Answer tab handlers...");
    initVoiceFeature();
    document.getElementById('voice-clear-history')?.addEventListener('click', clearVoiceHistory);
}

/** Main initialization function called on DOMContentLoaded. */
function initAllFeatures() {
    debugLog("--- Initializing All Features ---");

    const tokenMeta = document.querySelector('meta[name="token"]');
    if (tokenMeta && tokenMeta.content) {
        TOKEN = tokenMeta.content;
        debugLog('Authentication token loaded.');
    } else {
        console.warn('Authentication token meta tag not found or empty.');
    }

    initBaseButtonHandlers();
    initTabs();
    initScreenshotAnalysisHandlers();
    initAiChatHandlers();
    initVoiceAnswerHandlers();
    initSocketIO();

    debugLog("--- Application initialization complete ---");
}


// --- Application Entry Point ---
document.addEventListener('DOMContentLoaded', initAllFeatures);

// --- Optional Enhancements ---
document.addEventListener('DOMContentLoaded', () => {
    const buttons = document.querySelectorAll('button, .btn, .tab-item');
    buttons.forEach(button => {
        button.addEventListener('touchstart', function() { this.classList.add('touch-active'); }, { passive: true });
        button.addEventListener('touchend', function() { this.classList.remove('touch-active'); });
        button.addEventListener('touchcancel', function() { this.classList.remove('touch-active'); });
    });
    if (!document.querySelector('style#touch-active-style')) {
        const style = document.createElement('style');
        style.id = 'touch-active-style';
        style.textContent = `.touch-active { opacity: 0.7; transform: scale(0.98); }`;
        document.head.appendChild(style);
    }
});

function saveChatSessionsToStorage() {
    try {
        localStorage.setItem('chatSessions', JSON.stringify(chatSessions));
        debugLog("Chat sessions saved to localStorage.");
    } catch (e) {
        console.error("Failed to save chat sessions to localStorage:", e);
    }
}

function loadChatSessionsFromStorage() {
    try {
        const savedSessions = localStorage.getItem('chatSessions');
        if (savedSessions) {
            chatSessions = JSON.parse(savedSessions);
            debugLog(`Loaded ${chatSessions.length} chat sessions from localStorage.`);
            const historyListEl = document.getElementById('chat-session-list');
            if (historyListEl) {
                historyListEl.innerHTML = '';
                chatSessions.sort((a, b) => (b.id || 0) - (a.id || 0)); // Sort by ID (timestamp) desc
                chatSessions.forEach(session => addChatHistoryItem(session));
            }
        } else {
            debugLog("No chat sessions found in localStorage.");
        }
    } catch (e) {
        console.error("Failed to load chat sessions from localStorage:", e);
        chatSessions = [];
    }
    currentChatSessionId = null; // Reset on load
    clearCurrentChatDisplay(); // Ensure display is placeholder
}

// 辅助函数：生成 UUID (Ensured only one definition)
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 辅助函数：移除思考指示器 (Ensured only one definition)
function removeThinkingIndicator(chatHistoryEl, aiThinkingDiv) {
    if (aiThinkingDiv && chatHistoryEl && chatHistoryEl.contains(aiThinkingDiv)) {
        chatHistoryEl.removeChild(aiThinkingDiv);
    } else if (aiThinkingDiv && aiThinkingDiv.parentNode) { // More robust removal
        aiThinkingDiv.parentNode.removeChild(aiThinkingDiv);
    } else if (aiThinkingDiv) {
        // Fallback if parentNode is somehow null but element exists (less likely)
        try { aiThinkingDiv.remove(); } catch (e) { console.warn("Failed to remove thinking indicator directly", e); }
    }
}

/**
 * 使用 KaTeX 渲染页面中的 LaTeX 公式
 */
function renderMathWithKaTeX(element) {
    // 防御性检查：确保 element 存在
    if (!element) {
        console.warn("尝试渲染 LaTeX 但元素不存在");
        return;
    }
    
    // 防御性检查：确保 renderMathInElement 函数存在
    if (typeof window.renderMathInElement !== 'function') {
        console.warn('KaTeX auto-render 未加载或不可用');
        return;
    }
    
    try {
        // 尝试渲染数学公式
        window.renderMathInElement(element, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true}
            ],
            throwOnError: false
        });
    } catch (error) {
        console.error("渲染 LaTeX 时出错:", error);
        // 错误不会影响正常功能
    }
}

// 简化的 LaTeX 渲染函数
function safeRenderMath() {
    // 如果 KaTeX 未加载，不执行任何操作
    if (!window.katexLoaded || typeof window.renderMathInElement !== 'function') {
        return;
    }
    
    try {
        // 尝试渲染最新的消息
        const latestMessages = document.querySelectorAll('.ai-message');
        if (latestMessages && latestMessages.length > 0) {
            const latestMessage = latestMessages[latestMessages.length - 1];
            window.renderMathInElement(latestMessage, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false}
                ],
                throwOnError: false
            });
        }
    } catch (error) {
        console.error("安全渲染 LaTeX 失败:", error);
        // 错误被捕获，不会影响主要功能
    }
}

// 修改现有的消息显示函数，添加 LaTeX 渲染支持
function displayAIMessage(message, messageId, provider) {
    // 现有的消息显示代码...
    
    // 在消息添加到 DOM 后渲染其中的 LaTeX 公式
    const messageElement = document.getElementById(messageId);
    if (messageElement) {
        renderMathWithKaTeX(messageElement);
    }
}


// 修改 renderMathWithKaTeX 函数，添加错误处理和防御性编程
function renderMathWithKaTeX(element) {
    // 防御性检查：确保 element 存在
    if (!element) {
        console.warn("尝试渲染 LaTeX 但元素不存在");
        return;
    }
    
    // 防御性检查：确保 renderMathInElement 函数存在
    if (typeof window.renderMathInElement !== 'function') {
        console.warn('KaTeX auto-render 未加载或不可用');
        return;
    }
    
    try {
        // 尝试渲染数学公式
        window.renderMathInElement(element, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true}
            ],
            throwOnError: false
        });
    } catch (error) {
        console.error("渲染 LaTeX 时出错:", error);
        // 错误不会影响正常功能
    }
}

// 在页面加载完成后初始化渲染
document.addEventListener('DOMContentLoaded', function() {
    // 现有的初始化代码...
    // console.log("Existing initialization code has run."); // Example debug log

    // 初始化渲染页面中已有的公式
    setTimeout(() => {
        console.log("Attempting initial LaTeX rendering on page load...");

        if (typeof renderMathWithKaTeX === 'function') {
            try {
                // Call the user's custom rendering function
                renderMathWithKaTeX(document.body);
                console.log("LaTeX rendering initiated using 'renderMathWithKaTeX'.");
            } catch (error) {
                console.error("Error executing 'renderMathWithKaTeX':", error);
            }
        } else if (typeof katex !== 'undefined' && typeof renderMathInElement === 'function') {
            // Fallback: If renderMathWithKaTeX is not defined, but KaTeX and its auto-render
            // function (renderMathInElement) are available, try using the standard auto-render.
            // This is common if using KaTeX's auto-render extension.
            console.warn("'renderMathWithKaTeX' function not found. Attempting to use KaTeX auto-render (renderMathInElement) as a fallback.");
            try {
                renderMathInElement(document.body, {
                    delimiters: [
                        {left: "$$", right: "$$", display: true},
                        {left: "$", right: "$", display: false},
                        {left: "\\(", right: "\\)", display: false},
                        {left: "\\[", right: "\\]", display: true}
                    ],
                    throwOnError: false // Set to true to see KaTeX parsing errors, false to display errors in place
                });
                console.log("LaTeX rendering initiated using KaTeX auto-render (renderMathInElement).");
            } catch (error) {
                console.error("Error executing KaTeX auto-render (renderMathInElement):", error);
            }
        } else {
            // If neither the custom function nor KaTeX auto-render is available
            let errorMessage = "'renderMathWithKaTeX' function is not defined. ";
            if (typeof katex === 'undefined') {
                errorMessage += "KaTeX library (katex) also seems to be unavailable. Please ensure KaTeX is loaded correctly.";
            } else if (typeof renderMathInElement === 'undefined') {
                errorMessage += "KaTeX core library is loaded, but its auto-render extension ('renderMathInElement') was not found. Ensure the auto-render script is included if you intend to use it.";
            } else {
                errorMessage += "Please ensure 'renderMathWithKaTeX' is defined and loaded before this script runs, or that KaTeX auto-render is correctly set up.";
            }
            console.error(errorMessage + " LaTeX rendering cannot proceed as configured.");
        }
    }, 500); // 给页面充分时间加载 (Timeout to allow the page ample time to load)
});

/**
 * IMPORTANT CONSIDERATIONS:
 *
 * 1. KaTeX Library:
 * Ensure the KaTeX library is loaded before this script runs, or at least before the setTimeout callback executes.
 * Typically, you would include it in your HTML like this:
 * * <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" integrity="sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV" crossorigin="anonymous">
 * * <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js" integrity="sha384-XjKyOOlGwcjNTAIQHIpgOno0Hl1YQqzUOEleOLALmuqehneUG+vnGctmUbKyKLO8" crossorigin="anonymous"></script>
 * * <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" integrity="sha384-+VBxd3r6XgURycqtZ117nYw44OOcIax56Z4dCRWbxyPt0Koah1uHoK0o4+/RRE05" crossorigin="anonymous"></script>
 * *
 * 2. Definition of `renderMathWithKaTeX`:
 * If `renderMathWithKaTeX` is your custom function, ensure it is defined *before* this
 * `DOMContentLoaded` event listener is set up, or that its script is loaded and executed first.
 * For example:
 *
 * function renderMathWithKaTeX(element) {
 * if (typeof renderMathInElement === 'function' && typeof katex !== 'undefined') {
 * console.log("Using KaTeX auto-render inside renderMathWithKaTeX for element:", element);
 * renderMathInElement(element, {
 * delimiters: [
 * {left: "$$", right: "$$", display: true},
 * {left: "$", right: "$", display: false},
 * {left: "\\(", right: "\\)", display: false},
 * {left: "\\[", right: "\\]", display: true}
 * ],
 * throwOnError: false
 * });
 * } else {
 * console.error("KaTeX or its auto-render extension (renderMathInElement) is not available within renderMathWithKaTeX.");
 * }
 * }
 *
 * 3. The `setTimeout` delay (500ms):
 * This delay is a common workaround for ensuring that all page content (and sometimes other scripts)
 * are fully ready. However, relying on fixed timeouts can be fragile.
 * - If KaTeX and your `renderMathWithKaTeX` function are loaded via `<script defer ...>` tags placed
 * before this script, they should generally be available by `DOMContentLoaded`.
 * - If they are loaded via `<script async ...>`, their execution order is not guaranteed,
 * and a timeout might be a pragmatic way to wait, but it's not foolproof.
 * - A more robust way to handle dependencies is to use script `onload` events or Promises
 * if you're loading external scripts dynamically.
 * For an initial page render, if all scripts are ordered correctly, the timeout might not be strictly necessary
 * or could be reduced. Test thoroughly to see if it's essential for your specific setup.
 */
