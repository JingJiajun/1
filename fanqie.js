// ==UserScript==
// @name          番茄小说增强工具
// @author        cctv
// @version       2025.11.21
// @description   番茄小说下载器 + 内容处理功能
// @license       MIT
// @match         https://fanqienovel.com/page/*
// @match         https://fanqienovel.com/reader/*
// @require       https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @require       https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @icon          https://img.onlinedown.net/download/202102/152723-601ba1db7a29e.jpg
// @grant         GM_xmlhttpRequest
// @grant         GM_addStyle
// @grant         GM_getValue
// @grant         GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    // 配置管理 - 移除API域名默认值
    const config = {
        apiDomain: GM_getValue('apiDomain', ''), // 移除默认值
        concurrentRequests: GM_getValue('concurrentRequests', 2),
        timeout: GM_getValue('timeout', 20000),
        maxRetries: 2,
        autoReplaceEnabled: GM_getValue('autoReplaceEnabled', false),
        checkInterval: GM_getValue('checkInterval', 5000),
        idleTimeout: 300000,
        panelPosition: GM_getValue('panelPosition', 'right'),
        autoHideEnabled: GM_getValue('autoHideEnabled', true),
        autoHideDelay: GM_getValue('autoHideDelay', 3000)
    };

    // 全局变量
    let bookInfo = null;
    let chapters = null;
    let isDownloading = false;
    let uiElements = {};
    let replaceInProgress = false;
    let lastActivityTime = Date.now();
    let checkTimer = null;
    let lastUrl = window.location.href;
    let autoHideTimer = null;

    let contentReplaceState = {
        replaced: false,
        chapterId: GM_getValue('lastChapterId', null),
        chapterTitle: GM_getValue('lastChapterTitle', null),
        contentHash: null,
        timestamp: GM_getValue('lastReplaceTime', 0),
        stableCount: 0,
        isIdle: false
    };

    // 检查页面类型并获取对应的ID
    const pageInfo = (() => {
        const pathname = window.location.pathname;
        const pageMatch = pathname.match(/^\/page\/(\d+)$/);
        const readerMatch = pathname.match(/^\/reader\/(\d+)/);

        if (pageMatch) return { type: 'page', bookId: pageMatch[1] };
        if (readerMatch) return { type: 'reader', bookId: readerMatch[1] };

        if (window.location.hostname === 'changdunovel.com') {
            const changdunovelMatch = window.location.href.match(/book_id=(\d{19})/);
            if (changdunovelMatch) return { type: 'page', bookId: changdunovelMatch[1] };
        }

        return null;
    })();

    if (!pageInfo) {
        console.log('番茄小说增强工具: 当前页面不支持');
        return;
    }

    // 界面样式 - 优化移动端适配
    GM_addStyle(`
        .tamper-container { position: fixed; top: 20px; background: #fff; border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 12px; z-index: 9999; width: 180px; font-size: 13px; line-height: 1.3;
            transition: transform 0.3s ease, opacity 0.3s ease, right 0.3s ease, left 0.3s ease;
            overflow: hidden; }

        /* 位置样式 */
        .tamper-container.right { right: 0; left: auto; border-top-right-radius: 0; border-bottom-right-radius: 0; }
        .tamper-container.left { left: 0; right: auto; border-top-left-radius: 0; border-bottom-left-radius: 0; }

        /* 隐藏状态 */
        .tamper-container.hidden.right { transform: translateX(160px); opacity: 0.9; }
        .tamper-container.hidden.left { transform: translateX(-160px); opacity: 0.9; }

        /* 悬停效果 */
        .tamper-container:hover { transform: translateX(0) !important; opacity: 1 !important; }
        .tamper-container.right:hover { transform: translateX(-5px) !important; }
        .tamper-container.left:hover { transform: translateX(5px) !important; }

        /* 显示按钮 */
        .show-button { position: fixed; top: 20px; transform: translateY(0); width: 30px; height: 80px;
            background: #4CAF50; color: white; border: none; border-radius: 5px 0 0 5px; cursor: pointer;
            font-size: 14px; writing-mode: vertical-rl; text-orientation: mixed; z-index: 10000;
            transition: all 0.3s ease; opacity: 0.9; display: none; }
        .show-button:hover { opacity: 1; transform: scale(1.05); }
        .show-button.right { right: 0; border-radius: 5px 0 0 5px; }
        .show-button.left { left: 0; border-radius: 0 5px 5px 0; }

        /* 手动隐藏按钮 */
        .manual-hide-button { position: absolute; top: 5px; right: 5px; width: 24px; height: 24px;
            background: #f44336; color: white; border: none; border-radius: 50%; cursor: pointer;
            font-size: 12px; font-weight: bold; display: none; z-index: 10; }
        .manual-hide-button:hover { background: #d32f2f; transform: scale(1.1); }

        .tamper-button { border: none; border-radius: 20px; padding: 8px 15px; margin: 4px 0; cursor: pointer;
            font-size: 12px; font-weight: bold; transition: all 0.2s; width: 100%; text-align: center;
            touch-action: manipulation; }
        .tamper-button:hover { opacity: 0.9; transform: translateY(-2px); }
        .tamper-button:disabled { background: #ccc; cursor: not-allowed; transform: none; }
        .tamper-button.txt { background: #4CAF50; color: #fff; font-size: 11px; padding: 7px 10px; }
        .tamper-button.epub { background: #2196F3; color: #fff; font-size: 11px; padding: 7px 10px; }
        .tamper-button.download-chapter { background: #FF9800; color: #fff; font-size: 11px; padding: 7px 10px; }
        .tamper-button.settings { background: #9C27B0; color: #fff; font-size: 11px; padding: 7px 10px; }
        .tamper-button.control { font-size: 10px; padding: 5px; border-radius: 15px; }
        .tamper-button.position { background: #795548; color: #fff; font-size: 10px; padding: 5px; border-radius: 12px; }

        .stats-container { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; }
        .stat-item { display: flex; flex-direction: column; align-items: center; flex: 1; padding: 3px; }
        .stat-label { margin-bottom: 3px; color: #666; font-size: 10px; }
        .stat-value { font-weight: bold; font-size: 14px; }
        .total-value { color: #333; }
        .success-value { color: #4CAF50; }
        .failed-value { color: #F44336; }

        .progress-bar { width: 100%; height: 8px; background-color: #f0f0f0; border-radius: 4px;
            margin-top: 8px; overflow: hidden; }
        .progress-fill { height: 100%; background-color: #4CAF50; transition: width 0.3s ease; }

        .tamper-notification { position: fixed; bottom: 20px; right: 20px; color: white; padding: 20px;
            border-radius: 8px; box-shadow: 0 6px 12px rgba(0,0,0,0.2); z-index: 9999; font-size: 16px;
            animation: fadeIn 0.5s; max-width: 80%; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        .settings-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #fff; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); padding: 15px;
            z-index: 10000; width: 90%; max-width: 320px; display: none; max-height: 80vh; overflow-y: auto; }
        .settings-panel.active { display: block; }
        .settings-title { font-size: 16px; font-weight: bold; margin-bottom: 12px; text-align: center; }
        .settings-group { margin-bottom: 12px; padding: 8px; border-radius: 5px; background: #f8f9fa; }
        .settings-label { display: block; margin-bottom: 6px; font-weight: bold; font-size: 13px; color: #333; }
        .settings-input { width: 100%; padding: 7px 10px; border: 1px solid #ddd; border-radius: 4px;
            font-size: 13px; box-sizing: border-box; }
        .settings-buttons { display: flex; justify-content: space-between; margin-top: 15px; padding-top: 12px;
            border-top: 1px solid #eee; }
        .settings-button { padding: 7px 12px; border: none; border-radius: 4px; cursor: pointer;
            font-size: 13px; font-weight: bold; }
        .settings-save { background: #4CAF50; color: white; }
        .settings-cancel { background: #f44336; color: white; }

        .overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5);
            z-index: 9999; display: none; }
        .overlay.active { display: block; }

        .muye-reader-content { line-height: 1.8; font-size: 16px; }
        .replaced-content { background: #f8f9fa; border-radius: 8px; padding: 15px; margin: 8px 0;
            border: 2px solid #4CAF50; }

        .auto-replace-status { text-align: center; margin: 6px 0; padding: 4px; font-size: 11px;
            border-radius: 12px; background: #f0f0f0; color: #666; }
        .auto-replace-status.active { background: #e8f5e9; color: #2e7d32; }
        .auto-replace-status.monitoring { background: #e3f2fd; color: #1565c0; }
        .auto-replace-status.idle { background: #fff3e0; color: #f57c00; }
        .auto-replace-status.stable { background: #e8f5e9; color: #2e7d32; font-weight: bold; }

        .control-buttons { display: flex; gap: 4px; margin-top: 6px; }
        .control-group { display: flex; gap: 3px; margin-bottom: 8px; justify-content: center; }

        .settings-toggle { margin-bottom: 12px; padding: 8px; border-radius: 5px; background: #f8f9fa; }
        .settings-toggle-label { display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 6px; font-weight: bold; font-size: 13px; color: #333; }
        .settings-toggle-switch { position: relative; display: inline-block; width: 45px; height: 24px; }
        .settings-toggle-switch input { opacity: 0; width: 0; height: 0; }
        .settings-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #ccc; transition: .4s; border-radius: 24px; }
        .settings-toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px;
            bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .settings-toggle-slider { background-color: #4CAF50; }
        input:checked + .settings-toggle-slider:before { transform: translateX(21px); }

        .chapter-title-container { text-align: center; margin: 15px 0; padding: 12px; }
        .chapter-title-container h1 { margin: 0; font-size: 20px; color: #333; font-weight: bold; }
        .chapter-title-container .api-title { margin: 0; font-size: 18px; color: #2c3e50; font-weight: 600; }

        /* 移动端优化 */
        @media (max-width: 768px) {
            .tamper-container { width: 160px; padding: 10px; font-size: 12px; top: 15px; }
            .tamper-button { padding: 7px 12px; font-size: 11px; }
            .tamper-button.position { font-size: 9px; padding: 4px; }
            .tamper-container.hidden.right { transform: translateX(140px); }
            .tamper-container.hidden.left { transform: translateX(-140px); }
            .show-button { top: 15px; width: 25px; height: 70px; font-size: 12px; }
            .manual-hide-button { width: 22px; height: 22px; font-size: 11px; }
        }

        /* 小屏幕手机优化 */
        @media (max-width: 480px) {
            .tamper-container { width: 140px; padding: 8px; font-size: 11px; top: 10px; }
            .tamper-button { padding: 6px 10px; font-size: 10px; margin: 3px 0; }
            .tamper-container.hidden.right { transform: translateX(120px); }
            .tamper-container.hidden.left { transform: translateX(-120px); }
            .show-button { top: 10px; width: 22px; height: 60px; font-size: 11px; }
        }
    `);

    // 移除VIP提示框
    const removeVIPPrompt = () => {
        const vipElement = document.querySelector('.muye-to-fanqie');
        if (vipElement) vipElement.remove();
    };

    // 观察DOM变化，自动移除VIP提示框
    const observeVIPElement = () => {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.addedNodes.length) removeVIPPrompt();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    // 辅助工具
    const utils = {
        showNotification: (message, isSuccess = true) => {
            const notification = document.createElement('div');
            notification.className = 'tamper-notification';
            notification.style.backgroundColor = isSuccess ? '#4CAF50' : '#F44336';
            notification.textContent = message;
            document.body.appendChild(notification);
            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transform = 'translateY(20px)';
                setTimeout(() => notification.remove(), 500);
            }, 2500);
        },

        decodeHtmlEntities: (str) => {
            const entities = {'&#34;':'"','&#39;':"'",'&amp;':'&','&lt;':'<','&gt;':'>'};
            return str.replace(/&#34;|&#39;|&amp;|&lt;|&gt;/g, match => entities[match]);
        },

        sanitizeFilename: (name) => name.replace(/[\\/*?:"<>|]/g, '').trim(),

        extractContentAndTitle: (htmlContent) => {
            let title = '';
            let content = htmlContent;

            try {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = htmlContent;

                const headerElement = tempDiv.querySelector('header');
                if (headerElement) {
                    const titleElement = headerElement.querySelector('.tt-title');
                    title = titleElement ? titleElement.textContent.trim() : headerElement.textContent.trim();
                    headerElement.remove();
                }

                const articleElement = tempDiv.querySelector('article');
                content = articleElement ? articleElement.innerHTML : tempDiv.innerHTML;

            } catch (error) {
                console.error('提取标题和内容时出错:', error);
            }

            if (!title || title.trim() === '') {
                const pathname = window.location.pathname;
                const titleMatch = pathname.match(/\/reader\/\d+\/([^\/]+)/);
                title = titleMatch && titleMatch[1] ?
                    decodeURIComponent(titleMatch[1]).replace(/-/g, ' ') : '未知章节';
            }

            return { title, content };
        },

        formatContent: (content, forText = true) => {
            let formatted = utils.decodeHtmlEntities(content)
                .replace(/<header>[\s\S]*?<\/header>/i, '')
                .replace(/<article>|<\/article>/gi, '')
                .replace(/<footer>[\s\S]*$/i, '')
                .replace(/<p><\/p>/g, '');

            if (forText) {
                formatted = formatted
                    .replace(/<p[^>]*>/g, '  ')
                    .replace(/<\/p>/g, '\n')
                    .replace(/<br\/?>/g, '\n')
                    .replace(/<[^>]+>/g, '')
                    .trim()
                    .replace(/\n{2,}/g, '\n\n');

                if (!formatted.startsWith('  ') && formatted.length > 0) {
                    const firstNewline = formatted.indexOf('\n');
                    formatted = firstNewline === -1 ?
                        '  ' + formatted :
                        '  ' + formatted.substring(0, firstNewline) + formatted.substring(firstNewline);
                }
            } else {
                formatted = formatted
                    .replace(/<p[^>]*>/g, '<p>')
                    .replace(/<br\/?>/g, '<br>')
                    .trim();
            }

            return formatted;
        },

        getContentHash: (content) => {
            let hash = 0;
            for (let i = 0; i < content.length; i++) {
                const char = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        },

        isContentReplaced: () => {
            const contentContainer = document.querySelector('.muye-reader-content');
            return contentContainer ? !!contentContainer.querySelector('.replaced-content') : false;
        },

        checkContentOverwritten: () => {
            const contentContainer = document.querySelector('.muye-reader-content');
            if (!contentContainer) return false;
            const replacedContent = contentContainer.querySelector('.replaced-content');
            return !replacedContent || !contentContainer.contains(replacedContent);
        }
    };

    // 网络请求
    const network = {
        request: (url, options = {}) => {
            return new Promise((resolve, reject) => {
                const timeout = options.timeout || config.timeout;
                const timeoutTimer = setTimeout(() => reject(new Error(`请求超时 (${timeout}ms)`)), timeout);

                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'Accept-Encoding': 'gzip, deflate',
                        'Connection': 'keep-alive',
                        ...options.headers
                    },
                    responseType: options.responseType || 'text',
                    onload: (response) => {
                        clearTimeout(timeoutTimer);
                        resolve(response);
                    },
                    onerror: (error) => {
                        clearTimeout(timeoutTimer);
                        reject(new Error(`请求失败: ${error.message}`));
                    },
                    ontimeout: () => {
                        clearTimeout(timeoutTimer);
                        reject(new Error('请求超时'));
                    },
                    timeout: timeout
                });
            });
        },

        requestWithRetry: async (url, options = {}, retries = config.maxRetries) => {
            for (let i = 0; i <= retries; i++) {
                try {
                    return await network.request(url, options);
                } catch (error) {
                    if (i === retries) throw error;
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000 + Math.random() * 500));
                }
            }
        }
    };

    // 面板管理
    const panelManager = {
        // 显示面板
        showPanel: () => {
            const container = uiElements.container;
            if (container) {
                container.classList.remove('hidden');
                container.style.display = 'block';
            }

            // 隐藏显示按钮
            if (uiElements.showButton) {
                uiElements.showButton.style.display = 'none';
            }

            // 显示手动隐藏按钮（如果自动隐藏关闭）
            panelManager.updateManualHideButtonVisibility();

            // 清除自动隐藏计时器
            if (autoHideTimer) {
                clearTimeout(autoHideTimer);
                autoHideTimer = null;
            }

            // 如果启用了自动隐藏，设置新的计时器
            if (config.autoHideEnabled) {
                autoHideTimer = setTimeout(panelManager.hidePanel, config.autoHideDelay);
            }
        },

        // 隐藏面板
        hidePanel: () => {
            if (!config.autoHideEnabled && !uiElements.manualHideButton?.clicked) {
                // 如果自动隐藏关闭且不是手动点击隐藏，不执行隐藏
                return;
            }

            const container = uiElements.container;
            if (container) {
                container.classList.add('hidden');
            }

            // 显示显示按钮
            if (uiElements.showButton) {
                uiElements.showButton.style.display = 'block';
            }

            // 重置手动点击状态
            if (uiElements.manualHideButton) {
                uiElements.manualHideButton.clicked = false;
            }
        },

        // 手动隐藏面板
        manualHidePanel: () => {
            if (uiElements.manualHideButton) {
                uiElements.manualHideButton.clicked = true;
            }
            panelManager.hidePanel();
        },

        // 更新手动隐藏按钮可见性
        updateManualHideButtonVisibility: () => {
            if (uiElements.manualHideButton) {
                uiElements.manualHideButton.style.display = config.autoHideEnabled ? 'none' : 'block';
            }
        },

        // 创建手动隐藏按钮
        createManualHideButton: () => {
            const hideButton = document.createElement('button');
            hideButton.className = 'manual-hide-button';
            hideButton.textContent = '×';
            hideButton.title = '隐藏面板';
            hideButton.addEventListener('click', panelManager.manualHidePanel);
            hideButton.clicked = false;
            return hideButton;
        },

        // 重置自动隐藏计时器
        resetAutoHideTimer: () => {
            if (!config.autoHideEnabled) return;

            if (autoHideTimer) {
                clearTimeout(autoHideTimer);
                autoHideTimer = null;
            }

            autoHideTimer = setTimeout(panelManager.hidePanel, config.autoHideDelay);
        },

        // 创建显示按钮
        createShowButton: () => {
            console.log('创建显示按钮');
            const showButton = document.createElement('button');
            showButton.className = `show-button ${config.panelPosition}`;
            showButton.textContent = '工具';
            showButton.style.display = 'none';
            showButton.addEventListener('click', () => {
                console.log('显示按钮点击');
                panelManager.showPanel();
            });

            document.body.appendChild(showButton);
            return showButton;
        }
    };

    // UI管理
    const ui = {
        updateStatusDisplay: (statusKey, extraInfo = '') => {
            if (!uiElements.statusIndicator) return;

            const statusConfig = {
                'disabled': { text: '自动处理已关闭', class: '' },
                'enabled': { text: '自动处理已开启', class: 'active' },
                'checking': { text: '正在检查...', class: 'monitoring' },
                'no_change': { text: '内容无变化', class: 'stable' },
                'stable': { text: '内容稳定 ✓', class: 'stable' },
                'changed': { text: '检测到变化', class: 'active' },
                'replacing': { text: '正在处理...', class: 'monitoring' },
                'completed': { text: '处理完成', class: 'active' },
                'idle': { text: '空闲中', class: 'idle' },
                'error': { text: '检测异常', class: 'idle' }
            };

            const config = statusConfig[statusKey] || { text: '未知状态', class: '' };
            let message = config.text;
            if (extraInfo) message += ` (${extraInfo})`;

            uiElements.statusIndicator.textContent = message;
            uiElements.statusIndicator.className = 'auto-replace-status';
            if (config.class) uiElements.statusIndicator.classList.add(config.class);
        },

        createButton: (text, className, onClick, isControl = false) => {
            const btn = document.createElement('button');
            btn.className = isControl ?
                `control-button tamper-button ${className}` :
                `tamper-button ${className}`;
            btn.textContent = text;
            btn.addEventListener('click', onClick);
            return btn;
        },

        updateStats: (total, success, failed) => {
            if (uiElements.totalStat) uiElements.totalStat.textContent = total;
            if (uiElements.successStat) uiElements.successStat.textContent = success;
            if (uiElements.failedStat) uiElements.failedStat.textContent = failed;
        },

        updateProgress: (percentage) => {
            if (uiElements.progressFill) uiElements.progressFill.style.width = `${percentage}%`;
        },

        togglePanelPosition: () => {
            const newPosition = config.panelPosition === 'right' ? 'left' : 'right';
            config.panelPosition = newPosition;
            GM_setValue('panelPosition', newPosition);

            const container = uiElements.container;
            if (container) {
                container.classList.remove('left', 'right');
                container.classList.add(newPosition);
            }

            if (uiElements.showButton) {
                uiElements.showButton.classList.remove('left', 'right');
                uiElements.showButton.classList.add(newPosition);
            }

            utils.showNotification(`面板已切换到${newPosition === 'right' ? '右侧' : '左侧'}`);
        }
    };

    // 设置管理
    const settings = {
        showSettingsPanel: () => {
            console.log('显示设置面板');
            if (uiElements.settingsPanel) uiElements.settingsPanel.classList.add('active');
            if (uiElements.overlay) uiElements.overlay.classList.add('active');

            // 移除API域名默认值
            if (uiElements.apiDomainInput) uiElements.apiDomainInput.value = config.apiDomain || '';
            if (uiElements.timeoutInput) uiElements.timeoutInput.value = config.timeout / 1000;
            // 移除并发数限制，不设置max属性
            if (uiElements.concurrentInput) uiElements.concurrentInput.value = config.concurrentRequests;
            if (uiElements.checkIntervalInput) uiElements.checkIntervalInput.value = config.checkInterval / 1000;
            if (uiElements.autoReplaceToggle) uiElements.autoReplaceToggle.checked = config.autoReplaceEnabled;
            if (uiElements.autoHideToggle) uiElements.autoHideToggle.checked = config.autoHideEnabled;
            if (uiElements.autoHideDelayInput) uiElements.autoHideDelayInput.value = config.autoHideDelay / 1000;

            // 修复：使用正确的方法名
            if (config.autoHideEnabled) {
                panelManager.resetAutoHideTimer();
            }
        },

        hideSettingsPanel: () => {
            if (uiElements.settingsPanel) uiElements.settingsPanel.classList.remove('active');
            if (uiElements.overlay) uiElements.overlay.classList.remove('active');
        },

        saveSettings: () => {
            let settingsChanged = false;

            // API域名 - 移除默认值验证
            if (uiElements.apiDomainInput) {
                const newDomain = uiElements.apiDomainInput.value.trim();
                if (newDomain !== config.apiDomain) {
                    config.apiDomain = newDomain;
                    GM_setValue('apiDomain', newDomain);
                    settingsChanged = true;
                }
            }

            if (uiElements.timeoutInput) {
                const newTimeout = parseInt(uiElements.timeoutInput.value) * 1000;
                if (!isNaN(newTimeout) && newTimeout >= 5000 && newTimeout <= 60000 && newTimeout !== config.timeout) {
                    config.timeout = newTimeout;
                    GM_setValue('timeout', newTimeout);
                    settingsChanged = true;
                }
            }

            // 并发数 - 移除限制
            if (uiElements.concurrentInput) {
                const newConcurrent = parseInt(uiElements.concurrentInput.value);
                // 移除max限制，只保留min验证
                if (!isNaN(newConcurrent) && newConcurrent >= 1 && newConcurrent !== config.concurrentRequests) {
                    config.concurrentRequests = newConcurrent;
                    GM_setValue('concurrentRequests', newConcurrent);
                    settingsChanged = true;
                }
            }

            if (uiElements.checkIntervalInput) {
                const newCheckInterval = parseInt(uiElements.checkIntervalInput.value) * 1000;
                if (!isNaN(newCheckInterval) && newCheckInterval >= 3000 && newCheckInterval <= 30000 && newCheckInterval !== config.checkInterval) {
                    config.checkInterval = newCheckInterval;
                    GM_setValue('checkInterval', newCheckInterval);
                    settingsChanged = true;
                    if (config.autoReplaceEnabled && checkTimer) contentChecker.restartChecking();
                }
            }

            if (uiElements.autoReplaceToggle) {
                const newAutoReplace = uiElements.autoReplaceToggle.checked;
                if (newAutoReplace !== config.autoReplaceEnabled) {
                    config.autoReplaceEnabled = newAutoReplace;
                    GM_setValue('autoReplaceEnabled', newAutoReplace);
                    settingsChanged = true;

                    if (config.autoReplaceEnabled) {
                        ui.updateStatusDisplay('enabled');
                        utils.showNotification('自动处理已开启');
                        contentChecker.startChecking();
                        observer.startUrlChangeObserver();
                    } else {
                        ui.updateStatusDisplay('disabled');
                        utils.showNotification('自动处理已关闭');
                        contentChecker.stopChecking();
                        observer.stopUrlChangeObserver();
                    }
                }
            }

            if (uiElements.autoHideToggle) {
                const newAutoHide = uiElements.autoHideToggle.checked;
                if (newAutoHide !== config.autoHideEnabled) {
                    config.autoHideEnabled = newAutoHide;
                    GM_setValue('autoHideEnabled', newAutoHide);
                    settingsChanged = true;

                    if (config.autoHideEnabled) {
                        utils.showNotification('自动隐藏已开启');
                        panelManager.updateManualHideButtonVisibility();
                        panelManager.resetAutoHideTimer();
                    } else {
                        utils.showNotification('自动隐藏已关闭');
                        if (autoHideTimer) {
                            clearTimeout(autoHideTimer);
                            autoHideTimer = null;
                        }
                        panelManager.updateManualHideButtonVisibility();
                    }
                }
            }

            if (uiElements.autoHideDelayInput) {
                const newAutoHideDelay = parseInt(uiElements.autoHideDelayInput.value) * 1000;
                if (!isNaN(newAutoHideDelay) && newAutoHideDelay >= 1000 && newAutoHideDelay <= 10000 && newAutoHideDelay !== config.autoHideDelay) {
                    config.autoHideDelay = newAutoHideDelay;
                    GM_setValue('autoHideDelay', newAutoHideDelay);
                    settingsChanged = true;

                    if (config.autoHideEnabled) {
                        panelManager.resetAutoHideTimer();
                    }
                }
            }

            utils.showNotification(settingsChanged ? '设置已保存' : '未检测到变化');
            settings.hideSettingsPanel();
        }
    };

    // 内容处理
    const contentReplacer = {
        getChapterId: () => {
            const urlParams = new URLSearchParams(window.location.search);

            const chapterParam = urlParams.get('chapter_id') ||
                               urlParams.get('chapterId') ||
                               urlParams.get('cid') ||
                               urlParams.get('item_id') ||
                               urlParams.get('id');
            if (chapterParam) return chapterParam;

            const pathMatch = window.location.pathname.match(/\/reader\/(\d+)/);
            if (pathMatch && pathMatch[1]) return pathMatch[1];

            const urlMatch = window.location.href.match(/\/(\d+)(?:\?|$)/);
            return urlMatch && urlMatch[1] ? urlMatch[1] : null;
        },

        checkNeedReplace: async (currentChapterId, forceReplace = false) => {
            if (forceReplace) return true;
            if (!currentChapterId) return false;

            if (currentChapterId !== contentReplaceState.chapterId) return true;
            if (!contentReplaceState.replaced) return true;
            if (utils.checkContentOverwritten()) return true;

            const contentContainer = document.querySelector('.muye-reader-content');
            if (contentContainer) {
                const currentContent = contentContainer.innerHTML;
                const currentHash = utils.getContentHash(currentContent);
                if (currentHash !== contentReplaceState.contentHash) return true;
            }

            const now = Date.now();
            const minCheckInterval = 2000;
            return now - contentReplaceState.timestamp >= minCheckInterval;
        },

        performContentReplace: async (chapterId, isAuto = false) => {
            // 检查API域名是否设置
            if (!config.apiDomain) {
                utils.showNotification('请先在设置中配置API域名', false);
                return false;
            }

            if (replaceInProgress) return false;
            replaceInProgress = true;

            try {
                const apiUrl = `${config.apiDomain}/content?item_id=${chapterId}`;
                const response = await network.requestWithRetry(apiUrl, {
                    headers: { 'Accept': 'application/json' },
                    timeout: config.timeout
                });

                if (!response.responseText.trim()) throw new Error('API返回空响应');

                const data = JSON.parse(response.responseText);
                if (data.content === undefined || data.content === null) {
                    throw new Error('响应中缺少content字段');
                }

                const { title: chapterTitle, content: articleContent } = utils.extractContentAndTitle(data.content);
                const formattedContent = utils.formatContent(articleContent, false);

                let contentContainer = document.querySelector('.muye-reader-content') ||
                                     document.querySelector('.reader-content, .chapter-content, .content, .muye-content, .book-content');

                if (contentContainer) {
                    const newContentHtml = `
                        <div class="chapter-title-container">
                            <h1 class="api-title">${chapterTitle}</h1>
                        </div>
                        <div class="replaced-content">
                            ${formattedContent}
                        </div>
                    `;

                    contentContainer.innerHTML = newContentHtml;

                    contentReplaceState = {
                        replaced: true,
                        chapterId: chapterId,
                        chapterTitle: chapterTitle,
                        contentHash: utils.getContentHash(contentContainer.innerHTML),
                        timestamp: Date.now(),
                        stableCount: 0,
                        isIdle: false
                    };

                    GM_setValue('lastChapterId', chapterId);
                    GM_setValue('lastChapterTitle', chapterTitle);
                    GM_setValue('lastReplaceTime', Date.now());

                    return true;
                } else {
                    throw new Error('未找到内容容器');
                }
            } catch (error) {
                console.error('处理过程详细错误:', error);
                const errorMsg = error.message.includes('API返回空响应') ?
                    'API返回空数据，可能章节不存在或API不可用' :
                    error.message.includes('请求超时') ?
                    'API请求超时，请检查网络连接或调整超时设置' :
                    error.message.includes('JSON') ?
                    'API返回格式错误，可能API已更新' :
                    '处理失败: ' + error.message;

                utils.showNotification(errorMsg, false);
                return false;
            } finally {
                replaceInProgress = false;
            }
        },

        manualReplaceContent: async () => {
            const chapterId = contentReplacer.getChapterId();

            if (!chapterId) {
                utils.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            ui.updateStatusDisplay('checking', '处理');
            const replaceSuccess = await contentReplacer.performContentReplace(chapterId, false);
            ui.updateStatusDisplay(replaceSuccess ? 'completed' : 'error');

            if (replaceSuccess) {
                const title = contentReplaceState.chapterTitle || '当前章节';
                utils.showNotification(`内容处理成功！${title}`);
            }
        },

        resetReplaceState: () => {
            contentReplaceState = {
                replaced: false,
                chapterId: null,
                chapterTitle: null,
                contentHash: null,
                timestamp: 0,
                stableCount: 0,
                isIdle: false
            };

            GM_setValue('lastChapterId', null);
            GM_setValue('lastChapterTitle', null);
            GM_setValue('lastReplaceTime', 0);

            utils.showNotification('处理状态已重置');
            ui.updateStatusDisplay(config.autoReplaceEnabled ? 'enabled' : 'disabled');

            if (config.autoReplaceEnabled) {
                setTimeout(() => contentChecker.checkAndReplace(false, true), 300);
            }
        },

        handleUrlChange: async () => {
            contentReplaceState = {
                replaced: false,
                chapterId: null,
                chapterTitle: null,
                contentHash: null,
                timestamp: 0,
                stableCount: 0,
                isIdle: false
            };

            await new Promise(resolve => setTimeout(resolve, 800));
            const newChapterId = contentReplacer.getChapterId();

            if (newChapterId && config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                ui.updateStatusDisplay('checking', 'URL变化');
                const replaceSuccess = await contentReplacer.performContentReplace(newChapterId, true);
                ui.updateStatusDisplay(replaceSuccess ? 'completed' : 'error');
            }
        }
    };

    // 内容检查器
    const contentChecker = {
        checkAndReplace: async (isAuto = true, forceReplace = false) => {
            if (!config.autoReplaceEnabled && isAuto) return false;
            if (replaceInProgress || contentReplaceState.isIdle) return false;

            ui.updateStatusDisplay('checking');

            try {
                const currentChapterId = contentReplacer.getChapterId();

                if (!currentChapterId) {
                    ui.updateStatusDisplay('error', '未找到ID');
                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true);
                        }
                    }, 1000);
                    return false;
                }

                const shouldReplace = await contentReplacer.checkNeedReplace(currentChapterId, forceReplace);

                if (shouldReplace) {
                    ui.updateStatusDisplay('changed', currentChapterId);
                    const replaceSuccess = await contentReplacer.performContentReplace(currentChapterId, isAuto);
                    ui.updateStatusDisplay(replaceSuccess ? 'completed' : 'error');
                    contentReplaceState.stableCount = 0;
                    return replaceSuccess;
                } else {
                    contentReplaceState.stableCount = Math.min(contentReplaceState.stableCount + 1, 10);
                    ui.updateStatusDisplay(
                        contentReplaceState.stableCount >= 3 ? 'stable' : 'no_change',
                        `稳定${contentReplaceState.stableCount}/10`
                    );
                    return false;
                }
            } catch (error) {
                console.error('检查处理错误:', error);
                ui.updateStatusDisplay('error', error.message.substring(0, 10) + '...');
                return false;
            }
        },

        startChecking: () => {
            if (checkTimer) clearInterval(checkTimer);

            checkTimer = setInterval(() => {
                if (config.autoReplaceEnabled && !replaceInProgress) {
                    contentChecker.checkAndReplace(true);
                }
            }, config.checkInterval);

            setTimeout(() => {
                if (config.autoReplaceEnabled) contentChecker.checkAndReplace(true);
            }, 1000);
        },

        stopChecking: () => {
            if (checkTimer) {
                clearInterval(checkTimer);
                checkTimer = null;
            }
        },

        restartChecking: () => {
            contentChecker.stopChecking();
            if (config.autoReplaceEnabled) contentChecker.startChecking();
        }
    };

    // 活动管理器
    const activityManager = {
        recordActivity: () => {
            lastActivityTime = Date.now();
            if (contentReplaceState.isIdle) {
                contentReplaceState.isIdle = false;
                contentReplaceState.stableCount = 0;
                ui.updateStatusDisplay('checking', '活动恢复');
            }
        },

        checkIdleState: () => {
            const now = Date.now();
            if (!contentReplaceState.isIdle && now - lastActivityTime > config.idleTimeout) {
                contentReplaceState.isIdle = true;
                ui.updateStatusDisplay('idle', '5分钟无活动');
            }
        },

        observeUserActivity: () => {
            ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(eventType => {
                document.addEventListener(eventType, activityManager.recordActivity);
            });

            setInterval(activityManager.checkIdleState, 30000);
        }
    };

    // 观察者
    const observer = {
        urlCheckTimer: null,

        startUrlChangeObserver: () => {
            if (observer.urlCheckTimer) return;

            lastUrl = window.location.href;
            observer.urlCheckTimer = setInterval(async () => {
                const currentUrl = window.location.href;
                if (currentUrl !== lastUrl) {
                    lastUrl = currentUrl;
                    activityManager.recordActivity();
                    ui.updateStatusDisplay('checking', 'URL变化');
                    await contentReplacer.handleUrlChange();
                }
            }, 300);
        },

        stopUrlChangeObserver: () => {
            if (observer.urlCheckTimer) {
                clearInterval(observer.urlCheckTimer);
                observer.urlCheckTimer = null;
            }
        },

        startReaderMonitoring: () => {
            if (pageInfo.type === 'reader') {
                observer.startUrlChangeObserver();
            }
        },

        stopReaderMonitoring: () => {
            observer.stopUrlChangeObserver();
        }
    };

    // 下载功能
    const downloader = {
        fetchBookInfo: async () => {
            try {
                const response = await network.requestWithRetry(
                    `https://i.snssdk.com/reading/bookapi/multi-detail/v/?aid=1967&book_id=${pageInfo.bookId}`,
                    { timeout: config.timeout }
                );
                const data = JSON.parse(response.responseText);

                if (!data.data?.[0]) throw new Error('未获取到书籍信息');

                const book = data.data[0];
                return {
                    title: utils.sanitizeFilename(book.book_name),
                    author: utils.sanitizeFilename(book.author),
                    abstract: book.abstract,
                    wordCount: book.word_number,
                    chapterCount: book.serial_count,
                    thumb_url: book.thumb_url,
                    infoText: `书名：${book.book_name}\n作者：${book.author}\n字数：${parseInt(book.word_number)/10000}万字\n章节数：${book.serial_count}\n简介：${book.abstract}\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。若因使用本工具导致任何版权纠纷或法律问题，使用者需自行承担全部责任。`
                };
            } catch (error) {
                utils.showNotification('获取书籍信息失败: ' + error.message, false);
                throw error;
            }
        },

        fetchChapters: async () => {
            try {
                const response = await network.requestWithRetry(
                    `https://fanqienovel.com/api/reader/directory/detail?bookId=${pageInfo.bookId}`,
                    { timeout: config.timeout }
                );
                const text = response.responseText;

                const chapterListMatch = text.match(/"chapterListWithVolume":\[(.*?)\]]/);
                if (!chapterListMatch) throw new Error('未找到章节列表');

                const chapterListStr = chapterListMatch[1];
                const itemIds = chapterListStr.match(/"itemId":"(.*?)"/g).map(m => m.match(/"itemId":"(.*?)"/)[1]);
                const titles = chapterListStr.match(/"title":"(.*?)"/g).map(m => m.match(/"title":"(.*?)"/)[1]);

                return itemIds.map((id, index) => ({
                    id: id,
                    title: titles[index] || `第${index+1}章`
                }));
            } catch (error) {
                utils.showNotification('获取章节列表失败: ' + error.message, false);
                throw error;
            }
        },

        downloadChapter: async (chapterId, index, chapterTitle) => {
            // 检查API域名是否设置
            if (!config.apiDomain) {
                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: '[错误: 请先在设置中配置API域名]',
                    success: false
                };
            }

            try {
                const response = await network.requestWithRetry(
                    `${config.apiDomain}/content?item_id=${chapterId}`,
                    { headers: { 'Accept': 'application/json' }, timeout: config.timeout }
                );

                if (!response.responseText.trim()) throw new Error('空响应');

                const data = JSON.parse(response.responseText);
                if (data.content === undefined || data.content === null) {
                    throw new Error('响应中缺少content字段');
                }

                const { title: apiTitle, content: articleContent } = utils.extractContentAndTitle(data.content);
                const finalTitle = apiTitle || chapterTitle || `第${index + 1}章`;

                return {
                    title: finalTitle,
                    content: utils.formatContent(articleContent, true),
                    success: true
                };
            } catch (error) {
                console.error(`章节 ${chapterId} 下载失败:`, error);
                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: `[下载失败: ${error.message}]`,
                    success: false
                };
            }
        },

        downloadChaptersBatch: async (chapterIds) => {
            const results = [];
            const total = chapterIds.length;
            let completed = 0;
            let successCount = 0;
            let failedCount = 0;

            // 移除并发数限制，使用用户设置的任意值
            const batchSize = config.concurrentRequests;

            for (let i = 0; i < total; i += batchSize) {
                const batch = chapterIds.slice(i, i + batchSize);
                const batchPromises = batch.map((chapter, batchIndex) =>
                    downloader.downloadChapter(chapter.id, i + batchIndex, chapter.title)
                );

                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);

                batchResults.forEach(result => {
                    result.success ? successCount++ : failedCount++;
                });

                completed += batch.length;
                ui.updateProgress((completed / total) * 100);
                ui.updateStats(total, successCount, failedCount);

                if (i + batchSize < total) {
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 800 + 200));
                }
            }

            return results;
        },

        generateEPUB: async (bookInfo, chapters, contents, coverUrl) => {
            const zip = new JSZip();
            const uuid = URL.createObjectURL(new Blob([])).split('/').pop();
            const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

            zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

            const metaInf = zip.folder('META-INF');
            metaInf.file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`);

            const oebps = zip.folder('OEBPS');
            const textFolder = oebps.folder('Text');

            oebps.file('Styles/main.css', `body { font-family: "Microsoft Yahei", serif; line-height: 1.8; margin: 2em auto; padding: 0 20px; color: #333; text-align: justify; background-color: #f8f4e8; }
h1 { font-size: 1.4em; margin: 1.2em 0; color: #0057BD; }
h2 { font-size: 1.0em; margin: 0.8em 0; color: #0057BD; }
.pic { margin: 50% 30% 0 30%; padding: 2px 2px; border: 1px solid #f5f5dc; background-color: rgba(250,250,250, 0); border-radius: 1px; }
p { text-indent: 2em; margin: 0.8em 0; hyphens: auto; }
.book-info { margin: 1em 0; padding: 1em; background: #f8f8f8; border-radius: 5px; }
.book-info p { text-indent: 0; }`);

            let coverItem = '';
            if (coverUrl) {
                try {
                    const response = await network.requestWithRetry(coverUrl, {
                        responseType: 'blob',
                        timeout: config.timeout * 2
                    });
                    oebps.file('Images/cover.jpg', response.response, { binary: true });

                    textFolder.file('cover.html', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/html">
<head>
    <title>封面</title>
    <link href="../Styles/main.css" rel="stylesheet"/></head><body><div class="pic"><img src="../Images/cover.jpg" alt="${bookInfo.title}封面" style="max-height: 60vh;"/></div><h1 style="margin-top: 2em;">${bookInfo.title}</h1><h2>${bookInfo.author}</h2>
</body></html>`);

                    coverItem = '<item id="cover" href="Text/cover.html" media-type="application/xhtml+xml"/><item id="cover-image" href="Images/cover.jpg" media-type="image/jpeg"/>';
                } catch (e) {
                    console.warn('封面下载失败:', e);
                }
            }

            textFolder.file('info.html', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/html">
<head>
    <title>书籍信息</title>
    <link href="../Styles/main.css" rel="stylesheet"/></head><body><h1>${bookInfo.title}</h1><div class="book-info"><p><strong>作者：</strong>${bookInfo.author}</p><p><strong>字数：</strong>${parseInt(bookInfo.wordCount)/10000}万字</p><p><strong>章节数：</strong>${bookInfo.chapterCount}</p></div><h2>简介</h2><p>${bookInfo.abstract.replace(/\n/g, '</p><p>')}</p><h2>免责声明</h2><p>本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。若因使用本工具导致任何版权纠纷或法律问题，使用者需自行承担全部责任。</p></body></html>`);

            const manifestItems = [`<item id="css" href="Styles/main.css" media-type="text/css"/>`,
                                   `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
                                   `<item id="info" href="Text/info.html" media-type="application/xhtml+xml"/>`,
                                   coverItem].filter(Boolean);

            const spineItems = [coverItem ? '<itemref idref="cover"/>' : '', '<itemref idref="info"/>'].filter(Boolean);
            const navPoints = [];

            chapters.forEach((chapter, index) => {
                const filename = `chapter_${index}.html`;
                const safeContent = contents[index]
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/\n/g, '</p><p>');

                textFolder.file(filename, `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/html">
<head>
    <title>${chapter.title}</title>
    <link href="../Styles/main.css" rel="stylesheet"/></head><body><h1>${chapter.title}</h1><p>${safeContent}</p></body></html>`);

                manifestItems.push(`<item id="chap${index}" href="Text/${filename}" media-type="application/xhtml+xml"/>`);
                spineItems.push(`<itemref idref="chap${index}"/>`);

                navPoints.push(`<navPoint id="navpoint-${index+3}" playOrder="${index+3}">
    <navLabel><text>${chapter.title}</text></navLabel>
    <content src="Text/${filename}"/>
</navPoint>`);
            });

            oebps.file('toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
        <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
        <meta name="dtb:depth" content="1"/>
        <meta name="dtb:totalPageCount" content="0"/>
        <meta name="dtb:maxPageNumber" content="0"/>
        <meta name="dtb:modified" content="${now}"/>
    </head>
    <docTitle>
        <text>${bookInfo.title}</text>
    </docTitle>
    <navMap>
        <navPoint id="navpoint-1" playOrder="1">
            <navLabel><text>封面</text></navLabel>
            <content src="Text/cover.html"/>
        </navPoint>
        <navPoint id="navpoint-2" playOrder="2">
            <navLabel><text>书籍信息</text></navLabel>
            <content src="Text/info.html"/>
        </navPoint>
        ${navPoints.join('\n        ')}
    </navMap>
</ncx>`);

            oebps.file('content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
        <dc:title>${bookInfo.title}</dc:title>
        <dc:creator>${bookInfo.author}</dc:creator>
        <dc:language>zh-CN</dc:language>
        ${coverItem ? '<meta name="cover" content="cover-image"/>' : ''}
    </metadata>
    <manifest>
        ${manifestItems.join('\n        ')}
    </manifest>
    <spine toc="ncx">
        ${spineItems.join('\n        ')}
    </spine>
    <guide>
        ${coverItem ? '<reference type="cover" title="封面" href="Text/cover.html"/>' : ''}
        <reference type="toc" title="目录" href="toc.ncx"/>
    </guide>
</package>`);

            return await zip.generateAsync({
                type: 'blob',
                mimeType: 'application/epub+zip',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 }
            });
        },

        startDownload: async (format) => {
            if (isDownloading) return;

            // 检查API域名是否设置
            if (!config.apiDomain) {
                utils.showNotification('请先在设置中配置API域名', false);
                return;
            }

            isDownloading = true;
            const txtBtn = document.querySelector('.tamper-button.txt');
            const epubBtn = document.querySelector('.tamper-button.epub');
            if (txtBtn) txtBtn.disabled = true;
            if (epubBtn) epubBtn.disabled = true;
            if (uiElements.progressContainer) uiElements.progressContainer.style.display = 'block';
            utils.showNotification('开始下载章节内容...');

            try {
                if (!bookInfo) bookInfo = await downloader.fetchBookInfo();
                if (!chapters) chapters = await downloader.fetchChapters();

                const chapterResults = await downloader.downloadChaptersBatch(chapters);
                const contents = chapterResults.map(result => result.content);
                const successCount = chapterResults.filter(r => r.success).length;
                const failedCount = chapterResults.filter(r => !r.success).length;

                const updatedChapters = chapterResults.map((result, index) => ({
                    id: chapters[index].id,
                    title: result.title
                }));

                if (format === 'txt') {
                    let txtContent = bookInfo.infoText + '\n\n';
                    for (let i = 0; i < updatedChapters.length; i++) {
                        txtContent += `${updatedChapters[i].title}\n\n`;
                        txtContent += `${contents[i]}\n\n`;
                    }
                    saveAs(new Blob([txtContent], { type: 'text/plain;charset=utf-8' }), `${bookInfo.title}.txt`);
                } else if (format === 'epub') {
                    const epubBlob = await downloader.generateEPUB(bookInfo, updatedChapters, contents, bookInfo.thumb_url);
                    saveAs(epubBlob, `${bookInfo.title}.epub`);
                }

                utils.showNotification(`下载完成！成功: ${successCount}, 失败: ${failedCount}`);
            } catch (error) {
                console.error('下载过程出错:', error);
                let errorMsg = '下载失败: ' + error.message;
                if (error.message.includes('超时')) errorMsg += '\n建议：尝试调整设置中的超时时间或并发数';
                utils.showNotification(errorMsg, false);
            } finally {
                if (txtBtn) txtBtn.disabled = false;
                if (epubBtn) epubBtn.disabled = false;
                if (uiElements.progressContainer) uiElements.progressContainer.style.display = 'none';
                isDownloading = false;
            }
        },

        downloadCurrentChapter: async () => {
            const chapterId = contentReplacer.getChapterId();

            if (!chapterId) {
                utils.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            // 检查API域名是否设置
            if (!config.apiDomain) {
                utils.showNotification('请先在设置中配置API域名', false);
                return;
            }

            utils.showNotification('开始下载当前章节...');

            try {
                const result = await downloader.downloadChapter(chapterId, 0, '当前章节');

                if (result.success) {
                    let chapterContent = `章节：${result.title}\n\n`;
                    chapterContent += result.content;
                    chapterContent += '\n\n---\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。若因使用本工具导致任何版权纠纷或法律问题，使用者需自行承担全部责任。';

                    const sanitizedTitle = utils.sanitizeFilename(result.title);
                    saveAs(new Blob([chapterContent], { type: 'text/plain;charset=utf-8' }), `${sanitizedTitle}.txt`);

                    utils.showNotification(`章节下载成功！${result.title}`);
                } else {
                    utils.showNotification(`下载失败: ${result.content}`, false);
                }
            } catch (error) {
                console.error('章节下载错误:', error);
                utils.showNotification('下载失败: ' + error.message, false);
            }
        }
    };

    // 创建UI
    const createUI = () => {
        console.log('创建UI开始');

        // 创建面板容器
        const container = document.createElement('div');
        container.className = `tamper-container ${config.panelPosition}`;
        container.style.display = 'block';

        // 添加鼠标事件
        container.addEventListener('mouseenter', panelManager.showPanel);
        container.addEventListener('mouseleave', () => {
            if (config.autoHideEnabled) {
                panelManager.resetAutoHideTimer();
            }
        });

        // 添加手动隐藏按钮
        const manualHideButton = panelManager.createManualHideButton();
        container.appendChild(manualHideButton);

        // 添加控制按钮组
        const controlGroup = document.createElement('div');
        controlGroup.className = 'control-group';

        controlGroup.appendChild(ui.createButton('切换位置', 'position', ui.togglePanelPosition, true));
        container.appendChild(controlGroup);

        if (pageInfo.type === 'page') {
            container.appendChild(ui.createButton('下载TXT', 'txt', () => downloader.startDownload('txt')));
            container.appendChild(ui.createButton('下载EPUB', 'epub', () => downloader.startDownload('epub')));
            container.appendChild(ui.createButton('设置', 'settings', settings.showSettingsPanel));

            const progressContainer = document.createElement('div');
            progressContainer.style.marginTop = '8px';
            progressContainer.style.display = 'none';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = 'progress-fill';
            progressBar.appendChild(progressFill);
            progressContainer.appendChild(progressBar);
            container.appendChild(progressContainer);

            const statsContainer = document.createElement('div');
            statsContainer.className = 'stats-container';
            statsContainer.innerHTML = `
                <div class="stat-item">
                    <div class="stat-label">总章节</div>
                    <div class="stat-value total-value">0</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">成功</div>
                    <div class="stat-value success-value">0</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">失败</div>
                    <div class="stat-value failed-value">0</div>
                </div>
            `;
            container.appendChild(statsContainer);
        } else if (pageInfo.type === 'reader') {
            container.appendChild(ui.createButton('下载本章', 'download-chapter', downloader.downloadCurrentChapter));
            container.appendChild(ui.createButton('设置', 'settings', settings.showSettingsPanel));

            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'auto-replace-status';
            ui.updateStatusDisplay(config.autoReplaceEnabled ? 'enabled' : 'disabled');
            container.appendChild(statusIndicator);

            const controlButtons = document.createElement('div');
            controlButtons.className = 'control-buttons';
            controlButtons.appendChild(ui.createButton('处理', 'replace', contentReplacer.manualReplaceContent, true));
            controlButtons.appendChild(ui.createButton('重置', 'reset', contentReplacer.resetReplaceState, true));
            container.appendChild(controlButtons);
        }

        document.body.appendChild(container);
        console.log('面板容器添加到页面');

        // 创建显示按钮 - 修复：使用正确的方法名
        const showButton = panelManager.createShowButton();
        console.log('显示按钮创建完成');

        // 创建设置面板 - 移除并发数限制和API域名默认值
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.addEventListener('click', settings.hideSettingsPanel);

        const settingsPanel = document.createElement('div');
        settingsPanel.className = 'settings-panel';
        settingsPanel.innerHTML = `
            <div class="settings-title">番茄小说增强工具设置</div>
            <div class="settings-toggle">
                <div class="settings-toggle-label">
                    自动处理内容
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="autoReplaceToggle">
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="settings-toggle">
                <div class="settings-toggle-label">
                    自动隐藏面板
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="autoHideToggle">
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="settings-group">
                <label class="settings-label">自动隐藏延迟(秒)</label>
                <input type="number" class="settings-input" id="autoHideDelayInput" min="1" max="10" value="3">
            </div>
            <div class="settings-group">
                <label class="settings-label">API域名</label>
                <input type="text" class="settings-input" id="apiDomain" placeholder="请输入API域名">
            </div>
            <div class="settings-group">
                <label class="settings-label">超时时间(秒)</label>
                <input type="number" class="settings-input" id="timeout" min="5" max="60" value="20">
            </div>
            <div class="settings-group">
                <label class="settings-label">并发数</label>
                <input type="number" class="settings-input" id="concurrent" min="1" value="2">
            </div>
            <div class="settings-group">
                <label class="settings-label">检查间隔(秒)</label>
                <input type="number" class="settings-input" id="checkInterval" min="3" max="30" value="5">
            </div>
            <div class="settings-buttons">
                <button class="settings-button settings-save">保存设置</button>
                <button class="settings-button settings-cancel">取消</button>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(settingsPanel);
        console.log('设置面板创建完成');

        uiElements = {
            container,
            manualHideButton,
            showButton,
            progressContainer: container.querySelector('.progress-bar')?.parentNode,
            progressFill: container.querySelector('.progress-fill'),
            totalStat: container.querySelector('.total-value'),
            successStat: container.querySelector('.success-value'),
            failedStat: container.querySelector('.failed-value'),
            settingsPanel,
            overlay,
            apiDomainInput: settingsPanel.querySelector('#apiDomain'),
            timeoutInput: settingsPanel.querySelector('#timeout'),
            concurrentInput: settingsPanel.querySelector('#concurrent'),
            checkIntervalInput: settingsPanel.querySelector('#checkInterval'),
            autoReplaceToggle: settingsPanel.querySelector('#autoReplaceToggle'),
            autoHideToggle: settingsPanel.querySelector('#autoHideToggle'),
            autoHideDelayInput: settingsPanel.querySelector('#autoHideDelayInput'),
            saveBtn: settingsPanel.querySelector('.settings-save'),
            cancelBtn: settingsPanel.querySelector('.settings-cancel'),
            statusIndicator: document.querySelector('.auto-replace-status')
        };

        console.log('UI元素收集完成:', Object.keys(uiElements));

        uiElements.saveBtn.addEventListener('click', settings.saveSettings);
        uiElements.cancelBtn.addEventListener('click', settings.hideSettingsPanel);

        console.log('UI创建完成');
    };

    // 初始化
    const init = async () => {
        console.log('番茄小说增强工具初始化开始');

        removeVIPPrompt();
        observeVIPElement();

        console.log('创建UI...');
        createUI();

        // 加载保存的状态
        if (GM_getValue('lastChapterId')) {
            contentReplaceState = {
                replaced: utils.isContentReplaced(),
                chapterId: GM_getValue('lastChapterId'),
                chapterTitle: GM_getValue('lastChapterTitle', null),
                contentHash: null,
                timestamp: GM_getValue('lastReplaceTime', 0),
                stableCount: 0,
                isIdle: false
            };
        }

        activityManager.observeUserActivity();

        if (pageInfo.type === 'reader') {
            observer.startReaderMonitoring();
            if (config.autoReplaceEnabled) contentChecker.startChecking();
        }

        if (pageInfo.type === 'page') {
            try {
                bookInfo = await downloader.fetchBookInfo();
                chapters = await downloader.fetchChapters();
                ui.updateStats(chapters.length, 0, 0);
            } catch (error) {
                console.error('初始化失败:', error);
                utils.showNotification('初始化失败: ' + error.message, false);
            }
        }

        // 初始化自动隐藏和手动隐藏按钮
        panelManager.updateManualHideButtonVisibility();
        if (config.autoHideEnabled) {
            autoHideTimer = setTimeout(panelManager.hidePanel, config.autoHideDelay);
        }

        console.log('番茄小说增强工具初始化完成');
    };

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        console.log('页面加载中，等待DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', init);
    } else {
        console.log('页面已加载，立即初始化');
        init();
    }

    // 监听页面刷新或导航
    window.addEventListener('beforeunload', () => {
        contentChecker.stopChecking();
        observer.stopReaderMonitoring();
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }
    });

})();
