// src/js/features/chat.js
import { getSocket } from '../services/socketService.js';
import { generateUUID } from '../utils/uuid.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import * as apiService from '../services/apiService.js'; // Added import

// Debounce utility
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

let activeStreamingMessages = {}; // Stores { text: string, element: HTMLElement, debouncedRender: function }
const RENDER_DEBOUNCE_DELAY = 200; // milliseconds

// Global/Module Scope Array for Pasted Images & Uploaded Files
let pastedImagesBase64 = [];
let uploadedFiles = window.uploadedFiles || []; // Assuming window.uploadedFiles is set by fileUpload.js


function initAiChatHandlers() {
    document.getElementById('chat-send-chat')?.addEventListener('click', sendChatMessage);
    document.getElementById('chat-chat-input')?.addEventListener('keypress', (e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMessage();}});
    // Ensure handleFileUpload is defined or imported if it's from fileUpload.js
    // For this task, assuming handleFileUpload is available in this scope or globally.
    // If it's from fileUpload.js, it should be imported: import { handleFileUpload } from './fileUpload.js';
    // For now, we'll assume it's globally available or will be correctly linked.
    const chatFileUploadInput = document.getElementById('chat-file-upload');
    if (chatFileUploadInput) {
        // If handleFileUpload is from fileUpload.js and it's not automatically attaching, attach it.
        // This event listener might already be set up in fileUpload.js, if so, this is redundant.
        // Check fileUpload.js to see how it initializes.
        // chatFileUploadInput.addEventListener('change', handleFileUpload); // Example if needed
    }
    document.getElementById('chat-clear-current-chat')?.addEventListener('click', clearCurrentChatDisplay);
    document.getElementById('chat-clear-all-sessions')?.addEventListener('click', clearAllChatSessions);
    loadChatSessionsFromStorage(); // This function should also be defined or imported
    const streamingToggle = document.getElementById('streaming-toggle-checkbox');
    if (streamingToggle) {
        const saved = localStorage.getItem('useStreamingOutput');
        streamingToggle.checked = saved !== null ? saved === 'true' : true;
        if (saved === null) localStorage.setItem('useStreamingOutput', 'true');
        streamingToggle.addEventListener('change', function () { localStorage.setItem('useStreamingOutput', String(this.checked)); });
    }
    // Test render button logic (remains unchanged)
    const testRenderBtn = document.getElementById('test-render-btn');
    if (testRenderBtn) {
        testRenderBtn.addEventListener('click', () => {
            const chatHistoryEl = document.getElementById('chat-chat-history'); if(!chatHistoryEl)return;
            if(chatHistoryEl.querySelector(".system-message")) chatHistoryEl.innerHTML = '';
            const testMsgDiv = document.createElement('div'); testMsgDiv.className = 'ai-message';
            const testMD = "### Test MD\n\n- List\n- KaTeX: $E=mc^2$ and $$\\sum_{i=0}^n i^2 = \\frac{n(n+1)(2n+1)}{6}$$";
            if (typeof processAIMessage === 'function') processAIMessage(testMsgDiv, testMD); 
            chatHistoryEl.appendChild(testMsgDiv); 
            if (typeof scrollToChatBottom === 'function') scrollToChatBottom(chatHistoryEl);
        });
    } else {
        console.warn("Test render button #test-render-btn not found in HTML.");
    }

    // 允许粘贴图片
    const chatInput = document.getElementById('chat-chat-input');
    if (chatInput) {
        chatInput.addEventListener('paste', e => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (!file) return;

                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64WithPrefix = reader.result;
                        const base64 = base64WithPrefix.split(',')[1];
                        pastedImagesBase64.push(base64);

                        const previewContainer = document.getElementById('chat-upload-preview');
                        if (!previewContainer) return;

                        const previewItem = document.createElement('div');
                        previewItem.className = 'preview-item pasted-image-preview';
                        
                        const img = document.createElement('img');
                        img.src = base64WithPrefix; // Use the full dataURL for src
                        img.style.maxWidth = '100px';
                        img.style.maxHeight = '100px';
                        img.style.marginRight = '10px';

                        const removeBtn = document.createElement('button');
                        removeBtn.className = 'btn-close'; // Bootstrap close button
                        removeBtn.setAttribute('aria-label', 'Remove pasted image');
                        
                        // Store index for removal. Could also store base64 string if preferred.
                        const currentIndex = pastedImagesBase64.length - 1; 
                        
                        removeBtn.onclick = () => {
                            // Find the index of the base64 string to remove.
                            // This is safer if items are removed out of order or if duplicates could exist.
                            const indexToRemove = pastedImagesBase64.indexOf(base64);
                            if (indexToRemove > -1) {
                                pastedImagesBase64.splice(indexToRemove, 1);
                            }
                            previewItem.remove();
                            console.log('Pasted image removed. Remaining:', pastedImagesBase64);
                        };

                        previewItem.appendChild(img);
                        previewItem.appendChild(removeBtn);
                        previewContainer.appendChild(previewItem);
                    };
                    reader.readAsDataURL(file);
                    // Only handle the first image pasted if multiple are pasted simultaneously by the browser.
                    // Most browsers only allow pasting one image file at a time from clipboard.
                    break; 
                }
            }
        });
    }
}

