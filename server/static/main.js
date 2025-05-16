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
let ssHistory = [];
let voiceHistory = [];


const THEME_STORAGE_KEY = 'selectedAppTheme'; // 您可以选择一个合适的键名
const MODEL_SELECTOR_STORAGE_KEY_PROVIDER = 'selectedProvider';
const MODEL_SELECTOR_STORAGE_KEY_MODEL_ID = 'selectedModelId';
const ACTIVE_MAIN_FEATURE_TAB_KEY = 'activeMainFeature'; // Changed from ...TAB
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';


function loadHistoriesFromStorage() {
  try {
    ssHistory    = JSON.parse(localStorage.getItem('ssHistory')     || '[]');
    voiceHistory = JSON.parse(localStorage.getItem('voiceHistory') || '[]');

    ssHistory.forEach(addScreenshotHistoryItem);
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

        // ssHistory.unshift(item);                      // ② 放到数组（想让旧的在前就用 push）
        // saveScreenshotHistory();                      // ③ 写回 localStorage
        // historyListEl.insertBefore(li, historyListEl.firstChild);  // ④ 插到 DOM
        return;

    }
    ssHistory.unshift(item);     // 最新在最前；用 push 就改成 push
    saveScreenshotHistory();     // 写回 localStorage

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
              // 1. 删数组
            ssHistory = ssHistory.filter(h => h.image_url !== item.image_url);
            // 2. 删 DOM
            li.remove();
            // 3. 保存
            saveScreenshotHistory();
        });
        actionsContainer.appendChild(deleteBtn);
    }

    li.appendChild(contentWrapper);
    li.appendChild(actionsContainer);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.history-item-actions')) {
            return;
        }

        showViewerOverlay(item.image_url);

        // ② 把大图塞进右侧（可以 display:none，只做数据容器）
        const preview = document.getElementById('ss-main-preview-image');
        if (preview) {
            preview.src= item.image_url;
            preview.dataset.currentUrl = item.image_url;
            document.getElementById('ss-crop-current-btn')?.style.removeProperty('display');
        }

        // ③ 把服务器返回的分析（若已存在）直接填到右侧
        if (typeof item.analysis === 'string') {
            const analysisEl = document.getElementById('ss-ai-analysis');
            if (analysisEl) {
                analysisEl.dataset.sourceUrl = item.image_url;
                analysisEl.innerHTML = md.render(item.analysis);       // ← Markdown
                renderLatexInElement(analysisEl);                      // ← KaTeX
                analysisEl.innerHTML = md.render(item.analysis || '');
                renderLatexInElement(analysisEl);
            }
        }
    });

    historyListEl.insertBefore(li, historyListEl.firstChild);
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
(function initImageInput() {
  const chatInput  = document.getElementById('chat-chat-input');
  const fileInput  = document.getElementById('chat-file-upload');
  const previewEl  = document.getElementById('chat-upload-preview');
  if (!chatInput || !fileInput || !previewEl) return;

  // =========== 1. 粘贴 ===========
  chatInput.addEventListener('paste', e => {
    const fItem = [...e.clipboardData.items]
      .find(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (!fItem) return;
    e.preventDefault();
    const file = fItem.getAsFile();
    if (file) stageImage(file);
  });

  // =========== 2. 选择文件 ===========
  fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) stageImage(file);
    e.target.value = '';           // 清空选择
  });

  // =========== 3. 预览并缓存 ===========
  function stageImage(file) {
    uploadedFile = file;           // ✨ 关键：缓存到全局
    const urlObj = URL.createObjectURL(file);
    previewEl.innerHTML =
      `<img src="${urlObj}" style="max-width:120px;max-height:120px;
        border:1px solid var(--bs-border-color);border-radius:4px;">`;
  }
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

    attachBtn.addEventListener('click', () => {
    // 直接打开文件选择框
    fileInput.click();
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
document.addEventListener('DOMContentLoaded', initAllFeatures);





/* =========================================================
   统一发送文字 / 文件 / 粘贴图
   ========================================================= */
async function sendChatMessage() {
  const chatInputEl    = document.getElementById('chat-chat-input');
  const chatHistoryEl  = document.getElementById('chat-chat-history');
  const previewWrap    = document.getElementById('chat-upload-preview');
  const useStreaming = document.getElementById('streaming-toggle-checkbox').checked;

  /* ---------- 基础校验 ---------- */
  if (!socket?.connected) {
    appendSystemError('错误：无法连接到服务器，请检查网络连接。');
    return;
  }
  if (!chatInputEl || !chatHistoryEl) return;

  const txt = chatInputEl.value.trim();
  const fileToSend   = uploadedFile        || null;          // 由 file input 选中
  const imageBase64  = window.pastedImageBase64 || null;     // 由粘贴逻辑填充

  if (!txt && !fileToSend && !imageBase64) return;           // 空发送，忽略

  if (!selectedModel.provider || !selectedModel.model_id) {
    appendSystemError('请先从顶部选择一个 AI 模型。');
    return;
  }

  /* ---------- 找 / 建 会话 ---------- */
  let sess = chatSessions.find(s => s.id === currentChatSessionId);
  if (!sess) {
    sess = {
      id:   Date.now(),
      title: (txt || (fileToSend ? fileToSend.name : '包含图片的对话')).slice(0, 30),
      history: []
    };
    chatSessions.unshift(sess);
    addChatHistoryItem(sess);
    currentChatSessionId = sess.id;
    saveCurrentChatSessionId?.();
  }

  /* ---------- Push "user" 历史 ---------- */
  let historyText = txt;
  if (!historyText) {
    historyText = fileToSend
      ? `[用户上传了文件: ${fileToSend.name}]`
      : '[用户发送了一张图片]';
  }
  sess.history.push({ role:'user', parts:[{ text: historyText }] });

  /* ---------- UI: 用户消息气泡 ---------- */
  const uDiv = document.createElement('div');
  uDiv.className = 'user-message';
  uDiv.innerHTML = `<strong>您: </strong>`;
  const content = document.createElement('div');
  content.className = 'message-content';
  if (txt)  content.append(txt);
  if (imageBase64)  content.innerHTML += '<br><i class="fas fa-image"></i> [已粘贴图片]';
  if (fileToSend)   content.innerHTML += `<br><i class="fas fa-paperclip"></i> ${escapeHtml(fileToSend.name)}`;
  uDiv.appendChild(content);
  chatHistoryEl.appendChild(uDiv);

  /* ---------- AI thinking 占位 ---------- */
  const reqId = generateUUID();
  const think = document.createElement('div');
  think.className = 'ai-message ai-thinking';
  think.dataset.requestId = reqId;
  think.innerHTML = `<i class="fas fa-spinner fa-spin"></i> AI (${selectedModel.provider}/${selectedModel.model_id}) 正在思考...`;
  chatHistoryEl.appendChild(think);
  scrollToChatBottom(chatHistoryEl);

  /* ---------- 历史里加 AI 占位 ---------- */
  sess.history.push({ role:'model', parts:[{text:''}], temp_id:reqId,
                      provider:selectedModel.provider, model_id:selectedModel.model_id });

  /* ---------- 构造历史副本（不含 AI 占位） ---------- */
  const historyToSend = sess.history.slice(0, -1);

  /* ---------- 发送 ---------- */
  if (fileToSend) {
    /* ======= 文件上传: /chat_with_file ======= */
    const fd = new FormData();
    fd.append('prompt', txt);
    fd.append('file', fileToSend, fileToSend.name);
    fd.append('history', JSON.stringify(historyToSend));
    fd.append('session_id', sess.id);
    fd.append('request_id', reqId);
    fd.append('provider', selectedModel.provider);
    fd.append('model_id', selectedModel.model_id);

    fetch('/chat_with_file', { method:'POST',
         headers:{ ...(TOKEN && {Authorization:`Bearer ${TOKEN}`}) }, body:fd })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .catch(e => showRequestError(e, reqId));
  } else {
    /* ======= 文字/粘贴图: Socket ======= */
    socket.emit('chat_message', {
      request_id : reqId,
      prompt     : txt,
      history    : historyToSend,
      use_streaming : useStreaming,
      session_id : sess.id,
      provider   : selectedModel.provider,
      model_id   : selectedModel.model_id,
      image_data : imageBase64                     // null 则后端忽略
    });
  }

  /* ---------- 清理输入区 ---------- */
  chatInputEl.value = '';
  previewWrap.innerHTML = '';
  uploadedFile = null;
  window.pastedImageBase64 = null;

  saveChatSessionsToStorage?.();
}

/* ======== 辅助 ======== */
function appendSystemError(msg){
  const err = document.createElement('div');
  err.className = 'system-message error-text';
  err.textContent = msg;
  document.getElementById('chat-chat-history')
           .appendChild(err);
  scrollToChatBottom(document.getElementById('chat-chat-history'));
}
function showRequestError(e, reqId){
  console.error('[Chat] file upload error:', e);
  const think = document.querySelector(`.ai-thinking[data-request-id="${reqId}"]`);
  think?.remove();
  appendSystemError('文件上传请求失败');
}
