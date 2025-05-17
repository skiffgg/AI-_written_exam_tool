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
let uploadedFiles = []; // File staged for chat upload
let pastedImageBase64Array = [];//用于存储粘贴的多张图片的Base64编码数组
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
let ssHistory = [];
let voiceHistory = [];
// 全局标志：当前截图分析是否用流式
let ssIsStreaming = false;


const THEME_STORAGE_KEY = 'selectedAppTheme'; // 您可以选择一个合适的键名
const MODEL_SELECTOR_STORAGE_KEY_PROVIDER = 'selectedProvider';
const MODEL_SELECTOR_STORAGE_KEY_MODEL_ID = 'selectedModelId';
const ACTIVE_MAIN_FEATURE_TAB_KEY = 'activeMainFeature'; // Changed from ...TAB
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';


function loadHistoriesFromStorage() {
  try {
    ssHistory    = JSON.parse(localStorage.getItem('ssHistory')     || '[]');
    voiceHistory = JSON.parse(localStorage.getItem('voiceHistory') || '[]');

    ssHistory = JSON.parse(localStorage.getItem('ssHistory') || '[]');
    ssHistory.forEach(item => addHistoryItem(item));
    voiceHistory.forEach(item => addVoiceHistoryItem(item, /* skipSave= */ true)); // ← 关键
  } catch (err) {
    console.warn('[Storage] load error:', err);
  }
}

function saveScreenshotHistory() {
  localStorage.setItem('ssHistory', JSON.stringify(ssHistory));
}
function saveVoiceHistory() {
  localStorage.setItem('voiceHistory', JSON.stringify(voiceHistory));
}
// --- Utility Functions ---

/* ========= 获取当前会话 history ========= */
function getCurrentSessionHistory() {
  const sess = chatSessions.find(s => s.id === currentChatSessionId);
  return sess ? sess.history : [];
}


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