// Assuming initChat is called elsewhere to set up basic chat UI (not part of this task's direct modifications)
export function initChat() {
  // TODO: 绑定聊天按钮、输入回车；调用 sendChatMessage；渲染历史会话
  // This function might need to be updated or ensure it doesn't conflict with initAiChatHandlers
}

export async function sendChatMessage() {
    // Ensure uploadedFiles is up-to-date from window object if necessary
    // This assumes fileUpload.js updates window.uploadedFiles
    if (window.uploadedFiles) {
        uploadedFiles = window.uploadedFiles;
    }


    const chatInputEl = document.getElementById('chat-chat-input');
    const prompt = chatInputEl ? chatInputEl.value.trim() : "";

    // Assume getCurrentSessionHistory, selectedModel are available globally or via import
    const history = (typeof getCurrentSessionHistory === 'function') ? getCurrentSessionHistory() : [];
    const model = (typeof selectedModel !== 'undefined') ? selectedModel : { model_id: '', provider: '' };
    
    const streamingToggle = document.getElementById('streaming-toggle-checkbox');
    const use_streaming = streamingToggle ? streamingToggle.checked : true;

    if (!prompt && uploadedFiles.length === 0 && pastedImagesBase64.length === 0) {
        if (typeof appendSystemMessage === 'function') {
            appendSystemMessage("请输入文字或添加文件/图片后再发送。", null, "info");
        } else {
            alert("请输入文字或添加文件/图片后再发送。"); // Fallback
        }
        return;
    }

    const request_id = generateUUID();

    // Display user message with attachments and pasted images
    appendUserMessageToChat(request_id, prompt, uploadedFiles, pastedImagesBase64);

    try {
        // Call apiService.sendChatWithFiles
        // Ensure apiService is imported or sendChatWithFiles is globally available
        await apiService.sendChatWithFiles(
            request_id,
            prompt,
            uploadedFiles, // Pass the array of File objects
            pastedImagesBase64, // Pass the array of base64 strings
            history,
            model.model_id,
            model.provider,
            use_streaming
        );
        // Backend will handle socket messages for AI response. Client might only show user message here.
    } catch (error) {
        console.error("sendChatMessage error:", error);
        if (typeof appendSystemMessage === 'function') {
            appendSystemMessage(`发送失败: ${error.message}`, null, "error");
        } else {
            alert(`发送失败: ${error.message}`); // Fallback
        }
        // Do not clear inputs if sending failed, allow user to retry.
        return;
    }
    

    // Post-Send Cleanup
    if(chatInputEl) chatInputEl.value = '';
    
    const uploadPreviewEl = document.getElementById('chat-upload-preview');
    if(uploadPreviewEl) uploadPreviewEl.innerHTML = '';
    
    // Reset arrays
    if (window.uploadedFiles) window.uploadedFiles = []; // Clear global reference if used
    uploadedFiles.length = 0; 
    pastedImagesBase64.length = 0;

    const chatFileUploadInput = document.getElementById('chat-file-upload');
    if (chatFileUploadInput) chatFileUploadInput.value = ''; // Reset native file input
}

