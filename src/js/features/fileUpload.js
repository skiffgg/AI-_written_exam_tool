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