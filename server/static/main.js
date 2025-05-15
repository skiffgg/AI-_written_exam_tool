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
// import 'highlight.js/styles/github.min.css';
import 'highlight.js/styles/atom-one-dark.min.css'; // 引入新的 atom-one-dark 主题

let TOKEN = '';
let selection = { x: 0, y: 0, width: 0, height: 0 };
let isDragging = false;
let dragStartX, dragStartY;
let dragType = '';
let currentImage = null; // URL of image in overlay
let socket = null;
let latexConversionHappened = false;
let uploadedFile = null; // File staged for chat upload
let mediaRecorder; // For voice recording
let audioChunks = []; // Store audio data chunks
let chatSessions = []; // Stores all chat session objects {id, title, history}
let currentChatSessionId = null; // ID of the currently active session
let availableModels = {}; // To store models fetched from backend
let selectedModel = {     // To store the currently selected model
    provider: null,       // e.g., "openai"
    model_id: null        // e.g., "gpt-4o"
};
var currentVoiceRequestId = null; // Used by voice recording
let md = null; // Markdown-it instance


const THEME_STORAGE_KEY = 'selectedAppTheme'; // 您可以选择一个合适的键名
const MODEL_SELECTOR_STORAGE_KEY_PROVIDER = 'selectedProvider';
const MODEL_SELECTOR_STORAGE_KEY_MODEL_ID = 'selectedModelId';
const ACTIVE_MAIN_FEATURE_TAB_KEY = 'activeMainFeature'; // Changed from ...TAB
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';


// --- Utility Functions ---

// 打印调试信息
function debugLog(message) {
  console.log(`[AI DEBUG] ${message}`);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === undefined || bytes === null || bytes < 0) return 'N/A';
  if (bytes === 0) return '0 B';

  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 滚动聊天记录到最底部
function scrollToChatBottom(chatHistoryEl) {
  if (chatHistoryEl) {
    requestAnimationFrame(() => {
      chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
    });
  }
}

// 转义 HTML 特殊字符
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };

  return text.replace(/[&<>"']/g, function(m) {
    return map[m];
  });
}

// 生成 UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 移除正在思考的指示器
function removeThinkingIndicator(chatHistoryEl, aiThinkingDiv) {
  if (aiThinkingDiv && aiThinkingDiv.parentNode) {
    try {
      aiThinkingDiv.parentNode.removeChild(aiThinkingDiv);
    } catch (e) {
      console.warn("Failed to remove thinking indicator:", e);
      try {
        aiThinkingDiv.remove();
      } catch (e2) {}
    }
  }
}




// --- Utility Functions ---

/**
 * Creates a delete button for the history list.
 * @param {Function} onClickCallback - The callback function to call when the button is clicked.
 * @returns {HTMLButtonElement} The delete button element.
 */
function createDeleteButton(onClickCallback) {
    const btn = document.createElement('button');
    btn.className = 'delete-history btn btn-xs btn-outline-danger py-0 px-1 ms-auto';
    btn.innerHTML = '<i class="fas fa-times small"></i>';
    btn.title = '删除此条记录';
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClickCallback(); });
    return btn;
}

// --- Text Preprocessing ---

/**
 * Preprocesses the input text for rendering (such as converting LaTeX).
 * @param {string} text - The text to preprocess.
 * @returns {string} The preprocessed text.
 */
function preprocessTextForRendering(text) {
    if (!text) return "";

    let processedText = String(text);
    let latexConversionHappened = false;

    // Convert LaTeX expressions
    processedText = processedText.replace(/\\\[([\s\S]*?)\\\]/g, (match, group1) => {
        latexConversionHappened = true;
        return '$$' + group1.trim() + '$$';
    });

    processedText = processedText.replace(/\\\(([\s\S]*?)\\\)/g, (match, group1) => {
        latexConversionHappened = true;
        return '$' + group1.trim() + '$';
    });

    // Fix apostrophe characters
    processedText = processedText.replace(/’/g, "'");

    if (latexConversionHappened) {
        console.log("[Preprocess] LaTeX separators converted.");
    }
    return processedText;
}

// --- KaTeX and Markdown Rendering ---

/**
 * Initializes the Markdown renderer with KaTeX and highlights code blocks.
 */
function initMarkdownRenderer() {
    if (typeof MarkdownIt === 'function' && typeof hljs !== 'undefined') {
        md = new MarkdownIt({
            html: true,
            breaks: true,
            langPrefix: 'language-',
            linkify: true,
            typographer: false,
            quotes: '“”‘’',
            highlight: function (str, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return '<pre class="hljs"><code>' + hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
                    } catch (e) {
                        console.error("[HLJS] Error:", e);
                    }
                }
                return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>';
            }
        });
        console.log("[MD RENDERER] markdown-it initialized.");
    } else {
        console.error("[MD RENDERER] MarkdownIt or hljs not available. Using basic fallback.");
        md = { render: (text) => escapeHtml(String(text)).replace(/\n/g, '<br>') };
    }
}

