/**
 * main.js
 *
 * Frontend JavaScript logic for the AI Assistant Dashboard.
 * Includes Markdown and LaTeX rendering for chat messages.
 */

// --- Global Variables & State ---



import renderMathInElement from 'katex/contrib/auto-render'
import 'katex/dist/katex.min.css';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
// 你可以选择一个你喜欢的主题。这里以 'github.min.css' 为例，与你之前 CDN 使用的一致。
// 如果你想使用其他主题，请相应修改路径。
import 'highlight.js/styles/github.min.css';

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

// --- File Upload Handling ---


// --- **** NEW: Preprocessing Function **** ---
/**
 * 预处理 AI 消息文本，将非标准的 LaTeX 分隔符统一为 $ 和 $$
 * @param {string} text 原始消息文本
 * @returns {string} 处理后的文本
 */
function preprocessTextForRendering(text) {
    if (!text) return "";
    let processedText = String(text); // 确保输入是字符串
    let latexConversionHappened = false;

    // --- 原 preprocessLatexSeparators 的逻辑 ---
    // 1. 替换块级公式分隔符 \[ ... \] 为 $$ ... $$
    processedText = processedText.replace(/\\\[([\s\S]*?)\\\]/g, (match, group1) => {
        latexConversionHappened = true;
        return '$$' + group1.trim() + '$$';
    });

    // 2. 替换行内公式分隔符 \( ... \) 为 $ ... $
    processedText = processedText.replace(/\\\(([\s\S]*?)\\\)/g, (match, group1) => {
        latexConversionHappened = true;
        return '$' + group1.trim() + '$';
    });

    if (latexConversionHappened) {
        // 注意：如果你还想保留这个特定的日志，可以这样做。
        // 或者，如果主要目的是看转换是否发生，这个标志本身可能就足够了，不一定每次都打印日志。
        console.log("[Preprocess] LaTeX separators were converted by preprocessTextForRendering.");
    }

    // --- 原 preprocessSpecialCharacters 的逻辑 ---
    // 将弯单引号 (apostrophe/prime, U+2019) 替换为直单引号 (apostrophe, U+0027)
    processedText = processedText.replace(/’/g, "'");

    // 你可以在这里按需添加其他特殊字符的替换规则
    // 例如，更通用的弯双引号替换:
    // processedText = processedText.replace(/[“”]/g, '"'); 
    // 或者针对 LaTeX 文本模式的引号 (如果 typographer 未正确处理):
    // processedText = processedText.replace(/“/g, "``");
    // processedText = processedText.replace(/”/g, "''");

    return processedText;
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
// --- LaTeX and Markdown Rendering ---
function renderLatexInElement(element) {
    if (!element) return;
    try {
        // 直接调用导入的 renderMathInElement (它应该在文件顶部被 import)
        renderMathInElement(element, { 
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false },
                { left: '\\[', right: '\\]', display: true }
            ],
            throwOnError: false,
            ignoredClasses: ["no-katex-render", "hljs", "no-math", "highlight", "language-"]
        });
    } catch (error) {
        console.error("[KaTeX] Rendering error (通过 import):", error, "on element:", element);
    }
}

function initMarkdownRenderer() {
    console.log("[MD RENDERER] Initializing markdown-it...");
    try {
        // 确保 MarkdownIt 已经按照上一步的建议导入和实例化
        if (typeof MarkdownIt === 'function') { 
            md = new MarkdownIt({
                html: true,
                breaks: true,
                langPrefix: 'language-',
                linkify: true,
                typographer: false,
                quotes: '“”‘’',
                highlight: function (str, lang) {
                    // 使用导入的 hljs
                    if (lang && hljs && hljs.getLanguage(lang)) { // <--- 修改这里: window.hljs -> hljs
                        try {
                            return '<pre class="hljs"><code>' +
                                   hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + // <--- 修改这里: window.hljs -> hljs
                                   '</code></pre>';
                        } catch (e) { console.error("[HLJS] Error highlighting:", e); }
                    }
                    // 确保 md.utils.escapeHtml 在 md 实例化前不可用，所以这里用你全局的 escapeHtml
                    // 或者，如果 md 已经实例化，可以使用 md.utils.escapeHtml(str)
                    return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>'; 
                }
            });
            console.log("[MD RENDERER] ✅ markdown-it initialized successfully.");
        } else {
            throw new Error("Imported MarkdownIt is not a function.");
        }
    } catch (e) {
        console.error("[MD RENDERER] ❌ Failed to initialize markdown-it:", e);
        md = { 
            render: function(text) { return escapeHtml(text).replace(/\n/g, '<br>'); },
            utils: { escapeHtml: escapeHtml }
        };
        console.warn("[MD RENDERER] ⚠️ Using basic fallback markdown renderer.");
    }
}

