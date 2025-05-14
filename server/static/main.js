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
        // console.log(`[KaTeX Debug from ${sourceEvent}] Removing streamingSpan for message:`, String(messageText || "").substring(0, 50) + "...");
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

    let textToRender = String(messageText || "");
    
    if (typeof preprocessTextForRendering === 'function') {
        textToRender = preprocessTextForRendering(textToRender);
    } else {
        console.warn("Warning: preprocessTextForRendering function is not defined. Text preprocessing skipped.");
    }

    if (md && typeof md.render === 'function') {
        contentDiv.innerHTML = md.render(textToRender);
    } else {
        if (typeof escapeHtml === 'function') {
            contentDiv.innerHTML = escapeHtml(textToRender).replace(/\n/g, '<br>');
        } else { // 极端的 fallback
            console.error("escapeHtml function is not defined! Displaying raw text.");
            const tempP = document.createElement('p');
            tempP.textContent = textToRender;
            contentDiv.appendChild(tempP);
        }
    }

    // --- 添加复制代码按钮的逻辑 START ---
    const codeBlocks = contentDiv.querySelectorAll('pre > code'); // 更精确地选择 highlight.js 生成的结构
    codeBlocks.forEach(codeBlock => {
        const preElement = codeBlock.parentElement; // 获取父元素 <pre>
        if (preElement) {
            // 确保 pre 元素是相对定位的 (最好在 CSS 中设置 .message-content pre { position: relative; })
            // if (getComputedStyle(preElement).position === 'static') {
            // preElement.style.position = 'relative';
            // }
            // 从 style.css 中看到 .message-content pre 已经有 position: relative; 了，所以上面这块可以省略

            // 检查是否已经有复制按钮，防止重复添加 (虽然innerHTML清空了，但以防万一)
            if (preElement.querySelector('.copy-code-button')) {
                return; 
            }

            const copyButton = document.createElement('button');
            copyButton.className = 'copy-code-button'; // 应用CSS样式
            copyButton.innerHTML = '<i class="fas fa-copy"></i>'; // Font Awesome 复制图标
            copyButton.title = '复制到剪贴板';
            copyButton.setAttribute('aria-label', '复制到剪贴板'); // 增强可访问性

            copyButton.addEventListener('click', (event) => {
                event.stopPropagation(); // 防止点击按钮时触发其他可能绑定在 pre 或 message 上的事件

                const codeToCopy = codeBlock.textContent || ""; 
                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    navigator.clipboard.writeText(codeToCopy).then(() => {
                        copyButton.innerHTML = '<i class="fas fa-check"></i>'; // 已复制图标
                        copyButton.classList.add('copied');
                        setTimeout(() => {
                            copyButton.innerHTML = '<i class="fas fa-copy"></i>'; // 恢复原图标
                            copyButton.classList.remove('copied');
                        }, 2000);
                    }).catch(err => {
                        console.error('无法复制到剪贴板:', err);
                        copyButton.textContent = '失败';
                        copyButton.classList.add('copy-failed'); // 可以定义一个 .copy-failed 样式
                        setTimeout(() => {
                            copyButton.innerHTML = '<i class="fas fa-copy"></i>';
                            copyButton.classList.remove('copy-failed');
                        }, 2000);
                        // 作为后备方案，可以尝试传统的 execCommand('copy')，但它已不推荐
                        // fallbackCopyTextToClipboard(codeToCopy, copyButton);
                    });
                } else {
                    // 如果 navigator.clipboard 不可用 (例如在非 HTTPS 环境或非常旧的浏览器)
                    console.warn('navigator.clipboard.writeText API 不可用。尝试后备复制方法。');
                    fallbackCopyTextToClipboard(codeToCopy, copyButton); // 调用后备方法
                }
            });

            preElement.appendChild(copyButton); // 将按钮添加到 <pre> 元素
        }
    });
    // --- 添加复制代码按钮的逻辑 END ---

    // --- 日志代码 (保持不变) ---
    if (sourceEvent === "chat_stream_end") {
        console.log(`%c[KaTeX Debug from ${sourceEvent}] FINAL KaTeX Processing:`, "color: blue; font-weight: bold;");
        console.log("Original messageText for logs:", messageText);
        console.log("Text after preprocessing (passed to md.render):", textToRender);
        console.log("contentDiv HTML AFTER adding copy buttons, BEFORE KaTeX render:", contentDiv.innerHTML);
    } else if (sourceEvent === "test_button") {
        // ... (其他日志分支)
    } else if (sourceEvent === "history_load" || sourceEvent === "voice_chat_response" || sourceEvent === "new_screenshot_immediate_analysis" || sourceEvent === "analysis_result_update" || sourceEvent === "history_click_ss_analysis") {
        // 合并其他 sourceEvent 的日志，避免过多分支
        console.log(`%c[Render Debug from ${sourceEvent}] Processing:`, "color: purple;");
        // console.log("Original messageText for logs:", messageText);
        // console.log("Text after preprocessing (passed to md.render):", textToRender);
        console.log("contentDiv HTML AFTER adding copy buttons, BEFORE KaTeX render:", contentDiv.innerHTML.substring(0, 300) + "..."); // 只打印部分HTML
    }
    // --- 日志代码结束 ---

    // KaTeX 渲染应该在所有DOM操作（包括添加复制按钮）之后进行
    if (typeof renderLatexInElement === 'function') {
        renderLatexInElement(contentDiv);
    } else {
        console.warn("renderLatexInElement function is not defined. LaTeX rendering skipped.");
    }
}