// 初始化时给按钮绑定切换行为
function initScreenshotStreamToggle() {
  const toggleBtn = document.getElementById('ss-toggle-stream-btn');
  toggleBtn.addEventListener('click', () => {
    ssIsStreaming = !ssIsStreaming;
    toggleBtn.textContent = ssIsStreaming ? '关闭流式' : '启用流式';

    const analysisEl = document.getElementById('ss-ai-analysis');
    analysisEl.innerHTML = '';  // 清空旧内容

    // 通知后端：开始或停止流式推送
    const imageUrl = analysisEl.dataset.sourceUrl;
    if (ssIsStreaming && imageUrl) {
      socket.emit('start_screenshot_analysis_stream', { image_url: imageUrl });
    } else if (!ssIsStreaming && imageUrl) {
      socket.emit('stop_screenshot_analysis_stream',  { image_url: imageUrl });
    }
  });
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
          document
            .querySelector('.nav-dropdown-item[data-feature="voice-answer"]')
            ?.click();

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

function createNewChatSession() {

  // A. 构造会话对象
  const newSession = {
    id: generateUUID(),
    title: '新对话',
    history: []
  };

  // B. 写进数组最前并保存
  chatSessions.unshift(newSession);       // 最新在最前
  saveChatSessionsToStorage();

  // C. 把 <li> 插到左侧最上方
  addChatHistoryItem(newSession);         // addChatHistoryItem 已改成 insertBefore

  // D. 激活此会话
  if (typeof setActiveChatSession === 'function') {
    setActiveChatSession(newSession.id);
  }

  // E. 清空聊天窗口
  if (typeof clearCurrentChatDisplay === 'function') {
    clearCurrentChatDisplay(false);
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

    document.getElementById('chat-new-session-btn-top')
        ?.addEventListener('click', createNewChatSession);


    document.getElementById('voice-new-recording-btn-top')?.addEventListener('click', () => {
        const startRecordingBtn = document.getElementById('voice-start-recording');
        if (startRecordingBtn && !startRecordingBtn.disabled) startRecordingBtn.click();
        else console.warn("Start recording button not available or not ready.");
    });
}

// main.js

function handleFileUpload(e) {
    debugLog("File input changed (handleFileUpload).");
    const fileInput = e.target; // input#chat-file-upload 元素
    const uploadPreviewEl = document.getElementById('chat-upload-preview');

    if (!uploadPreviewEl) {
        console.error("Chat upload preview element (#chat-upload-preview) not found.");
        return;
    }

    // **修改点：不再无条件清空预览区和 uploadedFiles 数组**
    // uploadPreviewEl.innerHTML = ''; // 注释掉或移除
    // uploadedFiles = [];         // 注释掉或移除

    if (fileInput.files && fileInput.files.length > 0) {
        debugLog(`Number of new files selected: ${fileInput.files.length}`);

        for (let i = 0; i < fileInput.files.length; i++) {
            const file = fileInput.files[i];

            // **新增：检查文件是否已存在于 uploadedFiles 数组中，避免重复添加**
            // （基于文件名和大小的简单检查，更严格的检查可能需要比较文件内容或最后修改时间）
            const alreadyExists = uploadedFiles.some(existingFile =>
                existingFile.name === file.name && existingFile.size === file.size
            );

            if (alreadyExists) {
                debugLog(`File already in list, skipping: ${file.name}`);
                continue; // 跳过已存在的文件
            }

            uploadedFiles.push(file); // 将当前文件添加到 uploadedFiles 数组
            debugLog(`File added to list: ${file.name}, Size: ${formatFileSize(file.size)}, Type: ${file.type}`);

            // --- 创建并显示每个文件的预览项 ---
            const previewItem = document.createElement('div');
            previewItem.className = 'preview-item d-flex justify-content-between align-items-center mb-1 p-1 border rounded';
            // 使用文件在数组中的索引作为移除时的唯一标识，比文件名更可靠
            previewItem.dataset.fileIndexToRemove = uploadedFiles.length - 1; // 当前文件在数组中的索引

            const fileInfo = document.createElement('div');
            fileInfo.className = 'file-info text-truncate me-2';

            let iconClass = 'fas fa-file me-2';
            if (file.type.startsWith('image/')) iconClass = 'fas fa-file-image me-2';
            else if (file.type.startsWith('text/')) iconClass = 'fas fa-file-alt me-2';
            else if (file.type === 'application/pdf') iconClass = 'fas fa-file-pdf me-2';

            const displayName = file.name.length > 25 ? file.name.substring(0, 22) + '...' : file.name;
            fileInfo.innerHTML = `<i class="${iconClass}"></i><span title="${escapeHtml(file.name)}">${escapeHtml(displayName)} (${formatFileSize(file.size)})</span>`;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-close btn-sm';
            removeBtn.setAttribute('aria-label', 'Remove file');
            removeBtn.title = '移除此文件';

            removeBtn.onclick = (event) => {
                event.stopPropagation();
                // const indexToRemove = parseInt(previewItem.dataset.fileIndexToRemove, 10); // 旧方法，如果DOM顺序变了就不准
                // 从DOM中找到对应预览项，然后找到其在当前 uploadedFiles 数组中的真实索引
                const currentPreviewItems = Array.from(uploadPreviewEl.children);
                const domIndex = currentPreviewItems.indexOf(previewItem); // 获取当前项在DOM中的索引

                if (domIndex > -1 && domIndex < uploadedFiles.length) { // 确保索引有效
                    const removedFile = uploadedFiles.splice(domIndex, 1); // 根据DOM顺序移除
                    debugLog(`File removed from array: ${removedFile[0]?.name}. Remaining files: ${uploadedFiles.length}`);
                } else {
                    debugLog(`Could not accurately determine file to remove by DOM index.`);
                }

                previewItem.remove();

                // 更新后续预览项的 data-file-index-to-remove (如果使用基于索引的移除)
                // 或者，更简单的方式是在移除时直接从数组中按文件名或其他唯一标识查找。
                // 当前的 splice(domIndex, 1) 已经处理了数组。

                if (uploadedFiles.length === 0) {
                    fileInput.value = '';
                }
                debugLog("Updated uploadedFiles array:", uploadedFiles.map(f => f.name));
            };

            previewItem.appendChild(fileInfo);
            previewItem.appendChild(removeBtn);
            uploadPreviewEl.appendChild(previewItem); // 追加到预览区
        }
    } else {
        debugLog("File selection dialog was cancelled or no file chosen by user this time.");
    }

    // **重要：为了让下一次选择相同文件也能触发 change 事件，需要在处理完后清空原生文件输入框的值。**
    // 否则，如果用户选择了一批文件，然后再次点击“+”号并选择完全相同的一批文件，change 事件可能不会触发。
    fileInput.value = ''; // 放在这里，确保每次选择操作后都清空
    console.log("Final uploadedFiles after this selection:", uploadedFiles.map(f => f.name));
}

// --- History & UI Update Functions ---
/**
 * 向截图历史列表中插入一条记录。
 * @param {{ image_url: string, analysis?: string, prompt?: string, timestamp?: number, provider?: string }} item
 */
function addHistoryItem(item) {
  const historyListEl = document.getElementById('ss-history-list');
  if (!historyListEl || !item || !item.image_url) {
    console.warn("Cannot add screenshot history item, missing list element or item data.", item);
    return;
  }

  // 如果已存在，则只更新 analysis 并返回
  const existingLi = historyListEl.querySelector(`li[data-url="${item.image_url}"]`);
  if (existingLi) {
    console.log(`Screenshot history item for ${item.image_url} already exists; updating if analysis changed.`);
    if (typeof item.analysis === 'string' && existingLi.dataset.analysis !== item.analysis) {
      existingLi.dataset.analysis = item.analysis;
      // 如果当前正在展示这张截图，也同步更新右侧分析
      const analysisEl = document.getElementById('ss-ai-analysis');
      if (analysisEl && analysisEl.dataset.sourceUrl === item.image_url) {
        analysisEl.innerHTML = '';
        const container = document.createElement('div');
        container.className = 'message-content';
        processAIMessage(container, item.analysis, 'history_item_analysis_update');
        analysisEl.appendChild(container);
        renderLatexInElement(analysisEl);
      }
    }
    return;
  }

  // 1. 更新内存和 localStorage
  ssHistory.unshift(item);
  saveScreenshotHistory();

  // 2. 构造 <li> 及其子元素
  const li = document.createElement('li');
  li.className = 'history-item';
  li.setAttribute('data-url', item.image_url);
  li.dataset.analysis  = item.analysis  || '';
  li.dataset.prompt    = item.prompt    || '';
  li.dataset.timestamp = String(item.timestamp || Date.now() / 1000);
  li.dataset.provider  = item.provider  || 'unknown';

  // 内容包装器
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'history-item-content-wrapper';

  // 缩略图 <img>
  const img = document.createElement('img');
  img.src     = item.image_url + '?t=' + Date.now();  // 防缓存
  img.alt     = '历史截图缩略图';
  img.loading = 'lazy';
  img.onerror = () => {
    const errDiv = document.createElement('div');
    errDiv.className = 'history-error';
    errDiv.textContent = '图片加载失败';
    contentWrapper.replaceChild(errDiv, img);
  };
  contentWrapper.appendChild(img);

  // 时间戳
  const tsDiv = document.createElement('div');
  tsDiv.className = 'history-item-text';
  const date = new Date(parseFloat(li.dataset.timestamp) * 1000);
  tsDiv.textContent = date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short', hour12: false });
  tsDiv.title = date.toLocaleString();
  contentWrapper.appendChild(tsDiv);

  // 操作按钮容器
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'history-item-actions';
  if (typeof createDeleteButton === 'function') {
    const deleteBtn = createDeleteButton(() => {
      // 从数组中移除
      ssHistory = ssHistory.filter(h => h.image_url !== item.image_url);
      saveScreenshotHistory();
      // 从 DOM 中移除
      li.remove();
    });
    actionsDiv.appendChild(deleteBtn);
  }

  // 组装并插入列表
  li.appendChild(contentWrapper);
  li.appendChild(actionsDiv);
  historyListEl.prepend(li);

  // 3. 点击事件：打开大图 + 渲染已有分析
  li.addEventListener('click', e => {
    // 如果点在删除按钮上，忽略
    if (e.target.closest('.history-item-actions')) return;

    // 打开查看大图的 Overlay
    showViewerOverlay(item.image_url);

    // 可选：更新右侧预览图（如你不需要，可以注释以下三行）
    const previewImg = document.getElementById('ss-main-preview-image');
    if (previewImg) {
      previewImg.src             = item.image_url;
      previewImg.dataset.currentUrl = item.image_url;
      previewImg.style.display   = 'block';
      document.getElementById('ss-crop-current-btn')?.style.removeProperty('display');
    }

    // 如果已有分析，则渲染到右侧分析区
    if (typeof item.analysis === 'string') {
      const analysisEl = document.getElementById('ss-ai-analysis');
      if (analysisEl) {
        analysisEl.dataset.sourceUrl = item.image_url;
        analysisEl.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'message-content';
        // 渲染 Markdown + 流式兼容
        div.innerHTML = md.render(item.analysis);
        renderLatexInElement(analysisEl);
        analysisEl.appendChild(div);
      }
    }
  });
}


function showViewerOverlay(url) {
  const overlay = document.getElementById('viewer-overlay');
  const img     = document.getElementById('viewer-image');
  if (!overlay || !img) return;
  img.src = url;
  overlay.style.display = 'flex';
}

function hideViewerOverlay() {
  const overlay = document.getElementById('viewer-overlay');
  if (overlay) overlay.style.display = 'none';
}


// ---------------------------------------------------------------------
//  Base Button Handlers  ✨唯一官方版本✨
//  放在 util & feature-helper 函数之后，initAllFeatures() 之前
// ---------------------------------------------------------------------
/* =========================================================
   初始化所有零散按钮（仅绑定一次）
   ========================================================= */
function initBaseButtonHandlers() {

  /* ========= 1. 通用 / 测试按钮 ========= */
  document.getElementById('test-render-btn')
      ?.addEventListener('click', () => {
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;
        if (chatHistoryEl.querySelector('.system-message')) chatHistoryEl.innerHTML = '';
        const testDiv = document.createElement('div');
        testDiv.className = 'ai-message';
        processAIMessage(testDiv, '### Test MD\n\n- List\n- KaTeX: $E=mc^2$', 'test_button');
        chatHistoryEl.appendChild(testDiv);
        scrollToChatBottom(chatHistoryEl);
      });

  document.getElementById('clear-chat-btn')
      ?.addEventListener('click', () => {
        document.getElementById('chat-chat-history').innerHTML = '';
      });

  document.getElementById('copy-last-msg-btn')
      ?.addEventListener('click', () => {
        const last = document.querySelector('#chat-chat-history .message-content:last-child');
        if (last) navigator.clipboard.writeText(last.textContent || '');
      });

  // 可选：整个聊天截图
  if (window.html2canvas) {
    document.getElementById('screenshot-btn')
        ?.addEventListener('click', () => {
          html2canvas(document.getElementById('chat-chat-history'))
            .then(c => {
              const a = document.createElement('a');
              a.download = 'chat_screenshot.png';
              a.href = c.toDataURL('image/png');
              a.click();
            });
        });
  }

  /* ========= 2. 截图分析区 ========= */
  document.getElementById('ss-capture-btn')   ?.addEventListener('click', requestScreenshot);
  document.getElementById('ss-clear-history') ?.addEventListener('click', clearScreenshotHistory);

  document.getElementById('viewer-close-btn') ?.addEventListener('click', hideViewerOverlay);
  document.getElementById('viewer-overlay')   ?.addEventListener('click', e => {
      if (e.target.id === 'viewer-overlay') hideViewerOverlay();
  });

  document.getElementById('ss-crop-current-btn')
      ?.addEventListener('click', () => {
        const img = document.getElementById('ss-main-preview-image');
        if (img?.dataset.currentUrl) showImageOverlay(img.dataset.currentUrl);
        else alert('没有当前显示的图片可裁剪');
      });

  /* ========= 3. 聊天区 ========= */
  document.getElementById('chat-send-chat')
      ?.addEventListener('click', sendChatMessage);

  document.getElementById('chat-chat-input')
      ?.addEventListener('keypress', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
      });

  document.getElementById('chat-file-upload')
      ?.addEventListener('change', handleFileUpload);     // 仅缓存文件，不立即发送

  document.getElementById('chat-clear-current-chat')
      ?.addEventListener('click', clearCurrentChatDisplay);

  document.getElementById('chat-clear-all-sessions')
      ?.addEventListener('click', clearAllChatSessions);

  /* ========= 4. 语音区 ========= */
  document.getElementById('voice-clear-history')
      ?.addEventListener('click', clearVoiceHistory);     // 只绑定一次

  // 录音开始/停止按钮在 initVoiceFeature() 里绑定

  /* ========= 5. 裁剪遮罩 Overlay ========= */
  document.getElementById('close-overlay')     ?.addEventListener('click', hideImageOverlay);
  document.getElementById('confirm-selection') ?.addEventListener('click', confirmCrop);
  document.getElementById('cancel-selection')  ?.addEventListener('click', hideImageOverlay);

  /* ========= （已删除）粘贴图片立即发送 =========
     该逻辑已经移动到 “粘贴/选择文件 → 仅预览，点发送再发” 的统一实现中。
     若仍需要，请确保只保留一份逻辑，避免重复发送。 */
}


/* =========================================================
   图片发送 – 只预览，不立即发送
   ========================================================= */
// main.js (文件末尾的 IIFE - 修改后，粘贴逻辑将调用 handleFileUpload)
(function initImageInput() {
  const chatInputEl = document.getElementById('chat-chat-input');
  const fileInputEl = document.getElementById('chat-file-upload'); // 用于清空 value

  if (!chatInputEl || !fileInputEl) {
    console.warn("initImageInput: chatInput or fileInput element not found. Paste functionality might be affected.");
    return;
  }

  // =========== 1. 粘贴图片处理 ===========
  chatInputEl.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFilesFromClipboard = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault(); // 阻止默认的粘贴行为（如将图片作为文本插入）
        const file = item.getAsFile();
        if (file) {
          // 为了区分粘贴的文件和选择的文件（如果需要），可以给文件名加个前缀
          // Object.defineProperty(file, 'name', { writable: true, value: `pasted_${file.name}` });
          pastedFilesFromClipboard.push(file);
        }
      }
    }

    if (pastedFilesFromClipboard.length > 0) {
      debugLog(`Processing ${pastedFilesFromClipboard.length} image(s) from paste.`);

      // 使用 DataTransfer 来创建一个 FileList，以便 handleFileUpload 可以处理
      const dataTransfer = new DataTransfer();
      pastedFilesFromClipboard.forEach(file => dataTransfer.items.add(file));


      const mockFileInputTarget = { files: dataTransfer.files };
      handleFileUpload({ target: mockFileInputTarget }); // 调用统一的文件处理与预览函数

  
      pastedImageBase64Array = [];
      if (window.pastedImageBase64) window.pastedImageBase64 = null;

    }
  });

  // =========== 2. 选择文件 (相关的 change 事件监听器已在 initAllFeatures 中由 handleFileUpload 处理) ===========
  // 该 IIFE 不再需要监听 fileInput 的 'change' 事件

  // =========== 3. stageImage 函数 (不再需要，其功能已由粘贴逻辑调用 handleFileUpload 实现) ===========
  // function stageImage(file) { ... } // 可以安全删除此函数
})();