function processAIMessage(messageElement, messageText, sourceEvent = "unknown") {
    let strongTag = messageElement.querySelector('strong');
    if (!strongTag) {
        strongTag = document.createElement('strong');
        if (messageElement.firstChild) {
            messageElement.insertBefore(strongTag, messageElement.firstChild);
        } else {
            messageElement.appendChild(strongTag);
        }
    }
    const providerName = messageElement.dataset.provider || 'AI';
    strongTag.textContent = `${providerName}: `;

    let contentDiv = messageElement.querySelector('.message-content');
    const streamingSpan = messageElement.querySelector('.ai-response-text-streaming');

    if (streamingSpan) {
        console.log(`[KaTeX Debug from ${sourceEvent}] Removing streamingSpan for message:`, String(messageText || "").substring(0, 50) + "...");
        streamingSpan.remove();
    }

    if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        if (strongTag.nextSibling) {
            messageElement.insertBefore(contentDiv, strongTag.nextSibling);
        } else {
            messageElement.appendChild(contentDiv);
        }
    }
    contentDiv.innerHTML = ''; // 清空内容，为新的渲染做准备

    // 将原始消息文本转换为字符串并进行统一预处理
    let textToRender = String(messageText || "");
    
    if (typeof preprocessTextForRendering === 'function') {
        textToRender = preprocessTextForRendering(textToRender);
    } else {
        // 如果函数缺失，可以给一个警告，避免静默失败
        console.warn("Warning: preprocessTextForRendering function is not defined. Text preprocessing skipped.");
    }

    // 使用经过预处理的文本进行 Markdown 渲染
    if (md && typeof md.render === 'function') {
        contentDiv.innerHTML = md.render(textToRender);
    } else {
        contentDiv.innerHTML = escapeHtml(textToRender).replace(/\n/g, '<br>');
    }

    // --- 日志代码可以保持不变，或者按需调整 ---
    // 例如，确保 "Raw messageText passed to markdown-it:" 仍然是你期望记录的原始或中间状态的文本
    // 而 "contentDiv HTML BEFORE KaTeX render:" 会显示最终的、将要给 KaTeX 处理的 HTML
    if (sourceEvent === "chat_stream_end") {
        console.log(`%c[KaTeX Debug from ${sourceEvent}] FINAL KaTeX Processing:`, "color: blue; font-weight: bold;");
        console.log("Original messageText for logs:", messageText); // 原始的、未处理的 messageText
        console.log("Text after preprocessing (passed to md.render):", textToRender); // 经过统一预处理后的文本
        console.log("contentDiv HTML BEFORE KaTeX render:", contentDiv.innerHTML);
    } else if (sourceEvent === "test_button") {
        console.log(`%c[KaTeX Debug from ${sourceEvent}] TEST BUTTON KaTeX Processing:`, "color: green; font-weight: bold;");
        console.log("Original messageText (testMD) for logs:", messageText);
        console.log("Text after preprocessing (passed to md.render):", textToRender);
        console.log("contentDiv HTML BEFORE KaTeX render (Test Button):", contentDiv.innerHTML);
    } else if (sourceEvent === "history_load") {
        console.log(`%c[KaTeX Debug from ${sourceEvent}] HISTORY LOAD KaTeX Processing:`, "color: orange; font-weight: bold;");
        console.log("Original messageText (history) for logs:", messageText);
        console.log("Text after preprocessing (passed to md.render):", textToRender);
        console.log("contentDiv HTML BEFORE KaTeX render (History):", contentDiv.innerHTML);
    }
    // --- 日志代码结束 ---

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