// --- 新的侧边栏切换初始化函数 ---
function initSidebarToggle() {
    const toggleButton = document.getElementById('toggle-sidebar-btn');
    // 获取所有标签页下的 .main-content 元素
    const mainContents = document.querySelectorAll('.tab-content > .main-content'); 
    const leftPanels = document.querySelectorAll('.tab-content .left-panel'); // 用于检查初始状态

    if (!toggleButton || mainContents.length === 0) {
        console.warn("Sidebar toggle button or main content areas not found.");
        return;
    }

    // (可选) 检查 localStorage 中是否有保存的侧边栏状态
    let isSidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';

    // 根据存储的状态初始化
    function applySidebarState(collapsed) {
        const icon = toggleButton.querySelector('i');
        mainContents.forEach(content => {
            if (collapsed) {
                content.classList.add('sidebar-collapsed');
            } else {
                content.classList.remove('sidebar-collapsed');
            }
        });
        if (icon) { // 改变按钮图标
            icon.className = collapsed ? 'fas fa-bars' : 'fas fa-chevron-left'; // 或者 fa-align-justify / fa-align-left
        }
        // 更新 localStorage
        localStorage.setItem('sidebarCollapsed', collapsed);
        isSidebarCollapsed = collapsed; // 更新当前状态变量
    }

    // 初始化状态
    applySidebarState(isSidebarCollapsed);


    toggleButton.addEventListener('click', () => {
        isSidebarCollapsed = !isSidebarCollapsed; // 切换状态
        applySidebarState(isSidebarCollapsed);
    });
}

// --- 后备的文本复制函数 (当 navigator.clipboard 不可用时) ---
function fallbackCopyTextToClipboard(text, buttonElement) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    
    // 避免在屏幕上闪烁
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    let successful = false;
    try {
        successful = document.execCommand('copy');
        if (successful) {
            if (buttonElement) {
                buttonElement.innerHTML = '<i class="fas fa-check"></i>';
                buttonElement.classList.add('copied');
                setTimeout(() => {
                    buttonElement.innerHTML = '<i class="fas fa-copy"></i>';
                    buttonElement.classList.remove('copied');
                }, 2000);
            }
            console.log('后备复制成功');
        } else {
            throw new Error('document.execCommand("copy") failed');
        }
    } catch (err) {
        console.error('后备复制失败:', err);
        if (buttonElement) {
            buttonElement.textContent = '失败';
            buttonElement.classList.add('copy-failed');
            setTimeout(() => {
                buttonElement.innerHTML = '<i class="fas fa-copy"></i>';
                buttonElement.classList.remove('copy-failed');
            }, 2000);
        }
        // 可以提示用户手动复制
        // alert('无法自动复制到剪贴板，请手动复制。');
    }
    
    document.body.removeChild(textArea);
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

// --- 新增：主题切换相关函数 ---

/**
 * 应用指定的主题到页面。
 * @param {string} themeName - 要应用的主题名称 ('light' 或 'dark').
 */
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


// --- 辅助函数：清空主截图显示区 ---
function clearMainScreenshotDisplay() {
    const mainImagePreviewEl = document.getElementById('ss-main-preview-image');
    const mainAnalysisEl = document.getElementById('ss-ai-analysis');
    const cropCurrentBtn = document.getElementById('ss-crop-current-btn');

    if (mainImagePreviewEl) {
        mainImagePreviewEl.src = '#';
        mainImagePreviewEl.style.display = 'none';
        mainImagePreviewEl.removeAttribute('data-current-url');
    }
    if (mainAnalysisEl) {
        mainAnalysisEl.textContent = '请在左侧点击历史记录查看分析结果，或点击“发起截屏”进行分析。';
        mainAnalysisEl.removeAttribute('data-source-url');
    }
    if (cropCurrentBtn) {
        cropCurrentBtn.style.display = 'none';
    }
    const historyListEl = document.getElementById('ss-history-list');
    const currentActive = historyListEl?.querySelector('.active-screenshot-item');
    if (currentActive) {
        currentActive.classList.remove('active-screenshot-item');
    }
}