function loadChatSessionsFromStorage() {
    try {
        const saved = localStorage.getItem('chatSessions');
        if (saved) {
            chatSessions = JSON.parse(saved);
            const listEl = document.getElementById('chat-session-list');
            if (listEl) { 
                listEl.innerHTML = ''; 
                chatSessions.sort((a,b)=>(b.id||0)-(a.id||0)).forEach(addChatHistoryItem); 
            }
            const lastSessionId = localStorage.getItem('currentChatSessionId');
            if (lastSessionId && chatSessions.find(s => s.id === Number(lastSessionId))) {
                currentChatSessionId = Number(lastSessionId);
                const activeSessionItem = listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`);
                if (activeSessionItem) activeSessionItem.click();
                else clearCurrentChatDisplay();
            } else { 
                clearCurrentChatDisplay(); 
            }
        } else { 
            clearCurrentChatDisplay(); 
        }
    } catch (e) { 
        console.error("Failed to load chat sessions:", e); 
        chatSessions=[]; 
        clearCurrentChatDisplay(); 
    }
}

/**
 * Processes AI message by rendering markdown, LaTeX, and inserting proper elements into the DOM.
 * @param {HTMLElement} messageElement - The element where the message will be rendered.
 * @param {string} messageText - The message text to render.
 * @param {string} sourceEvent - The source event triggering the message (optional).
 */
function processAIMessage(messageElement, messageText, sourceEvent = "unknown") {
    if (!messageElement) {
        console.error("processAIMessage: null messageElement. Source:", sourceEvent);
        return;
    }

    // --- 1. 设置发送者信息 (strongTag) ---
    let strongTag = messageElement.querySelector('strong.ai-sender-prefix');
    if (!strongTag) {
        strongTag = document.createElement('strong');
        strongTag.className = 'ai-sender-prefix me-1';
        // (插入 strongTag 的逻辑...)
        if (messageElement.firstChild && messageElement.firstChild.nodeType === Node.ELEMENT_NODE) {
            messageElement.insertBefore(strongTag, messageElement.firstChild);
        } else {
            messageElement.appendChild(strongTag);
        }
    }
    const providerName = messageElement.dataset.provider || 'AI';
    const modelId = messageElement.dataset.modelId;
    const modelNameShort = modelId ? ` (${modelId.split(/[-/]/).pop().substring(0, 20)})` : '';
    strongTag.textContent = `${providerName}${modelNameShort}:`;

    // --- 2. 获取或创建内容容器 (contentDiv) ---
    let contentDiv;
    const streamingSpan = messageElement.querySelector('.ai-response-text-streaming');

    // 如果是流式块，并且 streamingSpan 存在，则追加到 streamingSpan
    if (sourceEvent === "chat_stream_chunk" && streamingSpan) {
        contentDiv = streamingSpan; // 后续文本将追加到这里
    } else {
        // 对于非流式块、流结束，或者 streamingSpan 不存在的情况
        if (streamingSpan) streamingSpan.remove(); // 移除临时的流式 span

        contentDiv = messageElement.querySelector('.message-content');
        if (!contentDiv) {
            contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            if (strongTag.nextSibling) messageElement.insertBefore(contentDiv, strongTag.nextSibling);
            else messageElement.appendChild(contentDiv);
        }
        contentDiv.innerHTML = ''; // 清空，为完整渲染做准备
    }

    // --- 3. 预处理文本 ---
    let textToRender = String(messageText || "");
    if (typeof preprocessTextForRendering === 'function') {
        textToRender = preprocessTextForRendering(textToRender);
    }

    // --- 4. Markdown 渲染 ---
    if (md && typeof md.render === 'function') {
        if (sourceEvent === "chat_stream_chunk" && contentDiv.classList.contains('ai-response-text-streaming')) {
            // 流式传输时，仅追加文本到 streamingSpan
            contentDiv.textContent += textToRender; // 注意：这里应该是 += data.chunk (原始块)，而不是预处理后的 textToRender
                                                 // 或者，如果预处理很快，也可以用 textToRender，但要确保只处理当前块
                                                 // 更好的做法是，流式传输时，由 chat_stream_chunk 事件处理器直接更新 streamingSpan.textContent
                                                 // processAIMessage 在流式块时不应该被这样调用
        } else {
            // 非流式或流结束后，渲染完整的 Markdown
            contentDiv.innerHTML = md.render(textToRender);
            console.log(`[ProcessAIMessage from ${sourceEvent}] HTML after md.render:`, contentDiv.innerHTML.substring(0, 200) + "...");
        }
    } else {
        // Fallback Markdown 渲染
        if (sourceEvent === "chat_stream_chunk" && contentDiv.classList.contains('ai-response-text-streaming')) {
            contentDiv.textContent += escapeHtml(textToRender);
        } else {
            contentDiv.innerHTML = escapeHtml(textToRender).replace(/\n/g, '<br>');
        }
    }

    // --- 5. 代码高亮、复制代码按钮、KaTeX 渲染 (仅在消息完整时执行) ---
    if (sourceEvent !== "chat_stream_chunk") { // 确保这是针对完整消息的
        // 确保 contentDiv 是 '.message-content' (而不是 '.ai-response-text-streaming')
        if (contentDiv.classList.contains('message-content')) {
            // A. 代码高亮和复制代码按钮
            contentDiv.querySelectorAll('pre code').forEach(block => {
                if (typeof hljs !== 'undefined' && typeof hljs.highlightElement === 'function') {
                    try {
                        hljs.highlightElement(block);
                    } catch (e) {
                        console.error("hljs error:", e);
                    }
                }
                const preElement = block.closest('pre');
                if (preElement && !preElement.querySelector('.copy-code-button')) {
                    const copyButton = document.createElement('button');
                    copyButton.className = 'copy-code-button btn btn-xs btn-outline-secondary p-1';
                    copyButton.innerHTML = '<i class="far fa-copy small"></i>';
                    copyButton.title = '复制';
                    copyButton.type = 'button';
                    copyButton.addEventListener('click', (event) => { /* TODO: copy logic */ });
                    if (getComputedStyle(preElement).position === 'static') preElement.style.position = 'relative';
                    preElement.appendChild(copyButton);
                }
            });

            // B. KaTeX 渲染
            console.log(`[ProcessAIMessage from ${sourceEvent}] HTML before KaTeX render (after copy buttons):`, contentDiv.innerHTML.substring(0, 200) + "...");
            if (typeof renderLatexInElement === 'function') {
                console.log(`[ProcessAIMessage from ${sourceEvent}] About to call renderLatexInElement on:`, contentDiv);
                try {
                    renderLatexInElement(contentDiv);
                    console.log(`[ProcessAIMessage from ${sourceEvent}] KaTeX render attempted. HTML after:`, contentDiv.innerHTML.substring(0, 100) + "...");
                } catch (e) {
                    console.error(`[ProcessAIMessage from ${sourceEvent}] Error during renderLatexInElement:`, e);
                }
            } else {
                console.warn(`[ProcessAIMessage from ${sourceEvent}] renderLatexInElement is not defined.`);
            }
        } else {
            console.warn(`[ProcessAIMessage from ${sourceEvent}] Attempted final rendering on non-contentDiv:`, contentDiv);
        }
    }
}
// function processAIMessage(messageElement, messageText, sourceEvent = "unknown") {
//     if (!messageElement) {
//         console.error("processAIMessage: null messageElement. Source:", sourceEvent);
//         return;
//     }

//     // --- 1. 设置发送者信息 (strongTag) ---
//     let strongTag = messageElement.querySelector('strong.ai-sender-prefix');
//     if (!strongTag) {
//         strongTag = document.createElement('strong');
//         strongTag.className = 'ai-sender-prefix me-1';
//         // (插入 strongTag 的逻辑...)
//         if (messageElement.firstChild && messageElement.firstChild.nodeType === Node.ELEMENT_NODE) {
//             messageElement.insertBefore(strongTag, messageElement.firstChild);
//         } else {
//             messageElement.appendChild(strongTag);
//         }
//     }
//     const providerName = messageElement.dataset.provider || 'AI';
//     const modelId = messageElement.dataset.modelId;
//     const modelNameShort = modelId ? ` (${modelId.split(/[-/]/).pop().substring(0, 20)})` : '';
//     strongTag.textContent = `${providerName}${modelNameShort}:`;

//     // --- 2. 获取或创建内容容器 (contentDiv) ---
//     let contentDiv;
//     const streamingSpan = messageElement.querySelector('.ai-response-text-streaming');

//     // 如果是流式块，并且 streamingSpan 存在，则追加到 streamingSpan
//     if (sourceEvent === "chat_stream_chunk" && streamingSpan) {
//         contentDiv = streamingSpan; // 后续文本将追加到这里
//     } else {
//         // 对于非流式块、流结束，或者 streamingSpan 不存在的情况
//         if (streamingSpan) streamingSpan.remove(); // 移除临时的流式 span

//         contentDiv = messageElement.querySelector('.message-content');
//         if (!contentDiv) {
//             contentDiv = document.createElement('div');
//             contentDiv.className = 'message-content';
//             if (strongTag.nextSibling) messageElement.insertBefore(contentDiv, strongTag.nextSibling);
//             else messageElement.appendChild(contentDiv);
//         }
//         contentDiv.innerHTML = ''; // 清空，为完整渲染做准备
//     }

//     // --- 3. 预处理文本 ---
//     let textToRender = String(messageText || "");
//     if (typeof preprocessTextForRendering === 'function') {
//         textToRender = preprocessTextForRendering(textToRender);
//     }

//     // --- 4. Markdown 渲染 ---
//     if (md && typeof md.render === 'function') {
//         if (sourceEvent === "chat_stream_chunk" && contentDiv.classList.contains('ai-response-text-streaming')) {
//             // 流式传输时，仅追加文本到 streamingSpan
//             contentDiv.textContent += textToRender; // 注意：这里应该是 += data.chunk (原始块)，而不是预处理后的 textToRender
//                                                  // 或者，如果预处理很快，也可以用 textToRender，但要确保只处理当前块
//                                                  // 更好的做法是，流式传输时，由 chat_stream_chunk 事件处理器直接更新 streamingSpan.textContent
//                                                  // processAIMessage 在流式块时不应该被这样调用
//         } else {
//             // 非流式或流结束后，渲染完整的 Markdown
//             contentDiv.innerHTML = md.render(textToRender);
//             console.log(`[ProcessAIMessage from ${sourceEvent}] HTML after md.render:`, contentDiv.innerHTML.substring(0, 200) + "...");
//         }
//     } else {
//         // Fallback Markdown 渲染
//         if (sourceEvent === "chat_stream_chunk" && contentDiv.classList.contains('ai-response-text-streaming')) {
//             contentDiv.textContent += escapeHtml(textToRender);
//         } else {
//             contentDiv.innerHTML = escapeHtml(textToRender).replace(/\n/g, '<br>');
//         }
//     }

//     // --- 5. 代码高亮、复制代码按钮、KaTeX 渲染 (仅在消息完整时执行) ---
//     if (sourceEvent !== "chat_stream_chunk") { // 确保这是针对完整消息的
//         // 确保 contentDiv 是 '.message-content' (而不是 '.ai-response-text-streaming')
//         if (contentDiv.classList.contains('message-content')) {
//             // A. 代码高亮和复制代码按钮
//             contentDiv.querySelectorAll('pre code').forEach(block => {
//                 if (typeof hljs !== 'undefined' && typeof hljs.highlightElement === 'function') {
//                     try {
//                         hljs.highlightElement(block);
//                     } catch (e) {
//                         console.error("hljs error:", e);
//                     }
//                 }
//                 const preElement = block.closest('pre');
//                 if (preElement && !preElement.querySelector('.copy-code-button')) {
//                     const copyButton = document.createElement('button');
//                     copyButton.className = 'copy-code-button btn btn-xs btn-outline-secondary p-1';
//                     copyButton.innerHTML = '<i class="far fa-copy small"></i>';
//                     copyButton.title = '复制';
//                     copyButton.type = 'button';
//                     copyButton.addEventListener('click', (event) => { /* TODO: copy logic */ });
//                     if (getComputedStyle(preElement).position === 'static') preElement.style.position = 'relative';
//                     preElement.appendChild(copyButton);
//                 }
//             });

//             // B. KaTeX 渲染
//             console.log(`[ProcessAIMessage from ${sourceEvent}] HTML before KaTeX render (after copy buttons):`, contentDiv.innerHTML.substring(0, 200) + "...");
//             if (typeof renderLatexInElement === 'function') {
//                 console.log(`[ProcessAIMessage from ${sourceEvent}] About to call renderLatexInElement on:`, contentDiv);
//                 try {
//                     renderLatexInElement(contentDiv);
//                     console.log(`[ProcessAIMessage from ${sourceEvent}] KaTeX render attempted. HTML after:`, contentDiv.innerHTML.substring(0, 100) + "...");
//                 } catch (e) {
//                     console.error(`[ProcessAIMessage from ${sourceEvent}] Error during renderLatexInElement:`, e);
//                 }
//             } else {
//                 console.warn(`[ProcessAIMessage from ${sourceEvent}] renderLatexInElement is not defined.`);
//             }
//         } else {
//             console.warn(`[ProcessAIMessage from ${sourceEvent}] Attempted final rendering on non-contentDiv:`, contentDiv);
//         }
//     }
// }

function initVoiceFeature() {
    const startRecordingBtn = document.getElementById('voice-start-recording');
    const stopRecordingBtn = document.getElementById('voice-stop-recording');
    const voiceResultEl = document.getElementById('voice-result');

    // 检查浏览器是否支持录音功能
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        if (startRecordingBtn) startRecordingBtn.disabled = true;
        if (stopRecordingBtn) stopRecordingBtn.disabled = true;
        if (voiceResultEl) voiceResultEl.textContent = '抱歉，您的浏览器不支持录音功能。';
        console.warn("Browser does not support MediaRecorder or getUserMedia.");
        return;
    }

    // 确保所有必要的元素都存在
    if (!startRecordingBtn || !stopRecordingBtn || !voiceResultEl) {
        console.error("Voice feature UI elements not found (start/stop button or result area).");
        return;
    }

    // “开始录音”按钮的事件监听器
    startRecordingBtn.addEventListener('click', async () => {
        audioChunks = []; // 清空之前的音频片段

        // 禁用开始按钮，启用停止按钮，更新UI为录音状态
        startRecordingBtn.disabled = true;
        stopRecordingBtn.disabled = false;
        if (voiceResultEl) voiceResultEl.innerHTML = `<p><i class="fas fa-microphone-alt fa-beat" style="color:red;"></i> 录音中...</p>`;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // 尝试找到浏览器支持的音频格式
            const mimeTypes = [
                'audio/webm;codecs=opus',
                'audio/ogg;codecs=opus',
                'audio/mp4', // 有些浏览器可能支持mp4容器的AAC或Opus
                'audio/webm', // 通用webm
                'audio/ogg',  // 通用ogg
                // 'audio/wav' // MediaRecorder对WAV的直接支持较少，通常需要后期转换
            ];
            const supportedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));

            if (!supportedMimeType) {
                alert("未找到浏览器支持的录音格式。");
                console.error("No supported MIME type found for MediaRecorder.");
                startRecordingBtn.disabled = false;
                stopRecordingBtn.disabled = true;
                if (voiceResultEl) voiceResultEl.textContent = '录音格式不受支持。';
                stream.getTracks().forEach(track => track.stop()); // 关闭媒体流
                return;
            }
            console.log("[VOICE] Using MIME type:", supportedMimeType);

            mediaRecorder = new MediaRecorder(stream, { mimeType: supportedMimeType });

            // *** 生成并设置当前语音请求的唯一ID ***
            window.currentVoiceRequestId = generateUUID();
            console.log('[VOICE] New currentVoiceRequestId set:', window.currentVoiceRequestId);
            // 更新UI，可以包含部分ID用于调试
            if (voiceResultEl) voiceResultEl.innerHTML = `<p><i class="fas fa-microphone-alt fa-beat" style="color:red;"></i> 录音中... (ID: ${window.currentVoiceRequestId.substring(0,8)})</p>`;


            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                console.log("[VOICE] Recording stopped. Audio chunks count:", audioChunks.length);
                // 确保媒体流被关闭，释放麦克风
                stream.getTracks().forEach(track => track.stop());

                if (audioChunks.length === 0) {
                    if (voiceResultEl) voiceResultEl.textContent = "未录到有效音频。";
                    console.warn("[VOICE] No audio chunks recorded.");
                    startRecordingBtn.disabled = false;
                    stopRecordingBtn.disabled = true;
                    return;
                }

                const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                sendVoiceToServer(audioBlob); // sendVoiceToServer 内部会设置 "处理中..."
                audioChunks = []; // 清空，为下次录音准备

                // 按钮状态的最终控制权在 sendVoiceToServer 成功或失败，以及Socket.IO事件回调中
                // 这里可以暂时保持“停止录音”为禁用，因为处理已经开始
                // startRecordingBtn.disabled = true; // 保持禁用，直到处理完成或失败
                // stopRecordingBtn.disabled = true;  // 已经停止，禁用它
            };

            mediaRecorder.onerror = event => {
                console.error("[VOICE] MediaRecorder error:", event.error);
                alert(`录音出错: ${event.error.name || '未知错误'}`);
                stream.getTracks().forEach(track => track.stop()); // 关闭媒体流
                if (voiceResultEl) voiceResultEl.innerHTML = `<p class="error-message">录音错误: ${escapeHtml(event.error.name || '未知错误')}</p>`;
                startRecordingBtn.disabled = false;
                stopRecordingBtn.disabled = true;
                window.currentVoiceRequestId = null; // 出错时清空ID
            };
            
            mediaRecorder.start(); // 开始录音

        } catch (error) {
            console.error("[VOICE] Error starting recording or getting media:", error);
            alert(`无法访问麦克风或启动录音: ${error.message}`);
            if (voiceResultEl) voiceResultEl.innerHTML = `<p class="error-message">麦克风访问失败: ${escapeHtml(error.message)}</p>`;
            startRecordingBtn.disabled = false;
            stopRecordingBtn.disabled = true;
            window.currentVoiceRequestId = null; // 出错时清空ID
        }
    });

    // “停止录音”按钮的事件监听器
    stopRecordingBtn.addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            console.log("[VOICE] Stop recording button clicked.");
            mediaRecorder.stop(); // 这会触发 mediaRecorder.onstop
        }
        // 按钮状态的更新主要由 onstop 和 onerror 控制，以及后续的Socket.IO事件
        // stopRecordingBtn.disabled = true; // 立即禁用，防止重复点击
        // startRecordingBtn.disabled = false; // 暂时不启用，等待处理结果
    });

    // 语音模块历史记录清除按钮 (如果这个逻辑不在这里，确保它在别处正确初始化)
    document.getElementById('voice-clear-history')?.addEventListener('click', clearVoiceHistory);
}



// --- Model Selector Functions (MODIFIED) ---
async function fetchAndPopulateModels() {
  const modelSelectorEl = document.getElementById('model-selector');
  // const apiProviderDisplayEl = document.getElementById('api-provider-display'); // REMOVED as element is removed from HTML

  if (!modelSelectorEl) {
    console.error("Model selector element (#model-selector) not found in the DOM. Cannot populate models.");
    return;
  }

  modelSelectorEl.innerHTML = '<option value="">正在加载模型...</option>';
  // if (apiProviderDisplayEl) apiProviderDisplayEl.textContent = 'AI模型: 加载中...'; // REMOVED

  try {
    const response = await fetch('/api/available_models', {
      headers: { ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` }) }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`获取模型列表失败: ${response.status} ${response.statusText}. Server: ${errorText}`);
      modelSelectorEl.innerHTML = '<option value="">加载模型失败</option>';
      // if (apiProviderDisplayEl) apiProviderDisplayEl.textContent = 'AI模型: 加载失败'; // REMOVED
      return;
    }

    availableModels = await response.json();
    
    if (Object.keys(availableModels).length === 0) {
      modelSelectorEl.innerHTML = '<option value="">无可用模型</option>';
      // if (apiProviderDisplayEl) apiProviderDisplayEl.textContent = 'AI模型: 无可用'; // REMOVED
      console.warn("No available models received from the backend.");
      return;
    }
    
    console.log("Available models loaded:", availableModels);
    modelSelectorEl.innerHTML = ''; // Clear "loading" or "error"

    const lastSelectedProvider = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY_PROVIDER);
    const lastSelectedModelId = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY_MODEL_ID);
    let isLastSelectedModelStillAvailable = false;
    let firstOptionDetails = null; 

    for (const providerKey in availableModels) {
      if (Object.prototype.hasOwnProperty.call(availableModels, providerKey)) {
        const providerModels = availableModels[providerKey];
        if (Object.keys(providerModels).length === 0) continue;

        const optgroup = document.createElement('optgroup');
        let providerDisplayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
        if (providerKey.toLowerCase() === "openai") providerDisplayName = "OpenAI";
        else if (providerKey.toLowerCase() === "gemini") providerDisplayName = "Google Gemini";
        optgroup.label = providerDisplayName;

        for (const modelId in providerModels) {
          if (Object.prototype.hasOwnProperty.call(providerModels, modelId)) {
            const modelDisplayName = providerModels[modelId];
            const option = document.createElement('option');
            option.value = `${providerKey}:${modelId}`;
            option.textContent = modelDisplayName;
            option.dataset.provider = providerKey;
            option.dataset.modelId = modelId;

            // Set option style for dark/light theme compatibility for dropdown items
            option.style.backgroundColor = "var(--bs-body-bg)";
            option.style.color = "var(--bs-body-color)";

            if (!firstOptionDetails) { 
              firstOptionDetails = { provider: providerKey, model_id: modelId, text: modelDisplayName, value: option.value };
            }

            if (providerKey === lastSelectedProvider && modelId === lastSelectedModelId) {
              option.selected = true;
              isLastSelectedModelStillAvailable = true;
            }

            optgroup.appendChild(option);
          }
        }
        modelSelectorEl.appendChild(optgroup);
      }
    }

    if (modelSelectorEl.options.length === 0) {
      modelSelectorEl.innerHTML = '<option value="">无模型</option>';
      selectedModel.provider = null;
      selectedModel.model_id = null;
    } else if (isLastSelectedModelStillAvailable) {
      // The correct option is already selected via option.selected = true;
      // Now, trigger the handleModelSelectionChange to update the global state and localStorage
      handleModelSelectionChange({ target: modelSelectorEl });
    } else if (firstOptionDetails) { 
      // If no stored selection or stored selection is no longer available, select the first one
      modelSelectorEl.value = firstOptionDetails.value;
      handleModelSelectionChange({ target: modelSelectorEl });
    } else { 
      console.error("Logic error in populating model selector - no first option found, though options exist.");
      modelSelectorEl.innerHTML = '<option value="">错误</option>';
    }

    // Ensure event listener is added only once, or managed if function is re-run
    modelSelectorEl.removeEventListener('change', handleModelSelectionChange); // Remove previous if any
    modelSelectorEl.addEventListener('change', handleModelSelectionChange);

  } catch (error) {
    console.error("Error fetching or populating models:", error);
    modelSelectorEl.innerHTML = '<option value="">加载模型失败</option>';
    // if (apiProviderDisplayEl) apiProviderDisplayEl.textContent = 'AI模型: 加载失败'; // REMOVED
  }
}

function handleModelSelectionChange(event) {
  const selector = event.target;
  const selectedOption = selector.options[selector.selectedIndex];
  // const apiProviderDisplayEl = document.getElementById('api-provider-display'); // REMOVED

  if (selectedOption && selectedOption.dataset.provider && selectedOption.dataset.modelId) {
    selectedModel.provider = selectedOption.dataset.provider;
    selectedModel.model_id = selectedOption.dataset.modelId;

    localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY_PROVIDER, selectedModel.provider);
    localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY_MODEL_ID, selectedModel.model_id);

    console.log("Model selected:", JSON.stringify(selectedModel));
  } else {
    selectedModel.provider = null;
    selectedModel.model_id = null;
    localStorage.removeItem(MODEL_SELECTOR_STORAGE_KEY_PROVIDER);
    localStorage.removeItem(MODEL_SELECTOR_STORAGE_KEY_MODEL_ID);
    console.warn("Invalid model selection or no model selected.");
  }
}




