// src/js/init/initFeatures.js
import { initMarkdown }    from './initMarkdown.js';
import { initTheme }       from './initTheme.js';
import { initNavigation }  from './initNavigation.js';
import initSocket          from './initSocket.js';

import { initChat }        from '../features/chat.js';
import { initScreenshot }  from '../features/screenshot.js';
import { initVoice }       from '../features/voice.js';

export default function initAllFeatures() {
  // 核心功能初始化顺序
  initSocket();        // 建立 Socket 连接
  initMarkdown();      // Markdown + KaTeX + 代码高亮
  initTheme();         // 主题切换
  initNavigation();    // 主导航功能切换

  // 各业务模块
  initChat();          // 聊天模块
  initScreenshot();    // 截图模块
  initVoice();         // 语音模块
}


/ --- initAllFeatures (Main entry point for UI initialization) ---
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