// --- 初始化截图分析相关的按钮和事件 ---
function initScreenshotAnalysisHandlers() {
    // “发起截屏”按钮
    document.getElementById('ss-capture-btn')?.addEventListener('click', () => {
        if (typeof requestScreenshot === 'function') {
            requestScreenshot();
            // 点击发起截屏后，可以考虑清空主显示区或显示等待信息
            const analysisEl = document.getElementById('ss-ai-analysis');
            if (analysisEl) {
                analysisEl.innerHTML = '<p><i class="fas fa-spinner fa-spin"></i> 等待截屏和分析中...</p>';
            }
            const mainImagePreviewEl = document.getElementById('ss-main-preview-image');
            if (mainImagePreviewEl) mainImagePreviewEl.style.display = 'none';
            const cropBtn = document.getElementById('ss-crop-current-btn');
            if (cropBtn) cropBtn.style.display = 'none';

        } else {
            console.error("requestScreenshot function is not defined.");
        }
    });

    // “清空截图历史”按钮
    document.getElementById('ss-clear-history')?.addEventListener('click', () => {
        if(confirm('确定要清空所有截图历史记录吗？')) {
            const historyListEl = document.getElementById('ss-history-list');
            if (historyListEl) historyListEl.innerHTML = '';
            if (typeof clearMainScreenshotDisplay === 'function') {
                clearMainScreenshotDisplay();
            }
        }
    });

    // 主预览区旁的“裁剪此图”按钮
    document.getElementById('ss-crop-current-btn')?.addEventListener('click', () => {
        const mainImagePreviewEl = document.getElementById('ss-main-preview-image');
        const imageUrlToCrop = mainImagePreviewEl ? mainImagePreviewEl.dataset.currentUrl : null;

        if (imageUrlToCrop) {
            console.log(`[CROP] Crop button clicked for image: ${imageUrlToCrop}`);
            if (typeof showImageOverlay === 'function') {
                showImageOverlay(imageUrlToCrop);
            } else {
                console.error("showImageOverlay function is not defined.");
            }
        } else {
            alert("没有当前显示的图片可供裁剪。请先从历史记录中选择一张图片。");
            console.warn("[CROP] Crop button clicked, but no current image URL found in main preview.");
        }
    });

    // (可选) 关闭覆盖层的按钮事件，确保它们调用 hideImageOverlay
    document.getElementById('close-overlay')?.addEventListener('click', () => {
        if (typeof hideImageOverlay === 'function') hideImageOverlay();
    });
    document.getElementById('cancel-selection')?.addEventListener('click', () => {
        if (typeof hideImageOverlay === 'function') hideImageOverlay();
    });
    // “确认裁剪并分析”按钮的事件监听器应该在 `initBaseButtonHandlers` 或类似地方，因为它调用 `confirmCrop`
    // document.getElementById('confirm-selection')?.addEventListener('click', confirmCrop); 
    // ^^^ 这个应该已经在 initBaseButtonHandlers 或类似的地方了
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
    
    // 3. 更新UI为“处理中...”状态
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
            // UI 已经是“处理中...”，按钮状态也已设置。等待 Socket.IO 事件来更新最终结果或错误。
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
// function initScreenshotAnalysisHandlers(){
//     document.getElementById('ss-capture-btn')?.addEventListener('click', requestScreenshot);
//     document.getElementById('ss-clear-history')?.addEventListener('click', clearScreenshotHistory);
// }
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
    if (tokenMeta?.content) {
        TOKEN = tokenMeta.content; // 赋值给全局或模块级 TOKEN 变量
        console.log("Token loaded from meta tag.");
    } else {
        console.warn('Token meta tag missing or empty. Some features might not work.');
        // 如果 TOKEN 对后续初始化至关重要，您可能需要在这里提前返回或采取其他措施
    }

    initMarkdownRenderer();
    initSidebarToggle();
    
    initThemeSelector(); // <<< 新增：调用主题初始化函数

    // 关于 API 信息和模型列表的获取:
    // 如果您已经将模型列表获取逻辑整合到了 fetchInitialModelsInfo() 中，
    // 并且该函数会在 SocketIO 连接成功后被调用 (通过 initSocketIO -> socket.on('connect')),
    // 那么您可能不需要在这里再次调用 getApiInfo() 或 fetchInitialModelsInfo()。
    // 如果 getApiInfo() 只是获取 provider 名称，并且您仍需要它，可以保留。
    // 关键是确保模型选择器和主题选择器都能在合适的时机被正确初始化和填充。
    // 我将假设 fetchInitialModelsInfo (或类似的函数) 会在 socket 连接后处理模型列表的加载。
    // getApiInfo(); // 如果这个函数只是获取旧的 provider 信息，可以考虑与模型列表获取合并或调整。

    // KaTeX 渲染页面上已有的内容
    // 确保 renderLatexInElement 函数已正确导入或定义
    if (typeof renderLatexInElement === 'function') {
        document.querySelectorAll('.message-content').forEach(element => {
            try {
                renderLatexInElement(element);
            } catch (e) {
                console.error("Error rendering KaTeX for existing element:", e, element);
            }
        });
    } else {
        console.warn("renderLatexInElement function is not available. KaTeX rendering for existing content skipped.");
    }

    initBaseButtonHandlers();
    initTabs();
    initScreenshotAnalysisHandlers();
    initAiChatHandlers();
    initVoiceAnswerHandlers();
    
    initSocketIO(); // Socket.IO 的初始化通常会包含连接成功后获取初始数据的逻辑

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