// --- Model Selector Functions ---
// async function fetchAndPopulateModels() {
//     const modelSelectorEl = document.getElementById('model-selector');
//     const apiProviderDisplayEl = document.getElementById('api-provider-display');

//     if (!modelSelectorEl || !apiProviderDisplayEl) {
//         console.error("Model selector or API provider display element not found in the DOM.");
//         if (modelSelectorEl) modelSelectorEl.innerHTML = '<option value="">Error: UI Missing</option>';
//         if (apiProviderDisplayEl) apiProviderDisplayEl.textContent = 'AI模型: UI错误';
//         return;
//     }

//     modelSelectorEl.innerHTML = '<option value="">正在加载模型...</option>';
//     apiProviderDisplayEl.textContent = 'AI模型: 加载中...';
//     apiProviderDisplayEl.title = '正在从服务器获取可用模型列表';

//     try {
//         const response = await fetch('/api/available_models', {
//             headers: {
//                 // Assuming TOKEN is a global variable holding your auth token
//                 ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` })
//             }
//         });

//         if (!response.ok) {
//             const errorText = await response.text();
//             throw new Error(`获取模型列表失败: ${response.status} ${response.statusText}. ${errorText}`);
//         }
//         availableModels = await response.json(); // Expected: { "openai": {"gpt-4o": "OpenAI GPT-4o"}, ... }
        
//         if (Object.keys(availableModels).length === 0) {
//             modelSelectorEl.innerHTML = '<option value="">无可用模型</option>';
//             apiProviderDisplayEl.textContent = 'AI模型: 无可用';
//             console.warn("No available models received from the backend.");
//             return;
//         }
        
//         console.log("Available models loaded:", availableModels);
//         modelSelectorEl.innerHTML = ''; // Clear "loading" message

//         const lastSelectedProvider = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY_PROVIDER);
//         const lastSelectedModelId = localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY_MODEL_ID);
//         let isLastSelectedModelStillAvailable = false;

//         for (const providerKey in availableModels) {
//             if (Object.prototype.hasOwnProperty.call(availableModels, providerKey)) {
//                 const providerModels = availableModels[providerKey];
//                 if (Object.keys(providerModels).length === 0) continue; // Skip empty providers

//                 const optgroup = document.createElement('optgroup');
//                 // Attempt to create a friendlier display name for the provider
//                 let providerDisplayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
//                 if (providerKey.toLowerCase() === "openai") providerDisplayName = "OpenAI";
//                 else if (providerKey.toLowerCase() === "gemini") providerDisplayName = "Google Gemini";
//                 else if (providerKey.toLowerCase() === "claude") providerDisplayName = "Anthropic Claude";
//                 else if (providerKey.toLowerCase() === "grok") providerDisplayName = "xAI Grok";
//                 optgroup.label = providerDisplayName;

//                 for (const modelId in providerModels) {
//                     if (Object.prototype.hasOwnProperty.call(providerModels, modelId)) {
//                         const modelDisplayName = providerModels[modelId];
//                         const option = document.createElement('option');
//                         // Store provider and model_id in a single value for simplicity,
//                         // or use dataset attributes as you prefer.
//                         option.value = `${providerKey}:${modelId}`;
//                         option.textContent = modelDisplayName;
//                         // Store in dataset for easier access on change
//                         option.dataset.provider = providerKey;
//                         option.dataset.modelId = modelId;

//                         if (providerKey === lastSelectedProvider && modelId === lastSelectedModelId) {
//                             option.selected = true;
//                             isLastSelectedModelStillAvailable = true;
//                         }
//                         optgroup.appendChild(option);
//                     }
//                 }
//                 modelSelectorEl.appendChild(optgroup);
//             }
//         }

//         if (modelSelectorEl.options.length === 0) {
//             modelSelectorEl.innerHTML = '<option value="">无可用模型</option>';
//             apiProviderDisplayEl.textContent = 'AI模型: 无可用';
//             selectedModel.provider = null;
//             selectedModel.model_id = null;
//         } else if (isLastSelectedModelStillAvailable) {
//             // Trigger change to set selectedModel and update display for the stored selection
//             handleModelSelectionChange({ target: modelSelectorEl });
//         } else {
//             // If no stored selection or stored selection is no longer available, select the first option
//             modelSelectorEl.selectedIndex = 0;
//             handleModelSelectionChange({ target: modelSelectorEl });
//         }

//         modelSelectorEl.addEventListener('change', handleModelSelectionChange);

//     } catch (error) {
//         console.error("Error fetching or populating models:", error);
//         modelSelectorEl.innerHTML = '<option value="">加载模型失败</option>';
//         apiProviderDisplayEl.textContent = 'AI模型: 加载失败';
//         apiProviderDisplayEl.title = `错误: ${error.message}`;
//     }
// }


// function handleModelSelectionChange(event) {
//     const selector = event.target;
//     const selectedOption = selector.options[selector.selectedIndex];

//     if (selectedOption && selectedOption.dataset.provider && selectedOption.dataset.modelId) {
//         selectedModel.provider = selectedOption.dataset.provider;
//         selectedModel.model_id = selectedOption.dataset.modelId;

//         localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY_PROVIDER, selectedModel.provider);
//         localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY_MODEL_ID, selectedModel.model_id);

//         const apiProviderDisplayEl = document.getElementById('api-provider-display');
//         if (apiProviderDisplayEl) {
//             const modelDisplayName = selectedOption.textContent;
//             // Get provider display name from optgroup label
//             const providerDisplayName = selectedOption.parentElement.label || selectedModel.provider.toUpperCase();
//             apiProviderDisplayEl.textContent = `AI模型: ${modelDisplayName}`;
//             apiProviderDisplayEl.title = `当前模型: ${modelDisplayName} (来自 ${providerDisplayName})`;
//         }
//         console.log("Model selected:", JSON.stringify(selectedModel));
        
//         // Optional: You could emit an event to the server if it needs to know about the change immediately
//         // if (socket && socket.connected) {
//         // socket.emit('ui_model_changed', { provider: selectedModel.provider, model_id: selectedModel.model_id });
//         // }
//     } else {
//         // Handle empty or invalid selection if necessary
//         selectedModel.provider = null;
//         selectedModel.model_id = null;
//         const apiProviderDisplayEl = document.getElementById('api-provider-display');
//         if (apiProviderDisplayEl) {
//             apiProviderDisplayEl.textContent = 'AI模型: 请选择';
//             apiProviderDisplayEl.title = '请从下拉列表中选择一个AI模型';
//         }
//         console.warn("Invalid model selection or no model selected.");
//     }
// }


function applyTheme(themeName) {
    document.body.classList.remove('theme-light', 'theme-dark'); // 先移除所有主题类

    if (themeName === 'dark') {
        document.body.classList.add('theme-dark');
    } else {
        document.body.classList.add('theme-light'); // 默认或明确指定亮色
    }
    
    // 将选择的主题保存到 localStorage
    try {
        localStorage.setItem(THEME_STORAGE_KEY, themeName);
    } catch (e) {
        console.warn("无法访问 localStorage:", e);
    }

    // 更新主题选择下拉菜单的显示值，确保它与当前应用的主题一致
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector && themeSelector.value !== themeName) {
        themeSelector.value = themeName;
    }
    console.log(`主题已应用: ${themeName}`);
}

/**
 * 页面加载时加载并应用保存的主题，或应用默认主题。
 */
function loadAndApplyInitialTheme() {
    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    } catch (e) {
        console.warn("无法从 localStorage 读取主题:", e);
    }
    
    const themeSelector = document.getElementById('theme-selector');

    if (savedTheme && (savedTheme === 'light' || savedTheme === 'dark')) {
        applyTheme(savedTheme);
        // themeSelector.value 会在 applyTheme 中设置
    } else {
        // 如果没有保存的主题，或者保存的值无效，则应用默认主题（例如 'light'）
        // 未来，"跟随系统"的逻辑会在这里扩展
        applyTheme('light'); // 默认应用亮色主题
    }
}

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


/**
 * 初始化主题选择器的事件监听和初始主题加载。
 */
function initThemeSelector() {
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) {
        themeSelector.addEventListener('change', (event) => {
            applyTheme(event.target.value);
        });
    }
    // 在所有UI元素都可能已加载后应用初始主题
    loadAndApplyInitialTheme();
}

// --- NEW: Main Navigation Dropdown Logic ---
function initMainNavigation() {
  const navDropdownItems = document.querySelectorAll('.main-navigation-dropdown-container .dropdown-item.nav-dropdown-item');
  const dropdownButtonTextSpan = document.getElementById('selected-feature-name');
  const leftPanelContainer = document.querySelector('aside.left-panel');
  const rightPanelContainer = document.querySelector('main.right-panel');

  // Check if essential elements exist
  if (!navDropdownItems.length || !dropdownButtonTextSpan || !leftPanelContainer || !rightPanelContainer) {
    console.warn("Main navigation UI elements missing for initMainNavigation.");
    if (dropdownButtonTextSpan) dropdownButtonTextSpan.innerHTML = `<i class="fas fa-exclamation-triangle me-2"></i> Nav Error`;
    return;
  }

  // Switch to active feature and update UI accordingly
  function switchActiveFeature(featureKey) {
    let newButtonText = "选择功能"; 
    let newButtonIconHTML = '<i class="fas fa-bars me-2"></i>'; 

    // Deactivate previous content
    leftPanelContainer.querySelectorAll('.feature-content-block').forEach(content => content.classList.remove('active'));
    rightPanelContainer.querySelectorAll('.feature-content-block').forEach(content => content.classList.remove('active'));
    navDropdownItems.forEach(item => item.classList.remove('active'));

    // Find and activate the target content blocks
    const targetLeftPanelContent = document.getElementById(`left-panel-${featureKey}`);
    const targetRightPanelContent = document.getElementById(`right-panel-${featureKey}`);
    const targetNavItem = Array.from(navDropdownItems).find(item => item.dataset.feature === featureKey);

    if (targetLeftPanelContent && targetRightPanelContent && targetNavItem) {
      targetLeftPanelContent.classList.add('active');
      targetRightPanelContent.classList.add('active');
      targetNavItem.classList.add('active'); 
      
      newButtonText = targetNavItem.textContent.trim();
      const iconEl = targetNavItem.querySelector('i.fas');
      newButtonIconHTML = iconEl ? iconEl.outerHTML + " " : "";
    } else {
      console.warn(`Content blocks or nav item not found for feature: ${featureKey}. Defaulting if possible.`);
      if (navDropdownItems.length > 0 && navDropdownItems[0].dataset.feature) {
        const firstFeatureKey = navDropdownItems[0].dataset.feature;
        document.getElementById(`left-panel-${firstFeatureKey}`)?.classList.add('active');
        document.getElementById(`right-panel-${firstFeatureKey}`)?.classList.add('active');
        navDropdownItems[0].classList.add('active');
        newButtonText = navDropdownItems[0].textContent.trim();
        const iconEl = navDropdownItems[0].querySelector('i.fas');
        newButtonIconHTML = iconEl ? iconEl.outerHTML + " " : "";
        featureKey = firstFeatureKey; 
      }
    }
    
    dropdownButtonTextSpan.innerHTML = `${newButtonIconHTML}${newButtonText}`;
    if (featureKey === 'ai-chat') document.getElementById('chat-chat-input')?.focus();
    localStorage.setItem(ACTIVE_MAIN_FEATURE_TAB_KEY, featureKey);
    console.log(`Switched to main feature: ${featureKey}`);
  }

  // Event listener for dropdown item clicks
  navDropdownItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const featureKey = item.dataset.feature; 
      if (featureKey) switchActiveFeature(featureKey);
    });
  });

  // Initialize with the last active feature or default feature
  const lastActiveFeature = localStorage.getItem(ACTIVE_MAIN_FEATURE_TAB_KEY);
  let initialFeatureKey = null;
  const activeHTMLNavItem = Array.from(navDropdownItems).find(item => item.classList.contains('active'));

  if (activeHTMLNavItem && activeHTMLNavItem.dataset.feature) initialFeatureKey = activeHTMLNavItem.dataset.feature;
  else if (lastActiveFeature && Array.from(navDropdownItems).find(item => item.dataset.feature === lastActiveFeature)) initialFeatureKey = lastActiveFeature;
  else if (navDropdownItems.length > 0 && navDropdownItems[0].dataset.feature) initialFeatureKey = navDropdownItems[0].dataset.feature;

  if (initialFeatureKey) switchActiveFeature(initialFeatureKey);
  else if (dropdownButtonTextSpan) dropdownButtonTextSpan.innerHTML = `<i class="fas fa-exclamation-triangle me-2"></i> 无功能`;
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

// --- NEW: Left Panel Top Controls Initialization ---
// --- NEW: Left Panel Top Controls Initialization ---
function initLeftPanelTopControls() {
    const globalToggleButton = document.getElementById('global-sidebar-toggle');
    const mainContent = document.querySelector('.main-content'); // 页面上通常只有一个 .main-content

    if (!globalToggleButton || !mainContent) {
        console.warn('Global sidebar toggle button (#global-sidebar-toggle) or .main-content element not found. Sidebar toggle functionality will not work.');
        // 即使按钮没找到，下面的搜索框和动作按钮初始化仍应尝试执行
    } else {
        // 辅助函数：更新全局切换按钮的图标
        function updateGlobalButtonIcon(isCollapsed) {
            const icon = globalToggleButton.querySelector('i');
            if (icon) {
                if (isCollapsed) {
                    icon.classList.remove('fa-bars');
                    icon.classList.add('fa-chevron-left'); // 侧边栏折叠时，图标变为向左箭头
                } else {
                    icon.classList.remove('fa-chevron-left');
                    icon.classList.add('fa-bars'); // 侧边栏展开时，图标为菜单横杠
                }
            }
        }

        // 为全局切换按钮添加点击事件监听器
        globalToggleButton.addEventListener('click', () => {
            mainContent.classList.toggle('sidebar-collapsed');
            const isCollapsed = mainContent.classList.contains('sidebar-collapsed');
            localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed); // SIDEBAR_COLLAPSED_KEY 需已定义
            console.log(`Global sidebar toggled via header button. Collapsed: ${isCollapsed}`);
            updateGlobalButtonIcon(isCollapsed);
        });

        // 从 localStorage 恢复侧边栏折叠状态，并设置全局按钮的初始图标
        const savedSidebarState = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
        if (savedSidebarState) {
            mainContent.classList.add('sidebar-collapsed');
        }
        // 总是根据初始状态（来自存储或默认）更新全局按钮的图标
        updateGlobalButtonIcon(mainContent.classList.contains('sidebar-collapsed'));
    }

    // --- 以下是原函数中关于搜索框和其他顶部动作按钮的初始化代码 ---
    // --- 这些元素仍然在左侧面板的各功能区内，所以这部分逻辑保留 ---

    // 搜索框事件监听器
    document.getElementById('screenshot-history-search-input')?.addEventListener('input', (e) => {
        console.log("Screenshot search:", e.target.value);
        /* TODO: Filter #ss-history-list */
    });

    document.getElementById('chat-session-search-input')?.addEventListener('input', (e) => {
        console.log("Chat search:", e.target.value);
        /* TODO: Filter #chat-session-list */
    });

    document.getElementById('voice-history-search-input')?.addEventListener('input', (e) => {
        console.log("Voice search:", e.target.value);
        /* TODO: Filter #voice-history-list */
    });

    // 左侧面板顶部的新建/操作按钮 (这些按钮在各自的 .left-panel-top-controls 内)
    document.getElementById('ss-capture-btn-top')?.addEventListener('click', () => {
        if (typeof requestScreenshot === 'function') requestScreenshot();
        else console.warn("requestScreenshot function not defined for top button.");
    });

    document.getElementById('chat-new-session-btn-top')?.addEventListener('click', () => {
        if (typeof clearCurrentChatDisplay === 'function') clearCurrentChatDisplay(true); // true for new session
        else console.warn("clearCurrentChatDisplay function not defined for top button.");
    });

    document.getElementById('voice-new-recording-btn-top')?.addEventListener('click', () => {
        const startRecordingBtn = document.getElementById('voice-start-recording');
        if (startRecordingBtn && !startRecordingBtn.disabled) startRecordingBtn.click();
        else console.warn("Start recording button not available or not ready.");
    });
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

