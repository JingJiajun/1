// ==UserScript==
// @name          番茄小说增强工具
// @author        cctv
// @version       2025.11.21
// @description   番茄小说下载器 + 内容替换功能
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

    // 配置管理
    const config = {
        apiDomain: GM_getValue('apiDomain', 'https://api-x.shrtxs.cn/fanqie'),
        concurrentRequests: GM_getValue('concurrentRequests', 2),
        timeout: GM_getValue('timeout', 20000),
        maxRetries: 2,
        autoReplaceEnabled: GM_getValue('autoReplaceEnabled', false),
        checkInterval: GM_getValue('checkInterval', 5000),
        idleTimeout: 300000
    };

    // 全局变量
    let bookInfo = null;
    let chapters = null;
    let isDownloading = false;
    let uiElements = {};
    let replaceInProgress = false;
    let lastActivityTime = Date.now();
    let checkTimer = null;
    let chapterChangeObserver = null;

    let contentReplaceState = {
        replaced: false,
        chapterId: GM_getValue('lastChapterId', null),
        contentHash: null,
        timestamp: GM_getValue('lastReplaceTime', 0),
        stableCount: 0,
        isIdle: false
    };

    // 检查页面类型并获取对应的ID
    function getPageInfo() {
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
    }

    const pageInfo = getPageInfo();
    if (!pageInfo) {
        console.log('番茄小说增强工具: 当前页面不支持');
        return;
    }

    // 界面样式
    GM_addStyle(`
        .tamper-container { position: fixed; top: 220px; right: 20px; background: #fff; border-radius: 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 15px; z-index: 9999; width: 200px; font-size: 14px; line-height: 1.3 }
        .tamper-button { border: none; border-radius: 20px; padding: 10px 20px; margin: 5px 0; cursor: pointer;
            font-size: 14px; font-weight: bold; transition: all 0.2s; width: 100%; text-align: center }
        .tamper-button:hover { opacity: 0.9 }
        .tamper-button:disabled { background: #ccc; cursor: not-allowed }
        .tamper-button.txt { background: #4CAF50; color: #fff }
        .tamper-button.epub { background: #2196F3; color: #fff }
        .tamper-button.download-chapter { background: #FF9800; color: #fff; font-size: 12px; padding: 8px 10px }
        .tamper-button.settings { background: #9C27B0; color: #fff; font-size: 12px; padding: 8px 10px }
        .tamper-button.control { font-size: 11px; padding: 6px; border-radius: 15px; }

        .stats-container { display: flex; justify-content: space-between; margin-top: 15px; font-size: 12px }
        .stat-item { display: flex; flex-direction: column; align-items: center; flex: 1; padding: 5px }
        .stat-label { margin-bottom: 5px; color: #666 }
        .stat-value { font-weight: bold; font-size: 16px }
        .total-value { color: #333 }
        .success-value { color: #4CAF50 }
        .failed-value { color: #F44336 }

        .progress-bar { width: 100%; height: 10px; background-color: #f0f0f0; border-radius: 5px;
            margin-top: 10px; overflow: hidden }
        .progress-fill { height: 100%; background-color: #4CAF50; transition: width 0.3s ease }

        .tamper-notification { position: fixed; bottom: 40px; right: 40px; color: white; padding: 30px;
            border-radius: 10px; box-shadow: 0 8px 16px rgba(0,0,0,0.2); z-index: 9999; font-size: 28px;
            animation: fadeIn 0.5s }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }

        .settings-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #fff; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); padding: 20px;
            z-index: 10000; width: 350px; display: none; max-height: 80vh; overflow-y: auto; }
        .settings-panel.active { display: block }
        .settings-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; text-align: center }
        .settings-group { margin-bottom: 15px; padding: 10px; border-radius: 5px; background: #f8f9fa; }
        .settings-label { display: block; margin-bottom: 8px; font-weight: bold; font-size: 14px; color: #333; }
        .settings-input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 5px;
            font-size: 14px; box-sizing: border-box; }
        .settings-buttons { display: flex; justify-content: space-between; margin-top: 20px; padding-top: 15px;
            border-top: 1px solid #eee; }
        .settings-button { padding: 8px 16px; border: none; border-radius: 5px; cursor: pointer;
            font-size: 14px; font-weight: bold; }
        .settings-save { background: #4CAF50; color: white; }
        .settings-cancel { background: #f44336; color: white; }

        .overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5);
            z-index: 9999; display: none }
        .overlay.active { display: block }

        .muye-reader-content { line-height: 1.8; font-size: 16px; }
        .replaced-content { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 10px 0;
            border: 2px solid #4CAF50; }

        .auto-replace-status { text-align: center; margin: 8px 0; padding: 5px; font-size: 12px;
            border-radius: 15px; background: #f0f0f0; color: #666; }
        .auto-replace-status.active { background: #e8f5e9; color: #2e7d32; }
        .auto-replace-status.monitoring { background: #e3f2fd; color: #1565c0; }
        .auto-replace-status.idle { background: #fff3e0; color: #f57c00; }
        .auto-replace-status.stable { background: #e8f5e9; color: #2e7d32; font-weight: bold; }

        .status-badge { position: absolute; top: 10px; right: 10px; background: rgba(76, 175, 80, 0.9);
            color: white; padding: 3px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }

        .control-buttons { display: flex; gap: 5px; margin-top: 8px; }

        .settings-toggle { margin-bottom: 15px; padding: 10px; border-radius: 5px; background: #f8f9fa; }
        .settings-toggle-label { display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 8px; font-weight: bold; font-size: 14px; color: #333; }
        .settings-toggle-switch { position: relative; display: inline-block; width: 50px; height: 26px; }
        .settings-toggle-switch input { opacity: 0; width: 0; height: 0; }
        .settings-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
            background-color: #ccc; transition: .4s; border-radius: 26px; }
        .settings-toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 4px;
            bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .settings-toggle-slider { background-color: #4CAF50; }
        input:checked + .settings-toggle-slider:before { transform: translateX(24px); }
    `);

    // 移除VIP提示框
    function removeVIPPrompt() {
        const vipElement = document.querySelector('.muye-to-fanqie');
        if (vipElement) vipElement.remove();
    }

    // 观察DOM变化，自动移除VIP提示框
    function observeVIPElement() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.addedNodes.length) {
                    removeVIPPrompt();
                }
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 辅助函数
    const utils = {
        showNotification: (message, isSuccess = true) => {
            const notification = document.createElement('div');
            notification.className = 'tamper-notification';
            notification.style.backgroundColor = isSuccess ? '#4CAF50' : '#F44336';
            notification.textContent = message;
            document.body.appendChild(notification);
            setTimeout(() => {
                notification.style.opacity = '0';
                setTimeout(() => notification.remove(), 500);
            }, 3000);
        },

        decodeHtmlEntities: (str) => {
            const entities = {'&#34;':'"','&#39;':"'",'&amp;':'&','&lt;':'<','&gt;':'>'};
            return str.replace(/&#34;|&#39;|&amp;|&lt;|&gt;/g, match => entities[match]);
        },

        sanitizeFilename: (name) => {
            return name.replace(/[\\/*?:"<>|]/g, '').trim();
        },

        formatContent: (content, forText = true) => {
            let formatted = utils.decodeHtmlEntities(content)
                .replace(/<header>[\s\S]*?<\/header>/i, '')
                .replace(/<article>|<\/article>/gi, '')
                .replace(/<footer>[\s\S]*$/i, '')
                .replace(/<p><\/p>/g, '');

            return forText ?
                formatted.replace(/<p[^>]*>/g, '  ')
                         .replace(/<\/p>/g, '\n')
                         .replace(/<br\/?>/g, '\n')
                         .replace(/<[^>]+>/g, '')
                         .trim()
                         .replace(/\n{2,}/g, '\n') :
                formatted.replace(/<p[^>]*>/g, '<p>')
                         .replace(/<br\/?>/g, '<br>')
                         .trim();
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
        },

        getChapterTitle: () => {
            // 优先从特定的h1标签获取章节标题
            const titleElement = document.querySelector('h1.muye-reader-title');
            if (titleElement) {
                const title = titleElement.textContent.trim();
                console.log('从h1.muye-reader-title获取章节标题:', title);
                return title;
            }

            // 备选方案：从其他标题元素获取
            const otherTitleElements = document.querySelectorAll('.chapter-title, .muye-chapter-title, .title');
            for (let element of otherTitleElements) {
                if (element.textContent.trim()) {
                    const title = element.textContent.trim();
                    console.log('从备选元素获取章节标题:', title);
                    return title;
                }
            }

            // 从URL获取章节标题作为最后的备选
            const pathname = window.location.pathname;
            const titleMatch = pathname.match(/\/reader\/\d+\/([^\/]+)/);
            if (titleMatch && titleMatch[1]) {
                const title = decodeURIComponent(titleMatch[1]).replace(/-/g, ' ');
                console.log('从URL获取章节标题:', title);
                return title;
            }

            return '未知章节';
        }
    };

    // 网络请求函数
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
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    };

    // UI管理
    const ui = {
        updateStatusDisplay: (statusKey, extraInfo = '') => {
            if (!uiElements.statusIndicator) return;

            const statusConfig = {
                'disabled': { text: '自动替换已关闭', class: '' },
                'enabled': { text: '自动替换已开启', class: 'active' },
                'checking': { text: '正在检查...', class: 'monitoring' },
                'no_change': { text: '内容无变化', class: 'stable' },
                'stable': { text: '内容稳定 ✓', class: 'stable' },
                'changed': { text: '检测到变化', class: 'active' },
                'replacing': { text: '正在替换...', class: 'monitoring' },
                'replaced': { text: '替换完成', class: 'active' },
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

        createStat: (label, valueClass) => {
            const stat = document.createElement('div');
            stat.className = 'stat-item';
            stat.innerHTML = `
                <div class="stat-label">${label}</div>
                <div class="stat-value ${valueClass}">0</div>
            `;
            return stat;
        },

        updateStats: (total, success, failed) => {
            if (uiElements.totalStat) uiElements.totalStat.textContent = total;
            if (uiElements.successStat) uiElements.successStat.textContent = success;
            if (uiElements.failedStat) uiElements.failedStat.textContent = failed;
        },

        updateProgress: (percentage) => {
            if (uiElements.progressFill) uiElements.progressFill.style.width = `${percentage}%`;
        }
    };

    // 设置管理
    const settings = {
        showSettingsPanel: () => {
            uiElements.settingsPanel.classList.add('active');
            uiElements.overlay.classList.add('active');
            uiElements.apiDomainInput.value = config.apiDomain;
            uiElements.timeoutInput.value = config.timeout / 1000;
            uiElements.concurrentInput.value = config.concurrentRequests;
            uiElements.checkIntervalInput.value = config.checkInterval / 1000;
            if (uiElements.autoReplaceToggle) uiElements.autoReplaceToggle.checked = config.autoReplaceEnabled;
        },

        hideSettingsPanel: () => {
            uiElements.settingsPanel.classList.remove('active');
            uiElements.overlay.classList.remove('active');
        },

        saveSettings: () => {
            let settingsChanged = false;

            // 保存API域名
            const newDomain = uiElements.apiDomainInput.value.trim();
            if (newDomain && newDomain !== config.apiDomain) {
                config.apiDomain = newDomain;
                GM_setValue('apiDomain', newDomain);
                settingsChanged = true;
            }

            // 保存超时时间
            const newTimeout = parseInt(uiElements.timeoutInput.value) * 1000;
            if (!isNaN(newTimeout) && newTimeout >= 5000 && newTimeout <= 60000 && newTimeout !== config.timeout) {
                config.timeout = newTimeout;
                GM_setValue('timeout', newTimeout);
                settingsChanged = true;
            }

            // 保存并发数
            const newConcurrent = parseInt(uiElements.concurrentInput.value);
            if (!isNaN(newConcurrent) && newConcurrent >= 1 && newConcurrent <= 5 && newConcurrent !== config.concurrentRequests) {
                config.concurrentRequests = newConcurrent;
                GM_setValue('concurrentRequests', newConcurrent);
                settingsChanged = true;
            }

            // 保存检查间隔
            const newCheckInterval = parseInt(uiElements.checkIntervalInput.value) * 1000;
            if (!isNaN(newCheckInterval) && newCheckInterval >= 3000 && newCheckInterval <= 30000 && newCheckInterval !== config.checkInterval) {
                config.checkInterval = newCheckInterval;
                GM_setValue('checkInterval', newCheckInterval);
                settingsChanged = true;
                if (config.autoReplaceEnabled && checkTimer) contentChecker.restartChecking();
            }

            // 保存自动替换设置
            const newAutoReplace = uiElements.autoReplaceToggle.checked;
            if (newAutoReplace !== config.autoReplaceEnabled) {
                config.autoReplaceEnabled = newAutoReplace;
                GM_setValue('autoReplaceEnabled', newAutoReplace);
                settingsChanged = true;

                if (config.autoReplaceEnabled) {
                    ui.updateStatusDisplay('enabled');
                    utils.showNotification('自动替换已开启');
                    contentChecker.startChecking();
                    observer.startChapterChangeObserver();
                } else {
                    ui.updateStatusDisplay('disabled');
                    utils.showNotification('自动替换已关闭');
                    contentChecker.stopChecking();
                    observer.stopChapterChangeObserver();
                }
            }

            utils.showNotification(settingsChanged ? '设置已保存' : '未检测到变化');
            settings.hideSettingsPanel();
        }
    };

    // 内容替换功能
    const contentReplacer = {
        // 只从页面地址获取ID
        getChapterId: () => {
            const urlParams = new URLSearchParams(window.location.search);

            // 1. 从URL参数中获取
            const chapterParam = urlParams.get('chapter_id') ||
                               urlParams.get('chapterId') ||
                               urlParams.get('cid') ||
                               urlParams.get('item_id') ||
                               urlParams.get('id');
            if (chapterParam) {
                console.log('从URL参数获取章节ID:', chapterParam);
                return chapterParam;
            }

            // 2. 从路径中获取（/reader/后面的数字）
            const pathMatch = window.location.pathname.match(/\/reader\/(\d+)/);
            if (pathMatch && pathMatch[1]) {
                console.log('从路径获取章节ID:', pathMatch[1]);
                return pathMatch[1];
            }

            // 3. 从完整URL中匹配数字（作为最后的手段）
            const urlMatch = window.location.href.match(/\/(\d+)(?:\?|$)/);
            if (urlMatch && urlMatch[1]) {
                console.log('从URL匹配获取章节ID:', urlMatch[1]);
                return urlMatch[1];
            }

            console.log('未从URL中找到章节ID');
            return null;
        },

        // 检查是否需要进行替换
        checkNeedReplace: async (currentChapterId, forceReplace = false) => {
            if (forceReplace) return true;
            if (!currentChapterId) return false;

            // 章节ID变化时需要替换
            if (currentChapterId !== contentReplaceState.chapterId) {
                console.log('章节ID变化:', contentReplaceState.chapterId, '->', currentChapterId);
                return true;
            }

            // 未替换过需要替换
            if (!contentReplaceState.replaced) return true;

            // 检查内容是否被覆盖
            if (utils.checkContentOverwritten()) {
                console.log('内容被覆盖，需要重新替换');
                return true;
            }

            // 检查内容是否有变化
            const contentContainer = document.querySelector('.muye-reader-content');
            if (contentContainer) {
                const currentContent = contentContainer.innerHTML;
                const currentHash = utils.getContentHash(currentContent);
                if (currentHash !== contentReplaceState.contentHash) {
                    console.log('内容变化，需要重新替换');
                    return true;
                }
            }

            // 检查时间间隔
            const now = Date.now();
            const minCheckInterval = 2000;
            if (now - contentReplaceState.timestamp < minCheckInterval) return false;

            return false;
        },

        // 执行内容替换
        performContentReplace: async (chapterId, isAuto = false) => {
            if (replaceInProgress) return false;
            replaceInProgress = true;

            try {
                const apiUrl = `${config.apiDomain}/content?item_id=${chapterId}`;
                console.log('请求API:', apiUrl);

                const response = await network.requestWithRetry(apiUrl, {
                    headers: { 'Accept': 'application/json' },
                    timeout: config.timeout
                });

                if (!response.responseText.trim()) {
                    throw new Error('API返回空响应');
                }

                const data = JSON.parse(response.responseText);
                if (data.content === undefined || data.content === null) {
                    throw new Error('响应中缺少content字段');
                }

                const formattedContent = utils.formatContent(data.content, false);
                let contentContainer = document.querySelector('.muye-reader-content');

                // 增强的内容容器查找
                if (!contentContainer) {
                    const otherContainers = document.querySelectorAll(
                        '.reader-content, .chapter-content, .content, .muye-content, .book-content'
                    );
                    if (otherContainers.length > 0) {
                        contentContainer = otherContainers[0];
                        console.log('使用替代内容容器:', contentContainer.className);
                    }
                }

                if (contentContainer) {
                    contentContainer.innerHTML = `<div class="replaced-content">
                        <div class="status-badge">已替换</div>
                        ${formattedContent}
                    </div>`;

                    contentReplaceState = {
                        replaced: true,
                        chapterId: chapterId,
                        contentHash: utils.getContentHash(contentContainer.innerHTML),
                        timestamp: Date.now(),
                        stableCount: 0, // 替换成功后重置稳定计数
                        isIdle: false
                    };

                    GM_setValue('lastChapterId', chapterId);
                    GM_setValue('lastReplaceTime', Date.now());

                    console.log('内容替换成功，章节ID:', chapterId);
                    return true;
                } else {
                    throw new Error('未找到内容容器');
                }
            } catch (error) {
                console.error('替换过程详细错误:', error);

                // 特殊错误处理
                if (error.message.includes('API返回空响应')) {
                    utils.showNotification('API返回空数据，可能章节不存在或API不可用', false);
                } else if (error.message.includes('请求超时')) {
                    utils.showNotification('API请求超时，请检查网络连接或调整超时设置', false);
                } else if (error.message.includes('JSON')) {
                    utils.showNotification('API返回格式错误，可能API已更新', false);
                }

                return false;
            } finally {
                replaceInProgress = false;
            }
        },

        // 手动替换内容
        manualReplaceContent: async () => {
            activityManager.recordActivity();

            const chapterId = contentReplacer.getChapterId();
            if (!chapterId) {
                utils.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            ui.updateStatusDisplay('checking', '替换');
            const replaceSuccess = await contentReplacer.performContentReplace(chapterId, false);
            ui.updateStatusDisplay(replaceSuccess ? 'replaced' : 'error');

            if (replaceSuccess) utils.showNotification('内容替换成功！');
        },

        // 重置替换状态
        resetReplaceState: () => {
            contentReplaceState = {
                replaced: false,
                chapterId: null,
                contentHash: null,
                timestamp: 0,
                stableCount: 0,
                isIdle: false
            };
            GM_setValue('lastChapterId', null);
            GM_setValue('lastReplaceTime', 0);

            utils.showNotification('替换状态已重置');
            ui.updateStatusDisplay(config.autoReplaceEnabled ? 'enabled' : 'disabled');

            if (config.autoReplaceEnabled) {
                setTimeout(() => contentChecker.checkAndReplace(false, true), 300);
            }
        }
    };

    // 内容检查器
    const contentChecker = {
        // 检查并替换内容
        checkAndReplace: async (isAuto = true, forceReplace = false, fromObserver = false) => {
            if (!config.autoReplaceEnabled && isAuto) return false;
            if (replaceInProgress || contentReplaceState.isIdle) return false;

            ui.updateStatusDisplay('checking', fromObserver ? '观察者' : '定时');

            try {
                // 获取当前章节ID（只从URL获取）
                const currentChapterId = contentReplacer.getChapterId();
                console.log('检查章节ID:', currentChapterId, '当前状态ID:', contentReplaceState.chapterId);

                if (!currentChapterId) {
                    ui.updateStatusDisplay('error', '未找到ID');
                    // 尝试重新获取ID
                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true, false, fromObserver);
                        }
                    }, 1000);
                    return false;
                }

                const shouldReplace = await contentReplacer.checkNeedReplace(currentChapterId, forceReplace);

                if (shouldReplace) {
                    ui.updateStatusDisplay('changed', currentChapterId);
                    const replaceSuccess = await contentReplacer.performContentReplace(currentChapterId, isAuto);
                    ui.updateStatusDisplay(replaceSuccess ? 'replaced' : 'error');
                    contentReplaceState.stableCount = 0; // 替换成功后重置计数
                    return replaceSuccess;
                } else {
                    // 内容无变化时增加稳定计数，但设置上限
                    contentReplaceState.stableCount++;
                    if (contentReplaceState.stableCount > 10) {
                        contentReplaceState.stableCount = 10; // 设置上限为10
                    }
                    ui.updateStatusDisplay(contentReplaceState.stableCount >= 3 ? 'stable' : 'no_change',
                                      `稳定${contentReplaceState.stableCount}/10`);
                    return false;
                }
            } catch (error) {
                console.error('检查替换错误:', error);
                ui.updateStatusDisplay('error', error.message.substring(0, 10) + '...');
                return false;
            }
        },

        // 定时检查函数
        startChecking: () => {
            if (checkTimer) clearInterval(checkTimer);

            checkTimer = setInterval(() => {
                if (config.autoReplaceEnabled && !replaceInProgress) {
                    contentChecker.checkAndReplace(true);
                }
            }, config.checkInterval);

            // 立即检查一次
            setTimeout(() => {
                if (config.autoReplaceEnabled) {
                    contentChecker.checkAndReplace(true);
                }
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
            if (config.autoReplaceEnabled) {
                contentChecker.startChecking();
            }
        }
    };

    // 活动管理器
    const activityManager = {
        // 记录用户活动
        recordActivity: () => {
            lastActivityTime = Date.now();
            if (contentReplaceState.isIdle) {
                contentReplaceState.isIdle = false;
                contentReplaceState.stableCount = 0;
                ui.updateStatusDisplay('checking', '活动恢复');
            }
        },

        // 检查是否需要进入空闲状态
        checkIdleState: () => {
            const now = Date.now();
            const idleThreshold = config.idleTimeout;

            if (!contentReplaceState.isIdle && now - lastActivityTime > idleThreshold) {
                contentReplaceState.isIdle = true;
                ui.updateStatusDisplay('idle', '5分钟无活动');
            }
        },

        // 观察用户活动
        observeUserActivity: () => {
            ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'].forEach(eventType => {
                document.addEventListener(eventType, activityManager.recordActivity);
            });

            setInterval(activityManager.checkIdleState, 30000);
        }
    };

    // 观察者
    const observer = {
        // 章节变化观察器
        startChapterChangeObserver: () => {
            if (pageInfo.type !== 'reader') return;
            if (chapterChangeObserver) return;

            console.log('启动章节变化观察器');

            chapterChangeObserver = new MutationObserver(async (mutations) => {
                if (!config.autoReplaceEnabled || replaceInProgress || contentReplaceState.isIdle) return;

                let needCheck = false;
                let mutationCount = 0;

                mutations.forEach((mutation) => {
                    // 检查重要节点的变化
                    if (mutation.addedNodes.length || mutation.removedNodes.length) {
                        const contentContainer = document.querySelector('.muye-reader-content');
                        const chapterNavigation = document.querySelector('.chapter-navigation');
                        const vipPrompt = document.querySelector('.muye-to-fanqie');
                        const titleElement = document.querySelector('h1.muye-reader-title');

                        if (contentContainer || chapterNavigation || vipPrompt || titleElement) {
                            needCheck = true;
                        }

                        mutationCount++;
                    }
                });

                if (needCheck && mutationCount > 0) {
                    activityManager.recordActivity();
                    console.log('检测到DOM变化，准备检查章节');

                    // 延迟检查，给页面足够时间更新
                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true, false, true);
                        }
                    }, 800);
                }
            });

            // 观察配置
            chapterChangeObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['data-chapter-id', 'data-item-id', 'data-chapter_id', 'class', 'style']
            });

            // 导航按钮监听
            document.addEventListener('click', (event) => {
                if (!config.autoReplaceEnabled || contentReplaceState.isIdle) return;

                const target = event.target;
                const isNavigationButton = target.closest(
                    '.next-chapter, .prev-chapter, .chapter-btn, .navigation-btn, .page-turn-btn, ' +
                    '.muye-next-chapter, .muye-prev-chapter, .chapter-navigation button, ' +
                    '[data-action="next"], [data-action="prev"], .nav-btn'
                );

                if (isNavigationButton) {
                    activityManager.recordActivity();
                    ui.updateStatusDisplay('checking', '导航点击');

                    // 导航后延迟检查，时间稍长以确保页面完全加载
                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true, true, true);
                        }
                    }, 1200);
                }
            });

            // 监听页面滚动到章节底部的情况
            let lastScrollPosition = 0;
            document.addEventListener('scroll', () => {
                if (!config.autoReplaceEnabled || contentReplaceState.isIdle) return;

                const currentScrollPosition = window.pageYOffset;
                const windowHeight = window.innerHeight;
                const documentHeight = document.documentElement.scrollHeight;

                // 检测是否滚动到页面底部
                if (currentScrollPosition + windowHeight >= documentHeight - 200 &&
                    currentScrollPosition > lastScrollPosition) {

                    activityManager.recordActivity();
                    ui.updateStatusDisplay('checking', '滚动到底部');

                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true, false, true);
                        }
                    }, 800);
                }

                lastScrollPosition = currentScrollPosition;
            });

            // 监听URL变化
            let lastUrl = window.location.href;
            setInterval(() => {
                if (window.location.href !== lastUrl) {
                    lastUrl = window.location.href;
                    console.log('URL变化:', lastUrl);
                    activityManager.recordActivity();
                    ui.updateStatusDisplay('checking', 'URL变化');

                    setTimeout(() => {
                        if (config.autoReplaceEnabled && !replaceInProgress && !contentReplaceState.isIdle) {
                            contentChecker.checkAndReplace(true, true, true);
                        }
                    }, 800);
                }
            }, 500);
        },

        stopChapterChangeObserver: () => {
            if (chapterChangeObserver) {
                chapterChangeObserver.disconnect();
                chapterChangeObserver = null;
                console.log('停止章节变化观察器');
            }
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
            const url = `${config.apiDomain}/content?item_id=${chapterId}`;

            try {
                const response = await network.requestWithRetry(url, {
                    headers: { 'Accept': 'application/json' },
                    timeout: config.timeout
                });

                if (!response.responseText.trim()) throw new Error('空响应');

                const data = JSON.parse(response.responseText);
                if (data.content === undefined || data.content === null) {
                    throw new Error('响应中缺少content字段');
                }

                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: utils.formatContent(data.content, true),
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

            for (let i = 0; i < total; i += config.concurrentRequests) {
                const batch = chapterIds.slice(i, i + config.concurrentRequests);
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

                if (i + config.concurrentRequests < total) {
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

                if (format === 'txt') {
                    let txtContent = bookInfo.infoText + '\n\n';
                    for (let i = 0; i < chapters.length; i++) {
                        txtContent += `${chapters[i].title}\n\n`;
                        txtContent += `${contents[i]}\n\n`;
                    }
                    saveAs(new Blob([txtContent], { type: 'text/plain;charset=utf-8' }), `${bookInfo.title}.txt`);
                } else if (format === 'epub') {
                    const epubBlob = await downloader.generateEPUB(bookInfo, chapters, contents, bookInfo.thumb_url);
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

        // 下载当前章节
        downloadCurrentChapter: async () => {
            activityManager.recordActivity();

            const chapterId = contentReplacer.getChapterId();
            if (!chapterId) {
                utils.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            const chapterTitle = utils.getChapterTitle();
            const sanitizedTitle = utils.sanitizeFilename(chapterTitle);

            utils.showNotification('开始下载当前章节...');

            try {
                const result = await downloader.downloadChapter(chapterId, 0, chapterTitle);

                if (result.success) {
                    // 构建章节内容
                    let chapterContent = `章节：${chapterTitle}\n\n`;
                    chapterContent += result.content;
                    chapterContent += '\n\n---\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。若因使用本工具导致任何版权纠纷或法律问题，使用者需自行承担全部责任。';

                    // 保存为TXT文件
                    saveAs(new Blob([chapterContent], { type: 'text/plain;charset=utf-8' }), `${sanitizedTitle}.txt`);

                    utils.showNotification('章节下载成功！');
                } else {
                    utils.showNotification(`下载失败: ${result.content}`, false);
                }
            } catch (error) {
                console.error('章节下载错误:', error);
                utils.showNotification('下载失败: ' + error.message, false);
            }
        }
    };

    // UI创建函数
    function createUI() {
        const container = document.createElement('div');
        container.className = 'tamper-container';

        if (pageInfo.type === 'page') {
            // Page页面：下载TXT → 下载EPUB → 设置（调整顺序）
            container.appendChild(ui.createButton('下载TXT', 'txt', () => downloader.startDownload('txt')));
            container.appendChild(ui.createButton('下载EPUB', 'epub', () => downloader.startDownload('epub')));

            // 将设置按钮放在EPUB按钮下面
            container.appendChild(ui.createButton('设置', 'settings', settings.showSettingsPanel));

            const progressContainer = document.createElement('div');
            progressContainer.style.marginTop = '10px';
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
            statsContainer.appendChild(ui.createStat('总章节', 'total-value'));
            statsContainer.appendChild(ui.createStat('成功', 'success-value'));
            statsContainer.appendChild(ui.createStat('失败', 'failed-value'));
            container.appendChild(statsContainer);
        } else if (pageInfo.type === 'reader') {
            // Reader页面：下载本章 → 设置 → 状态显示 → 控制按钮
            container.appendChild(ui.createButton('下载本章', 'download-chapter', downloader.downloadCurrentChapter));

            // 设置按钮放在下载本章按钮下面
            container.appendChild(ui.createButton('设置', 'settings', settings.showSettingsPanel));

            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'auto-replace-status';
            ui.updateStatusDisplay(config.autoReplaceEnabled ? 'enabled' : 'disabled');
            container.appendChild(statusIndicator);

            const controlButtons = document.createElement('div');
            controlButtons.className = 'control-buttons';
            controlButtons.appendChild(ui.createButton('替换', 'replace', contentReplacer.manualReplaceContent, true));
            controlButtons.appendChild(ui.createButton('重置', 'reset', contentReplacer.resetReplaceState, true));
            container.appendChild(controlButtons);
        }

        document.body.appendChild(container);

        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.addEventListener('click', settings.hideSettingsPanel);

        const settingsPanel = document.createElement('div');
        settingsPanel.className = 'settings-panel';
        settingsPanel.innerHTML = `
            <div class="settings-title">番茄小说增强工具设置</div>
            <div class="settings-toggle">
                <div class="settings-toggle-label">
                    自动替换内容
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="autoReplaceToggle" ${config.autoReplaceEnabled ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div class="settings-group">
                <label class="settings-label">API域名</label>
                <input type="text" class="settings-input" id="apiDomain" placeholder="https://api-x.shrtxs.cn/fanqie" value="${config.apiDomain}">
            </div>
            <div class="settings-group">
                <label class="settings-label">超时时间(秒)</label>
                <input type="number" class="settings-input" id="timeout" value="${config.timeout / 1000}" min="5" max="60">
            </div>
            <div class="settings-group">
                <label class="settings-label">并发数</label>
                <input type="number" class="settings-input" id="concurrent" value="${config.concurrentRequests}" min="1" max="5">
            </div>
            <div class="settings-group">
                <label class="settings-label">检查间隔(秒)</label>
                <input type="number" class="settings-input" id="checkInterval" value="${config.checkInterval / 1000}" min="3" max="30">
            </div>
            <div class="settings-buttons">
                <button class="settings-button settings-save">保存设置</button>
                <button class="settings-button settings-cancel">取消</button>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(settingsPanel);

        uiElements = {
            container,
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
            saveBtn: settingsPanel.querySelector('.settings-save'),
            cancelBtn: settingsPanel.querySelector('.settings-cancel'),
            statusIndicator: document.querySelector('.auto-replace-status')
        };

        uiElements.saveBtn.addEventListener('click', settings.saveSettings);
        uiElements.cancelBtn.addEventListener('click', settings.hideSettingsPanel);
    }

    // 初始化函数
    async function init() {
        console.log('番茄小说增强工具初始化...');

        removeVIPPrompt();
        observeVIPElement();
        createUI();

        if (config.lastChapterId) {
            contentReplaceState.replaced = utils.isContentReplaced();
            console.log('加载保存的状态:', contentReplaceState);
        }

        activityManager.observeUserActivity();

        if (pageInfo.type === 'reader' && config.autoReplaceEnabled) {
            contentChecker.startChecking();
            observer.startChapterChangeObserver();
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
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 监听页面刷新或导航
    window.addEventListener('beforeunload', () => {
        contentChecker.stopChecking();
        observer.stopChapterChangeObserver();
    });

})();
