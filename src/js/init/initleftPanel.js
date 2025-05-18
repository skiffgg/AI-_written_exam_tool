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