// --- History & UI Update Functions ---
// 修改后的 addHistoryItem (用于截图历史记录显示)
function addHistoryItem(item) {
    const historyListEl = document.getElementById('ss-history-list');
    if (!historyListEl || !item || !item.image_url) {
        console.warn("Cannot add screenshot history item, list element or item data missing.", item);
        return;
    }

    if (historyListEl.querySelector(`li[data-url="${item.image_url}"]`)) {
        console.log(`Screenshot history item for ${item.image_url} already exists. Updating analysis if newer.`);
        const existingLi = historyListEl.querySelector(`li[data-url="${item.image_url}"]`);
        if (existingLi && typeof item.analysis === 'string' && existingLi.dataset.analysis !== item.analysis) {
            existingLi.dataset.analysis = item.analysis;
            const mainAnalysisEl = document.getElementById('ss-ai-analysis');
            if (mainAnalysisEl && mainAnalysisEl.dataset.sourceUrl === item.image_url) {
                mainAnalysisEl.innerHTML = '';
                const analysisContentDiv = document.createElement('div');
                analysisContentDiv.className = 'message-content';
                if (typeof processAIMessage === 'function') {
                    const tempAiMessageDiv = document.createElement('div');
                    tempAiMessageDiv.className = 'ai-message';
                    tempAiMessageDiv.dataset.provider = item.provider || 'AI';
                    processAIMessage(tempAiMessageDiv, item.analysis, 'history_item_analysis_update');
                    while (tempAiMessageDiv.firstChild) {
                        analysisContentDiv.appendChild(tempAiMessageDiv.firstChild);
                    }
                } else {
                    analysisContentDiv.textContent = item.analysis || '(processAIMessage 未定义)';
                }
                mainAnalysisEl.appendChild(analysisContentDiv);
            }
        }
        return;
    }

    const li = document.createElement('li');
    li.className = 'history-item';
    li.setAttribute('data-url', item.image_url);
    li.dataset.analysis = item.analysis || '';
    li.dataset.prompt = item.prompt || 'Describe this screenshot and highlight anything unusual.';
    li.dataset.timestamp = String(item.timestamp || (Date.now() / 1000));
    li.dataset.provider = item.provider || 'unknown';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'history-item-content-wrapper';

    const img = document.createElement('img');
    img.src = item.image_url + '?t=' + Date.now();
    img.alt = '历史截图缩略图';
    img.loading = 'lazy';
    const timestampDivForError = document.createElement('div');

    img.onerror = () => {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'history-error';
        errorDiv.textContent = '图片加载失败';
        if (img.parentNode) {
            img.parentNode.replaceChild(errorDiv, img);
        } else {
            li.insertBefore(errorDiv, timestampDivForError);
        }
    };

    const timestampDiv = timestampDivForError;
    timestampDiv.className = 'history-item-text';
    const date = new Date(parseFloat(li.dataset.timestamp) * 1000);
    timestampDiv.textContent = date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    timestampDiv.title = date.toLocaleString();

    contentWrapper.appendChild(img);
    contentWrapper.appendChild(timestampDiv);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'history-item-actions';

    if (typeof createDeleteButton === 'function') {
        const deleteBtn = createDeleteButton(() => {
            if (confirm('确定要删除此截图记录及其分析吗?')) {
                if (typeof clearMainScreenshotDisplay === 'function') {
                    const mainAnalysisEl = document.getElementById('ss-ai-analysis');
                    if (mainAnalysisEl && mainAnalysisEl.dataset.sourceUrl === item.image_url) {
                        clearMainScreenshotDisplay();
                    }
                }
                li.remove();
                console.log(`Screenshot history item ${item.image_url} deleted.`);
            }
        });
        actionsContainer.appendChild(deleteBtn);
    }

    li.appendChild(contentWrapper);
    li.appendChild(actionsContainer);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.history-item-actions')) {
            return;
        }

        const mainAnalysisEl = document.getElementById('ss-ai-analysis');
        const mainImagePreviewEl = document.getElementById('ss-main-preview-image');
        const cropCurrentBtn = document.getElementById('ss-crop-current-btn');

        if (mainAnalysisEl) {
            mainAnalysisEl.innerHTML = '';
            const analysisContentDiv = document.createElement('div');
            analysisContentDiv.className = 'message-content';
            const analysisText = li.dataset.analysis || '此截图没有分析结果。';
            const analysisProvider = li.dataset.provider || 'AI';
            const tempAiMessageDiv = document.createElement('div');
            tempAiMessageDiv.className = 'ai-message';
            tempAiMessageDiv.dataset.provider = analysisProvider;
            if (typeof processAIMessage === 'function') {
                processAIMessage(tempAiMessageDiv, analysisText, 'history_click_ss_analysis');
                while (tempAiMessageDiv.firstChild) {
                    analysisContentDiv.appendChild(tempAiMessageDiv.firstChild);
                }
            } else {
                analysisContentDiv.textContent = analysisText + " (processAIMessage 未定义)";
            }
            mainAnalysisEl.appendChild(analysisContentDiv);
            mainAnalysisEl.dataset.sourceUrl = item.image_url;
        }

        if (mainImagePreviewEl) {
            mainImagePreviewEl.src = item.image_url + '?t=' + Date.now();
            mainImagePreviewEl.alt = `截图预览 - ${new Date(parseFloat(li.dataset.timestamp) * 1000).toLocaleString()}`;
            mainImagePreviewEl.style.display = 'block';
            mainImagePreviewEl.dataset.currentUrl = item.image_url;
            if (cropCurrentBtn) cropCurrentBtn.style.display = 'inline-block';
        } else {
            if (cropCurrentBtn) cropCurrentBtn.style.display = 'none';
        }

        const currentActive = historyListEl.querySelector('.active-screenshot-item');
        if (currentActive) currentActive.classList.remove('active-screenshot-item');
        li.classList.add('active-screenshot-item');
    });

    historyListEl.insertBefore(li, historyListEl.firstChild);
}

function saveCurrentChatSessionId() {
    if (currentChatSessionId) { 
        localStorage.setItem('currentChatSessionId', currentChatSessionId); 
    } else { 
        localStorage.removeItem('currentChatSessionId'); 
    }
}

// --- initAllFeatures (Main entry point for UI initialization) ---
function initAllFeatures() {
  console.log("--- Initializing All Features ---");

  // Load token from meta tag
  const tokenMeta = document.querySelector('meta[name="token"]');
  if (tokenMeta?.content && tokenMeta.content !== "{{ token }}") {
    TOKEN = tokenMeta.content;
    console.log("Token loaded:", TOKEN);
  } else {
    console.warn('Token meta tag missing or placeholder.');
  }

  // Initialize Markdown renderer and theme selector if functions are available
  if (typeof initMarkdownRenderer === 'function') initMarkdownRenderer();
  if (typeof initThemeSelector === 'function') initThemeSelector();

  // Initialize main navigation dropdown
  initMainNavigation(); // Initialize NEW dropdown navigation first

  // Fetch and populate models
  if (typeof fetchAndPopulateModels === 'function') {
    fetchAndPopulateModels();
  } else {
    console.error("CRITICAL: fetchAndPopulateModels not defined!");
  }

  // Initialize top controls for left panel
  initLeftPanelTopControls(); // NEW: Initialize top controls for left panels
  //initVoiceFeature()

  // Render LaTeX in message content and analysis sections
  if (typeof renderLatexInElement === 'function') {
    setTimeout(() => { 
      document.querySelectorAll('.message-content, .ai-analysis').forEach(element => {
        try { 
          renderLatexInElement(element); 
        } catch (e) { 
          console.error("KaTeX Error on initial load:", e, element); 
        }
      });
    }, 300);
  }

  // Initialize specific feature handlers
  if (typeof initScreenshotAnalysisHandlers === 'function') initScreenshotAnalysisHandlers();
  if (typeof initAiChatHandlers === 'function') {
    initAiChatHandlers(); // This should also call initChatInputBarButtons
    //initVoiceFeature();
  }
  if (typeof initVoiceAnswerHandlers === 'function') initVoiceAnswerHandlers();

  // Initialize Socket.IO connection
  if (typeof initSocketIO === 'function') {
    initSocketIO();
  } else {
    console.error("CRITICAL: initSocketIO not defined!");
  }

  // Load chat sessions from storage
  if (typeof loadChatSessionsFromStorage === 'function') {
    loadChatSessionsFromStorage();
  } else {
    console.warn("loadChatSessionsFromStorage not defined.");
  }

  console.log("--- Application initialization complete ---");
}


// 修改后的 addChatHistoryItem (AI 对话历史)
function addChatHistoryItem(session) {
    const historyListEl = document.getElementById('chat-session-list');
    if (!historyListEl || !session || !session.id) {
        console.warn("Cannot add chat session item, list or session data missing.", session);
        return;
    }

    const existingLi = historyListEl.querySelector(`li[data-session-id="${session.id}"]`);
    if (existingLi) existingLi.remove();

    const li = document.createElement('li');
    li.className = 'history-item chat-history-item';
    li.setAttribute('data-session-id', String(session.id));

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'history-item-content-wrapper';

    const titleText = session.title || '无标题对话';
    const timestamp = new Date(session.id).toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });

    const titleDiv = document.createElement('div');
    titleDiv.title = escapeHtml(titleText);
    titleDiv.style.fontWeight = '500';
    titleDiv.style.whiteSpace = 'nowrap';
    titleDiv.style.overflow = 'hidden';
    titleDiv.style.textOverflow = 'ellipsis';
    titleDiv.innerHTML = `<i class="fas fa-comment"></i> ${escapeHtml(titleText)}`;

    const timeDiv = document.createElement('div');
    timeDiv.style.fontSize = '0.75em';
    timeDiv.style.color = '#666';
    timeDiv.textContent = timestamp;

    contentWrapper.appendChild(titleDiv);
    contentWrapper.appendChild(timeDiv);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'history-item-actions';

    if (typeof createDeleteButton === 'function') {
        const deleteBtn = createDeleteButton(() => {
            if (confirm(`确定要删除对话 \"${escapeHtml(titleText)}\"?`)) {
                chatSessions = chatSessions.filter(s => s.id !== session.id);
                li.remove();
                if (currentChatSessionId === session.id && typeof clearCurrentChatDisplay === 'function') {
                    clearCurrentChatDisplay();
                }
                if (typeof saveChatSessionsToStorage === 'function') saveChatSessionsToStorage();
            }
        });
        actionsContainer.appendChild(deleteBtn);
    }

    li.appendChild(contentWrapper);
    li.appendChild(actionsContainer);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.history-item-actions')) return;

        const sessionId = Number(li.getAttribute('data-session-id'));
        const clickedSession = chatSessions.find(s => s.id === sessionId);
        if (clickedSession) {
            currentChatSessionId = clickedSession.id;
            if (typeof renderChatHistory === 'function') renderChatHistory(clickedSession.history);

            historyListEl.querySelectorAll('.history-item.active-session').forEach(item => item.classList.remove('active-session'));
            li.classList.add('active-session');

            document.getElementById('chat-chat-input')?.focus();
            if (typeof saveCurrentChatSessionId === 'function') saveCurrentChatSessionId();
        }
    });

    historyListEl.insertBefore(li, historyListEl.firstChild);
}