function updateSelectionBox() {
  const selBox   = document.getElementById('selection-box');
  const cropInfo = document.getElementById('crop-info');
  const imgEl    = document.getElementById('overlay-image');

  if (!selBox || !cropInfo || !imgEl || !imgEl.width || !imgEl.naturalWidth) return;

  // 1) 边界 & 最小尺寸校正
  selection.x      = Math.max(0, Math.min(selection.x, imgEl.width));
  selection.y      = Math.max(0, Math.min(selection.y, imgEl.height));
  selection.width  = Math.max(10, Math.min(selection.width,  imgEl.width  - selection.x));
  selection.height = Math.max(10, Math.min(selection.height, imgEl.height - selection.y));

  // 2) 更新选框 CSS
  Object.assign(selBox.style, {
    left  : `${selection.x}px`,
    top   : `${selection.y}px`,
    width : `${selection.width}px`,
    height: `${selection.height}px`
  });

  // 3) 显示原图中的坐标/尺寸
  const scaleX = imgEl.naturalWidth  / imgEl.width;
  const scaleY = imgEl.naturalHeight / imgEl.height;
  cropInfo.textContent =
    `选择(原图): ${Math.round(selection.x * scaleX)}, ${Math.round(selection.y * scaleY)}, ` +
    `${Math.round(selection.width * scaleX)} × ${Math.round(selection.height * scaleY)}`;
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
  loadHistoriesFromStorage();      // ★★ 加在最顶部
    /* ② 渲染已有历史到左栏 */
  ssHistory.forEach(addHistoryItem);            // ← 截图条目
  voiceHistory.forEach(addVoiceHistoryItem);    // ← 语音条目 (若有)

    const fileInput = document.getElementById('chat-file-upload');
    const attachBtn = document.getElementById('chat-attach-file-btn');


    attachBtn.addEventListener('click', function(e) {
    // 只处理用户真实点击
    if (!e.isTrusted) return;
    // fileInput.click();
    });


    // 仍然监听 change 事件进行预览
    fileInput.addEventListener('change', handleFileUpload);

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
  initBaseButtonHandlers();
  initVoiceFeature();
  initScreenshotStreamToggle();

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

// main.js (可以放在其他辅助函数附近)

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
}

// 您可能已经在 style.css 中有 .system-message 和 .error-text 的样式
// 如果没有，可以添加一些基础样式，例如：
/*
In style.css:
.system-message {
    font-size: 0.85em;
    text-align: center;
    margin: 0.5rem auto;
    padding: 0.25rem 0.5rem;
    max-width: 80%;
    color: var(--system-message-text-color, #6c757d);
}
.error-text {
    color: var(--error-message-text-color, #842029) !important;
    background-color: var(--error-message-bg, #f8d7da);
    border: 1px solid var(--error-message-border-color, #f5c2c7);
    border-radius: var(--bs-border-radius-sm, 0.2rem);
}
.info-text {
    color: #0c5460 !important;
    background-color: #d1ecf1;
    border: 1px solid #bee5eb;
    border-radius: var(--bs-border-radius-sm, 0.2rem);
}
*/

// main.js (可以放在其他与聊天会话UI相关的函数附近)

/**
 * 在左侧的聊天会话列表中，高亮显示指定的会话项，并取消其他项的高亮。
 * @param {string | number | null} sessionId 要激活的会话的ID。如果为 null，则取消所有高亮。
 */