// Helper function to append user's message, including files and pasted images, to the chat UI
export function appendUserMessageToChat(requestId, prompt, files, pastedB64s) {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = 'user-message';
    msgDiv.dataset.requestId = requestId;

    let htmlContent = `<strong>您:</strong><br>`;

    if (prompt) {
        htmlContent += `<div>${escapeHtml(prompt)}</div>`;
    }

    if (files && files.length > 0) {
        htmlContent += `<div><strong>上传的文件:</strong></div>`;
        files.forEach(file => {
            // Assuming file is a File object, escape its name
            htmlContent += `<div class="attached-file-display"><i class="fas fa-paperclip"></i> ${escapeHtml(file.name)}</div>`;
        });
    }

    if (pastedB64s && pastedB64s.length > 0) {
        htmlContent += `<div><strong>粘贴的图片:</strong></div>`;
        pastedB64s.forEach((b64, index) => {
            // Use the full data URL for display
            const fullDataUrl = `data:image/png;base64,${b64}`; // Assuming PNG, adjust if type is known
            htmlContent += `<img src="${fullDataUrl}" alt="Pasted image ${index + 1}" style="max-width: 80px; max-height: 80px; margin: 5px; border-radius: 4px;" />`;
        });
    }
    
    msgDiv.innerHTML = htmlContent;
    chatHistoryEl.appendChild(msgDiv);
    if (typeof scrollToChatBottom === 'function') {
        scrollToChatBottom(chatHistoryEl);
    }
}


function saveCurrentChatSessionId() {
    // Ensure currentChatSessionId is defined in this scope or globally
    if (typeof currentChatSessionId !== 'undefined' && currentChatSessionId) {
        localStorage.setItem('currentChatSessionId', currentChatSessionId);
    } else {
        localStorage.removeItem('currentChatSessionId');
    }
}

// renderChatHistory function (remains largely unchanged, ensure it's compatible)
// Minor adjustment: ensure it doesn't clear system messages if they are part of history
function renderChatHistory(historyArray) {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if (!chatHistoryEl) return;

    chatHistoryEl.innerHTML = ''; // Clear previous history
    if (!historyArray || !historyArray.length) {
        chatHistoryEl.innerHTML = '<div class="system-message">对话为空...</div>';
        return;
    }

    historyArray.forEach(turn => {
        if (!turn || !turn.role || !turn.parts || !Array.isArray(turn.parts)) return;
        
        // For user messages, parts might contain complex objects (text, files, images)
        // For AI messages, parts usually contain a single text object.
        // This render function might need to be enhanced to display user messages 
        // that were constructed with files/images if they are stored in history this way.
        // For now, assuming 'text' is the primary content for history rendering.
        const firstPart = turn.parts[0];
        const text = (firstPart && firstPart.text) ? firstPart.text : '';
        
        const msgDiv = document.createElement('div');

        if (turn.role === 'user') {
            msgDiv.className = 'user-message';
            // If user messages in history can also have files/images, 
            // appendUserMessageToChat logic might be partially reusable here.
            // For now, just rendering text.
            msgDiv.innerHTML = `<strong>您:</strong> <div>${escapeHtml(text)}</div>`;
            // Potentially, iterate over turn.parts if it contains more than just text (e.g. file info)
            // This part is simplified; actual history rendering for user messages with attachments
            // would need to parse 'parts' more carefully if they store file/image info.
            // The current task focuses on *sending* rather than *re-rendering from history*.

        } else if (turn.role === 'model') {
            msgDiv.className = 'ai-message';
            if (typeof processAIMessage === 'function') {
                processAIMessage(msgDiv, text, 'history_load');
            } else {
                msgDiv.textContent = text; // Fallback
            }
        } else { 
            msgDiv.className = 'system-message';
            msgDiv.innerHTML = `<strong>${escapeHtml(turn.role)}:</strong> <div>${escapeHtml(text)}</div>`;
        }

        // If the turn has a request_id, add it for potential future use (e.g., linking to streamed responses)
        if (turn.request_id) {
            msgDiv.dataset.requestId = turn.request_id;
        }
        
        chatHistoryEl.appendChild(msgDiv);
    });

    if (typeof scrollToChatBottom === 'function') {
        scrollToChatBottom(chatHistoryEl);
    }
}