function initSocketIO() {
    socket = io({
        path: '/socket.io',
        auth: { token: TOKEN },
        transports: ['websocket']
    });

    socket.on('connect', function() {
        console.log('[Socket] Connected to server');
        const statusEl = document.getElementById('connection-status');
        if (statusEl) statusEl.textContent = '已连接';
        if (typeof getApiInfo === 'function') getApiInfo(); 
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
        // if (contentDiv) renderLatexInElement(contentDiv);
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

    socket.on('chat_response', function(data) {
    console.log('<<<<< [Socket RECEIVED] chat_response (NON-STREAMING) >>>>>', data);
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) {
        console.error("[chat_response] Critical: chatHistoryEl (#chat-chat-history) not found.");
        return;
    }

    // 1. 移除思考中指示器
    // 假设你的思考指示器有 data-request-id="${data.request_id}" 并且 class 'ai-thinking'
    const thinkingDiv = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
    if (thinkingDiv && typeof removeThinkingIndicator === 'function') {
        removeThinkingIndicator(chatHistoryEl, thinkingDiv);
    } else if (thinkingDiv) {
        thinkingDiv.remove(); // 简单的移除
        console.warn("removeThinkingIndicator function not found, used direct remove().");
    }

    // 2. 创建或找到用于显示AI回复的div
    // 通常，对于非流式，我们可能不会预先创建占位div，而是直接追加新消息。
    // 但如果你的 sendChatMessage 为非流式也创建了占位（例如 thinkingDiv 本身就是占位），则需要找到它。
    // 这里我们假设直接创建一个新的AI消息div。
    let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`);
    if (!aiDiv) { // 如果流式逻辑意外地没有完全清理，或者没有占位符
        aiDiv = document.createElement('div');
        aiDiv.className = 'ai-message'; // 基础类名
        aiDiv.dataset.requestId = data.request_id; // 绑定 request ID
        chatHistoryEl.appendChild(aiDiv);
    }
    // 如果 aiDiv 已经存在（例如由 thinkingDiv 转换而来），确保它没有 streaming span
    const streamingSpan = aiDiv.querySelector('.ai-response-text-streaming');
    if (streamingSpan) streamingSpan.remove();


    if (data.provider) { // 如果服务器提供了 provider 信息
        aiDiv.dataset.provider = data.provider;
    }
    
    // 3. 更新界面显示 (调用 processAIMessage)
    // processAIMessage 会处理 Markdown, KaTeX 等，并放入 aiDiv
    if (typeof processAIMessage === 'function') {
        processAIMessage(aiDiv, data.message || 'AI未返回信息。', "chat_response_non_stream");
    } else {
        console.error("processAIMessage function is not defined! Cannot render AI message.");
        // Fallback: display raw text if processAIMessage is missing
        const tempContentDiv = document.createElement('div');
        tempContentDiv.className = 'message-content';
        tempContentDiv.textContent = data.message || 'AI未返回信息。 (Renderer missing)';
        // 如果 aiDiv 还没有 provider strong 标签，可以简单添加
        let strongTag = aiDiv.querySelector('strong');
        if (!strongTag) {
            strongTag = document.createElement('strong');
            strongTag.textContent = `${data.provider || 'AI'}: `;
            aiDiv.insertBefore(strongTag, aiDiv.firstChild);
        }
        aiDiv.appendChild(tempContentDiv);
    }
    
    // 4. 滚动到底部
    if (typeof scrollToChatBottom === 'function') {
        scrollToChatBottom(chatHistoryEl);
    }

    // 5. 更新 localStorage 中的聊天历史 (与 chat_stream_end 中的逻辑非常相似)
    // 假设 currentChatSessionId 和 chatSessions 是可访问的
    const activeSessionId = data.session_id || currentChatSessionId; 
    if (activeSessionId && typeof chatSessions !== 'undefined' && typeof saveChatSessionsToStorage === 'function') {
        const sessionToUpdate = chatSessions.find(s => s.id === activeSessionId);
        if (sessionToUpdate) {
            // 查找内存中对应的AI消息占位符 (它应该有 temp_id)
            const messageIndex = sessionToUpdate.history.findIndex(
                msg => msg.role === 'model' && msg.temp_id === data.request_id 
            );
            if (messageIndex !== -1) {
                sessionToUpdate.history[messageIndex].parts = [{ text: data.message || '' }];
                if (data.provider) {
                    sessionToUpdate.history[messageIndex].provider = data.provider;
                }
                delete sessionToUpdate.history[messageIndex].temp_id; // **非常重要：移除temp_id**
                console.log(`[History] Updated AI message in session ${activeSessionId} for request ${data.request_id} (non-stream) and removed temp_id.`);
                saveChatSessionsToStorage();
            } else {
                // 如果没有找到占位符，这可能表示 sendChatMessage 没有为非流式请求添加占位符
                // 或者 request_id 管理仍有问题。
                // 一个简化的处理可以是，如果找不到就直接追加（但这可能导致重复或顺序问题）
                console.warn(`[History] Could not find placeholder AI message (non-stream) for request ${data.request_id} in session ${activeSessionId}. Appending new message.`);
                sessionToUpdate.history.push({
                    role: 'model',
                    parts: [{ text: data.message || '' }],
                    provider: data.provider || 'AI'
                    // 不应该有 temp_id 因为这是最终消息
                });
                saveChatSessionsToStorage();
            }
        } else {
            console.warn(`[History] Could not find session ${activeSessionId} to update AI message (non-stream).`);
        }
    } else {
        console.warn("[History] No active session ID found or chatSessions/saveChatSessionsToStorage not available for non-stream AI message history update.");
    }
});



    socket.on('new_screenshot', function(data) {
    console.log('<<<<< [Socket RECEIVED] new_screenshot >>>>>', data);
    // data 预期格式: { image_url: "...", analysis: "...", prompt: "...", timestamp: ..., provider: "..." }

    if (typeof addHistoryItem === 'function') {
        addHistoryItem(data); // addHistoryItem 会创建列表项并处理点击事件
    } else {
        console.warn("Function addHistoryItem is not defined. Cannot add to screenshot history.");
    }

    // 可选：如果你希望新截图立即显示在主区域（而不仅仅是添加到历史列表）
    // 通常是点击历史条目才显示在主区域，但这里提供一个立即显示的选择
    const shouldDisplayImmediately = false; // 改为 true 如果你想立即显示
    if (shouldDisplayImmediately) {
        const mainAnalysisEl = document.getElementById('ss-ai-analysis');
        const mainImagePreviewEl = document.getElementById('ss-main-preview-image');

        if (mainAnalysisEl) {
            mainAnalysisEl.innerHTML = ''; // 清空
            const analysisContentDiv = document.createElement('div');
            analysisContentDiv.className = 'message-content';
            processAIMessage(analysisContentDiv, data.analysis || 'AI分析完成，但无文本结果。', 'new_screenshot_immediate_analysis');
            mainAnalysisEl.appendChild(analysisContentDiv);
            mainAnalysisEl.dataset.sourceUrl = data.image_url;
        }
        if (mainImagePreviewEl) {
            mainImagePreviewEl.src = data.image_url + '?t=' + Date.now();
            mainImagePreviewEl.alt = `截图预览 - ${new Date((data.timestamp || Date.now()/1000) * 1000).toLocaleString()}`;
            mainImagePreviewEl.style.display = 'block';
        }
    }
});

socket.on('analysis_result', function(data) {
    console.log('<<<<< [Socket RECEIVED] analysis_result >>>>>', data);
    // data 预期格式: { request_id: "?", image_url: "...", analysis: "...", provider: "...", prompt: "...", timestamp: ... }
    // 这个事件通常是在特定分析任务（如裁剪后分析，或初始上传后的分析）完成后发送的。
    // new_screenshot 事件可能已经包含了初始分析。你需要协调这两个事件。

    // 主要用途：如果用户正在查看某个截图，并且这个截图的分析结果更新了，则更新主显示区域。
    const mainAnalysisEl = document.getElementById('ss-ai-analysis');
    if (mainAnalysisEl && mainAnalysisEl.dataset.sourceUrl === data.image_url) {
        console.log(`Updating main analysis display for ${data.image_url} due to 'analysis_result' event.`);
        mainAnalysisEl.innerHTML = ''; // 清空
        const analysisContentDiv = document.createElement('div');
        analysisContentDiv.className = 'message-content';
        processAIMessage(analysisContentDiv, data.analysis || 'AI分析结果为空。', 'analysis_result_update');
        mainAnalysisEl.appendChild(analysisContentDiv);
    }

    // 你可能还需要更新 historyList 中对应条目的 data-analysis 属性，
    // 这样如果用户之后再点击这个历史条目，能看到最新的分析。
    const historyListEl = document.getElementById('ss-history-list');
    if (historyListEl) {
        const listItem = historyListEl.querySelector(`li[data-url="${data.image_url}"]`);
        if (listItem) {
            listItem.dataset.analysis = data.analysis || '';
            console.log(`Updated data-analysis for history item ${data.image_url}`);
        }
    }
});

socket.on('analysis_error', function(data) {
    console.error('<<<<< [Socket RECEIVED] analysis_error >>>>>', data);
    // data: { request_id: "?", image_url: "...", error: "..." }
    const mainAnalysisEl = document.getElementById('ss-ai-analysis');
    // 如果错误是针对当前显示的图片，或者主分析区是空的/初始状态
    if (mainAnalysisEl && (mainAnalysisEl.dataset.sourceUrl === data.image_url || 
        mainAnalysisEl.textContent.includes('请在左侧点击历史记录') || 
        mainAnalysisEl.textContent.includes('等待截屏和分析中'))) {
        mainAnalysisEl.innerHTML = `<p class="error-message"><strong>图片分析错误 (${data.image_url || '未知图片'}):</strong> ${escapeHtml(data.error)}</p>`;
    }
    // 也可以在对应的历史条目旁显示错误图标
    const historyListEl = document.getElementById('ss-history-list');
    if (historyListEl) {
        const listItem = historyListEl.querySelector(`li[data-url="${data.image_url}"]`);
        if (listItem) {
            // 示例：添加一个错误提示到历史条目
            let errorHint = listItem.querySelector('.history-item-error-hint');
            if (!errorHint) {
                errorHint = document.createElement('span');
                errorHint.className = 'history-item-error-hint';
                errorHint.style.color = 'red';
                errorHint.style.fontSize = '0.8em';
                errorHint.textContent = ' (分析失败)';
                const timestampDiv = listItem.querySelector('.history-item-text');
                if(timestampDiv) timestampDiv.appendChild(errorHint);
            }
        }
    }
});

    socket.on('stt_result', function(data) {
        console.log('<<<<< [Socket RECEIVED] stt_result >>>>>', data);
        const voiceResultEl = document.getElementById('voice-result');
        // 确保 window.currentVoiceRequestId 在开始录音时已设置，并与 data.request_id 匹配
        if (voiceResultEl && data.request_id === window.currentVoiceRequestId) {
            let currentHTML = voiceResultEl.innerHTML;
            // 尝试更安全地清除 "处理中..." 或 "AI正在回复..."
            const processingMessages = ['处理中...', 'AI正在回复...'];
            processingMessages.forEach(msg => {
                currentHTML = currentHTML.replace(new RegExp(`<p.*?>${msg}</p>`, 'gi'), ''); // 移除包含这些文本的<p>标签
                currentHTML = currentHTML.replace(msg, ''); // 直接替换文本
            });
            if (currentHTML.trim() === '<div class="system-message">点击下方按钮开始录音，识别结果和 AI 回答将显示在此处。</div>' || currentHTML.trim() === '') {
                currentHTML = ''; // 如果是初始消息或空，则清空
            }

            voiceResultEl.innerHTML = currentHTML + 
                                    `<p><strong>识别到 (${data.provider || 'STT'}):</strong> ${escapeHtml(data.transcript)}</p>` +
                                    `<p>AI正在回复...</p>`; // 提示用户AI正在处理
            scrollToChatBottom(voiceResultEl); // 如果 voiceResultEl 是可滚动的
        }
    });

    socket.on('stt_error', function(data) {
        console.error('<<<<< [Socket RECEIVED] stt_error >>>>>', data);
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data.request_id === window.currentVoiceRequestId) {
            voiceResultEl.innerHTML = `<p class="error-message"><strong>语音识别错误 (${data.provider || 'STT'}):</strong> ${escapeHtml(data.error)}</p>`;
            // 重置录音按钮状态
            document.getElementById('voice-start-recording').disabled = false;
            document.getElementById('voice-stop-recording').disabled = true;
        }
    });

    socket.on('voice_chat_response', function(data) {
        console.log('<<<<< [Socket RECEIVED] voice_chat_response >>>>>', data); // **关键日志**
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl && data.request_id === window.currentVoiceRequestId) {
            voiceResultEl.innerHTML = ''; // 清空之前的所有状态

            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果 (<span class="math-inline">\{data\.stt\_provider \|\| 'STT'\}\)\:</strong\><div class\="message\-content\-simple"\></span>{escapeHtml(data.transcript || '未提供识别文本')}</div></div>`;

            const aiResponseContainer = document.createElement('div');
            aiResponseContainer.innerHTML = `<strong><i class="fas fa-robot"></i> AI回答 (${data.chat_provider || 'AI'}):</strong>`;

            const aiMessageDiv = document.createElement('div');
            aiMessageDiv.className = 'ai-message'; // 复用聊天消息样式
            aiMessageDiv.dataset.provider = data.chat_provider || 'AI'; 
            processAIMessage(aiMessageDiv, data.message || 'AI未返回有效回复。', 'voice_chat_response'); // 使用 processAIMessage 渲染

            aiResponseContainer.appendChild(aiMessageDiv);

            voiceResultEl.innerHTML = transcriptHtml + '<hr>';
            voiceResultEl.appendChild(aiResponseContainer);

            addVoiceHistoryItem({ // 添加到左侧语音历史
                transcript: data.transcript,
                response: data.message,
                // provider: data.chat_provider // 可选
            });

            // 重置录音按钮状态
            document.getElementById('voice-start-recording').disabled = false;
            document.getElementById('voice-stop-recording').disabled = true;
            scrollToChatBottom(voiceResultEl);
        }
    });
    
    socket.on('api_info', function(data) {
        console.log('<<<<< [Socket RECEIVED] api_info >>>>>', data);
        if (typeof updateApiInfo === 'function') {
            updateApiInfo(data); // data 应该包含 { provider: "..." }
        } else {
            console.error("updateApiInfo function is not defined.");
        }
    });

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

function saveChatSessionsToStorage() { try {localStorage.setItem('chatSessions',JSON.stringify(chatSessions));}catch(e){console.error("Failed to save chat sessions:",e);} }
// function loadChatSessionsFromStorage() {
//     try {
//         const saved = localStorage.getItem('chatSessions');
//         if (saved) {
//             chatSessions = JSON.parse(saved);
//             const listEl = document.getElementById('chat-session-list');
//             if (listEl) { listEl.innerHTML = ''; chatSessions.sort((a,b)=>(b.id||0)-(a.id||0)).forEach(addChatHistoryItem); }
//             const lastSessionId = localStorage.getItem('currentChatSessionId');
//             if (lastSessionId && chatSessions.find(s => s.id === Number(lastSessionId))) {
//                 currentChatSessionId = Number(lastSessionId);
//                 const activeSessionItem = listEl?.querySelector(`[data-session-id="${currentChatSessionId}"]`);
//                 if (activeSessionItem) activeSessionItem.click();
//                 else clearCurrentChatDisplay();
//             } else { clearCurrentChatDisplay(); }
//         } else { clearCurrentChatDisplay(); }
//     } catch (e) { console.error("Failed to load chat sessions:", e); chatSessions=[]; clearCurrentChatDisplay(); }
// }




// 修改后的 addVoiceHistoryItem (语音历史记录)
function addVoiceHistoryItem(item) {
    const voiceHistoryListEl = document.getElementById('voice-history-list');
    if (!voiceHistoryListEl || !item) {
        console.warn("Cannot add voice history item, list or item data missing.", item);
        return;
    }

    const li = document.createElement('li');
    li.className = 'history-item voice-history-item';
    li.dataset.transcript = item.transcript || '无法识别';
    li.dataset.response = item.response || '无回答';
    const timestampForStorage = Date.now();
    li.dataset.timestamp = String(timestampForStorage / 1000);

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'history-item-content-wrapper';

    const timestamp = new Date(timestampForStorage).toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
    const transcript = item.transcript || '无法识别';
    const transcriptDisplay = transcript.length > 30 ? transcript.substring(0, 27) + '...' : transcript;

    const timeDivVoice = document.createElement('div');
    timeDivVoice.innerHTML = `<strong><i class="fas fa-clock"></i> ${timestamp}</strong>`;

    const transcriptDivVoice = document.createElement('div');
    transcriptDivVoice.title = escapeHtml(transcript);
    transcriptDivVoice.innerHTML = `<i class="fas fa-comment-dots"></i> ${escapeHtml(transcriptDisplay)}`;

    contentWrapper.appendChild(timeDivVoice);
    contentWrapper.appendChild(transcriptDivVoice);

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'history-item-actions';

    if (typeof createDeleteButton === 'function') {
        const deleteBtn = createDeleteButton(() => {
            if (confirm('确定要删除此语音记录吗?')) {
                li.remove();
                const voiceResultEl = document.getElementById('voice-result');
                if (voiceResultEl && voiceResultEl.dataset.associatedTimestamp === String(timestampForStorage)) {
                    voiceResultEl.innerHTML = '点击下方按钮开始录音，识别结果和 AI 回答将显示在此处。';
                    delete voiceResultEl.dataset.associatedTimestamp;
                }
            }
        });
        actionsContainer.appendChild(deleteBtn);
    }

    li.appendChild(contentWrapper);
    li.appendChild(actionsContainer);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.history-item-actions')) return;

        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) {
            voiceResultEl.innerHTML = '';
            voiceResultEl.dataset.associatedTimestamp = String(timestampForStorage);

            const stashedTranscript = li.dataset.transcript;
            const stashedResponse = li.dataset.response;

            const transcriptHtml = `<div style="margin-bottom:0.5rem;"><strong><i class="fas fa-comment-dots"></i> 识别结果:</strong><div class="message-content-simple">${escapeHtml(stashedTranscript)}</div></div>`;

            const aiResponseContainer = document.createElement('div');
            aiResponseContainer.innerHTML = `<strong><i class="fas fa-robot"></i> AI回答:</strong>`;

            const aiMessageDiv = document.createElement('div');
            aiMessageDiv.className = 'ai-message';
            if (typeof processAIMessage === 'function') {
                processAIMessage(aiMessageDiv, stashedResponse, 'voice_history_click');
            } else {
                aiMessageDiv.textContent = stashedResponse + " (processAIMessage 未定义)";
            }
            aiResponseContainer.appendChild(aiMessageDiv);

            voiceResultEl.innerHTML = transcriptHtml + '<hr>';
            voiceResultEl.appendChild(aiResponseContainer);
        }

        voiceHistoryListEl.querySelectorAll('.history-item.active-session').forEach(i => i.classList.remove('active-session'));
        li.classList.add('active-session');
    });

    voiceHistoryListEl.insertBefore(li, voiceHistoryListEl.firstChild);
}

