// src/js/features/screenshot.js
import { getSocket } from '../services/socketService.js';

export function initScreenshot() {
  // TODO: 截图请求、裁剪 overlay、历史管理、流式切换
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