// appendSystemMessage function (ensure it's correctly defined and available)
// Assuming it's defined as provided in the problem description or elsewhere in the project.
// Make sure it's exported or globally available if initAiChatHandlers, sendChatMessage use it.
// For example:
// export function appendSystemMessage(message, chatHistoryElRef, messageType = 'system') { ... }
// If it's not exported, calls from other modules (if any) would fail.
// For this subtask, assuming it's available in the current file scope.

// Other functions like loadChatSessionsFromStorage, clearCurrentChatDisplay, clearAllChatSessions
// are assumed to be defined elsewhere or are not directly modified by this task.
// Ensure all helper functions (generateUUID, escapeHtml, scrollToChatBottom, processAIMessage, 
// getCurrentSessionHistory, selectedModel) are correctly imported, globally available, or defined.
// For example, if they are in utils:
// import { generateUUID } from '../utils/uuid.js';
// import { escapeHtml } from '../utils/escapeHtml.js';
// import { processAIMessage } from './renderService.js'; // If processAIMessage is in renderService.js
// import { scrollToChatBottom } from '../utils/uiUtils.js'; // If scrollToChatBottom is in uiUtils.js

// Ensure selectedModel and getCurrentSessionHistory are properly managed.
// e.g. selectedModel might be part of a state management system or global variable.
// let currentChatSessionId; // Should be defined
// let chatSessions = {}; // Should be defined if loadChatSessionsFromStorage uses it.
// function getCurrentSessionHistory() { /* needs implementation based on chatSessions and currentChatSessionId */ return []; }
// let selectedModel = { provider: 'default', model_id: 'default-model' }; // Placeholder


// Helper Functions for Stream Handling
function findOrCreateAIMessageElement(requestId) {
    const chatHistoryEl = document.getElementById('chat-chat-history');
    let msgContainer = chatHistoryEl.querySelector(`.ai-message[data-request-id="${requestId}"]`);
    let contentWrapper;

    if (!msgContainer) {
        msgContainer = document.createElement('div');
        msgContainer.className = 'ai-message';
        msgContainer.dataset.requestId = requestId;
        
        contentWrapper = document.createElement('div');
        contentWrapper.className = 'message-content-wrapper';
        
        const thinkingIndicator = document.createElement('em');
        thinkingIndicator.className = 'thinking-indicator';
        thinkingIndicator.textContent = 'AI is responding...'; 
        
        contentWrapper.appendChild(thinkingIndicator);
        msgContainer.appendChild(contentWrapper);
        chatHistoryEl.appendChild(msgContainer);
    } else {
        contentWrapper = msgContainer.querySelector('.message-content-wrapper');
        if (!contentWrapper) {
            console.error("Message content wrapper not found for existing AI message element.");
            // Attempt to recover or create if absolutely necessary, though this indicates a state issue.
            // For now, fallback to using msgContainer directly if wrapper is missing.
            contentWrapper = msgContainer; 
        }
    }
    return contentWrapper;
}

function renderStreamedMessage(targetElement, textContent) {
    if (!targetElement) return;
    // Assume window.md and window.renderLatexInElement are available
    if (typeof window.md !== 'undefined' && typeof window.renderLatexInElement === 'function') {
        targetElement.innerHTML = window.md.render(textContent);
        window.renderLatexInElement(targetElement);
    } else {
        targetElement.textContent = textContent; // Fallback
        console.warn("Markdown renderer (window.md) or window.renderLatexInElement not available.");
    }
    if (typeof hljs !== 'undefined') {
        targetElement.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });
    }
}


// Stream Handling Functions (Exported)
export function handleChatStreamChunk(data) {
    const { request_id, chunk } = data;
    if (!request_id || typeof chunk !== 'string') {
        console.error('Invalid chat_stream_chunk data:', data);
        return;
    }

    let streamData = activeStreamingMessages[request_id];
    if (!streamData) {
        const messageContentElement = findOrCreateAIMessageElement(request_id);
        // Check if the thinking indicator is still there before clearing
        if (messageContentElement.querySelector('.thinking-indicator')) {
             messageContentElement.innerHTML = ''; 
        }

        streamData = {
            text: '',
            element: messageContentElement,
            debouncedRender: debounce((el, txt) => {
                renderStreamedMessage(el, txt);
                const chatHistoryEl = document.getElementById('chat-chat-history');
                // Smart scroll: only if user is near the bottom
                if (chatHistoryEl && chatHistoryEl.scrollHeight - chatHistoryEl.scrollTop < chatHistoryEl.clientHeight + 200) {
                   if(typeof scrollToChatBottom === 'function') scrollToChatBottom(chatHistoryEl);
                }
            }, RENDER_DEBOUNCE_DELAY)
        };
        activeStreamingMessages[request_id] = streamData;
    }
    
    // Ensure thinking indicator is removed on first actual chunk
    const thinkingIndicator = streamData.element.querySelector('.thinking-indicator');
    if (thinkingIndicator && streamData.text === '' && chunk.length > 0) { 
         streamData.element.innerHTML = ''; 
    }

    streamData.text += chunk;
    streamData.debouncedRender(streamData.element, streamData.text);
}