function setActiveChatSessionUI(sessionId) {
    const sessionListEl = document.getElementById('chat-session-list');
    if (!sessionListEl) {
        // console.warn("setActiveChatSessionUI: Session list element (#chat-session-list) not found.");
        return;
    }

    // 移除所有现有会话项的 'active-session' 类
    const currentActiveItems = sessionListEl.querySelectorAll('.history-item.active-session');
    currentActiveItems.forEach(item => {
        item.classList.remove('active-session');
    });

    // 如果提供了有效的 sessionId，则给对应的会话项添加 'active-session' 类
    if (sessionId !== null && sessionId !== undefined) {
        // 构建选择器时要注意 sessionId 的类型，如果它是数字，直接用模板字符串可能没问题，
        // 但如果包含特殊字符或纯数字，确保CSS选择器有效。
        // 使用CSS.escape() 可以更安全，但需要浏览器支持。
        // let escapedSessionId;
        // try {
        //     escapedSessionId = CSS.escape(String(sessionId));
        // } catch (e) {
        //     escapedSessionId = String(sessionId).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1'); // 简单转义
        // }
        // const newActiveItem = sessionListEl.querySelector(`.history-item[data-session-id="${escapedSessionId}"]`);

        // 通常情况下，session ID 是UUID字符串或时间戳数字，可以直接用
        const newActiveItem = sessionListEl.querySelector(`.history-item[data-session-id="${String(sessionId)}"]`);

        if (newActiveItem) {
            newActiveItem.classList.add('active-session');
            // 可选：将激活的项滚动到视图中 (如果列表是可滚动的)
            // newActiveItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            // console.warn(`setActiveChatSessionUI: No session item found with ID: ${sessionId}`);
        }
    }
}

// 确保您在 style.css 中有 .active-session 类的样式，例如：
/*
In style.css:
.history-item.active-session {
    background-color: var(--history-item-active-bg, #e0e7ff) !important;
    border-left-color: var(--history-item-active-border-color, var(--primary-color, #0d6efd)) !important;
    font-weight: bold;
}
.history-item.active-session .history-item-content-wrapper > div:first-child {
    color: var(--panel-title-text-color, var(--primary-color, #0d6efd));
}
*/




// 修改后的 addChatHistoryItem (AI 对话历史)
/* =========================================================
   addChatHistoryItem — 在左侧会话栏插入 / 更新一条 <li>
   ========================================================= */
function addChatHistoryItem(session) {

  const listEl = document.getElementById('chat-session-list');
  if (!listEl || !session || !session.id) {
    console.warn('[ChatHistory] list element or session missing', session);
    return;
  }

  /* ---------- 1. 若已存在同 id 的 <li>，先移除 ---------- */
  listEl.querySelector(`li[data-session-id="${session.id}"]`)?.remove();

  /* ---------- 2. 创建新的 <li> ---------- */
  const li = document.createElement('li');
  li.className = 'history-item chat-history-item';
  li.dataset.sessionId = String(session.id);

  /* ---- 内容包裹 ---- */
  const wrapper = document.createElement('div');
  wrapper.className = 'history-item-content-wrapper';

  /* 标题 + 时间 */
  const title   = session.title?.trim() || '无标题对话';
  const ts      = session.created_at
                    ? new Date(session.created_at)
                    : (Number(session.id) ? new Date(Number(session.id)) : new Date());
  const tsText  = ts.toLocaleString([], { dateStyle:'short', timeStyle:'short', hour12:false });

  const titleDiv = document.createElement('div');
  Object.assign(titleDiv.style, {
    fontWeight:'500', whiteSpace:'nowrap',
    overflow:'hidden', textOverflow:'ellipsis'
  });
  titleDiv.title = title;
  titleDiv.innerHTML = `<i class="fas fa-comment"></i> ${escapeHtml(title)}`;

  const timeDiv  = document.createElement('div');
  timeDiv.style.cssText = 'font-size:.75em;color:#666;';
  timeDiv.textContent   = tsText;

  wrapper.appendChild(titleDiv);
  wrapper.appendChild(timeDiv);

  /* ---- 删除按钮 ---- */
  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  actions.appendChild(
    createDeleteButton(() => {
      if (!confirm(`确定要删除对话 "${title}"?`)) return;

      /* 1. 删数组 + 保存 */
      chatSessions = chatSessions.filter(s => s.id !== session.id);
      saveChatSessionsToStorage?.();

      /* 2. 删 DOM */
      li.remove();

      /* 3. 若正在查看此会话，则清右侧窗口 */
      if (currentChatSessionId === session.id) {
        clearCurrentChatDisplay?.();
      }
    })
  );

  /* ---- 组装 li ---- */
  li.appendChild(wrapper);
  li.appendChild(actions);

  /* ---- 点击 li → 激活会话 ---- */
  li.addEventListener('click', (e) => {
    if (e.target.closest('.history-item-actions')) return; // 点到了删除
    const sid = session.id;

    /* 设置激活 */
    currentChatSessionId = sid;
    renderChatHistory?.(session.history || []);
    listEl.querySelectorAll('.history-item.active-session')
          .forEach(el => el.classList.remove('active-session'));
    li.classList.add('active-session');
    saveCurrentChatSessionId?.();

    document.getElementById('chat-chat-input')?.focus();
  });

  /* ---------- 3. 插入到列表最前 ---------- */
  listEl.insertBefore(li, listEl.firstChild);
}

function bumpActiveChatSessionToTop() {
  const listEl = document.getElementById('chat-session-list');
  const activeLi = listEl.querySelector(`li[data-session-id="${currentChatSessionId}"]`);
  if (activeLi) listEl.insertBefore(activeLi, listEl.firstChild);
}


  // —— 确保历史条并返回它 —— 
function ensureHistoryItem(url, analysis='') {
  const list = document.getElementById('ss-history-list');
  let li = list.querySelector(`li[data-url="${url}"]`);
  if (!li) {
    li = document.createElement('li');
    li.dataset.url = url;
    li.addEventListener('click', () => selectHistoryItem(li, { image_url: url, analysis }));
    const thumb = document.createElement('img');
    thumb.src = url; thumb.alt = '缩略';
    li.appendChild(thumb);
    list.prepend(li);
  }
  li.dataset.analysis = analysis;
  return li;
}

// —— 切面板到“截图分析” —— 
function switchToScreenshotPanel() {
  // 导航按钮高亮
  document.querySelectorAll('.nav-dropdown-item.active')
    .forEach(el => el.classList.remove('active'));
  document.querySelector('.nav-dropdown-item[data-feature="screenshot-analysis"]')
    .classList.add('active');
  // 左右面板显示隐藏
  document.querySelectorAll('.feature-content-block')
    .forEach(el => el.classList.remove('active'));
  document.getElementById('left-panel-screenshot-analysis').classList.add('active');
  document.getElementById('right-panel-screenshot-analysis').classList.add('active');
}