// --- Global Variables & State ---


function initSocketIO() {
    socket = io({
        path: '/socket.io',
        auth: { token: TOKEN }
    });

    socket.on('connect', function() {
        console.log('[Socket] Connected to server');
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = '已连接';
    });

    socket.on('connect_error', function(error) {
        console.error('[Socket] Connection error:', error.message);
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = '连接失败: ' + error.message;
    });

    socket.on('chat_stream_chunk', function(data) {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;
        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
        let textSpan;

        if (!aiDiv) {
            const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
            if (thinkingDiv) removeThinkingIndicator(chatHistoryEl, thinkingDiv);

            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;
            if (data.provider) aiDiv.dataset.provider = data.provider;

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
                let contentDiv = aiDiv.querySelector('.message-content');
                if (!contentDiv) {
                    contentDiv = document.createElement('div');
                    contentDiv.className = 'message-content';
                    aiDiv.appendChild(contentDiv);
                }
                contentDiv.textContent += (data.chunk || '');
            }
        }
        // 立即渲染当前内容
        const contentDiv = aiDiv.querySelector('.message-content') || aiDiv.querySelector('.ai-response-text-streaming');
        if (contentDiv) renderLatexInElement(contentDiv);
        scrollToChatBottom(chatHistoryEl);
    });

    socket.on('chat_stream_end', function(data) {
        console.log(`[Socket] Received 'chat_stream_end' for requestId: ${data.request_id}`);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) {
            console.error("[chat_stream_end] Critical: chatHistoryEl not found.");
            return;
        }
    
        // --- 查找或创建用于显示 AI 回复的 div ---
        // 首先尝试查找已存在的对应 request_id 的消息 div (且不是 thinking 状态)
        let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
    
        // [可选调试] 检查找到的 aiDiv 是否确实在 chatHistoryEl 中 (通常是)
        // if (aiDiv && !chatHistoryEl.contains(aiDiv)) {
        //     console.warn(`[chat_stream_end] Found aiDiv for ${data.request_id}, but it's not a descendant of chatHistoryEl.`);
        // }
    
        // 如果没找到，就创建一个新的 div
        if (!aiDiv) {
            console.warn(`[chat_stream_end] No message div found for ${data.request_id}. Usually expected if streaming started before UI update. Creating one now.`);
            // 移除可能仍然存在的 thinking 指示器 (以防万一)
            const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
            if (thinkingDiv) removeThinkingIndicator(chatHistoryEl, thinkingDiv);
    
            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message'; // 基础类名
            aiDiv.dataset.requestId = data.request_id; // 绑定 request ID
            if (data.provider) { // 如果服务器提供了 provider 信息
                aiDiv.dataset.provider = data.provider;
            }
            
            // 将新创建的 div 添加到聊天记录的末尾
            if (typeof chatHistoryEl.appendChild === 'function') {
                chatHistoryEl.appendChild(aiDiv);
            } else {
                console.error("[chat_stream_end] Critical: chatHistoryEl is not a valid DOM element to append to.");
                return; // 无法添加，后续处理无意义
            }
        }
        // --- aiDiv 查找或创建结束 ---
    
        // 1. 更新界面显示 (调用 processAIMessage)
        // 确保 aiDiv 是一个有效的 HTML 元素
        if (aiDiv instanceof HTMLElement) {
            // processAIMessage 会处理 Markdown, KaTeX 等，并放入 aiDiv
            processAIMessage(aiDiv, data.full_message || '', "chat_stream_end");
        } else {
            console.error(`[chat_stream_end] aiDiv for ${data.request_id} is not a valid HTMLElement after find/create. Skipping UI update.`);
            // 如果 aiDiv 无效，后续保存历史可能仍需进行，取决于你的策略
        }
    
        // 2. 滚动到底部
        scrollToChatBottom(chatHistoryEl);
    
        // 3. **** 更新 localStorage 中的聊天历史 ****
        const activeSessionId = data.session_id || currentChatSessionId; // 优先使用服务器返回的 session_id
        if (activeSessionId) {
            const sessionToUpdate = chatSessions.find(s => s.id === activeSessionId);
            if (sessionToUpdate) {
                const messageIndex = sessionToUpdate.history.findIndex(
                    // 查找内存中对应的AI消息占位符
                    msg => msg.role === 'model' && msg.temp_id === data.request_id
                );
    
                if (messageIndex !== -1) {
                    // 更新找到的消息内容
                    sessionToUpdate.history[messageIndex].parts = [{ text: data.full_message || '' }];
                    if (data.provider) { // 如果服务器返回 provider 信息
                        sessionToUpdate.history[messageIndex].provider = data.provider;
                    }
                    delete sessionToUpdate.history[messageIndex].temp_id; // 移除临时ID
    
                    console.log(`[History] Updated AI message in session ${activeSessionId} for request ${data.request_id} (via stream)`);
                    saveChatSessionsToStorage(); // <--- 保存更新后的 chatSessions 到 localStorage
                } else {
                    // 虽然在界面上显示了消息，但在内存的 history 数组中没找到对应的占位符
                    // 这通常不应该发生，除非 sendChatMessage 中添加占位符失败，或者 request_id/session_id 逻辑有误
                    console.warn(`[History] Could not find placeholder AI message for request ${data.request_id} in session ${activeSessionId} to update (via stream). History might be inconsistent.`);
                }
            } else {
                // 内存中找不到对应的会话 ID
                console.warn(`[History] Could not find session ${activeSessionId} to update AI message (via stream).`);
            }
        } else {
            // 无法确定当前会话 ID
            console.warn("[History] No active session ID found to update AI message history (via stream).");
        }
    }); // chat_stream_end 回调结束

    socket.on('voice_answer', function(data) {
        console.log('[Socket] Received voice answer:', data);
        const audioPlayer = document.getElementById('voice-answer-player');
        const audioSource = document.getElementById('voice-answer-source');

        if (audioPlayer && audioSource && data.audio_url) {
            audioSource.src = data.audio_url;
            audioPlayer.load();
            audioPlayer.style.display = 'block';
            audioPlayer.play().catch(err => console.error('[Voice] Playback error:', err));
        }
    });

    socket.on('chat_error', function(data) {
        console.error('[Socket] Chat error:', data.message);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;

        const errorDiv = document.createElement('div');
        errorDiv.className = 'system-message';
        errorDiv.textContent = 'Error: ' + (data.message || 'An error occurred while processing your request.');
        chatHistoryEl.appendChild(errorDiv);
        scrollToChatBottom(chatHistoryEl);
    });
}


 // End of initSocketIO