export function handleChatStreamEnd(data) {
    const { request_id, full_message } = data;
    if (!request_id) {
        console.error('Invalid chat_stream_end data:', data);
        return;
    }

    let streamData = activeStreamingMessages[request_id];
    const messageToRender = full_message || (streamData ? streamData.text : '');

    if (streamData) {
        // Ensure debounced call is cancelled and final render happens immediately
        if (streamData.debouncedRender && typeof streamData.debouncedRender.clear === 'function') { // Check if it's a lodash-like debounce
            streamData.debouncedRender.clear(); // Or clearTimeout if it's a simple debounce
        }
        renderStreamedMessage(streamData.element, messageToRender);
        delete activeStreamingMessages[request_id];
    } else {
        const messageContentElement = findOrCreateAIMessageElement(request_id);
         if (messageContentElement.querySelector('.thinking-indicator')) {
            messageContentElement.innerHTML = '';
        }
        renderStreamedMessage(messageContentElement, messageToRender);
    }
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if(typeof scrollToChatBottom === 'function' && chatHistoryEl) scrollToChatBottom(chatHistoryEl);
}

export function handleTaskError(data) {
    const { request_id, error } = data;
    const errText = error || 'An unspecified error occurred.';
    // Ensure escapeHtml is available, if not, provide a simple fallback or log error
    const safeEscapeHtml = typeof escapeHtml === 'function' ? escapeHtml : (text) => text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    
    const reqIdText = request_id ? ` (Request ID: ${safeEscapeHtml(request_id)})` : '';

    if (request_id && activeStreamingMessages[request_id]) {
        const streamData = activeStreamingMessages[request_id];
        streamData.element.innerHTML = `<div class="error-text">Error: ${safeEscapeHtml(errText)}${reqIdText}</div>`;
        delete activeStreamingMessages[request_id];
    } else if (request_id) {
        const messageContentElement = findOrCreateAIMessageElement(request_id);
        // Ensure thinking indicator is removed
        if (messageContentElement.querySelector('.thinking-indicator')) {
            messageContentElement.innerHTML = '';
        }
        messageContentElement.innerHTML = `<div class="error-text">Error: ${safeEscapeHtml(errText)}${reqIdText}</div>`;
    } else {
        // Ensure appendSystemMessage is available
        if (typeof appendSystemMessage === 'function') { 
            appendSystemMessage(`Task Error: ${errText}`, null, 'error');
        } else {
            console.error(`Task Error (no request_id or appendSystemMessage not found): ${errText}`);
            // Fallback DOM manipulation if appendSystemMessage is not available
            const chatHistoryEl = document.getElementById('chat-chat-history');
            if (chatHistoryEl) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'system-message error-text p-2 my-1 text-danger border border-danger rounded bg-light-danger'; // Added bg-light-danger for visibility
                errorDiv.textContent = `Task Error: ${safeEscapeHtml(errText)}`;
                chatHistoryEl.appendChild(errorDiv);
            }
        }
    }
    const chatHistoryEl = document.getElementById('chat-chat-history');
    if(typeof scrollToChatBottom === 'function' && chatHistoryEl) scrollToChatBottom(chatHistoryEl);
}

// Assume appendSystemMessage, scrollToChatBottom, etc. are defined in this file or imported.
// If they are in this file, ensure they are defined before being used or hoisted (for function declarations).
// If imported, ensure imports are correct.
// Example:
// function appendSystemMessage(message, chatHistoryElRef, messageType = 'system') { ... }
// function scrollToChatBottom(chatHistoryEl) { ... }
// These might need to be defined or correctly imported for the above handlers to work.