// —— 选中历史并渲染分析 —— 
function selectHistoryItem(li, { image_url, analysis }) {
  // 左侧高亮
  const list = document.getElementById('ss-history-list');
  list.querySelectorAll('li.selected').forEach(el => el.classList.remove('selected'));
  li.classList.add('selected');

  // 渲染右侧
  const mainEl = document.getElementById('ss-ai-analysis');
  mainEl.dataset.sourceUrl = image_url;
  mainEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'message-content';
  processAIMessage(div, analysis||'无分析内容', 'analysis_result');
  mainEl.appendChild(div);
  if (typeof renderLatexInElement==='function') renderLatexInElement(mainEl);
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

        // 流式响应处理
    socket.on('chat_stream_chunk', data => {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;

    // 1. 找 aiDiv（非 thinking 状态）
    let aiDiv = chatHistoryEl.querySelector(`.ai-message[data-request-id="${data.request_id}"]`);

    // 2. 如果不存在，就移除 thinking、创建 aiDiv 和内容容器
    if (!aiDiv) {
        const thinkingEl = chatHistoryEl.querySelector(`.ai-thinking[data-request-id="${data.request_id}"]`);
        if (thinkingEl) removeThinkingIndicator(chatHistoryEl, thinkingEl);

        aiDiv = document.createElement('div');
        aiDiv.className = 'ai-message';
        aiDiv.dataset.requestId = data.request_id;
        if (data.provider) aiDiv.dataset.provider = data.provider;

        // 创建内容容器
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        aiDiv.appendChild(contentDiv);

        // 初始化 buffer
        aiDiv._streamBuffer = '';

        chatHistoryEl.appendChild(aiDiv);
    }

    // 3. 确保 contentDiv 一定存在
    let contentDiv = aiDiv.querySelector('.message-content');
    if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        aiDiv.appendChild(contentDiv);
        aiDiv._streamBuffer = aiDiv._streamBuffer || '';
    }

    // 4. 累积 chunk 到 buffer
    aiDiv._streamBuffer += data.chunk || '';

    // 5. 实时 Markdown + KaTeX 渲染
    contentDiv.innerHTML = md.render(aiDiv._streamBuffer);
    renderLatexInElement(contentDiv);

    // 6. 滚到底部
    scrollToChatBottom(chatHistoryEl);
    });



    /* =========================================================
   Socket 处理：chat_stream_end
   ========================================================= */
    socket.on('chat_stream_end', (data) => {
        console.log(`[Socket] 'chat_stream_end'  reqId=${data.request_id}`);

        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) {
            console.error('[chat_stream_end] chatHistoryEl NOT found');
            return;
        }

        /* ---------- 1. 找到或创建消息容器 ---------- */
        let aiDiv = chatHistoryEl.querySelector(
            `.ai-message[data-request-id="${data.request_id}"]:not(.ai-thinking)`
        );

        if (!aiDiv) {
            // 若流式开始时 UI 还没占位，则现在补一个
            console.warn(`[chat_stream_end] no div for ${data.request_id}, create one`);
            chatHistoryEl.querySelector(
            `.ai-thinking[data-request-id="${data.request_id}"]`
            )?.remove();                               // 清掉可能残留的“思考中”

            aiDiv = document.createElement('div');
            aiDiv.className = 'ai-message';
            aiDiv.dataset.requestId = data.request_id;
            if (data.provider) aiDiv.dataset.provider = data.provider;
            chatHistoryEl.appendChild(aiDiv);
        }

        /* ---------- 2. 渲染 Markdown / KaTeX / 代码高亮 ---------- */
        if (aiDiv instanceof HTMLElement) {
            processAIMessage(aiDiv, data.full_message || '', 'chat_stream_end');
            scrollToChatBottom(chatHistoryEl);
        }

        /* ---------- 3. 更新本地会话历史 (chatSessions[]) ---------- */
        const sid = data.session_id || currentChatSessionId;
        if (!sid) {
            console.warn('[History] no active session id');
            return;
        }

        const session = chatSessions.find(s => s.id === sid);
        if (!session) {
            console.warn(`[History] session ${sid} not found`);
            return;
        }

        const idx = session.history.findIndex(
            m => m.role === 'model' && m.temp_id === data.request_id
        );
        if (idx === -1) {
            console.warn(`[History] placeholder not found for req ${data.request_id}`);
            return;
        }

        session.history[idx].parts = [{ text: data.full_message || '' }];
        if (data.provider) session.history[idx].provider = data.provider;
        delete session.history[idx].temp_id;

        saveChatSessionsToStorage();
        bumpActiveChatSessionToTop();
        console.log(`[History] updated AI msg in session ${sid} (stream end)`);
    });

        // 处理非流式的完整回复
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

    socket.on('analysis_stream_chunk', chunk => {
        // 只在开启流式时处理
        if (!ssIsStreaming) return;

        const analysisEl = document.getElementById('ss-ai-analysis');
        // 如果这是流的第一块，先调用一次 processAIMessage 来初始化容器
        if (!analysisEl.querySelector('.message-content')) {
        const container = document.createElement('div');
        container.className = 'message-content';
        analysisEl.appendChild(container);
        // processAIMessage 也支持以空字符串开头
        processAIMessage(container, '', 'analysis_stream');
        }
        // 追加新内容
        const container = analysisEl.querySelector('.message-content');
        processAIMessage(container, chunk.text, 'analysis_stream');
    });

  // 3. 非流式一次性结果
  socket.on('analysis_result', data => {
    if (ssIsStreaming) return;
    console.log('[Socket] analysis_result', data);

    // 3.1 切到截图分析面板
    switchToScreenshotPanel();

    // 3.2 更新主预览图 + 裁剪按钮
    // const img = document.getElementById('ss-main-preview-image');
    // img.src = data.image_url;
    // img.dataset.currentUrl = data.image_url;
    // img.style.display = 'block';
    // document.getElementById('ss-main-preview-placeholder').style.display = 'none';
    document.getElementById('ss-crop-current-btn').style.display = 'inline-block';

    // 3.3 确保历史列表并更新
    const li = ensureHistoryItem(data.image_url, data.analysis);
    // 自动渲染
    selectHistoryItem(li, data);
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

    // socket.on('stt_result', function(data) {
    //     console.log('<<<<< [Socket RECEIVED] stt_result >>>>>', data);
    //     const voiceResultEl = document.getElementById('voice-result');
    //     // 确保 window.currentVoiceRequestId 在开始录音时已设置，并与 data.request_id 匹配
    //     if (voiceResultEl && data.request_id === window.currentVoiceRequestId) {
    //         let currentHTML = voiceResultEl.innerHTML;
    //         // 尝试更安全地清除 "处理中..." 或 "AI正在回复..."
    //         const processingMessages = ['处理中...', 'AI正在回复...'];
    //         processingMessages.forEach(msg => {
    //             currentHTML = currentHTML.replace(new RegExp(`<p.*?>${msg}</p>`, 'gi'), ''); // 移除包含这些文本的<p>标签
    //             currentHTML = currentHTML.replace(msg, ''); // 直接替换文本
    //         });
    //         if (currentHTML.trim() === '<div class="system-message">点击下方按钮开始录音，识别结果和 AI 回答将显示在此处。</div>' || currentHTML.trim() === '') {
    //             currentHTML = ''; // 如果是初始消息或空，则清空
    //         }

    //         voiceResultEl.innerHTML = currentHTML + 
    //                                 `<p><strong>识别到 (${data.provider || 'STT'}):</strong> ${escapeHtml(data.transcript)}</p>` +
    //                                 `<p>AI正在回复...</p>`; // 提示用户AI正在处理
    //         scrollToChatBottom(voiceResultEl); // 如果 voiceResultEl 是可滚动的
    //     }
    // });
    // ===== 语音识别文本 =====
    // 监听 STT 结果
    // 接收语音转写结果，更新“识别结果”并提示 AI 正在回复
    socket.on('stt_result', (data) => {
    // 只处理当前这次录音请求的结果
        if (data.request_id !== window.currentVoiceRequestId) return;

        const vr = document.getElementById('voice-result');
        if (!vr) return;

        vr.innerHTML = `
            <div><i class="fas fa-comment-dots"></i> 识别结果 (${escapeHtml(data.provider || 'STT')}):</div>
            <div class="message-content-simple" style="margin:8px 0;">
            ${escapeHtml(data.transcript || '未提供识别文本')}
            </div>
            <div><i class="fas fa-spinner fa-spin"></i> AI 正在回复…</div>
        `;
    });

    socket.on('voice_answer_text', data => {
    // 把回答也显示到界面上（可选）
    const ui = document.getElementById('voice-result');
    ui.innerHTML += `<div>AI 回答：${escapeHtml(data.text)}</div>`;

    // 调用浏览器 TTS
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(data.text);
        // 可选：设置语音、速度、音调
        // utterance.voice = speechSynthesis.getVoices().find(v => v.lang.startsWith('zh'));
        // utterance.rate = 1;
        window.speechSynthesis.speak(utterance);
    } else {
        console.warn('当前浏览器不支持 SpeechSynthesis');
    }
    });


    // ===== TTS 音频播放（如果你后端返回）=====
    // 处理后端下发的音频 URL
    socket.on('voice_answer_audio', data => {
    console.log('[Socket] voice_answer_audio', data);
    if (data.request_id !== window.currentVoiceRequestId) return;
    const player = document.getElementById('voice-answer-player');
    const src    = document.getElementById('voice-answer-source');
    if (!player || !src) return;

    src.src = data.audio_url;          // 填入后端生成的 MP3 地址
    player.style.display = 'block';    // 确保可见
    player.load();                     // 重新加载音源
    // （可选）自动播放：
    // player.play().catch(e=>console.warn('自动播放失败', e));
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

    /* =========================================================
   Socket 事件：服务器返回语音回答
   data: {
     audio_url   : String  服务器保存的音频文件 URL（或 blob URL）
     transcript  : String  识别文本
     response    : String  AI文字回答
     timestamp   : Number  (可选) 服务器统一时间戳 ms
   }
   ========================================================= */
    socket.on('voice_answer_ready', (data) => {
    if (!data) return;

    // ---------- 1. 播放音频 ----------
    const audioPlayer = document.getElementById('voice-answer-player');
    const audioSrc    = document.getElementById('voice-answer-source');
    if (audioPlayer && audioSrc && data.audio_url) {
        audioSrc.src = data.audio_url;
        audioPlayer.load();                 // 刷新 <audio>
        audioPlayer.style.removeProperty('display');
        audioPlayer.play().catch(() => {}); // 自动播放失败也不报错
    }

    // ---------- 2. 在右侧结果区域显示文字 ----------
    const vr = document.getElementById('voice-result');
    if (vr) {
        vr.innerHTML = '';                             // 先清空
        const transcriptHTML = `
        <div style="margin-bottom:0.5rem;">
            <strong><i class="fas fa-comment-dots"></i> 识别结果:</strong>
            <div class="message-content-simple">${escapeHtml(data.transcript || '')}</div>
        </div><hr>`;
        vr.insertAdjacentHTML('beforeend', transcriptHTML);

        // 用 processAIMessage 渲染 AI 回答（含 Markdown / KaTeX）
        const aiWrap = document.createElement('div');
        aiWrap.innerHTML = '<strong><i class="fas fa-robot"></i> AI回答:</strong>';
        const aiDiv = document.createElement('div');
        aiDiv.className = 'ai-message';
        processAIMessage(aiDiv, data.response || '无回答', 'voice_answer_ready');
        aiWrap.appendChild(aiDiv);
        vr.appendChild(aiWrap);
        scrollToChatBottom(vr);
    }

    // ---------- 3. 写入 voiceHistory 数组并保存 ----------
    const ts = data.timestamp ?? Date.now();
    const item = {
        timestamp : ts,
        transcript: data.transcript || '',
        response  : data.response   || '',
        audio_url : data.audio_url  || ''
    };
    addVoiceHistoryItem(item);   // 会自动 push/unshift + saveVoiceHistory()
    });


    socket.on('chat_error', function(data) {
        console.error('[Socket] Chat error:', data.error);
        const chatHistoryEl = document.getElementById('chat-chat-history');
        if (!chatHistoryEl) return;

        const errorDiv = document.createElement('div');
        errorDiv.className = 'system-message';
        errorDiv.textContent = 'Error: ' + (data.error || 'An error occurred while processing your request.');
        chatHistoryEl.appendChild(errorDiv);
        scrollToChatBottom(chatHistoryEl);
    });

    }







/* =========================================================
   addVoiceHistoryItem — 语音历史条目
   ========================================================= */
/* =========================================================
   addVoiceHistoryItem — 语音历史条目
   ========================================================= */
function addVoiceHistoryItem(item, skipSave = false) {
  const listEl = document.getElementById('voice-history-list');
  if (!listEl || !item) {
    console.warn('[VoiceHistory] list element or item missing:', item);
    return;
  }

  /* ---------- 1. 只有新纪录才写入并保存 ---------- */
  if (!skipSave) {
    voiceHistory.unshift(item);            // 用 push 就改 push
    saveVoiceHistory();
  }

  /* ---------- 2. 渲染 <li> ---------- */
  const ts = item.timestamp ?? Date.now();
  const li = document.createElement('li');
  li.className          = 'history-item voice-history-item';
  li.dataset.id         = String(ts);
  li.dataset.transcript = item.transcript || '无法识别';
  li.dataset.response   = item.response   || '无回答';

  const wrapper  = document.createElement('div');
  wrapper.className = 'history-item-content-wrapper';
  const tsStr = new Date(ts).toLocaleString([], {dateStyle:'short',timeStyle:'short',hour12:false});
  wrapper.innerHTML = `
    <div><strong><i class="fas fa-clock"></i> ${tsStr}</strong></div>
    <div title="${escapeHtml(item.transcript||'')}">
      <i class="fas fa-comment-dots"></i> ${escapeHtml((item.transcript||'').slice(0,30))}${item.transcript&&item.transcript.length>30?'…':''}
    </div>`;

  /* 删除按钮 */
  const actions = document.createElement('div');
  actions.className = 'history-item-actions';
  actions.appendChild(createDeleteButton(() => {
    if (!confirm('确定要删除此语音记录吗?')) return;
    voiceHistory = voiceHistory.filter(v => String(v.timestamp??v.id) !== String(ts));
    saveVoiceHistory();
    li.remove();
    const vr = document.getElementById('voice-result');
    if (vr && vr.dataset.associatedId === String(ts)) {
      vr.textContent = '点击下方按钮开始录音，识别结果和 AI 回答将显示在此处。';
      delete vr.dataset.associatedId;
    }
  }));

  li.appendChild(wrapper);
  li.appendChild(actions);

  /* 点击回放 */
  li.addEventListener('click', e => {
    if (e.target.closest('.history-item-actions')) return;
    const vr = document.getElementById('voice-result');
    if (!vr) return;
    vr.innerHTML = `
      <div style="margin-bottom:.5rem;">
        <strong><i class="fas fa-comment-dots"></i> 识别结果:</strong>
        <div class="message-content-simple">${escapeHtml(item.transcript||'')}</div>
      </div><hr>`;
    const aiWrap   = document.createElement('div');
    aiWrap.innerHTML = '<strong><i class="fas fa-robot"></i> AI回答:</strong>';
    const aiDiv    = document.createElement('div');
    aiDiv.className = 'ai-message';
    processAIMessage(aiDiv, item.response || '无回答', 'voice_history_click');
    aiWrap.appendChild(aiDiv);
    vr.appendChild(aiWrap);
    vr.dataset.associatedId = String(ts);
  });

  listEl.insertBefore(li, listEl.firstChild);
}



function initVoiceAnswerHandlers() {
    initVoiceFeature();

    const clearBtn = document.getElementById('voice-clear-history');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearVoiceHistory);
    }
}



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
        ssHistory = [];
        document.getElementById('ss-history-list').innerHTML = '';
        saveScreenshotHistory(); 
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
        uploadedFiles = null;
        
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
        voiceHistory = [];
        document.getElementById('voice-history-list').innerHTML = '';
        saveVoiceHistory();
    }

    const player = document.getElementById('voice-answer-player');
    if (player) {
        player.pause();
        player.style.display = 'none';
        document.getElementById('voice-answer-source').src = '';
    }
}