function initVoiceAnswerHandlers() {
    initVoiceFeature();

    const clearBtn = document.getElementById('voice-clear-history');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearVoiceHistory);
    }
}


function renderChatHistory(historyArray) {
    const chatHistoryEl=document.getElementById('chat-chat-history');
    if(!chatHistoryEl)return;
// --- Selection Controls for Image Cropping ---
function initSelectionControls() {
    const overlayEl = document.getElementById('overlay');
    const imgEl = document.getElementById('overlay-image');
    const selBox = document.getElementById('selection-box');
    
    if (!overlayEl || !imgEl || !selBox) {
        console.error("Required overlay elements not found for selection controls");
        return;
    }
    
    // Reset state
    isDragging = false;
    dragType = '';
    
    // Mouse down on selection box - start resize/move
    selBox.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        
        // Determine drag type based on where the mouse is within the selection box
        const rect = selBox.getBoundingClientRect();
        const edgeThreshold = 10; // pixels from edge to consider as resize
        
        const isNearLeftEdge = Math.abs(e.clientX - rect.left) < edgeThreshold;
        const isNearRightEdge = Math.abs(e.clientX - rect.right) < edgeThreshold;
        const isNearTopEdge = Math.abs(e.clientY - rect.top) < edgeThreshold;
        const isNearBottomEdge = Math.abs(e.clientY - rect.bottom) < edgeThreshold;
        
        if (isNearRightEdge && isNearBottomEdge) dragType = 'resize-se';
        else if (isNearLeftEdge && isNearBottomEdge) dragType = 'resize-sw';
        else if (isNearRightEdge && isNearTopEdge) dragType = 'resize-ne';
        else if (isNearLeftEdge && isNearTopEdge) dragType = 'resize-nw';
        else if (isNearRightEdge) dragType = 'resize-e';
        else if (isNearLeftEdge) dragType = 'resize-w';
        else if (isNearBottomEdge) dragType = 'resize-s';
        else if (isNearTopEdge) dragType = 'resize-n';
        else dragType = 'move';
        
        // Update cursor based on drag type
        if (dragType === 'resize-se' || dragType === 'resize-nw') selBox.style.cursor = 'nwse-resize';
        else if (dragType === 'resize-sw' || dragType === 'resize-ne') selBox.style.cursor = 'nesw-resize';
        else if (dragType === 'resize-e' || dragType === 'resize-w') selBox.style.cursor = 'ew-resize';
        else if (dragType === 'resize-s' || dragType === 'resize-n') selBox.style.cursor = 'ns-resize';
        else selBox.style.cursor = 'move';
    });
    
    // Mouse down on image (outside selection) - start new selection
    imgEl.addEventListener('mousedown', (e) => {
        if (e.target === imgEl) { // Only if directly on the image, not on the selection box
            e.preventDefault();
            isDragging = true;
            dragType = 'new-selection';
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            
            // Calculate position relative to image
            const imgRect = imgEl.getBoundingClientRect();
            const x = e.clientX - imgRect.left;
            const y = e.clientY - imgRect.top;
            
            // Start with a 1x1 selection at the click point
            selection = {
                x: x,
                y: y,
                width: 1,
                height: 1
            };
            
            updateSelectionBox();
        }
    });
    
    // Mouse move - update selection based on drag type
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        const imgRect = imgEl.getBoundingClientRect();
        
        // Handle different drag types
        if (dragType === 'new-selection') {
            // For new selection, adjust width and height based on drag direction
            if (dx > 0) {
                selection.width = dx;
            } else {
                selection.x = Math.max(0, selection.x + dx);
                selection.width = Math.abs(dx);
            }
            
            if (dy > 0) {
                selection.height = dy;
            } else {
                selection.y = Math.max(0, selection.y + dy);
                selection.height = Math.abs(dy);
            }
            
            // Ensure selection stays within image bounds
            if (selection.x + selection.width > imgEl.width) {
                selection.width = imgEl.width - selection.x;
            }
            if (selection.y + selection.height > imgEl.height) {
                selection.height = imgEl.height - selection.y;
            }
        } else if (dragType === 'move') {
            // Move the entire selection
            selection.x = Math.max(0, Math.min(imgEl.width - selection.width, selection.x + dx));
            selection.y = Math.max(0, Math.min(imgEl.height - selection.height, selection.y + dy));
        } else if (dragType.startsWith('resize-')) {
            // Resize the selection based on which edge/corner is being dragged
            if (dragType.includes('e')) { // Right edge
                selection.width = Math.max(10, Math.min(imgEl.width - selection.x, selection.width + dx));
            }
            if (dragType.includes('w')) { // Left edge
                const newX = Math.max(0, Math.min(selection.x + selection.width - 10, selection.x + dx));
                selection.width = selection.x + selection.width - newX;
                selection.x = newX;
            }
            if (dragType.includes('s')) { // Bottom edge
                selection.height = Math.max(10, Math.min(imgEl.height - selection.y, selection.height + dy));
            }
            if (dragType.includes('n')) { // Top edge
                const newY = Math.max(0, Math.min(selection.y + selection.height - 10, selection.y + dy));
                selection.height = selection.y + selection.height - newY;
                selection.y = newY;
            }
        }
        
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        updateSelectionBox();
        
        // Update crop info
        const cropInfoEl = document.getElementById('crop-info');
        if (cropInfoEl) {
            cropInfoEl.textContent = `选择区域: ${Math.round(selection.x)},${Math.round(selection.y)} ${Math.round(selection.width)}x${Math.round(selection.height)}`;
        }
    });
    
    // Mouse up - end dragging
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            if (selBox) selBox.style.cursor = 'move';
        }
    });
    
    // Update selection box position and size
    updateSelectionBox();
}

// --- Voice Feature Initialization ---


// --- Storage Functions ---
function saveChatSessionsToStorage() { 
    try {
        localStorage.setItem('chatSessions', JSON.stringify(chatSessions));
    } catch(e) {
        console.error("Failed to save chat sessions:", e);
    } 
}




// --- Base Button Handlers ---
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

    // --- Screenshot Analysis Handlers ---
    document.getElementById('ss-capture-btn')?.addEventListener('click', requestScreenshot);
    document.getElementById('ss-clear-history')?.addEventListener('click', clearScreenshotHistory);
    document.getElementById('ss-crop-current-btn')?.addEventListener('click', () => {
        const mainImagePreviewEl = document.getElementById('ss-main-preview-image');
        if (mainImagePreviewEl && mainImagePreviewEl.dataset.currentUrl) {
            showImageOverlay(mainImagePreviewEl.dataset.currentUrl);
        } else {
            alert('没有当前显示的图片可裁剪');
        }
    });

    // --- Chat Handlers ---
    document.getElementById('chat-send-chat')?.addEventListener('click', sendChatMessage);
    document.getElementById('chat-chat-input')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    document.getElementById('chat-file-upload')?.addEventListener('change', handleFileUpload);
    document.getElementById('chat-clear-current-chat')?.addEventListener('click', clearCurrentChatDisplay);
    document.getElementById('chat-clear-all-sessions')?.addEventListener('click', clearAllChatSessions);

    // --- Voice Handlers ---
    // Note: Voice recording buttons are handled in initVoiceFeature
    document.getElementById('voice-clear-history')?.addEventListener('click', clearVoiceHistory);

    // --- Overlay Controls ---
    document.getElementById('overlay-close')?.addEventListener('click', hideImageOverlay);
    document.getElementById('overlay-confirm')?.addEventListener('click', confirmCrop);
    document.getElementById('overlay-cancel')?.addEventListener('click', hideImageOverlay);
}
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

function updateConnectionStatus(isConnected){
    const ind=document.getElementById('connection-indicator'),st=document.getElementById('connection-status');
    if(ind&&st){
        ind.className=`status-indicator ${isConnected?'connected':'disconnected'}`;
        st.textContent=`实时连接: ${isConnected?'已连接':'未连接'}`;
        ind.title=`Socket.IO ${isConnected?'Connected':'Disconnected'}`;
    }
}

function updateApiInfo(d){
    const el=document.getElementById('api-provider-display');
    if(el){
        el.textContent=`AI模型: ${d?.provider||'未知'}`;
        el.title=d?.provider?`Using ${d.provider}`:'AI Provider Info Unavailable';
    }
}

function clearScreenshotHistory(){
    if(confirm('清空所有截图历史?')){
        const el=document.getElementById('ss-history-list');
        if(el)el.innerHTML='';
        const anEl=document.getElementById('ss-ai-analysis');
        if(anEl){
            anEl.textContent='点击历史查看分析...';
            delete anEl.dataset.sourceUrl;
        }
        if (typeof clearMainScreenshotDisplay === 'function') {
            clearMainScreenshotDisplay();
        }
    }
}

function clearCurrentChatDisplay(isNewSessionStart = false){
    const el=document.getElementById('chat-chat-history');
    if(el)el.innerHTML='<div class="system-message">选择记录或开始新对话...</div>';
    currentChatSessionId=null;
    document.getElementById('chat-session-list')?.querySelectorAll('.active-session').forEach(i=>i.classList.remove('active-session'));
    document.getElementById('chat-chat-input')?.focus(); 
    saveCurrentChatSessionId();
    
    // 如果是新会话开始，可以在这里添加额外的逻辑
    if (isNewSessionStart) {
        // 例如，可以清空输入框
        const chatInputEl = document.getElementById('chat-chat-input');
        if (chatInputEl) chatInputEl.value = '';
        
        // 清空文件上传预览
        const uploadPreviewEl = document.getElementById('chat-upload-preview');
        if (uploadPreviewEl) uploadPreviewEl.innerHTML = '';
        uploadedFile = null;
        
        // 重置文件输入
        const fileInputEl = document.getElementById('chat-file-upload');
        if (fileInputEl) fileInputEl.value = '';
    }
}

function clearAllChatSessions(){
    if(confirm('永久删除所有对话?')){
        chatSessions=[];
        currentChatSessionId=null;
        const el=document.getElementById('chat-session-list');
        if(el)el.innerHTML='';
        clearCurrentChatDisplay();
        saveChatSessionsToStorage();
        saveCurrentChatSessionId();
    }
}

function clearVoiceHistory(){
    if(confirm('清空所有语音历史?')){
        const el=document.getElementById('voice-history-list');
        if(el)el.innerHTML='';
        const resEl=document.getElementById('voice-result');
        if(resEl)resEl.textContent='点击开始录音...';
    }
}

// --- API & Server Communication ---
function getApiInfo() {
    if (!TOKEN) { updateApiInfo({ provider: '未知 (Token未设置)' }); return; }
    fetch('/api_info', { headers: { 'Authorization': `Bearer ${TOKEN}` } })
    .then(r=>{if(r.status===401)throw new Error('Unauthorized');if(!r.ok)throw new Error(`API信息获取失败(${r.status})`);return r.json();})
    .then(updateApiInfo).catch(e=>{console.error('API info error:',e);updateApiInfo({provider:`错误(${e.message})`});});
}