// --- Chat Message Sending ---
// --- Chat Message Sending ---
// --- Chat Message Sending ---
function sendChatMessage() {
    const chatInputEl = document.getElementById('chat-chat-input');
    const chatHistoryEl = document.getElementById('chat-chat-history'); // 定义在这里，后面也能访问

    if (!socket || !socket.connected) {
        console.error('[Chat] Socket not connected, cannot send message');
        // 可以在这里给用户一个提示，比如一个短暂的弹出消息或状态栏更新
        return;
    }

    if (!chatInputEl || !chatHistoryEl) { console.error("Chat input or history missing."); return; }
    const message = chatInputEl.value.trim();
    const currentFileToSend = uploadedFile; // 获取暂存的文件
    if (!message && !currentFileToSend) { debugLog("Empty message and no file selected."); return; }

    // 查找或创建当前会话
    let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
    if (!activeSession) {
        const newId = Date.now();
        let title = message.substring(0, 30) || (currentFileToSend ? `含${currentFileToSend.name.substring(0, 20)}的对话` : '新对话');
        if ((message.length > 30 && title.length === 30) || (currentFileToSend && currentFileToSend.name.length > 20 && title.length >= 22)) title += "...";
        activeSession = { id: newId, title: escapeHtml(title), history: [] };
        chatSessions.unshift(activeSession); // 添加到会话列表顶部
        addChatHistoryItem(activeSession); // 更新左侧会话列表UI
        currentChatSessionId = newId; // 设置为当前活动会话
        saveCurrentChatSessionId(); // 保存当前会话ID到localStorage
        // 激活新会话的显示
        setTimeout(() => {
            const l = document.getElementById('chat-session-list');
            l?.querySelectorAll('.active-session').forEach(i => i.classList.remove('active-session'));
            l?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');
            if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = ''; // 清除初始提示
        }, 0);
    }

    // 将用户消息添加到内存中的历史记录
    const histMsgTxt = message || (currentFileToSend ? `[用户上传了文件: ${currentFileToSend.name}]` : "");
    // 确保 activeSession 存在 (理论上在上面已确保)
    if (activeSession && (histMsgTxt || currentFileToSend)) {
         activeSession.history.push({ role: 'user', parts: [{ text: histMsgTxt }] });
    } else if (!activeSession) {
         console.error("[sendChatMessage] Critical error: activeSession is null when trying to push user message.");
         return; // 避免后续错误
    }

    // 更新UI显示用户消息
    const uDiv = document.createElement('div'); uDiv.className = 'user-message';
    const uStrong = document.createElement('strong'); uStrong.textContent = "您: "; uDiv.appendChild(uStrong);
    const uMsgContentDiv = document.createElement('div'); uMsgContentDiv.className = 'message-content';
    uMsgContentDiv.textContent = message;
    if (currentFileToSend) {
        const fD = document.createElement('div'); fD.className = 'attached-file';
        fD.innerHTML = `<i class="fas fa-paperclip"></i> ${escapeHtml(currentFileToSend.name)} (${formatFileSize(currentFileToSend.size)})`;
        if (message) uMsgContentDiv.appendChild(document.createElement('br'));
        uMsgContentDiv.appendChild(fD);
    }
    uDiv.appendChild(uMsgContentDiv);
    if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = ''; // 如果是第一条消息，清除提示
    chatHistoryEl.appendChild(uDiv); // 添加用户消息到聊天窗口

    const reqId = generateUUID(); // 为本次请求生成唯一ID
    console.log(`[sendChatMessage] Generated reqId: ${reqId}`);

    // 显示“思考中”指示器
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'ai-message ai-thinking';
    thinkingDiv.dataset.requestId = reqId; // 绑定请求ID，方便后续移除
    thinkingDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> AI正在思考...';
    chatHistoryEl.appendChild(thinkingDiv);
    scrollToChatBottom(chatHistoryEl); // 滚动到底部

    // 向内存中的历史记录添加AI回复的占位符 (文本为空，但有temp_id)
    if (activeSession) { // 再次确认 activeSession 存在
        activeSession.history.push({ role: 'model', parts: [{ text: '' }], temp_id: reqId, provider: 'AI' });
    } else {
         console.error("[sendChatMessage] Critical error: activeSession is null when trying to push model placeholder.");
         // 可能需要移除 thinkingDiv 并提示错误
         if(thinkingDiv.parentNode === chatHistoryEl) chatHistoryEl.removeChild(thinkingDiv);
         return;
    }

    const streamToggle = document.getElementById('streaming-toggle-checkbox');
    const stream = streamToggle ? streamToggle.checked : true; // 获取流式输出设置

    // 准备发送给后端的历史记录 (不包含最后一条 AI 占位符)
    let histToSend = activeSession ? JSON.parse(JSON.stringify(activeSession.history.slice(0, -1))) : [];

    // 根据是否有文件决定请求方式
    if (currentFileToSend) {
        // --- 带文件上传：使用 fetch 请求 /chat_with_file ---
        const fd = new FormData();
        fd.append('prompt', message);
        fd.append('file', currentFileToSend, currentFileToSend.name);
        fd.append('history', JSON.stringify(histToSend));
        fd.append('use_streaming', stream); // 后端会根据这个决定行为吗？(当前后端实现似乎没用这个)
        fd.append('session_id', activeSession.id);
        fd.append('request_id', reqId); // 发送前端生成的 reqId

        console.log('DEBUG: Fetching /chat_with_file with Authorization Header:', `Bearer ${TOKEN}`); 

        fetch('/chat_with_file', { method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: fd })
            .then(r => { // 处理 HTTP 响应头
                if (!r.ok) { // 如果 HTTP 状态码不是 2xx
                    // 尝试解析 JSON 错误体，若失败则用状态文本构造错误
                    return r.json().catch(() => ({ error: `HTTP Error: ${r.status} ${r.statusText}` }))
                               .then(eD => { throw new Error(eD.message || eD.error || `HTTP ${r.status}`) });
                }
                return r.json(); // 解析成功的 JSON 响应体
            })
            .then(d => { // 处理来自 /chat_with_file 的确认响应 {status, message, request_id}
                // 检查响应内容是否符合预期，且 request_id 是否与我们发送的一致
                if (d && d.request_id === reqId && d.status === 'processing') {
                    // 服务器已接受请求，后台任务已开始
                    console.log(`[File Upload] Request ${reqId} accepted by server. Status: ${d.status}. Waiting for Socket.IO response.`);
                    // “思考中”指示器保持显示，等待后续 Socket.IO 事件 (如 chat_stream_end 或 analysis_result)
                    // 不需要在这里更新UI或保存历史，依赖 Socket.IO 处理器完成
                } else {
                    // 服务器确认响应无效或 request_id 不匹配
                    console.warn('[File Upload] Server acknowledgment error or request_id mismatch.', d);
                    const currentThinkingDivMismatch = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                    if (currentThinkingDivMismatch) removeThinkingIndicator(chatHistoryEl, currentThinkingDivMismatch);
                    // 显示错误给用户
                    const errD = document.createElement('div');
                    errD.className = 'ai-message error-message';
                    errD.innerHTML = `<strong>系统错误:</strong><span>服务器未能确认处理文件请求。</span>`;
                    if (chatHistoryEl) {
                        chatHistoryEl.appendChild(errD);
                        scrollToChatBottom(chatHistoryEl);
                    }
                    // 清理历史记录中的AI占位符
                    if (activeSession) {
                        const messageIndex = activeSession.history.findIndex(msg => msg.role === 'model' && msg.temp_id === reqId);
                        if (messageIndex !== -1) {
                            activeSession.history.splice(messageIndex, 1);
                            saveChatSessionsToStorage(); // 保存清理后的历史
                            console.log(`[History] Removed placeholder AI message for unacknowledged request ${reqId}`);
                        }
                    }
                }
            })
            .catch(e => { // fetch 调用本身失败 (网络错误, 404, 500 等)
                console.error('Chat w/ file fetch error:', e);
                const currentThinkingDivError = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                if (currentThinkingDivError) removeThinkingIndicator(chatHistoryEl, currentThinkingDivError);

                const errD = document.createElement('div');
                errD.className = 'ai-message error-message';
                errD.innerHTML = `<strong>系统错误:</strong><span>文件上传请求失败: ${escapeHtml(e.message)}</span>`;
                if (chatHistoryEl) {
                    chatHistoryEl.appendChild(errD);
                    scrollToChatBottom(chatHistoryEl);
                }
                // 清理历史记录中的AI占位符
                if (activeSession) {
                    const messageIndex = activeSession.history.findIndex(msg => msg.role === 'model' && msg.temp_id === reqId);
                    if (messageIndex !== -1) {
                        activeSession.history.splice(messageIndex, 1);
                        saveChatSessionsToStorage(); // 保存清理后的历史
                        console.log(`[History] Removed placeholder AI message for failed fetch request ${reqId}`);
                    }
                }
            });
    } else {
        // --- 不带文件：使用 Socket.IO 发送 chat_message 事件 ---
        socket.emit('chat_message', {
            prompt: message,
            history: histToSend,
            request_id: reqId,
            use_streaming: stream, // 告知服务器是否期望流式响应
            session_id: activeSession.id
        });
        // AI 的响应将通过 chat_stream_chunk 和 chat_stream_end 事件到达
        // 务必确保 chat_stream_end 处理器会更新并保存历史记录
    }

    // 不论请求方式如何，都在添加用户消息和AI占位符后立即保存一次
    // 这确保了即使浏览器意外关闭，用户输入和AI思考状态也能恢复
    if (activeSession) {
        saveChatSessionsToStorage();
    }

    // 清空输入框和文件预览区
    chatInputEl.value = '';
    const upPrevEl = document.getElementById('chat-upload-preview'); if (upPrevEl) upPrevEl.innerHTML = ''; uploadedFile = null;
    const fInEl = document.getElementById('chat-file-upload'); if (fInEl) fInEl.value = '';
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
            processAIMessage(msgDiv, text, "history_load"); // <--- 标记来源
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
function initBaseButtonHandlers() {
    // --- Test Render Button ---
    document.getElementById('test-render-btn')?.addEventListener('click', () => {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;
        if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
        const testMsgDiv = document.createElement('div');
        testMsgDiv.className = 'ai-message';
        const testMD = "### Test MD\n\n- List\n- KaTeX: $E=mc^2$ and $$\\sum_{i=0}^n i^2 = \\frac{n(n+1)(2n+1)}{6}$$";
        processAIMessage(testMsgDiv, testMD, "test_button"); // <--- 标记来源
        chatHistoryEl.appendChild(testMsgDiv);
        scrollToChatBottom(chatHistoryEl);
    });

    // --- Other button handlers ---
    document.getElementById('clear-chat-btn')?.addEventListener('click', () => {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (chatHistoryEl) chatHistoryEl.innerHTML = '';
    });

    document.getElementById('copy-last-msg-btn')?.addEventListener('click', () => {
        const lastMsg = document.querySelector('#chat-chat-history .message-content:last-child');
        if (lastMsg) {
            navigator.clipboard.writeText(lastMsg.textContent).then(() => {
                console.log('[Clipboard] Copied last message');
            }).catch(err => {
                console.error('[Clipboard] Copy failed:', err);
            });
        }
    });

    document.getElementById('screenshot-btn')?.addEventListener('click', () => {
        html2canvas(document.getElementById('chat-chat-history')).then(canvas => {
            const link = document.createElement('a');
            link.download = 'chat_screenshot.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
        }).catch(err => {
            console.error('[Screenshot] Error:', err);
        });
    });

    // --- 保留原始的事件监听器 ---
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
    if (tokenMeta?.content) TOKEN = tokenMeta.content;
    else console.warn('Token meta tag missing.');

    initMarkdownRenderer();

    // KaTeX JS 和 CSS 已经通过 import 导入，renderMathInElement 函数现在可以直接使用。
    // 我们可以在这里渲染页面加载时已经存在的任何包含 LaTeX 的内容。
    // console.log('[KaTeX] renderMathInElement is available via import. Rendering existing content.'); // 可选的调试日志
    document.querySelectorAll('.message-content').forEach(renderLatexInElement);

    initBaseButtonHandlers();
    initTabs();
    initScreenshotAnalysisHandlers();
    initAiChatHandlers();
    initVoiceAnswerHandlers();
    initSocketIO();

    console.log("--- Application initialization complete ---");
}


document.addEventListener('DOMContentLoaded', initAllFeatures);

// 按钮触摸效果的 DOMContentLoaded 监听器
document.addEventListener('DOMContentLoaded', ()=>{
    const btns=document.querySelectorAll('button,.btn,.tab-item');
    btns.forEach(b=>{
        let touchTimer;
        const clearTimer=()=>{
            if(touchTimer){
                clearTimeout(touchTimer);
                touchTimer=null;
                // 'this' 在箭头函数中可能指向外部作用域，取决于 clearTimer 如何被调用
                // 如果是作为事件监听器回调，普通函数可能更合适以确保 'this' 指向按钮
                // 但既然您用了 this.classList.remove，它在特定调用下应该能工作
                b.classList.remove('touch-active'); // 直接用 b 更安全
            }
        };
        b.addEventListener('touchstart',function(){ // 用普通函数确保 this 指向 b
            this.classList.add('touch-active');
            touchTimer=setTimeout(() => clearTimer(), 300); // 确保 clearTimer 能访问 b
        },{passive:true});
        b.addEventListener('touchend', () => clearTimer()); // 确保 clearTimer 能访问 b
        b.addEventListener('touchcancel', () => clearTimer()); // 确保 clearTimer 能访问 b
    });
    if(!document.querySelector('style#touch-active-style')){
        const s=document.createElement('style');
        s.id='touch-active-style';
        s.textContent='.touch-active{opacity:0.7 !important; transform:scale(0.98) !important;}';
        document.head.appendChild(s);
    }
});