// --- API & Server Communication ---
function getApiInfo() {
    if (!TOKEN) { updateApiInfo({ provider: '未知 (Token未设置)' }); return; }
    fetch('/api_info', { headers: { 'Authorization': `Bearer ${TOKEN}` } })
    .then(r=>{if(r.status===401)throw new Error('Unauthorized');if(!r.ok)throw new Error(`API信息获取失败(${r.status})`);return r.json();})
    .then(updateApiInfo).catch(e=>{console.error('API info error:',e);updateApiInfo({provider:`错误(${e.message})`});});
}


async function sendVoiceToServer(audioBlob) {
    const fd = new FormData();
    const timestamp = Date.now();
    // 附加音频数据
    fd.append('audio', audioBlob, `recorded_audio_${timestamp}.wav`);

    // 附加客户端请求 ID
    const requestIdForThisOperation = window.currentVoiceRequestId;
    if (requestIdForThisOperation) {
        fd.append('request_id', requestIdForThisOperation);
        console.log('[VOICE] Sending voice to /process_voice with request_id:', requestIdForThisOperation);
    } else {
        console.error('[VOICE] Critical: requestId missing, aborting send.');
        const voiceResultEl = document.getElementById('voice-result');
        if (voiceResultEl) voiceResultEl.innerHTML = '<p class="error-message">请求ID丢失，无法发送语音。</p>';
        // 恢复按钮状态
        document.getElementById('voice-start-recording').disabled = false;
        document.getElementById('voice-stop-recording').disabled = true;
        return;
    }

    // 附加 Socket.IO ID
    if (socket && socket.id) {
        fd.append('socket_id', socket.id);
    }

    // 附加前端选择的 STT 提供商
    const sttProvider = document.getElementById('stt-provider-select').value;
    fd.append('stt_provider', sttProvider);

    // 更新 UI
    const voiceResultEl = document.getElementById('voice-result');
    if (voiceResultEl) {
        voiceResultEl.innerHTML = `<p><i class="fas fa-spinner fa-spin"></i> 处理中... (ID: ${requestIdForThisOperation.substr(0,8)})</p>`;
    }
    document.getElementById('voice-start-recording').disabled = true;
    document.getElementById('voice-stop-recording').disabled = true;

    // 发送到后端
    try {
        const response = await fetch('/process_voice', {
            method: 'POST',
            body: fd,
            headers: {
                ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` })
            }
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `状态: ${response.status}`);
        }
        console.log('[VOICE] Server ACK:', data);
        if (data.status === 'processing') {
            if (data.request_id !== requestIdForThisOperation) {
                console.warn(`[VOICE] Request ID mismatch: sent ${requestIdForThisOperation}, got ${data.request_id}`);
            }
            // 等待 Socket.IO 事件更新最终结果
        } else {
            throw new Error(data.message || data.error || '处理启动失败');
        }
    } catch (err) {
        console.error('[VOICE] Error sending voice:', err);
        if (voiceResultEl) voiceResultEl.innerHTML = `<p class="error-message">发送失败: ${err.message}</p>`;
        document.getElementById('voice-start-recording').disabled = false;
        document.getElementById('voice-stop-recording').disabled = true;
        window.currentVoiceRequestId = null;
    }
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




// Make sure initAllFeatures is the last thing called or is wrapped in DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  initAllFeatures();
});






/* =========================================================
   统一发送文字 / 文件 / 粘贴图
   ========================================================= */
// main.js

/**
 * 发送聊天消息（文本、选择的文件、粘贴的图片）。
 * 所有类型的消息（包括纯文本）都将通过 HTTP POST 请求发送到 /chat_with_file 接口。
 */
async function sendChatMessage() {
    // --- 0. 获取必要的DOM元素和状态 ---
    const chatInputEl = document.getElementById('chat-chat-input');
    const chatHistoryEl = document.getElementById('chat-chat-history');
    const previewWrapEl = document.getElementById('chat-upload-preview');
    const useStreaming = document.getElementById('streaming-toggle-checkbox').checked; // 后端会决定是否流式

    // --- 1. 基础校验 ---
    if (!chatInputEl || !chatHistoryEl || !previewWrapEl) {
        console.error("sendChatMessage: Critical UI elements (input, history, or preview) not found.");
        // 也可以考虑在此处调用 appendSystemMessage，但如果 chatHistoryEl 都没有，就只能 console.error
        return;
    }
    if (!selectedModel.provider || !selectedModel.model_id) {
        appendSystemMessage('请先从顶部选择一个 AI 模型。', chatHistoryEl);
        return;
    }

    const inputText = chatInputEl.value.trim();
    const filesSelected = uploadedFiles.length > 0 ? [...uploadedFiles] : [];
    const imagesPastedBase64 = window.pastedImageBase64Array && window.pastedImageBase64Array.length > 0 ? [...window.pastedImageBase64Array] : [];


    // ✨ 添加详细的日志进行调试 ✨
    console.log(`[DEBUG] sendChatMessage values:`);
    console.log(`  inputText: "${inputText}" (type: ${typeof inputText}, length: ${inputText.length})`);
    console.log(`  !inputText: ${!inputText}`);
    console.log(`  filesSelected.length: ${filesSelected.length}`);
    console.log(`  imagesPastedBase64.length: ${imagesPastedBase64.length}`);
    const conditionResult = !inputText && filesSelected.length === 0 && imagesPastedBase64.length === 0;
    console.log(`  Condition (!inputText && filesSelected.length === 0 && imagesPastedBase64.length === 0) is: ${conditionResult}`);

    if (conditionResult) { // 使用计算好的条件结果
        debugLog("sendChatMessage: No content (text, files, or pasted images) to send.");
        return; // 没有内容可发送
    }
    // if (!inputText && filesSelected.length === 0 && imagesPastedBase64.length === 0) {
    //     debugLog("sendChatMessage: No content (text, files, or pasted images) to send.");
    //     return; // 没有内容可发送
    // }

    // --- 2. 获取或创建当前聊天会话 ---
    let currentSession = chatSessions.find(s => s.id === currentChatSessionId);
    if (!currentSession) {
        const newTitleBase = inputText ||
                           (filesSelected.length > 0 ? filesSelected[0].name : '') ||
                           (imagesPastedBase64.length > 0 ? `粘贴的图片 (${imagesPastedBase64.length}张)` : '新对话');
        currentSession = {
            id: generateUUID(),
            title: newTitleBase.substring(0, 35) + (newTitleBase.length > 35 ? '...' : ''),
            history: [],
            createdAt: Date.now()
        };
        chatSessions.unshift(currentSession);
        if (typeof addChatHistoryItem === "function") addChatHistoryItem(currentSession);
        currentChatSessionId = currentSession.id;
        if (typeof saveCurrentChatSessionId === "function") saveCurrentChatSessionId();
        if (typeof setActiveChatSessionUI === "function") setActiveChatSessionUI(currentChatSessionId);
    }

    // --- 3. 构建用户消息内容（用于历史记录和UI气泡） ---
    const messagePartsForDisplay = []; // 用于构建用户气泡的 parts
    if (inputText) {
        messagePartsForDisplay.push({ type: 'text', content: inputText });
    }
    if (filesSelected.length > 0) {
        messagePartsForDisplay.push({ type: 'files', files: filesSelected.map(f => ({ name: f.name, size: f.size })) });
    }
    if (imagesPastedBase64.length > 0) {
        messagePartsForDisplay.push({ type: 'pasted_images', count: imagesPastedBase64.length, base64Array: imagesPastedBase64 });
    }
    

    // 生成用于存储到 session.history 的文本描述 (更简洁，主要用于AI上下文)
    let historyLogText = inputText;
    if (filesSelected.length > 0) {
        historyLogText += (historyLogText ? "\n" : "") + `[用户上传了 ${filesSelected.length} 个文件: ${filesSelected.map(f=>f.name).join(', ')}]`;
    }
    if (imagesPastedBase64.length > 0) {
        historyLogText += (historyLogText ? "\n" : "") + `[用户粘贴了 ${imagesPastedBase64.length} 张图片]`;
    }
    if (!historyLogText && (filesSelected.length > 0 || imagesPastedBase64.length > 0)) {
        historyLogText = "[用户发送了媒体内容]"; // 如果只有文件/图片没有文本
    }


    // 生成用于显示在用户聊天气泡中的HTML内容
    let userBubbleHTML = '';
    messagePartsForDisplay.forEach((part, index) => {
        let partHTML = '';
        if (part.type === 'text') {
            partHTML = escapeHtml(part.content);
        } else if (part.type === 'files') {
            partHTML = `<i class="fas fa-paperclip"></i> ${part.files.length} 个文件: ${part.files.map(f => escapeHtml(f.name)).join(', ')}`;
        } else if (part.type === 'pasted_images') {
            let pastedImagesPreviewHTMLInBubble = '';
            part.base64Array.forEach((base64, idx) => {
                pastedImagesPreviewHTMLInBubble += `<img src="data:image/png;base64,${base64}" alt="pasted image ${idx+1}" style="max-width:50px; max-height:50px; margin:2px; border:1px solid var(--bs-border-color); border-radius:3px; display:inline-block;">`;
            });
            partHTML = `<div class="pasted-images-preview-in-bubble my-1">${pastedImagesPreviewHTMLInBubble}</div> (${part.count} 张粘贴的图片)`;
        }

        if (userBubbleHTML && partHTML) { // 如果不是第一部分且当前部分有内容
            userBubbleHTML += (part.type === 'text' && messagePartsForDisplay[index-1]?.type === 'text') ? (' ' + partHTML) : ('<br>' + partHTML);
        } else {
            userBubbleHTML += partHTML;
        }
    });

    if (!userBubbleHTML.trim()) { // 避免发送完全是空内容的气泡
         if (filesSelected.length > 0 || imagesPastedBase64.length > 0) {
            userBubbleHTML = "(已发送媒体内容)";
         } else {
            debugLog("sendChatMessage: User bubble content is empty. Not sending.");
            return;
         }
    }


    // --- 4. 更新UI：添加用户消息气泡和会话历史 ---
    if (historyLogText) { // 只有当 historyLogText 不为空时才添加到历史记录
        currentSession.history.push({ role: 'user', parts: [{ text: historyLogText }] });
    }

    const userMessageDiv = document.createElement('div');
    userMessageDiv.className = 'user-message';
    userMessageDiv.innerHTML = `<strong>您: </strong><div class="message-content">${userBubbleHTML}</div>`;
    chatHistoryEl.appendChild(userMessageDiv);

    if (chatHistoryEl.firstElementChild && chatHistoryEl.firstElementChild.classList.contains('system-message') && chatHistoryEl.firstElementChild.textContent.includes('选择左侧记录或开始新对话')) {
        chatHistoryEl.firstElementChild.remove();
    }

    // --- 5. 准备AI请求ID和“思考中”UI ---
    const requestId = generateUUID();
    const thinkingIndicatorDiv = document.createElement('div');
    thinkingIndicatorDiv.className = 'ai-message ai-thinking';
    thinkingIndicatorDiv.dataset.requestId = requestId;
    thinkingIndicatorDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> AI (${selectedModel.provider}/${selectedModel.model_id}) 正在思考...`;
    chatHistoryEl.appendChild(thinkingIndicatorDiv);
    if (typeof scrollToChatBottom === "function") scrollToChatBottom(chatHistoryEl);

    currentSession.history.push({
        role: 'model', parts: [{ text: '' }], temp_id: requestId,
        provider: selectedModel.provider, model_id: selectedModel.model_id
    });
    const historyForAI = currentSession.history.slice(0, -1);

    // --- 6. 统一通过 HTTP FormData 发送所有内容到 /chat_with_file ---
    const formData = new FormData();
    formData.append('prompt', inputText); // 用户输入的原始文本提示
    formData.append('history', JSON.stringify(historyForAI));
    formData.append('session_id', currentSession.id); // 后端 /chat_with_file 可能会用到
    formData.append('request_id', requestId);
    formData.append('provider', selectedModel.provider);
    formData.append('model_id', selectedModel.model_id);

    // 添加选择的文件 (File 对象)
    filesSelected.forEach(file => {
        formData.append('files', file, file.name); // 后端用 request.files.getlist("files")
    });

    // 添加粘贴的图片的Base64数据数组 (作为JSON字符串)
    if (imagesPastedBase64.length > 0) {
        formData.append('pasted_images_base64_json_array', JSON.stringify(imagesPastedBase64));
    }
    formData.append('use_streaming', useStreaming);
    debugLog(`Sending unified request to /chat_with_file. Files: ${filesSelected.length}, Pasted Images: ${imagesPastedBase64.length}, Prompt: "${inputText}"`);

    fetch('/chat_with_file', {
        method: 'POST',
        headers: { ...(TOKEN && { 'Authorization': `Bearer ${TOKEN}` }) },
        body: formData
    })
    .then(response => {
        if (!response.ok) {
            return response.json().catch(() => ({
                error: `HTTP Error: ${response.status} ${response.statusText}`,
                details: `Response body was not valid JSON or empty.`
            })).then(errData => Promise.reject(errData));
        }
        return response.json();
    })
    .then(data => {
        debugLog('/chat_with_file request acknowledged:', data);
        // AI的回复将通过Socket.IO事件 (chat_stream_chunk, chat_stream_end) 返回并更新 thinkingIndicatorDiv
        // 这些事件会使用 requestId 来匹配和更新正确的 thinkingIndicatorDiv
    })
    .catch(error => {
        console.error('Error sending unified request via /chat_with_file:', error);
        if (typeof removeThinkingIndicator === "function") removeThinkingIndicator(chatHistoryEl, thinkingIndicatorDiv);
        else if (thinkingIndicatorDiv.parentNode) thinkingIndicatorDiv.parentNode.removeChild(thinkingIndicatorDiv);

        // 从会话历史中移除对应的AI占位符，因为它不会有回复了
        const modelPlaceholderIdx = currentSession.history.findIndex(m => m.temp_id === requestId);
        if (modelPlaceholderIdx > -1) currentSession.history.splice(modelPlaceholderIdx, 1);

        appendSystemMessage(`请求发送失败: ${error.error || error.message || JSON.stringify(error) || '未知错误'}`, chatHistoryEl);
    });

    // --- 7. 清理前端状态 ---
    chatInputEl.value = '';
    if (previewWrapEl) previewWrapEl.innerHTML = '';
    uploadedFiles = [];
    if (window.pastedImageBase64Array) window.pastedImageBase64Array = [];
    if (window.pastedImageBase64) window.pastedImageBase64 = null;

    if (typeof saveChatSessionsToStorage === "function") saveChatSessionsToStorage();
    if (typeof bumpActiveChatSessionToTop === "function") bumpActiveChatSessionToTop();
}