function sendVoiceToServer(audioBlob) {
    const fd = new FormData();
    const timestamp = Date.now();
    // 后端会根据上传的文件名和内容确定格式，这里的文件名主要是为了 FormData
    fd.append('audio', audioBlob, `recorded_audio_${timestamp}.wav`); 

    const requestIdForThisOperation = window.currentVoiceRequestId; // 获取当前操作的ID

    // 1. 检查并添加 request_id
    if (requestIdForThisOperation) {
        fd.append('request_id', requestIdForThisOperation);
        console.log('[VOICE] Sending voice to /process_voice with client-generated request_id:', requestIdForThisOperation);
    } else {
        console.error("[VOICE] CRITICAL: window.currentVoiceRequestId was NOT SET when sendVoiceToServer was called! Aborting send.");
        const voiceResultEl = document.getElementById('voice-result');
        if(voiceResultEl) voiceResultEl.innerHTML = '<p class="error-message">内部错误：请求ID丢失，无法发送语音。请重试。</p>';
        // 重新启用开始录音按钮，禁用停止按钮
        const startBtn = document.getElementById('voice-start-recording');
        const stopBtn = document.getElementById('voice-stop-recording');
        if(startBtn) startBtn.disabled = false;
        if(stopBtn) stopBtn.disabled = true;
        return; // 中止发送
    }

    // 2. 添加 socket_id (可选，用于后端尝试定向发送 Socket.IO 事件)
    if (socket && socket.id) {
        fd.append('socket_id', socket.id);
        // console.log('[VOICE] Sending with socket_id:', socket.id); // 日志可选
    } else {
        console.warn('[VOICE] Socket not available or socket.id is missing when sending voice. Backend will likely broadcast Socket.IO events.');
    }
    
    // 3. 更新UI为"处理中..."状态
    const voiceResultEl = document.getElementById('voice-result');
    const startRecordingBtn = document.getElementById('voice-start-recording');
    const stopRecordingBtn = document.getElementById('voice-stop-recording');

    if (voiceResultEl) {
        const displayRequestId = (requestIdForThisOperation || 'N/A').substring(0, 8);
        voiceResultEl.innerHTML = `<p><i class="fas fa-spinner fa-spin"></i> 处理中... (ID: ${displayRequestId})</p>`;
    }
    // 按钮状态：开始录音禁用（因为正在处理），停止录音禁用（因为已停止）
    if (startRecordingBtn) startRecordingBtn.disabled = true;
    if (stopRecordingBtn) stopRecordingBtn.disabled = true;


    // 4. 发送 fetch 请求到后端 /process_voice
    fetch('/process_voice', { 
        method: 'POST', 
        body: fd, 
        headers: { 
            ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` }) 
        }
    })
    .then(response => {
        if (!response.ok) {
            return response.json().catch(() => ({ 
                message: `语音请求失败，服务器状态: ${response.status} ${response.statusText}` 
            })).then(errorData => {
                throw new Error(errorData.message || JSON.stringify(errorData));
            });
        }
        return response.json();
    })
    .then(data => {
        console.log('[AI DEBUG] Voice ack from /process_voice:', data); 
        if (data.status === 'processing' && data.request_id) {
            // 确认后端返回的 request_id 与我们发送的一致
            if (data.request_id !== requestIdForThisOperation) {
                console.warn(`[VOICE] MISMATCH in HTTP ACK! Client sent ${requestIdForThisOperation}, server ACK'd for ${data.request_id}. This indicates a server-side issue if it's not using the provided ID. Subsequent Socket.IO events might not match.`);
                // 理论上，如果后端正确使用了前端提供的ID，这里不应该出现mismatch。
                // 如果出现，需要检查后端 /process_voice 路由获取 request_id 的逻辑。
            } else {
                console.log(`[VOICE] HTTP ACK matches sent request_id: ${data.request_id}. Waiting for Socket.IO events.`);
            }
            // UI 已经是"处理中..."，按钮状态也已设置。等待 Socket.IO 事件来更新最终结果或错误。
        } else {
            const errorMessage = data.message || data.error || '语音请求未被正确处理。';
            console.error('[VOICE] Voice processing initiation failed on server (non-202 or missing processing status):', errorMessage);
            if (voiceResultEl) voiceResultEl.innerHTML = `<p class="error-message">语音处理启动失败: ${escapeHtml(errorMessage)}</p>`;
            if (startRecordingBtn) startRecordingBtn.disabled = false;
            if (stopRecordingBtn) stopRecordingBtn.disabled = true;
            window.currentVoiceRequestId = null; // 清理ID，允许新的操作
        }
    })
    .catch(error => {
        console.error('[VOICE] Error sending voice or handling server ack:', error);
        if (voiceResultEl) {
            voiceResultEl.innerHTML = `<p class="error-message">语音请求发送失败: ${escapeHtml(error.message)}</p>`;
        }
        if (startRecordingBtn) startRecordingBtn.disabled = false;
        if (stopRecordingBtn) stopRecordingBtn.disabled = true;
        window.currentVoiceRequestId = null; // 出错时清理ID，允许新的操作
    });
}

function requestScreenshot(){
    if(socket?.connected)socket.emit('request_screenshot_capture');
    else alert('无法请求截图：未连接');
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

function confirmCrop() {
    if (!currentImage) { alert('错误：没有当前图片。'); return; }
    const overlayImageEl = document.getElementById('overlay-image');
    if (!overlayImageEl || !overlayImageEl.naturalWidth) { alert('错误：图片未加载。'); return; }
    const scaleX = overlayImageEl.naturalWidth / overlayImageEl.width;
    const scaleY = overlayImageEl.naturalHeight / overlayImageEl.height;
    const oSel = { 
        x: Math.round(selection.x * scaleX), y: Math.round(selection.y * scaleY), 
        width: Math.round(selection.width * scaleX), height: Math.round(selection.height * scaleY) 
    };

    const fd = new FormData();
    fd.append('image_url', currentImage); // original image URL
    fd.append('x', oSel.x); fd.append('y', oSel.y);
    fd.append('width', oSel.width); fd.append('height', oSel.height);
    
    const prmptEl = document.getElementById('prompt-input');
    if (prmptEl?.value.trim()) fd.append('prompt', prmptEl.value.trim());

    // Add selected model information
    if (selectedModel.provider && selectedModel.model_id) {
        fd.append('provider', selectedModel.provider);
        fd.append('model_id', selectedModel.model_id);
    } else {
        console.warn("Confirm Crop: No model selected, backend will use default for analysis.");
    }

    const analysisEl = document.getElementById('ss-ai-analysis');
    if (analysisEl) analysisEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 分析裁剪区域 (模型: ${selectedModel.provider || '默认'}/${selectedModel.model_id || '默认'})...`;
    hideImageOverlay(); // Assuming defined

    fetch('/crop_image', { method: 'POST', headers: { ...(TOKEN && {'Authorization': `Bearer ${TOKEN}`}) }, body: fd })
    .then(r => {
        if (!r.ok) return r.json().catch(() => ({error: `HTTP ${r.status}`})).then(eD => { throw new Error(eD.message || eD.error || `HTTP ${r.status}`) });
        return r.json();
    })
    .then(d => {
        debugLog(`Crop and re-analysis request acknowledged: ${JSON.stringify(d)}`);
        // Analysis result will come via SocketIO event 'analysis_result' or 'new_screenshot'
    })
    .catch(e => {
        console.error('Crop image error:', e);
        alert(`裁剪或分析出错: ${e.message}`);
        if (analysisEl) analysisEl.textContent = `分析失败: ${e.message}`;
    });
}


// Modify Socket.IO event handlers to display provider/model if received
// In processAIMessage(messageElement, messageText, sourceEvent)
// When creating/updating the AI message div, you can use data from messageElement.dataset
// (This assumes backend sends provider and model_id in socket events like 'chat_stream_chunk', 'chat_stream_end', 'analysis_result')

/* Example modification within processAIMessage (you'll need to adapt to your exact structure)
function processAIMessage(messageElement, messageText, sourceEvent = "unknown") {
    // ... your existing strongTag and contentDiv creation ...
    let strongTag = messageElement.querySelector('strong');
    // ...
    const providerName = messageElement.dataset.provider || 'AI'; // Get from data attribute
    const modelName = messageElement.dataset.modelId || '';    // Get from data attribute
    
    strongTag.textContent = `${providerName}${modelName ? ` (${modelName.split('/').pop()})` : ''}: `; // Display like "OpenAI (gpt-4o): "
    // ... rest of your markdown and KaTeX rendering ...
}
*/

// Make sure initAllFeatures is the last thing called or is wrapped in DOMContentLoaded
document.addEventListener('DOMContentLoaded', initAllFeatures);


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

// --- sendChatMessage (Ensure it includes model selection) ---
// function sendChatMessage() {
//   const chatInputEl = document.getElementById('chat-chat-input');
//   const chatHistoryEl = document.getElementById('chat-chat-history');

//   if (!socket || !socket.connected) {
//     console.error('[Chat] Socket not connected.');
//     if (chatHistoryEl) {
//       const errDiv = document.createElement('div');
//       errDiv.className = 'system-message error-text';
//       errDiv.textContent = '错误：无法连接到服务器。';
//       chatHistoryEl.appendChild(errDiv);
//       scrollToChatBottom(chatHistoryEl);
//     }
//     return;
//   }

//   if (!chatInputEl || !chatHistoryEl) {
//     console.error("Chat UI elements missing.");
//     return;
//   }

//   const message = chatInputEl.value.trim();
//   const currentFileToSend = uploadedFile;
//   let imageBase64Data = null; // For future direct paste

//   if (!message && !currentFileToSend && !imageBase64Data) {
//     debugLog("Empty message/file.");
//     return;
//   }

//   if (!selectedModel.provider || !selectedModel.model_id) {
//     console.warn("No model selected.");
//     if (chatHistoryEl) {
//       const errDiv = document.createElement('div');
//       errDiv.className = 'system-message error-text';
//       errDiv.textContent = '请先选择一个AI模型。';
//       chatHistoryEl.appendChild(errDiv);
//       scrollToChatBottom(chatHistoryEl);
//     }
//     return;
//   }

//   let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
//   if (!activeSession) {
//     const newId = Date.now();
//     let title = message.substring(0, 25) || (currentFileToSend ? `文件: ${currentFileToSend.name.substring(0, 15)}` : '新对话');
//     if (title.length >= 25 && message.length > 25) title += "...";
//     activeSession = { id: newId, title: escapeHtml(title), history: [] };
//     chatSessions.unshift(activeSession);

//     if (typeof addChatHistoryItem === 'function') addChatHistoryItem(activeSession);
//     currentChatSessionId = newId;
//     if (typeof saveCurrentChatSessionId === 'function') saveCurrentChatSessionId();
    
//     const listEl = document.getElementById('chat-session-list');
//     listEl?.querySelectorAll('.active-session').forEach(i => i.classList.remove('active-session'));
//     listEl?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');
//     if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
//   }

//   const userMessageText = message || (currentFileToSend ? `[用户上传了文件: ${currentFileToSend.name}]` : (imageBase64Data ? "[用户发送了图片]" : ""));
//   if (activeSession && (userMessageText || currentFileToSend || imageBase64Data)) {
//     activeSession.history.push({ role: 'user', parts: [{ text: userMessageText }] });
//   } else if (!activeSession) {
//     console.error("Active session null when pushing user message.");
//     return;
//   }

//   const uDiv = document.createElement('div');
//   uDiv.className = 'user-message';
//   const uStrong = document.createElement('strong');
//   uStrong.textContent = "您: ";
//   uDiv.appendChild(uStrong);

//   const uMsgContentDiv = document.createElement('div');
//   uMsgContentDiv.className = 'message-content';
//   if (message) uMsgContentDiv.appendChild(document.createTextNode(message));
//   if (currentFileToSend) { /* ... append file preview to uMsgContentDiv ... */ }
//   // TODO: Append pasted image preview to uMsgContentDiv if imageBase64Data exists
//   uDiv.appendChild(uMsgContentDiv);

//   if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
//   chatHistoryEl.appendChild(uDiv);
//   scrollToChatBottom(chatHistoryEl);

//   const reqId = generateUUID();
//   const thinkingDiv = document.createElement('div');
//   thinkingDiv.className = 'ai-message ai-thinking';
//   thinkingDiv.dataset.requestId = reqId;
//   thinkingDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> AI (${selectedModel.provider}/${selectedModel.model_id.split('/').pop()}) 正在思考...`;
//   chatHistoryEl.appendChild(thinkingDiv);
//   scrollToChatBottom(chatHistoryEl);

//   if (activeSession) {
//     activeSession.history.push({
//       role: 'model', parts: [{ text: '' }], temp_id: reqId,
//       provider: selectedModel.provider, model_id: selectedModel.model_id
//     });
//   }

//   const stream = document.getElementById('streaming-toggle-checkbox')?.checked ?? true;
//   let histToSend = activeSession ? JSON.parse(JSON.stringify(activeSession.history.slice(0, -1))) : [];

//   if (currentFileToSend) {
//     const fd = new FormData(); /* ... append data, provider, model_id ... */
//     fd.append('prompt', message); // 用户输入的文本提示
//     fd.append('file', currentFileToSend, currentFileToSend.name);
//     fd.append('history', JSON.stringify(histToSend));
//     // fd.append('use_streaming', stream); // 后端 /chat_with_file 可能不直接支持流式响应，但可以影响后续SocketIO行为
//     fd.append('session_id', activeSession.id);
//     fd.append('request_id', reqId);
//     fd.append('provider', selectedModel.provider);   // <--- 传递选择的提供商
//     fd.append('model_id', selectedModel.model_id);     // <--- 传递选择的模型ID


//     fetch('/chat_with_file', { method: 'POST', headers: { ...(TOKEN && {'Authorization': `Bearer ${TOKEN}`}) }, body: fd })
//         .then(r => {
//             if (!r.ok) {
//                 return r.json().catch(() => ({ error: `HTTP Error: ${r.status} ${r.statusText}` }))
//                             .then(eD => { throw new Error(eD.message || eD.error || `HTTP ${r.status}`) });
//             }
//             return r.json();
//         })
//         .then(d => {
//             if (d && d.request_id === reqId && d.status === 'processing') {
//                 console.log(`[/chat_with_file] Request ${reqId} accepted by server. Waiting for Socket.IO. Model: ${selectedModel.provider}/${selectedModel.model_id}`);
//             } else {
//                 console.warn('[/chat_with_file] Server acknowledgment error or request_id mismatch.', d);
//                 const currentThinkingDivMismatch = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
//                 if (currentThinkingDivMismatch) removeThinkingIndicator(chatHistoryEl, currentThinkingDivMismatch);
//                 const errD = document.createElement('div');
//                 errD.className = 'ai-message error-message';
//                 errD.innerHTML = `<strong>系统错误:</strong><span>服务器未能确认处理文件请求。</span>`;
//                 if (chatHistoryEl) { chatHistoryEl.appendChild(errD); scrollToChatBottom(chatHistoryEl); }
//                 if (activeSession) { /* ... 清理历史占位符 ... */ }
//             }
//         })
//         .catch(e => {
//             console.error('[/chat_with_file] Fetch error:', e);
//             const currentThinkingDivError = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
//             if (currentThinkingDivError) removeThinkingIndicator(chatHistoryEl, currentThinkingDivError);
//             const errD = document.createElement('div');
//             errD.className = 'ai-message error-message';
//             errD.innerHTML = `<strong>系统错误:</strong><span>文件上传请求失败: ${escapeHtml(e.message)}</span>`;
//             if (chatHistoryEl) { chatHistoryEl.appendChild(errD); scrollToChatBottom(chatHistoryEl); }
//             if (activeSession) { /* ... 清理历史占位符 ... */ }
//         });
//   } else {
//     socket.emit('chat_message', {
//       prompt: message, history: histToSend, request_id: reqId, use_streaming: stream,
//       session_id: activeSession.id, provider: selectedModel.provider,
//       model_id: selectedModel.model_id, image_data: imageBase64Data
//     });
//   }

//   if (activeSession && typeof saveChatSessionsToStorage === 'function') saveChatSessionsToStorage();

//   chatInputEl.value = '';
//   const upPrevEl = document.getElementById('chat-upload-preview');
//   if (upPrevEl) upPrevEl.innerHTML = '';
//   uploadedFile = null;
//   const fInEl = document.getElementById('chat-file-upload');
//   if (fInEl) fInEl.value = '';
// }

// // DOMContentLoaded Listeners (from your original file)
// document.addEventListener('DOMContentLoaded', initAllFeatures);
// document.addEventListener('DOMContentLoaded', () => { 
//   const btns = document.querySelectorAll('button, .btn, .dropdown-item'); // Updated selector
//   btns.forEach(b => {
//     let touchTimer;
//     const clearTimer = () => { 
//       if (touchTimer) { 
//         clearTimeout(touchTimer); 
//         touchTimer = null; 
//         b.classList.remove('touch-active'); 
//       }
//     };
//     b.addEventListener('touchstart', function() { 
//       this.classList.add('touch-active'); 
//       touchTimer = setTimeout(clearTimer, 300); 
//     }, { passive: true });
//     b.addEventListener('touchend', clearTimer); 
//     b.addEventListener('touchcancel', clearTimer);
//   });

//   if (!document.getElementById('touch-active-style')) {
//     const s = document.createElement('style');
//     s.id = 'touch-active-style';
//     s.textContent = '.touch-active { opacity:0.7 !important; transform:scale(0.98) !important; }';
//     document.head.appendChild(s);
//   }
// });

function sendChatMessage() {
    const chatInputEl = document.getElementById('chat-chat-input');
    const chatHistoryEl = document.getElementById('chat-chat-history');

    if (!socket || !socket.connected) {
        console.error('[Chat] Socket not connected, cannot send message');
        if(chatHistoryEl) { // 用户反馈
            const errDiv = document.createElement('div');
            errDiv.className = 'system-message error-text'; // 假设有 .error-text 样式
            errDiv.textContent = '错误：无法连接到服务器，请检查网络连接。';
            chatHistoryEl.appendChild(errDiv);
            scrollToChatBottom(chatHistoryEl);
        }
        return;
    }

    if (!chatInputEl || !chatHistoryEl) {
        console.error("Chat input or history element missing.");
        return;
    }

    const message = chatInputEl.value.trim();
    const currentFileToSend = uploadedFile; // 从全局变量获取
    let imageBase64Data = null; // 用于直接粘贴在聊天框的图片 (base64)

    // --- 预留：处理直接粘贴在聊天框的图片 ---
    // 例如，如果你有一个预览元素 for pasted images:
    // const pastedImagePreview = document.getElementById('pasted-image-in-chat-preview');
    // if (pastedImagePreview && pastedImagePreview.dataset.imageBase64) {
    //     imageBase64Data = pastedImagePreview.dataset.imageBase64;
    //     // 清理预览，因为消息即将发送
    //     pastedImagePreview.style.display = 'none';
    //     pastedImagePreview.removeAttribute('data-image-base64');
    // }
    // --- 预留结束 ---

    if (!message && !currentFileToSend && !imageBase64Data) {
        debugLog("Empty message, no file selected, and no directly provided image.");
        return;
    }

    // --- 关键：检查是否有模型被选中 ---
    if (!selectedModel.provider || !selectedModel.model_id) {
        console.warn("No model selected. Please choose a model from the dropdown.");
        if(chatHistoryEl) { // 用户反馈
            const errDiv = document.createElement('div');
            errDiv.className = 'system-message error-text';
            errDiv.textContent = '请先从顶部选择一个AI模型。';
            chatHistoryEl.appendChild(errDiv);
            scrollToChatBottom(chatHistoryEl);
        }
        return;
    }

    // --- 会话管理 (与您提供的版本基本一致) ---
    let activeSession = currentChatSessionId ? chatSessions.find(s => s.id === currentChatSessionId) : null;
    if (!activeSession) {
        const newId = Date.now();
        let title = message.substring(0, 30) ||
                    (imageBase64Data ? "包含图片的对话" : null) || // 优先显示图片对话
                    (currentFileToSend ? `含${currentFileToSend.name.substring(0, 20)}的对话` : '新对话');
        if (title.length === 30 || (currentFileToSend && currentFileToSend.name.length > 20 && title.length >= 22 && title.endsWith("..."))) {
            // title 已经很长或已截断
        } else if (title.length > 30 || (currentFileToSend && currentFileToSend.name.length > 20)) {
            title = title.substring(0, Math.min(title.length, 27)) + "...";
        }

        activeSession = { id: newId, title: escapeHtml(title), history: [] };
        chatSessions.unshift(activeSession);
        addChatHistoryItem(activeSession); // (确保此函数已定义)
        currentChatSessionId = newId;
        saveCurrentChatSessionId(); // (确保此函数已定义)
        setTimeout(() => {
            const l = document.getElementById('chat-session-list');
            l?.querySelectorAll('.active-session').forEach(i => i.classList.remove('active-session'));
            l?.querySelector(`[data-session-id="${activeSession.id}"]`)?.classList.add('active-session');
            if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
        }, 0);
    }

    // --- 将用户消息添加到内存和UI ---
    // 为历史记录准备文本 (主要用于纯文本历史或文件上传的标记)
    let historyMessageText = message;
    if (!historyMessageText && imageBase64Data && !currentFileToSend) {
        historyMessageText = "[用户发送了一张图片]"; // 如果只有粘贴的图片
    } else if (!historyMessageText && currentFileToSend) {
        historyMessageText = `[用户上传了文件: ${currentFileToSend.name}]`;
    } else if (historyMessageText && (currentFileToSend || imageBase64Data)) {
        // 如果同时有文本和文件/图片，文本优先，后续可以在后端组合
    }

    if (activeSession && (historyMessageText || currentFileToSend || imageBase64Data)) {
        activeSession.history.push({ role: 'user', parts: [{ text: historyMessageText }] });
        // 注意：如果 imageBase64Data 存在，更完善的历史记录可能需要包含图像信息，
        // 但这取决于后端如何处理历史中的多模态内容。目前简单起见，只存文本标记。
    } else if (!activeSession) {
        console.error("[sendChatMessage] Critical error: activeSession is null when trying to push user message.");
        return;
    }

    // 更新UI显示用户消息
    const uDiv = document.createElement('div'); uDiv.className = 'user-message';
    const uStrong = document.createElement('strong'); uStrong.textContent = "您: "; uDiv.appendChild(uStrong);
    const uMsgContentDiv = document.createElement('div'); uMsgContentDiv.className = 'message-content';
    // uMsgContentDiv.textContent = message; // 只显示文本提示

    // 改进UI显示，能同时处理文本、粘贴的图片预览（如果实现）、上传的文件信息
    let contentAddedToMsgDiv = false;
    if (message) {
        const textNode = document.createTextNode(message);
        uMsgContentDiv.appendChild(textNode);
        contentAddedToMsgDiv = true;
    }
    // 如果实现了粘贴图片预览，可以在这里添加预览到 uMsgContentDiv
    if (imageBase64Data && !currentFileToSend) { // 假设粘贴的图片优先于文件上传显示在用户消息气泡中
        if (contentAddedToMsgDiv) uMsgContentDiv.appendChild(document.createElement('br'));
        const imgInfo = document.createElement('div');
        imgInfo.className = 'attached-file'; // 复用样式
        imgInfo.innerHTML = `<i class="fas fa-image"></i> [已粘贴图片进行分析]`;
        uMsgContentDiv.appendChild(imgInfo);
        contentAddedToMsgDiv = true;
    }
    if (currentFileToSend) {
        if (contentAddedToMsgDiv) uMsgContentDiv.appendChild(document.createElement('br'));
        const fD = document.createElement('div'); fD.className = 'attached-file';
        fD.innerHTML = `<i class="fas fa-paperclip"></i> ${escapeHtml(currentFileToSend.name)} (${formatFileSize(currentFileToSend.size)})`;
        uMsgContentDiv.appendChild(fD);
    }
    uDiv.appendChild(uMsgContentDiv);
    if (chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
    chatHistoryEl.appendChild(uDiv);

    // --- 生成请求ID并显示“思考中” ---
    const reqId = generateUUID();
    console.log(`[sendChatMessage] Generated reqId: ${reqId} for model ${selectedModel.provider}/${selectedModel.model_id}`);

    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'ai-message ai-thinking';
    thinkingDiv.dataset.requestId = reqId;
    // 在“思考中”提示里加入选择的模型信息
    thinkingDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> AI (${selectedModel.provider || '默认'}/${selectedModel.model_id || '默认'}) 正在思考...`;
    chatHistoryEl.appendChild(thinkingDiv);
    scrollToChatBottom(chatHistoryEl);

    // --- AI回复占位符 (在历史记录中包含模型信息) ---
    if (activeSession) {
        activeSession.history.push({
            role: 'model',
            parts: [{ text: '' }],
            temp_id: reqId,
            provider: selectedModel.provider, // 保存实际使用的模型信息
            model_id: selectedModel.model_id
        });
    } else {
        console.error("[sendChatMessage] Critical error: activeSession is null when trying to push model placeholder.");
        if(thinkingDiv.parentNode === chatHistoryEl) removeThinkingIndicator(chatHistoryEl, thinkingDiv); // (确保此函数已定义)
        return;
    }

    const streamToggle = document.getElementById('streaming-toggle-checkbox');
    const stream = streamToggle ? streamToggle.checked : true;
    let histToSend = activeSession ? JSON.parse(JSON.stringify(activeSession.history.slice(0, -1))) : []; // 不包含AI占位符

    // --- 根据是否有文件（currentFileToSend）决定请求方式 ---
    if (currentFileToSend) {
        // 如果是文件上传，imageBase64Data (来自粘贴) 通常应被忽略，或由后端逻辑决定优先级。
        // 目前：文件上传优先，imageBase64Data 不会通过 FormData 发送。
        // 如果希望文件上传也结合粘贴的图片（虽然不常见），后端 /chat_with_file 需要额外处理。
        console.log(`[sendChatMessage] Using /chat_with_file for file: ${currentFileToSend.name}`);
        const fd = new FormData();
        fd.append('prompt', message); // 用户输入的文本提示
        fd.append('file', currentFileToSend, currentFileToSend.name);
        fd.append('history', JSON.stringify(histToSend));
        // fd.append('use_streaming', stream); // 后端 /chat_with_file 可能不直接支持流式响应，但可以影响后续SocketIO行为
        fd.append('session_id', activeSession.id);
        fd.append('request_id', reqId);
        fd.append('provider', selectedModel.provider);   // <--- 传递选择的提供商
        fd.append('model_id', selectedModel.model_id);     // <--- 传递选择的模型ID

        fetch('/chat_with_file', { method: 'POST', headers: { ...(TOKEN && {'Authorization': `Bearer ${TOKEN}`}) }, body: fd })
            .then(r => {
                if (!r.ok) {
                    return r.json().catch(() => ({ error: `HTTP Error: ${r.status} ${r.statusText}` }))
                               .then(eD => { throw new Error(eD.message || eD.error || `HTTP ${r.status}`) });
                }
                return r.json();
            })
            .then(d => {
                if (d && d.request_id === reqId && d.status === 'processing') {
                    console.log(`[/chat_with_file] Request ${reqId} accepted by server. Waiting for Socket.IO. Model: ${selectedModel.provider}/${selectedModel.model_id}`);
                } else {
                    console.warn('[/chat_with_file] Server acknowledgment error or request_id mismatch.', d);
                    const currentThinkingDivMismatch = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                    if (currentThinkingDivMismatch) removeThinkingIndicator(chatHistoryEl, currentThinkingDivMismatch);
                    const errD = document.createElement('div');
                    errD.className = 'ai-message error-message';
                    errD.innerHTML = `<strong>系统错误:</strong><span>服务器未能确认处理文件请求。</span>`;
                    if (chatHistoryEl) { chatHistoryEl.appendChild(errD); scrollToChatBottom(chatHistoryEl); }
                    if (activeSession) { /* ... 清理历史占位符 ... */ }
                }
            })
            .catch(e => {
                console.error('[/chat_with_file] Fetch error:', e);
                const currentThinkingDivError = chatHistoryEl?.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
                if (currentThinkingDivError) removeThinkingIndicator(chatHistoryEl, currentThinkingDivError);
                const errD = document.createElement('div');
                errD.className = 'ai-message error-message';
                errD.innerHTML = `<strong>系统错误:</strong><span>文件上传请求失败: ${escapeHtml(e.message)}</span>`;
                if (chatHistoryEl) { chatHistoryEl.appendChild(errD); scrollToChatBottom(chatHistoryEl); }
                if (activeSession) { /* ... 清理历史占位符 ... */ }
            });
    } else {
        // --- 无文件上传：使用 Socket.IO 发送 chat_message，可能包含文本和/或粘贴的图片 ---
        console.log(`[sendChatMessage] Emitting 'chat_message' via Socket.IO. Image via base64: ${imageBase64Data ? 'Yes' : 'No'}`);
        socket.emit('chat_message', {
            prompt: message,
            history: histToSend,
            request_id: reqId,
            use_streaming: stream,
            session_id: activeSession.id,
            provider: selectedModel.provider,      // <--- 传递选择的提供商
            model_id: selectedModel.model_id,        // <--- 传递选择的模型ID
            image_data: imageBase64Data        // <--- 传递粘贴图片的base64数据 (可能为null)
        });
    }

    if (activeSession) {
        saveChatSessionsToStorage(); // (确保此函数已定义)
    }

    // 清空输入
    chatInputEl.value = '';
    const upPrevEl = document.getElementById('chat-upload-preview'); if (upPrevEl) upPrevEl.innerHTML = ''; uploadedFile = null;
    const fInEl = document.getElementById('chat-file-upload'); if (fInEl) fInEl.value = '';
    // TODO: 如果实现了粘贴图片预览，在这里也需要清空它
    // const pastedImagePreview = document.getElementById('pasted-image-in-chat-preview');
    // if (pastedImagePreview) { pastedImagePreview.style.display = 'none'; pastedImagePreview.removeAttribute('data-image-base64'); }
}