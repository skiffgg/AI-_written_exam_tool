// src/js/services/apiService.js

// Assuming appendSystemMessage is available globally or imported if needed for error display
// For example: import { appendSystemMessage } from '../features/chat.js'; 

/**
 * Sends chat messages that may include text, uploaded files, and pasted images.
 * @param {string} requestId Unique ID for the request.
 * @param {string} prompt User's text prompt.
 * @param {File[]} uploadedFileObjects Array of File objects for uploaded files.
 * @param {string[]} pastedImagesBase64Array Array of base64 encoded image strings (without data: prefix).
 * @param {object[]} historyArray Array of chat history objects.
 * @param {string} modelId ID of the selected AI model.
 * @param {string} provider Name of the AI model provider.
 * @param {boolean} useStreaming Whether to use streaming for the response.
 * @returns {Promise<object>} The JSON response from the server.
 */
export async function sendChatWithFiles(
    requestId,
    prompt,
    uploadedFileObjects,
    pastedImagesBase64Array,
    historyArray,
    modelId,
    provider,
    useStreaming
) {
    if (typeof debugLog === 'function') { // Use debugLog if available
        debugLog("apiService.sendChatWithFiles called with:", {
            requestId,
            prompt: prompt ? prompt.substring(0, 50) + "..." : "empty", // Avoid logging long prompts
            uploadedFileObjectsCount: uploadedFileObjects ? uploadedFileObjects.length : 0,
            pastedImagesBase64ArrayCount: pastedImagesBase64Array ? pastedImagesBase64Array.length : 0,
            historyArrayCount: historyArray ? historyArray.length : 0,
            modelId,
            provider,
            useStreaming
        });
    } else {
        console.log("apiService.sendChatWithFiles called with (counts):", { // Fallback to console.log
            requestId,
            prompt: prompt ? prompt.substring(0, 50) + "..." : "empty",
            uploadedFileObjectsCount: uploadedFileObjects ? uploadedFileObjects.length : 0,
            pastedImagesBase64ArrayCount: pastedImagesBase64Array ? pastedImagesBase64Array.length : 0,
            historyArrayCount: historyArray ? historyArray.length : 0,
            modelId,
            provider,
            useStreaming
        });
    }


    const formData = new FormData();

    formData.append('request_id', requestId);
    formData.append('prompt', prompt || ""); 
    formData.append('history', JSON.stringify(historyArray || [])); 
    formData.append('model_id', modelId || '');
    formData.append('provider', provider || '');
    formData.append('use_streaming', String(useStreaming));

    // Append Files
    if (uploadedFileObjects && uploadedFileObjects.length > 0) {
        uploadedFileObjects.forEach(fileObject => {
            if (fileObject instanceof File) {
                formData.append('files', fileObject, fileObject.name);
            } else {
                console.warn("An item in uploadedFileObjects was not a File object:", fileObject);
                 if (typeof appendSystemMessage === 'function') {
                    appendSystemMessage("Encountered an invalid file object during upload preparation.", null, "error");
                }
            }
        });
    }

    // Append Pasted Images Base64 Array (as a JSON string of base64 strings)
    formData.append('pasted_images_base64_json_array', JSON.stringify(pastedImagesBase64Array || []));

    const headers = {};
    const token = localStorage.getItem('dashboardToken');
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    // 'Content-Type': 'multipart/form-data' is automatically set by the browser for FormData.

    try {
        const response = await fetch('/chat_with_file', {
            method: 'POST',
            body: formData,
            headers: headers
        });

        if (!response.ok) {
            let errorData;
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.indexOf("application/json") !== -1) {
                errorData = await response.json();
            } else {
                errorData = { error: await response.text() || 'Unknown server error. Response not JSON.' };
            }
            
            console.error("sendChatWithFiles API error response:", errorData);
            if (typeof appendSystemMessage === 'function') {
                appendSystemMessage(`API Error: ${errorData.error || response.statusText || 'Server error'}`, null, 'error');
            }
            throw new Error(errorData.error || `Failed to send chat message. Status: ${response.status}`);
        }

        const responseData = await response.json();
        if (typeof debugLog === 'function') {
            debugLog("sendChatWithFiles successful. Response data:", responseData);
        } else {
            console.log("sendChatWithFiles successful. Response data:", responseData);
        }
        return responseData;

    } catch (error) {
        console.error("Error in sendChatWithFiles fetch operation:", error);
        // Avoid double-messaging if appendSystemMessage was already called for !response.ok
        if (typeof appendSystemMessage === 'function' && !(error.message.includes("Failed to send chat message") || error.message.includes("API Error"))) {
            appendSystemMessage(`Client-side Error: ${error.message}`, null, 'error');
        }
        // Re-throw the error so the caller in chat.js can also handle it (e.g., not clearing fields)
        throw error;
    }
}

// Example of a debugLog function if not already globally available
// function debugLog(...args) {
//   console.log('[DEBUG]', ...args);
// }

// Example of appendSystemMessage if needed for standalone testing or if not imported
// function appendSystemMessage(message, elRef, type = 'error') {
//     console.log(`[${type.toUpperCase()}] CHAT_MESSAGE: ${message}`);
//     const chatHistoryEl = elRef || document.getElementById('chat-chat-history');
//     if (chatHistoryEl) {
//         const msgDiv = document.createElement('div');
//         msgDiv.className = `system-message ${type}-text`;
//         msgDiv.textContent = message;
//         chatHistoryEl.appendChild(msgDiv);
//         // scrollToChatBottom(chatHistoryEl); // If available
//     }
// }
