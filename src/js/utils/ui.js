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

