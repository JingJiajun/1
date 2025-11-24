// ==UserScript==
// @name          番茄小说增强工具
// @author        cctv
// @version       2025.11.25
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

    const C = Object.freeze({
        DEFAULT_TIMEOUT: 20000,
        DEFAULT_CHECK_INTERVAL: 5000,
        DEFAULT_AUTO_HIDE_DELAY: 3000,
        DEFAULT_CONCURRENT_REQUESTS: 2,
        MAX_RETRIES: 2,
        IDLE_TIMEOUT: 300000,
        URL_CHECK_INTERVAL: 300,
        CONTENT_CONTAINER_SELECTORS: [
            '.muye-reader-content', '.reader-content', '.chapter-content', '.content',
            '.muye-content', '.book-content', '.article-content', '.text-content',
            '#chapter-content', '#reader-content', '#content'
        ],
        NOTIFICATION_DURATION: 2500,
        DEBOUNCE_DELAY: 200,
        THROTTLE_DELAY: 1000,
        WAIT_FOR_CONTENT_TIMEOUT: 15000,
        CHAPTER_DOWNLOAD_DELAY: 800,
        CHAPTER_ID_PLACEHOLDER: '{chapterId}',
        DEFAULT_RETRY_COUNT: 2,
        DEFAULT_RETRY_DELAY: 1000,
        BATCH_RETRY_DELAY: 2000
    });

    const U = {
        decodeHtml: str => {
            const entities = { '&#34;': '"', '&#39;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
            return str.replace(/&#34;|&#39;|&amp;|&lt;|&gt;/g, m => entities[m] || m);
        },

        sanitizeFilename: name => name.replace(/[\\/*?:"<>|]/g, '').trim(),

        extractContent: (content, isPlainText = false, apiHasTitle = false, chapterId = null, fallbackTitle = null) => {
            let title = '';
            let extractedContent = content;

            try {
                if (isPlainText) {
                    if (content) {
                        const lines = content.split('\n');

                        if (apiHasTitle) {
                            let firstNonEmptyLine = '';
                            for (let line of lines) {
                                line = line.trim();
                                if (line) {
                                    firstNonEmptyLine = line;
                                    break;
                                }
                            }

                            if (firstNonEmptyLine.match(/^第.*章.*$/)) {
                                title = firstNonEmptyLine;
                                extractedContent = lines.slice(1).join('\n').trim();
                            } else if (firstNonEmptyLine.length > 0 && firstNonEmptyLine.length < 100) {
                                title = firstNonEmptyLine;
                                extractedContent = lines.slice(1).join('\n').trim();
                            }
                        } else {
                            extractedContent = content.trim();
                        }
                    }

                    if (!title) {
                        title = fallbackTitle || (chapterId ? `第${chapterId}章` : U.getTitleFromUrl() || '未知章节');
                    }
                } else {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;

                    if (apiHasTitle) {
                        const header = tempDiv.querySelector('header');
                        if (header && header.textContent.trim()) {
                            title = header.querySelector('.tt-title')?.textContent.trim() || header.textContent.trim();
                            header.remove();
                        }

                        if (!title) {
                            const article = tempDiv.querySelector('article');
                            if (article) {
                                const articleTempDiv = document.createElement('div');
                                articleTempDiv.innerHTML = article.innerHTML;

                                const possibleTitles = articleTempDiv.querySelectorAll('h1, h2, h3, .title, .chapter-title, .main-title');
                                for (const possibleTitle of possibleTitles) {
                                    const titleText = possibleTitle.textContent.trim();
                                    if (titleText && titleText.length > 3 && titleText.length < 100) {
                                        title = titleText;
                                        possibleTitle.remove();
                                        break;
                                    }
                                }

                                if (title) {
                                    article.innerHTML = articleTempDiv.innerHTML;
                                }
                            }
                        }
                    }

                    if (!title) {
                        title = fallbackTitle || (chapterId ? `第${chapterId}章` : U.getTitleFromUrl() || '未知章节');
                    }

                    const article = tempDiv.querySelector('article');
                    extractedContent = article ? article.innerHTML : tempDiv.innerHTML;
                }
            } catch (e) {
                console.error('提取内容失败:', e);
                title = fallbackTitle || (chapterId ? `第${chapterId}章` : U.getTitleFromUrl() || '未知章节');
            }

            return { title, content: extractedContent };
        },

        getTitleFromUrl: () => {
            try {
                const pathMatch = window.location.pathname.match(/\/reader\/\d+\/([^\/]+)/);
                if (pathMatch) return decodeURIComponent(pathMatch[1]).replace(/-/g, ' ');

                const urlParams = new URLSearchParams(window.location.search);
                const titleParam = urlParams.get('title') || urlParams.get('chapter_title');
                if (titleParam) return decodeURIComponent(titleParam);

                const chapterId = U.getChapterIdFromUrl();
                if (chapterId) return `第${chapterId}章`;
            } catch (e) {
                console.error('从URL获取标题失败:', e);
            }
            return null;
        },

        getChapterIdFromUrl: () => {
            try {
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
            } catch (e) {
                console.error('从URL获取章节ID失败:', e);
            }
            return null;
        },

        formatContent: (content, forText = true, isPlainText = false) => {
            let formatted = content;

            if (!isPlainText) {
                formatted = U.decodeHtml(content)
                    .replace(/<header>[\s\S]*?<\/header>/i, '')
                    .replace(/<article>|<\/article>/gi, '')
                    .replace(/<footer>[\s\S]*$/i, '')
                    .replace(/<p><\/p>/g, '');
            }

            if (forText) {
                if (isPlainText) {
                    formatted = content
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line)
                        .map(line => '  ' + line)
                        .join('\n');
                } else {
                    formatted = formatted
                        .replace(/<p[^>]*>/g, '  ')
                        .replace(/<\/p>/g, '\n')
                        .replace(/<br\/?>/g, '\n')
                        .replace(/<[^>]+>/g, '')
                        .trim()
                        .replace(/\n{2,}/g, '\n\n');

                    if (!formatted.startsWith('  ') && formatted.length > 0) {
                        const firstNewline = formatted.indexOf('\n');
                        formatted = firstNewline === -1
                            ? '  ' + formatted
                            : '  ' + formatted.substring(0, firstNewline) + formatted.substring(firstNewline);
                    }
                }
            } else {
                if (!isPlainText) {
                    formatted = formatted
                        .replace(/<p[^>]*>/g, '<p>')
                        .replace(/<br\/?>/g, '<br>')
                        .trim();
                } else {
                    formatted = formatted
                        .split('\n')
                        .map(line => line.trim() ? `<p>${line}</p>` : '')
                        .filter(line => line)
                        .join('\n');
                }
            }

            return formatted;
        },

        findContentContainer: () => {
            for (const selector of C.CONTENT_CONTAINER_SELECTORS) {
                const container = document.querySelector(selector);
                if (container) return container;
            }

            const containers = document.querySelectorAll('div');
            let bestContainer = null;
            let maxTextLength = 0;

            containers.forEach(container => {
                const rect = container.getBoundingClientRect();
                if (rect.width < 200 || rect.height < 100) return;

                const className = container.className.toLowerCase();
                if (className.includes('nav') || className.includes('ad') ||
                    className.includes('header') || className.includes('footer') ||
                    className.includes('side') || className.includes('bar')) {
                    return;
                }

                const textLength = container.textContent.length;
                if (textLength > maxTextLength && textLength > 500) {
                    maxTextLength = textLength;
                    bestContainer = container;
                }
            });

            return bestContainer;
        },

        waitForContent: (timeout = C.WAIT_FOR_CONTENT_TIMEOUT) => {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                const check = () => {
                    const container = U.findContentContainer();
                    if (container) {
                        resolve(container);
                        return;
                    }
                    if (Date.now() - startTime > timeout) {
                        reject(new Error('超时未找到内容容器'));
                        return;
                    }
                    setTimeout(check, 200);
                };
                check();
            });
        },

        debounce: (func, wait = C.DEBOUNCE_DELAY) => {
            let timeout;
            return function(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        },

        throttle: (func, limit = C.THROTTLE_DELAY) => {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        },

        exponentialBackoff: (attempt, baseDelay = C.DEFAULT_RETRY_DELAY) => {
            return baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        },

        retryAsync: async (asyncFunc, retries = C.DEFAULT_RETRY_COUNT, baseDelay = C.DEFAULT_RETRY_DELAY) => {
            let attempt = 0;
            while (true) {
                try {
                    return await asyncFunc(attempt);
                } catch (error) {
                    attempt++;
                    if (attempt > retries) throw error;
                    const delay = U.exponentialBackoff(attempt, baseDelay);
                    console.log(`第${attempt}次重试失败，${delay}ms后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    };

    const Config = {
        getApiConfigs: () => {
            const configs = GM_getValue('apiConfigs', []);
            return configs.length > 0 ? configs : [Config.getDefaultApi()];
        },

        getDefaultApi: () => ({
            name: '默认API',
            url: '',
            format: 'content_in_data',
            timeout: C.DEFAULT_TIMEOUT,
            concurrentRequests: C.DEFAULT_CONCURRENT_REQUESTS,
            isPlainText: true,
            hasTitle: false
        }),

        getCurrentApiIndex: () => GM_getValue('currentApiIndex', 0),

        setCurrentApiIndex: index => GM_setValue('currentApiIndex', index),

        saveApiConfigs: configs => GM_setValue('apiConfigs', configs),

        addApiConfig: config => {
            const configs = Config.getApiConfigs();
            configs.push(config);
            Config.saveApiConfigs(configs);
            return configs.length - 1;
        },

        updateApiConfig: (index, config) => {
            const configs = Config.getApiConfigs();
            if (index >= 0 && index < configs.length) {
                configs[index] = { ...configs[index], ...config };
                Config.saveApiConfigs(configs);
                return true;
            }
            return false;
        },

        deleteApiConfig: index => {
            const configs = Config.getApiConfigs();
            if (index >= 0 && index < configs.length && configs.length > 1) {
                configs.splice(index, 1);
                Config.saveApiConfigs(configs);
                const currentIndex = Config.getCurrentApiIndex();
                if (currentIndex >= index) Config.setCurrentApiIndex(Math.max(0, currentIndex - 1));
                return true;
            }
            return false;
        },

        getCurrentApi: () => {
            const configs = Config.getApiConfigs();
            const index = Config.getCurrentApiIndex();
            return configs[Math.min(index, configs.length - 1)];
        },

        getGlobalConfig: () => {
            const currentApi = Config.getCurrentApi();
            return {
                apiUrl: currentApi.url,
                apiFormat: currentApi.format,
                apiIsPlainText: currentApi.isPlainText !== undefined ? currentApi.isPlainText : true,
                apiHasTitle: currentApi.hasTitle !== undefined ? currentApi.hasTitle : false,
                concurrentRequests: currentApi.concurrentRequests,
                timeout: currentApi.timeout,

                autoReplaceEnabled: GM_getValue('autoReplaceEnabled', false),
                checkInterval: GM_getValue('checkInterval', C.DEFAULT_CHECK_INTERVAL),
                panelPosition: GM_getValue('panelPosition', 'right'),
                autoHideEnabled: GM_getValue('autoHideEnabled', true),
                autoHideDelay: GM_getValue('autoHideDelay', C.DEFAULT_AUTO_HIDE_DELAY),

                retryCount: GM_getValue('retryCount', C.DEFAULT_RETRY_COUNT),
                retryDelay: GM_getValue('retryDelay', C.DEFAULT_RETRY_DELAY),
                autoRetryEnabled: GM_getValue('autoRetryEnabled', true)
            };
        },

        saveGlobalConfig: config => {
            GM_setValue('autoReplaceEnabled', config.autoReplaceEnabled);
            GM_setValue('checkInterval', config.checkInterval);
            GM_setValue('panelPosition', config.panelPosition);
            GM_setValue('autoHideEnabled', config.autoHideEnabled);
            GM_setValue('autoHideDelay', config.autoHideDelay);

            GM_setValue('retryCount', config.retryCount);
            GM_setValue('retryDelay', config.retryDelay);
            GM_setValue('autoRetryEnabled', config.autoRetryEnabled);
        }
    };

    const Network = {
        request: (url, options = {}) => {
            return new Promise((resolve, reject) => {
                const timeout = options.timeout || C.DEFAULT_TIMEOUT;
                const timeoutTimer = setTimeout(
                    () => reject(new Error(`请求超时 (${timeout}ms)`)),
                    timeout
                );

                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                    },
                    responseType: options.responseType || 'text',
                    onload: response => {
                        clearTimeout(timeoutTimer);
                        resolve(response);
                    },
                    onerror: error => {
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

        requestWithRetry: async (url, options = {}, retries = C.DEFAULT_RETRY_COUNT) => {
            for (let i = 0; i <= retries; i++) {
                try {
                    return await Network.request(url, options);
                } catch (error) {
                    if (i === retries) throw error;
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    };

    class FanqieEnhancer {
        constructor() {
            this.state = {
                config: Config.getGlobalConfig(),
                pageInfo: this.getPageInfo(),
                bookInfo: null,
                chapters: null,
                isDownloading: false,
                replaceInProgress: false,
                lastActivityTime: Date.now(),
                contentReplaceState: {
                    replaced: false,
                    chapterId: GM_getValue('lastChapterId', null),
                    chapterTitle: GM_getValue('lastChapterTitle', null),
                    contentHash: null,
                    timestamp: GM_getValue('lastReplaceTime', 0),
                    stableCount: 0,
                    isIdle: false
                },
                uiElements: {},
                timers: {},
                currentEditingApiIndex: -1,
                downloadStats: { total: 0, success: 0, failed: 0, retried: 0, retriedSuccess: 0 },
                downloadResults: null
            };

            this.init();
        }

        async init() {
            console.log('番茄小说增强工具初始化');

            if (!this.state.pageInfo) {
                console.log('当前页面不支持');
                return;
            }

            this.removeVIPPrompt();
            this.createCSS();
            await this.createUI();
            this.setupEventListeners();
            this.startActivityMonitoring();

            // 更新API选择按钮显示
            this.updateApiSelectButton();

            if (this.state.pageInfo.type === 'reader') {
                this.startUrlObserver();
                setTimeout(() => this.initReaderPage(), 800);
            } else if (this.state.pageInfo.type === 'page') {
                await this.initPagePage();
            }
        }

        getPageInfo() {
            const pathname = window.location.pathname;
            const pageMatch = pathname.match(/^\/page\/(\d+)$/);
            const readerMatch = pathname.match(/^\/reader\/(\d+)/);

            if (pageMatch) return { type: 'page', bookId: pageMatch[1] };
            if (readerMatch) return { type: 'reader', bookId: readerMatch[1] };

            if (window.location.hostname === 'changdunovel.com') {
                const match = window.location.href.match(/book_id=(\d{19})/);
                if (match) return { type: 'page', bookId: match[1] };
            }

            return null;
        }

        removeVIPPrompt() {
            const remove = () => {
                const vipElement = document.querySelector('.muye-to-fanqie');
                if (vipElement) vipElement.remove();
            };

            const observer = new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    if (mutation.addedNodes.length) remove();
                });
            });

            remove();
            observer.observe(document.body, { childList: true, subtree: true });
        }

        createCSS() {
            const styles = `
                :root {
                    --primary: #4CAF50;
                    --secondary: #2196F3;
                    --warning: #FF9800;
                    --danger: #F44336;
                    --purple: #9C27B0;
                    --brown: #795548;
                    --orange: #FF5722;
                    --gray: #607D8B;
                    --panel-bg: #fff;
                    --panel-border: 1px solid #e8e8e8;
                    --panel-radius: 8px;
                    --panel-shadow: 0 2px 8px rgba(0,0,0,0.1);
                    --panel-padding: 10px;
                    --button-radius: 4px;
                    --button-padding: 6px 10px;
                    --button-font-size: 11px;
                    --text-sm: 10px;
                    --text-xs: 9px;
                }

                .tamper-container, .settings-panel, .api-config-section, .settings-group, .retry-settings, .api-edit-form {
                    background: var(--panel-bg);
                    border-radius: var(--panel-radius);
                    box-shadow: var(--panel-shadow);
                    padding: var(--panel-padding);
                    border: var(--panel-border);
                }

                .tamper-container {
                    position: fixed;
                    top: 20px;
                    width: 160px;
                    font-size: 12px;
                    transition: all 0.3s ease;
                    z-index: 9999;
                }
                .tamper-container.right {
                    right: 0;
                    border-top-right-radius: 0;
                    border-bottom-right-radius: 0;
                }
                .tamper-container.left {
                    left: 0;
                    border-top-left-radius: 0;
                    border-bottom-left-radius: 0;
                }
                .tamper-container.hidden.right { transform: translateX(140px); opacity: 0.9; }
                .tamper-container.hidden.left { transform: translateX(-140px); opacity: 0.9; }
                .tamper-container:hover { transform: translateX(0) !important; opacity: 1 !important; }

                .tamper-button, .settings-button, .api-config-add, .api-edit-save, .api-edit-cancel {
                    border: none;
                    border-radius: var(--button-radius);
                    padding: var(--button-padding);
                    margin: 3px 0;
                    cursor: pointer;
                    font-size: var(--button-font-size);
                    transition: background-color 0.2s;
                }
                .tamper-button { width: 100%; text-align: center; }
                .tamper-button.txt { background: var(--primary); color: #fff; }
                .tamper-button.epub { background: var(--secondary); color: #fff; }
                .tamper-button.download-chapter { background: var(--warning); color: #fff; }
                .tamper-button.settings { background: var(--purple); color: #fff; }
                .tamper-button.position { background: var(--brown); color: #fff; font-size: var(--text-sm); }
                .tamper-button.api-select {
                    background: var(--orange);
                    color: #fff;
                    font-size: var(--text-sm);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .tamper-button.api-switch { background: var(--gray); color: #fff; font-size: var(--text-sm); width: 30px; }
                .tamper-button.manual-hide-button {
                    background: var(--danger);
                    color: white;
                    font-size: var(--text-sm);
                    padding: 4px;
                    margin-bottom: 8px;
                }

                .show-button {
                    position: fixed;
                    top: 20px;
                    width: 30px;
                    height: 60px;
                    background: var(--primary);
                    color: white;
                    border: none;
                    border-radius: 5px 0 0 5px;
                    cursor: pointer;
                    font-size: 12px;
                    writing-mode: vertical-rl;
                    z-index: 10000;
                    display: none;
                }
                .show-button.right { right: 0; }
                .show-button.left { left: 0; border-radius: 0 5px 5px 0; }

                .stats-container {
                    display: flex;
                    justify-content: space-between;
                    margin-top: 8px;
                    font-size: var(--text-sm);
                }
                .stat-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    flex: 1;
                }
                .stat-label {
                    margin-bottom: 2px;
                    color: #666;
                    font-size: var(--text-xs);
                }
                .stat-value {
                    font-weight: bold;
                    font-size: 12px;
                }
                .success-value { color: var(--primary); }
                .failed-value { color: var(--danger); }
                .retry-value { color: var(--warning); }

                .progress-bar {
                    width: 100%;
                    height: 6px;
                    background-color: #f0f0f0;
                    border-radius: 3px;
                    margin-top: 6px;
                    overflow: hidden;
                }
                .progress-fill {
                    height: 100%;
                    background: var(--primary);
                    transition: width 0.3s ease;
                }

                .tamper-notification {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    color: white;
                    padding: 15px;
                    border-radius: var(--panel-radius);
                    box-shadow: var(--panel-shadow);
                    z-index: 9999;
                    font-size: 14px;
                    transition: all 0.3s ease;
                }

                .settings-panel {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 90%;
                    max-width: 400px;
                    max-height: 80vh;
                    overflow-y: auto;
                    display: none;
                    z-index: 10000;
                }
                .settings-panel.active { display: block; }

                .settings-title {
                    font-size: 16px;
                    font-weight: bold;
                    margin-bottom: 12px;
                    text-align: center;
                }

                .settings-label, .retry-setting-label, .api-edit-label {
                    display: block;
                    margin-bottom: 6px;
                    font-weight: bold;
                    font-size: 13px;
                }

                .settings-input, .retry-setting-input, .api-edit-input, .api-edit-select {
                    width: 100%;
                    padding: 8px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 13px;
                    margin-bottom: 8px;
                }

                .settings-buttons, .control-group, .api-config-header, .api-edit-buttons {
                    display: flex;
                    justify-content: space-between;
                    margin-top: 15px;
                }
                .settings-save, .api-config-add, .api-edit-save {
                    background: var(--primary);
                    color: white;
                }
                .settings-cancel, .api-edit-cancel {
                    background: var(--danger);
                    color: white;
                }

                .overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 9999;
                    display: none;
                }
                .overlay.active { display: block; }

                .auto-replace-status {
                    text-align: center;
                    margin: 6px 0;
                    padding: 4px;
                    font-size: var(--text-sm);
                    border-radius: 4px;
                    background: #f0f0f0;
                    color: #666;
                }
                .auto-replace-status.active, .auto-replace-status.stable {
                    background: #e8f5e9;
                    color: #2e7d32;
                }
                .auto-replace-status.monitoring {
                    background: #e3f2fd;
                    color: #1565c0;
                }
                .auto-replace-status.idle, .auto-replace-status.error {
                    background: #fff3e0;
                    color: #f57c00;
                }
                .auto-replace-status.stable { font-weight: bold; }

                .settings-toggle-switch {
                    position: relative;
                    display: inline-block;
                    width: 40px;
                    height: 20px;
                }
                .settings-toggle-switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                .settings-toggle-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #ccc;
                    transition: .4s;
                    border-radius: 20px;
                }
                .settings-toggle-slider:before {
                    position: absolute;
                    content: "";
                    height: 14px;
                    width: 14px;
                    left: 3px;
                    bottom: 3px;
                    background-color: white;
                    transition: .4s;
                    border-radius: 50%;
                }
                input:checked + .settings-toggle-slider { background-color: var(--primary); }
                input:checked + .settings-toggle-slider:before { transform: translateX(20px); }

                .chapter-title-container {
                    text-align: center;
                    margin: 12px 0;
                    padding: 10px;
                }
                .chapter-title-container h1 {
                    margin: 0;
                    font-size: 18px;
                    color: #333;
                }

                .api-selection, .api-format-indicator, .api-text-mode-indicator, .api-title-mode-indicator {
                    display: none;
                }

                .api-config-title {
                    font-size: 14px;
                    font-weight: bold;
                }
                .api-config-list {
                    max-height: 180px;
                    overflow-y: auto;
                    border: 1px solid #eee;
                    border-radius: var(--panel-radius);
                    margin: 8px 0;
                }
                .api-config-item {
                    padding: 8px;
                    border-bottom: 1px solid #eee;
                    cursor: pointer;
                }
                .api-config-item:last-child { border-bottom: none; }
                .api-config-item:hover { background: #f8f9fa; }
                .api-config-item.active {
                    background: #e8f5e9;
                    border-left: 2px solid var(--primary);
                }
                .api-config-name {
                    font-weight: bold;
                    font-size: 12px;
                }
                .api-config-actions {
                    display: flex;
                    gap: 4px;
                }
                .api-config-edit, .api-config-delete {
                    background: none;
                    border: 1px solid #ddd;
                    padding: 2px 6px;
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: var(--text-sm);
                }
                .api-config-edit {
                    color: var(--secondary);
                    border-color: var(--secondary);
                }
                .api-config-delete {
                    color: var(--danger);
                    border-color: var(--danger);
                }
                .api-config-details {
                    margin-top: 4px;
                    font-size: var(--text-sm);
                    color: #666;
                }
                .api-config-text-mode {
                    font-size: 10px;
                    color: #888;
                    font-style: italic;
                    margin-top: 2px;
                }
                .api-config-title-mode {
                    font-size: 10px;
                    color: #888;
                    font-style: italic;
                    margin-top: 2px;
                }

                .api-edit-form {
                    display: none;
                    margin-top: 10px;
                }
                .api-url-hint {
                    font-size: var(--text-sm);
                    color: #666;
                    margin-top: 4px;
                    font-style: italic;
                }
                .api-text-mode-toggle, .api-title-mode-toggle {
                    display: flex;
                    align-items: center;
                    margin: 8px 0;
                }
                .api-text-mode-label, .api-title-mode-label {
                    margin-right: 10px;
                    font-size: 13px;
                }
            `;

            GM_addStyle(styles);
        }

        async createUI() {
            const mainPanel = document.createElement('div');
            mainPanel.className = `tamper-container ${this.state.config.panelPosition}`;
            document.body.appendChild(mainPanel);
            this.state.uiElements.container = mainPanel;

            // 手动隐藏按钮 - 放在面板顶部
            const manualHideBtn = this.createButton('隐藏', 'manual-hide-button', () => this.manualHidePanel());
            mainPanel.appendChild(manualHideBtn);

            // API切换按钮组
            const apiSwitchGroup = document.createElement('div');
            apiSwitchGroup.className = 'control-group';
            const prevBtn = this.createButton('<', 'api-switch', () => this.switchToPrevApi());

            // 获取当前API名称
            const currentApi = Config.getCurrentApi();
            const apiName = currentApi.name || 'API';
            const apiSelectBtn = this.createButton(apiName, 'api-select', () => this.showSettingsPanel());

            const nextBtn = this.createButton('>', 'api-switch', () => this.switchToNextApi());
            apiSwitchGroup.appendChild(prevBtn);
            apiSwitchGroup.appendChild(apiSelectBtn);
            apiSwitchGroup.appendChild(nextBtn);
            mainPanel.appendChild(apiSwitchGroup);
            this.state.uiElements.apiSelectButton = apiSelectBtn;

            // 控制按钮组
            const controlGroup = document.createElement('div');
            controlGroup.className = 'control-group';
            const positionBtn = this.createButton('切换位置', 'position', () => this.togglePanelPosition());
            controlGroup.appendChild(positionBtn);
            mainPanel.appendChild(controlGroup);

            if (this.state.pageInfo.type === 'page') {
                this.createPageButtons(mainPanel);
            } else if (this.state.pageInfo.type === 'reader') {
                this.createReaderButtons(mainPanel);
            }

            const showButton = document.createElement('button');
            showButton.className = `show-button ${this.state.config.panelPosition}`;
            showButton.textContent = '工具';
            showButton.addEventListener('click', () => this.showPanel());
            document.body.appendChild(showButton);
            this.state.uiElements.showButton = showButton;

            const overlay = document.createElement('div');
            overlay.className = 'overlay';
            overlay.addEventListener('click', () => this.hideSettingsPanel());
            document.body.appendChild(overlay);
            this.state.uiElements.overlay = overlay;

            const settingsPanel = this.createSettingsPanel();
            document.body.appendChild(settingsPanel);
            this.state.uiElements.settingsPanel = settingsPanel;
        }

        createButton(text, className, onClick) {
            const btn = document.createElement('button');
            btn.className = `tamper-button ${className}`;
            btn.textContent = text;
            btn.addEventListener('click', onClick);
            return btn;
        }

        createPageButtons(panel) {
            panel.appendChild(this.createButton('下载TXT', 'txt', () => this.startDownload('txt')));
            panel.appendChild(this.createButton('下载EPUB', 'epub', () => this.startDownload('epub')));
            panel.appendChild(this.createButton('设置', 'settings', () => this.showSettingsPanel()));

            const progressContainer = document.createElement('div');
            progressContainer.style.marginTop = '8px';
            progressContainer.style.display = 'none';
            const progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            const progressFill = document.createElement('div');
            progressFill.className = 'progress-fill';
            progressBar.appendChild(progressFill);
            progressContainer.appendChild(progressBar);
            panel.appendChild(progressContainer);

            const statsContainer = document.createElement('div');
            statsContainer.className = 'stats-container';
            statsContainer.innerHTML = `
                <div class="stat-item"><div class="stat-label">总章节</div><div class="stat-value total-value">0</div></div>
                <div class="stat-item"><div class="stat-label">成功</div><div class="stat-value success-value">0</div></div>
                <div class="stat-item"><div class="stat-label">失败</div><div class="stat-value failed-value">0</div></div>
                <div class="stat-item"><div class="stat-label">重试</div><div class="stat-value retry-value">0</div></div>
            `;
            panel.appendChild(statsContainer);

            this.state.uiElements.progressContainer = progressContainer;
            this.state.uiElements.progressFill = progressFill;
            this.state.uiElements.totalStat = statsContainer.querySelector('.total-value');
            this.state.uiElements.successStat = statsContainer.querySelector('.success-value');
            this.state.uiElements.failedStat = statsContainer.querySelector('.failed-value');
            this.state.uiElements.retryStat = statsContainer.querySelector('.retry-value');
        }

        createReaderButtons(panel) {
            panel.appendChild(this.createButton('下载本章', 'download-chapter', () => this.downloadCurrentChapter()));
            panel.appendChild(this.createButton('设置', 'settings', () => this.showSettingsPanel()));

            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'auto-replace-status';
            this.updateStatusDisplay(statusIndicator, this.state.config.autoReplaceEnabled ? 'enabled' : 'disabled');
            panel.appendChild(statusIndicator);
            this.state.uiElements.statusIndicator = statusIndicator;

            const controlButtons = document.createElement('div');
            controlButtons.className = 'control-buttons';
            controlButtons.appendChild(this.createButton('处理', 'replace', () => this.manualReplaceContent()));
            controlButtons.appendChild(this.createButton('重置', 'reset', () => this.resetReplaceState()));
            panel.appendChild(controlButtons);
        }

        createSettingsPanel() {
            const panel = document.createElement('div');
            panel.className = 'settings-panel';
            panel.innerHTML = `
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

                <div class="retry-settings">
                    <div class="retry-settings-title">下载重试设置</div>
                    <div class="settings-toggle">
                        <div class="settings-toggle-label">
                            自动重试失败章节
                            <label class="settings-toggle-switch">
                                <input type="checkbox" id="autoRetryToggle">
                                <span class="settings-toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="retry-setting-item">
                        <label class="retry-setting-label">重试次数</label>
                        <input type="number" class="retry-setting-input" id="retryCountInput" min="0" max="10" value="2">
                        <div class="retry-setting-hint">控制单个章节和批量重试的最大次数</div>
                    </div>
                    <div class="retry-setting-item">
                        <label class="retry-setting-label">重试基础延迟(秒)</label>
                        <input type="number" class="retry-setting-input" id="retryDelayInput" min="0.5" max="10" step="0.5" value="1">
                    </div>
                </div>

                <div class="api-config-section">
                    <div class="api-config-header">
                        <div class="api-config-title">API配置管理</div>
                        <button class="api-config-add" id="addApiConfig">添加API</button>
                    </div>
                    <div class="api-config-list" id="apiConfigsList"></div>

                    <div class="api-edit-form" id="apiEditForm">
                        <div class="api-edit-row">
                            <label class="api-edit-label">API名称</label>
                            <input type="text" class="api-edit-input" id="apiNameInput" placeholder="例如: 官方API">
                        </div>
                        <div class="api-edit-row">
                            <label class="api-edit-label">API地址</label>
                            <input type="text" class="api-edit-input" id="apiUrlInput" placeholder="例如: https://api.example.com/content?item_id={chapterId}">
                            <div class="api-url-hint">使用 {chapterId} 作为章节ID的占位符</div>
                        </div>
                        <div class="api-edit-row">
                            <label class="api-edit-label">API格式</label>
                            <select class="api-edit-select" id="apiFormatSelect">
                                <option value="content_in_data">Content在Data中</option>
                                <option value="content_in_root">Content在根级</option>
                            </select>
                        </div>
                        <div class="api-text-mode-toggle">
                            <label class="api-text-mode-label">纯文本模式</label>
                            <label class="settings-toggle-switch">
                                <input type="checkbox" id="apiIsPlainTextToggle" checked>
                                <span class="settings-toggle-slider"></span>
                            </label>
                        </div>
                        <div class="api-title-mode-toggle">
                            <label class="api-title-mode-label">API包含章节标题</label>
                            <label class="settings-toggle-switch">
                                <input type="checkbox" id="apiHasTitleToggle">
                                <span class="settings-toggle-slider"></span>
                            </label>
                        </div>
                        <div class="api-edit-row">
                            <label class="api-edit-label">超时时间(秒)</label>
                            <input type="number" class="api-edit-input" id="apiTimeoutInput" min="5" max="60" value="20">
                        </div>
                        <div class="api-edit-row">
                            <label class="api-edit-label">并发数</label>
                            <input type="number" class="api-edit-input" id="apiConcurrentInput" min="1" max="10" value="2">
                        </div>
                        <div class="api-edit-buttons">
                            <button class="api-edit-save" id="saveApiConfig">保存</button>
                            <button class="api-edit-cancel" id="cancelApiEdit">取消</button>
                        </div>
                    </div>
                </div>

                <div class="settings-buttons">
                    <button class="settings-button settings-save" id="saveGlobalSettings">保存全局设置</button>
                    <button class="settings-button settings-cancel">取消</button>
                </div>
            `;

            panel.querySelector('#saveGlobalSettings').addEventListener('click', () => this.saveGlobalSettings());
            panel.querySelector('.settings-button.settings-cancel').addEventListener('click', () => this.hideSettingsPanel());

            panel.querySelector('#addApiConfig').addEventListener('click', () => this.addNewApiConfig());
            panel.querySelector('#saveApiConfig').addEventListener('click', () => this.saveApiConfig());
            panel.querySelector('#cancelApiEdit').addEventListener('click', () => this.cancelApiEdit());

            return panel;
        }

        setupEventListeners() {
            const container = this.state.uiElements.container;
            if (container) {
                container.addEventListener('mouseenter', () => this.showPanel());
                container.addEventListener('mouseleave', () => this.onPanelMouseLeave());
            }

            window.addEventListener('resize', U.debounce(() => this.updatePanelPosition(), C.DEBOUNCE_DELAY));
        }

        showPanel() {
            const container = this.state.uiElements.container;
            if (container) {
                container.classList.remove('hidden');
                container.style.display = 'block';
                container.style.transform = 'translateX(0)';
                container.style.opacity = '1';
            }

            if (this.state.uiElements.showButton) {
                this.state.uiElements.showButton.style.display = 'none';
            }

            this.clearAutoHideTimer();

            if (this.state.config.autoHideEnabled) {
                this.setAutoHideTimer();
            }
        }

        hidePanel(force = false) {
            if (force || !this.state.config.autoHideEnabled) {
                const container = this.state.uiElements.container;
                if (container) {
                    container.classList.add('hidden');
                    const position = this.state.config.panelPosition;
                    const translateValue = position === 'right' ? 'translateX(140px)' : 'translateX(-140px)';
                    container.style.transform = translateValue;
                    container.style.opacity = '0.9';
                }

                if (this.state.uiElements.showButton) {
                    this.state.uiElements.showButton.style.display = 'block';
                }

                this.clearAutoHideTimer();
            }
        }

        manualHidePanel() {
            this.hidePanel(true);
        }

        onPanelMouseLeave() {
            if (this.state.config.autoHideEnabled && this.isPanelVisible()) {
                this.setAutoHideTimer();
            }
        }

        setAutoHideTimer() {
            this.clearAutoHideTimer();

            if (this.state.config.autoHideEnabled) {
                this.state.timers.autoHideTimer = setTimeout(() => {
                    this.hidePanel(true);
                }, this.state.config.autoHideDelay);
            }
        }

        clearAutoHideTimer() {
            if (this.state.timers.autoHideTimer) {
                clearTimeout(this.state.timers.autoHideTimer);
                this.state.timers.autoHideTimer = null;
            }
        }

        isPanelVisible() {
            const container = this.state.uiElements.container;
            return container && !container.classList.contains('hidden') && container.style.display !== 'none';
        }

        updatePanelPosition() {
            const container = this.state.uiElements.container;
            const showButton = this.state.uiElements.showButton;
            const position = this.state.config.panelPosition;

            if (container) {
                container.classList.remove('left', 'right');
                container.classList.add(position);
            }

            if (showButton) {
                showButton.classList.remove('left', 'right');
                showButton.classList.add(position);
            }
        }

        togglePanelPosition() {
            const newPosition = this.state.config.panelPosition === 'right' ? 'left' : 'right';
            this.state.config.panelPosition = newPosition;
            this.updatePanelPosition();
            Config.saveGlobalConfig(this.state.config);
            this.showNotification(`面板已切换到${newPosition === 'right' ? '右侧' : '左侧'}`);
        }

        switchToPrevApi() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();
            const prevIndex = (currentIndex - 1 + configs.length) % configs.length;

            Config.setCurrentApiIndex(prevIndex);
            this.applyApiChange();
        }

        switchToNextApi() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();
            const nextIndex = (currentIndex + 1) % configs.length;

            Config.setCurrentApiIndex(nextIndex);
            this.applyApiChange();
        }

        applyApiChange() {
            this.state.config = Config.getGlobalConfig();
            const currentApi = Config.getCurrentApi();

            // 更新API选择按钮显示
            this.updateApiSelectButton();

            this.resetContentReplaceState();

            const formatText = this.getFormatDisplayName(currentApi.format);
            const textModeText = currentApi.isPlainText ? '纯文本' : 'HTML';
            const titleModeText = currentApi.hasTitle ? '含标题' : '不含标题';

            this.showNotification(`已切换到API: ${currentApi.name} (格式: ${formatText}, ${textModeText}, ${titleModeText})`);

            if (this.state.config.autoReplaceEnabled && this.state.pageInfo.type === 'reader') {
                setTimeout(async () => {
                    try {
                        const chapterId = this.getChapterId();
                        if (chapterId) {
                            await this.performContentReplace(chapterId, true);
                        }
                    } catch (error) {
                        console.error('API切换后处理错误:', error);
                    }
                }, 300);
            }
        }

        // 更新API选择按钮显示
        updateApiSelectButton() {
            const currentApi = Config.getCurrentApi();
            const apiName = currentApi.name || 'API';

            if (this.state.uiElements.apiSelectButton) {
                this.state.uiElements.apiSelectButton.textContent = apiName;
            }
        }

        getFormatDisplayName(format) {
            switch(format) {
                case 'content_in_data': return 'Content在Data中';
                case 'content_in_root': return 'Content在根级';
                default: return '未知';
            }
        }

        showSettingsPanel() {
            if (this.state.uiElements.settingsPanel) {
                this.state.uiElements.settingsPanel.classList.add('active');
            }
            if (this.state.uiElements.overlay) {
                this.state.uiElements.overlay.classList.add('active');
            }

            const settingsPanel = this.state.uiElements.settingsPanel;
            if (settingsPanel) {
                const autoReplaceToggle = settingsPanel.querySelector('#autoReplaceToggle');
                const autoHideToggle = settingsPanel.querySelector('#autoHideToggle');
                const autoHideDelayInput = settingsPanel.querySelector('#autoHideDelayInput');
                const autoRetryToggle = settingsPanel.querySelector('#autoRetryToggle');
                const retryCountInput = settingsPanel.querySelector('#retryCountInput');
                const retryDelayInput = settingsPanel.querySelector('#retryDelayInput');

                if (autoReplaceToggle) autoReplaceToggle.checked = this.state.config.autoReplaceEnabled;
                if (autoHideToggle) autoHideToggle.checked = this.state.config.autoHideEnabled;
                if (autoHideDelayInput) autoHideDelayInput.value = this.state.config.autoHideDelay / 1000;
                if (autoRetryToggle) autoRetryToggle.checked = this.state.config.autoRetryEnabled;
                if (retryCountInput) retryCountInput.value = this.state.config.retryCount;
                if (retryDelayInput) retryDelayInput.value = this.state.config.retryDelay / 1000;
            }

            this.loadApiConfigsList();
        }

        hideSettingsPanel() {
            if (this.state.uiElements.settingsPanel) {
                this.state.uiElements.settingsPanel.classList.remove('active');
            }
            if (this.state.uiElements.overlay) {
                this.state.uiElements.overlay.classList.remove('active');
            }

            const apiEditForm = this.state.uiElements.settingsPanel?.querySelector('#apiEditForm');
            if (apiEditForm) {
                apiEditForm.style.display = 'none';
            }
        }

        loadApiConfigsList() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();

            const apiConfigsList = this.state.uiElements.settingsPanel?.querySelector('#apiConfigsList');
            if (!apiConfigsList) return;

            apiConfigsList.innerHTML = '';

            configs.forEach((config, index) => {
                const configItem = document.createElement('div');
                configItem.className = `api-config-item ${index === currentIndex ? 'active' : ''}`;

                const displayUrl = config.url.length > 50
                    ? config.url.substring(0, 50) + '...'
                    : config.url;

                const formatText = this.getFormatDisplayName(config.format);
                const textMode = config.isPlainText !== undefined ? config.isPlainText : true;
                const hasTitle = config.hasTitle !== undefined ? config.hasTitle : false;

                configItem.innerHTML = `
                    <div class="api-config-header">
                        <span class="api-config-name">${config.name}</span>
                        <div class="api-config-actions">
                            <button class="api-config-edit" data-index="${index}">编辑</button>
                            <button class="api-config-delete" data-index="${index}" ${configs.length <= 1 ? 'disabled' : ''}>删除</button>
                        </div>
                    </div>
                    <div class="api-config-details">
                        <div class="api-config-url">${displayUrl}</div>
                        <div class="api-config-format">格式: ${formatText}</div>
                        <div class="api-config-params">超时: ${config.timeout/1000}s | 并发: ${config.concurrentRequests}</div>
                    </div>
                    <div class="api-config-text-mode">${textMode ? '纯文本模式' : 'HTML模式'}</div>
                    <div class="api-config-title-mode">${hasTitle ? '包含章节标题' : '不含章节标题'}</div>
                `;

                configItem.addEventListener('click', (e) => {
                    if (!e.target.closest('.api-config-actions')) {
                        Config.setCurrentApiIndex(index);
                        this.applyApiChange();
                        this.hideSettingsPanel();
                    }
                });

                const editBtn = configItem.querySelector('.api-config-edit');
                editBtn.addEventListener('click', () => this.editApiConfig(index));

                const deleteBtn = configItem.querySelector('.api-config-delete');
                deleteBtn.addEventListener('click', () => this.deleteApiConfig(index));

                apiConfigsList.appendChild(configItem);
            });
        }

        addNewApiConfig() {
            const newConfig = Config.getDefaultApi();
            newConfig.name = `API ${Config.getApiConfigs().length + 1}`;
            this.editApiConfig(-1);
        }

        editApiConfig(index) {
            const configs = Config.getApiConfigs();
            const config = configs[index] || Config.getDefaultApi();

            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            const apiEditForm = settingsPanel.querySelector('#apiEditForm');
            const apiNameInput = settingsPanel.querySelector('#apiNameInput');
            const apiUrlInput = settingsPanel.querySelector('#apiUrlInput');
            const apiFormatSelect = settingsPanel.querySelector('#apiFormatSelect');
            const apiIsPlainTextToggle = settingsPanel.querySelector('#apiIsPlainTextToggle');
            const apiHasTitleToggle = settingsPanel.querySelector('#apiHasTitleToggle');
            const apiTimeoutInput = settingsPanel.querySelector('#apiTimeoutInput');
            const apiConcurrentInput = settingsPanel.querySelector('#apiConcurrentInput');

            if (apiEditForm && apiNameInput && apiUrlInput && apiFormatSelect && apiTimeoutInput && apiConcurrentInput) {
                apiEditForm.style.display = 'block';
                apiEditForm.dataset.index = index;
                this.state.currentEditingApiIndex = index;

                apiNameInput.value = config.name || '';
                apiUrlInput.value = config.url || '';
                apiFormatSelect.value = config.format || 'content_in_data';
                if (apiIsPlainTextToggle) {
                    apiIsPlainTextToggle.checked = config.isPlainText !== undefined ? config.isPlainText : true;
                }
                if (apiHasTitleToggle) {
                    apiHasTitleToggle.checked = config.hasTitle !== undefined ? config.hasTitle : false;
                }
                apiTimeoutInput.value = config.timeout / 1000 || C.DEFAULT_TIMEOUT / 1000;
                apiConcurrentInput.value = config.concurrentRequests || C.DEFAULT_CONCURRENT_REQUESTS;

                setTimeout(() => {
                    apiEditForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }

        saveApiConfig() {
            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            const apiEditForm = settingsPanel.querySelector('#apiEditForm');
            const apiNameInput = settingsPanel.querySelector('#apiNameInput');
            const apiUrlInput = settingsPanel.querySelector('#apiUrlInput');
            const apiFormatSelect = settingsPanel.querySelector('#apiFormatSelect');
            const apiIsPlainTextToggle = settingsPanel.querySelector('#apiIsPlainTextToggle');
            const apiHasTitleToggle = settingsPanel.querySelector('#apiHasTitleToggle');
            const apiTimeoutInput = settingsPanel.querySelector('#apiTimeoutInput');
            const apiConcurrentInput = settingsPanel.querySelector('#apiConcurrentInput');

            if (!apiEditForm || !apiNameInput || !apiUrlInput || !apiFormatSelect || !apiTimeoutInput || !apiConcurrentInput) {
                this.showNotification('表单元素缺失', false);
                return;
            }

            const index = parseInt(apiEditForm.dataset.index || '-1');
            const name = apiNameInput.value.trim() || '';
            const url = apiUrlInput.value.trim() || '';
            const format = apiFormatSelect.value || 'content_in_data';
            const isPlainText = apiIsPlainTextToggle ? apiIsPlainTextToggle.checked : true;
            const hasTitle = apiHasTitleToggle ? apiHasTitleToggle.checked : false;
            const timeout = parseInt(apiTimeoutInput.value) * 1000 || C.DEFAULT_TIMEOUT;
            const concurrentRequests = parseInt(apiConcurrentInput.value) || C.DEFAULT_CONCURRENT_REQUESTS;

            if (!name) {
                this.showNotification('请输入API名称', false);
                return;
            }

            if (!url) {
                this.showNotification('请输入API地址', false);
                return;
            }

            if (!url.includes(C.CHAPTER_ID_PLACEHOLDER)) {
                const confirmAdd = confirm(`API地址中未包含章节ID占位符 ${C.CHAPTER_ID_PLACEHOLDER}\n\n是否自动在URL末尾添加?`);
                if (confirmAdd) {
                    const separator = url.includes('?') ? '&' : '?';
                    url = `${url}${separator}${C.CHAPTER_ID_PLACEHOLDER}`;
                }
            }

            const config = { name, url, format, isPlainText, hasTitle, timeout, concurrentRequests };

            let newIndex;
            if (index >= 0) {
                if (Config.updateApiConfig(index, config)) {
                    newIndex = index;
                    this.showNotification('API配置已更新');

                    const currentIndex = Config.getCurrentApiIndex();
                    if (currentIndex === index) {
                        this.applyApiChange();
                    }
                }
            } else {
                newIndex = Config.addApiConfig(config);
                this.showNotification('新API配置已添加');
            }

            if (newIndex !== undefined) {
                Config.setCurrentApiIndex(newIndex);
                apiEditForm.style.display = 'none';
                this.loadApiConfigsList();
            }
        }

        cancelApiEdit() {
            const apiEditForm = this.state.uiElements.settingsPanel?.querySelector('#apiEditForm');
            if (apiEditForm) {
                apiEditForm.style.display = 'none';
            }
            this.state.currentEditingApiIndex = -1;
        }

        deleteApiConfig(index) {
            if (confirm('确定要删除这个API配置吗？')) {
                if (Config.deleteApiConfig(index)) {
                    this.showNotification('API配置已删除');
                    this.loadApiConfigsList();
                    this.applyApiChange();
                } else {
                    this.showNotification('至少需要保留一个API配置', false);
                }
            }
        }

        saveGlobalSettings() {
            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            let settingsChanged = false;
            const newConfig = { ...this.state.config };

            const autoReplaceToggle = settingsPanel.querySelector('#autoReplaceToggle');
            const autoHideToggle = settingsPanel.querySelector('#autoHideToggle');
            const autoHideDelayInput = settingsPanel.querySelector('#autoHideDelayInput');
            const autoRetryToggle = settingsPanel.querySelector('#autoRetryToggle');
            const retryCountInput = settingsPanel.querySelector('#retryCountInput');
            const retryDelayInput = settingsPanel.querySelector('#retryDelayInput');

            if (autoReplaceToggle) {
                const newAutoReplace = autoReplaceToggle.checked;
                if (newAutoReplace !== newConfig.autoReplaceEnabled) {
                    newConfig.autoReplaceEnabled = newAutoReplace;
                    settingsChanged = true;

                    if (newConfig.autoReplaceEnabled) {
                        this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'enabled');
                        this.showNotification('自动处理已开启');
                        if (this.state.pageInfo.type === 'reader') {
                            setTimeout(async () => {
                                const chapterId = this.getChapterId();
                                if (chapterId) {
                                    await this.performContentReplace(chapterId, true);
                                }
                            }, 300);
                        }
                    } else {
                        this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'disabled');
                        this.showNotification('自动处理已关闭');
                    }
                }
            }

            if (autoHideToggle) {
                const newAutoHide = autoHideToggle.checked;
                if (newAutoHide !== newConfig.autoHideEnabled) {
                    newConfig.autoHideEnabled = newAutoHide;
                    settingsChanged = true;

                    if (newConfig.autoHideEnabled) {
                        this.showNotification('自动隐藏已开启');
                        if (this.isPanelVisible()) {
                            this.setAutoHideTimer();
                        }
                    } else {
                        this.showNotification('自动隐藏已关闭');
                        this.clearAutoHideTimer();
                    }
                }
            }

            if (autoHideDelayInput) {
                const newAutoHideDelay = parseInt(autoHideDelayInput.value) * 1000;
                if (!isNaN(newAutoHideDelay) && newAutoHideDelay >= 1000 && newAutoHideDelay <= 10000 && newAutoHideDelay !== newConfig.autoHideDelay) {
                    newConfig.autoHideDelay = newAutoHideDelay;
                    settingsChanged = true;

                    if (newConfig.autoHideEnabled && this.isPanelVisible()) {
                        this.setAutoHideTimer();
                    }
                }
            }

            if (autoRetryToggle) {
                const newAutoRetry = autoRetryToggle.checked;
                if (newAutoRetry !== newConfig.autoRetryEnabled) {
                    newConfig.autoRetryEnabled = newAutoRetry;
                    settingsChanged = true;
                    this.showNotification(newAutoRetry ? '自动重试已开启' : '自动重试已关闭');
                }
            }

            if (retryCountInput) {
                const newRetryCount = parseInt(retryCountInput.value);
                if (!isNaN(newRetryCount) && newRetryCount >= 0 && newRetryCount <= 10 && newRetryCount !== newConfig.retryCount) {
                    newConfig.retryCount = newRetryCount;
                    settingsChanged = true;
                }
            }

            if (retryDelayInput) {
                const newRetryDelay = parseFloat(retryDelayInput.value) * 1000;
                if (!isNaN(newRetryDelay) && newRetryDelay >= 500 && newRetryDelay <= 10000 && newRetryDelay !== newConfig.retryDelay) {
                    newConfig.retryDelay = newRetryDelay;
                    settingsChanged = true;
                }
            }

            if (settingsChanged) {
                this.state.config = newConfig;
                Config.saveGlobalConfig(newConfig);
                this.showNotification('全局设置已保存');
            } else {
                this.showNotification('未检测到变化');
            }
        }

        getChapterId() {
            return U.getChapterIdFromUrl();
        }

        buildApiUrl(apiUrlTemplate, chapterId) {
            if (!apiUrlTemplate || !chapterId) {
                throw new Error('API URL模板或章节ID缺失');
            }

            if (apiUrlTemplate.includes(C.CHAPTER_ID_PLACEHOLDER)) {
                return apiUrlTemplate.replace(new RegExp(C.CHAPTER_ID_PLACEHOLDER, 'g'), chapterId);
            }

            const separator = apiUrlTemplate.includes('?') ? '&' : '?';
            return `${apiUrlTemplate}${separator}${chapterId}`;
        }

        parseApiResponse(data, format) {
            if (format === 'content_in_data') {
                if (!data.data || data.data.content === undefined || data.data.content === null) {
                    throw new Error('未找到data.content字段');
                }
                return data.data.content;
            }

            if (format === 'content_in_root') {
                if (data.content === undefined || data.content === null) {
                    throw new Error('未找到content字段');
                }
                return data.content;
            }

            throw new Error(`不支持的API格式: ${format}`);
        }

        async performContentReplace(chapterId, isAuto = false) {
            const currentApi = Config.getCurrentApi();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return false;
            }

            if (this.state.replaceInProgress) return false;
            this.state.replaceInProgress = true;

            try {
                this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'checking', 'API请求');

                const apiUrl = this.buildApiUrl(currentApi.url, chapterId);
                const response = await Network.requestWithRetry(apiUrl, {
                    headers: { 'Accept': 'application/json' },
                    timeout: currentApi.timeout
                }, this.state.config.retryCount);

                if (!response.responseText.trim()) throw new Error('API返回空响应');

                const data = JSON.parse(response.responseText);
                const parsedContent = this.parseApiResponse(data, currentApi.format);
                const isPlainText = currentApi.isPlainText !== undefined ? currentApi.isPlainText : true;
                const apiHasTitle = currentApi.hasTitle !== undefined ? currentApi.hasTitle : false;

                const urlTitle = U.getTitleFromUrl();
                const { title: chapterTitle, content: articleContent } = U.extractContent(
                    parsedContent,
                    isPlainText,
                    apiHasTitle,
                    chapterId,
                    urlTitle
                );
                const formattedContent = U.formatContent(articleContent, false, isPlainText);

                let contentContainer;
                try {
                    contentContainer = await U.waitForContent();
                } catch (error) {
                    contentContainer = U.findContentContainer();
                    if (!contentContainer) {
                        throw new Error('未找到内容容器，请检查页面结构或刷新页面');
                    }
                }

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

                    this.state.contentReplaceState = {
                        replaced: true,
                        chapterId: chapterId,
                        chapterTitle: chapterTitle,
                        contentHash: this.getContentHash(contentContainer.innerHTML),
                        timestamp: Date.now(),
                        stableCount: 0,
                        isIdle: false
                    };

                    GM_setValue('lastChapterId', chapterId);
                    GM_setValue('lastChapterTitle', chapterTitle);
                    GM_setValue('lastReplaceTime', Date.now());

                    this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'completed');
                    return true;
                } else {
                    throw new Error('未找到内容容器，请检查页面结构');
                }
            } catch (error) {
                console.error('处理过程详细错误:', error);
                const errorMsg = this.getFriendlyErrorMessage(error);
                this.showNotification(errorMsg, false);
                this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'error');
                return false;
            } finally {
                this.state.replaceInProgress = false;
            }
        }

        getContentHash(content) {
            let hash = 0;
            for (let i = 0; i < content.length; i++) {
                const char = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        }

        getFriendlyErrorMessage(error) {
            if (error.message.includes('API返回空响应')) {
                return 'API返回空数据，可能章节不存在或API不可用';
            } else if (error.message.includes('请求超时')) {
                return 'API请求超时，请检查网络连接或调整超时设置';
            } else if (error.message.includes('JSON')) {
                return 'API返回格式错误，可能API已更新';
            } else if (error.message.includes('未找到content字段')) {
                return 'API响应中未找到content字段';
            } else if (error.message.includes('未找到data.content字段')) {
                return 'API响应中未找到data.content字段';
            } else if (error.message.includes('未找到内容容器')) {
                return '页面结构可能已更新，请尝试刷新页面或联系开发者';
            } else if (error.message.includes('API URL模板或章节ID缺失')) {
                return 'API配置错误，请检查API地址是否正确';
            } else if (error.message.includes('不支持的API格式')) {
                return 'API格式配置错误，请选择正确的格式';
            } else {
                return '处理失败: ' + error.message;
            }
        }

        async manualReplaceContent() {
            const chapterId = this.getChapterId();

            if (!chapterId) {
                this.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'checking', '处理');
            const replaceSuccess = await this.performContentReplace(chapterId, false);

            if (replaceSuccess) {
                const title = this.state.contentReplaceState.chapterTitle || '当前章节';
                this.showNotification(`内容处理成功！${title}`);
            }
        }

        resetReplaceState() {
            this.state.contentReplaceState = {
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

            this.showNotification('处理状态已重置');
            this.updateStatusDisplay(this.state.uiElements.statusIndicator, this.state.config.autoReplaceEnabled ? 'enabled' : 'disabled');
        }

        resetContentReplaceState() {
            this.state.contentReplaceState = {
                replaced: false,
                chapterId: null,
                chapterTitle: null,
                contentHash: null,
                timestamp: 0,
                stableCount: 0,
                isIdle: false
            };
        }

        startUrlObserver() {
            this.stopUrlObserver();

            let lastUrl = window.location.href;
            let lastChapterId = this.getChapterId();

            const checkUrlChange = async () => {
                const currentUrl = window.location.href;
                const currentChapterId = this.getChapterId();

                if (currentUrl !== lastUrl || currentChapterId !== lastChapterId) {
                    lastUrl = currentUrl;
                    lastChapterId = currentChapterId;

                    this.resetContentReplaceState();
                    await new Promise(resolve => setTimeout(resolve, 800));

                    if (currentChapterId && this.state.config.autoReplaceEnabled) {
                        this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'checking', 'URL变化');
                        await this.performContentReplace(currentChapterId, true);
                    }
                }
            };

            this.state.timers.urlCheckTimer = setInterval(checkUrlChange, C.URL_CHECK_INTERVAL);

            window.addEventListener('popstate', async () => {
                setTimeout(async () => {
                    const currentUrl = window.location.href;
                    const currentChapterId = this.getChapterId();

                    if (currentUrl !== lastUrl || currentChapterId !== lastChapterId) {
                        lastUrl = currentUrl;
                        lastChapterId = currentChapterId;

                        this.resetContentReplaceState();
                        await new Promise(resolve => setTimeout(resolve, 800));

                        if (currentChapterId && this.state.config.autoReplaceEnabled) {
                            this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'checking', '历史记录变化');
                            await this.performContentReplace(currentChapterId, true);
                        }
                    }
                }, 100);
            });
        }

        stopUrlObserver() {
            if (this.state.timers.urlCheckTimer) {
                clearInterval(this.state.timers.urlCheckTimer);
                this.state.timers.urlCheckTimer = null;
            }
        }

        async initReaderPage() {
            if (this.state.config.autoReplaceEnabled) {
                const chapterId = this.getChapterId();
                if (chapterId) {
                    await this.performContentReplace(chapterId, true);
                }
            }
        }

        async initPagePage() {
            try {
                this.state.bookInfo = await this.fetchBookInfo();
                this.state.chapters = await this.fetchChapters();
                this.updateStats(this.state.chapters.length, 0, 0, 0);
            } catch (error) {
                console.error('初始化失败:', error);
                this.showNotification('初始化失败: ' + error.message, false);
            }
        }

        startActivityMonitoring() {
            const throttledActivity = U.throttle(() => this.recordActivity(), C.THROTTLE_DELAY);

            ['mousemove', 'keydown', 'scroll', 'click'].forEach(eventType => {
                document.addEventListener(eventType, throttledActivity, { passive: true });
            });

            ['touchstart', 'touchend'].forEach(eventType => {
                document.addEventListener(eventType, throttledActivity, { passive: true });
            });

            setInterval(() => this.checkIdleState(), 30000);
        }

        recordActivity() {
            this.state.lastActivityTime = Date.now();
            if (this.state.contentReplaceState.isIdle) {
                this.state.contentReplaceState.isIdle = false;
                this.state.contentReplaceState.stableCount = 0;
            }
        }

        checkIdleState() {
            const now = Date.now();
            if (!this.state.contentReplaceState.isIdle && now - this.state.lastActivityTime > C.IDLE_TIMEOUT) {
                this.state.contentReplaceState.isIdle = true;
            }
        }

        async fetchBookInfo() {
            try {
                const response = await Network.requestWithRetry(
                    `https://i.snssdk.com/reading/bookapi/multi-detail/v/?aid=1967&book_id=${this.state.pageInfo.bookId}`,
                    { timeout: this.state.config.timeout },
                    this.state.config.retryCount
                );
                const data = JSON.parse(response.responseText);

                if (!data.data?.[0]) throw new Error('未获取到书籍信息');

                const book = data.data[0];
                const formattedAbstract = book.abstract ? book.abstract.replace(/\s/g, '\n').replace(/\n{2,}/g, '\n') : '';

                return {
                    title: U.sanitizeFilename(book.book_name),
                    author: U.sanitizeFilename(book.author),
                    abstract: formattedAbstract,
                    wordCount: book.word_number,
                    chapterCount: book.serial_count,
                    thumb_url: book.thumb_url,
                    infoText: `书名：${book.book_name}\n作者：${book.author}\n字数：${parseInt(book.word_number)/10000}万字\n章节数：${book.serial_count}\n简介：\n${formattedAbstract}\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。`
                };
            } catch (error) {
                this.showNotification('获取书籍信息失败: ' + error.message, false);
                throw error;
            }
        }

        async fetchChapters() {
            try {
                const response = await Network.requestWithRetry(
                    `https://fanqienovel.com/api/reader/directory/detail?bookId=${this.state.pageInfo.bookId}`,
                    { timeout: this.state.config.timeout },
                    this.state.config.retryCount
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
                this.showNotification('获取章节列表失败: ' + error.message, false);
                throw error;
            }
        }

        async downloadChapter(chapterId, index, chapterTitle) {
            const currentApi = Config.getCurrentApi();
            if (!currentApi.url) {
                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: `[错误: 请先在设置中配置API地址 (${currentApi.name})]`,
                    success: false,
                    retries: 0
                };
            }

            try {
                const result = await U.retryAsync(async (attempt) => {
                    const apiUrl = this.buildApiUrl(currentApi.url, chapterId);

                    const response = await Network.requestWithRetry(
                        apiUrl,
                        { headers: { 'Accept': 'application/json' }, timeout: currentApi.timeout },
                        0
                    );

                    if (!response.responseText.trim()) throw new Error('空响应');

                    const data = JSON.parse(response.responseText);
                    const parsedContent = this.parseApiResponse(data, currentApi.format);
                    const isPlainText = currentApi.isPlainText !== undefined ? currentApi.isPlainText : true;
                    const apiHasTitle = currentApi.hasTitle !== undefined ? currentApi.hasTitle : false;

                    const { title: apiTitle, content: articleContent } = U.extractContent(
                        parsedContent,
                        isPlainText,
                        apiHasTitle,
                        chapterId,
                        chapterTitle
                    );
                    const finalTitle = apiTitle || chapterTitle || `第${index + 1}章`;

                    return {
                        title: finalTitle,
                        content: U.formatContent(articleContent, true, isPlainText),
                        success: true,
                        retries: attempt
                    };
                }, this.state.config.retryCount, this.state.config.retryDelay);

                if (result.retries > 0) {
                    this.state.downloadStats.retried++;
                    if (result.success) {
                        this.state.downloadStats.retriedSuccess++;
                    }
                }

                return result;
            } catch (error) {
                console.error(`章节 ${chapterId} 下载失败:`, error);
                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: `[下载失败: ${error.message}]`,
                    success: false,
                    retries: this.state.config.retryCount
                };
            }
        }

        async downloadChaptersBatch(chapterIds) {
            const currentApi = Config.getCurrentApi();
            const results = [];
            const total = chapterIds.length;
            let completed = 0;
            let successCount = 0;
            let failedCount = 0;
            let retryCount = 0;

            const batchSize = currentApi.concurrentRequests;
            const debouncedUpdate = U.debounce((completed, total, successCount, failedCount, retryCount) => {
                this.updateProgress((completed / total) * 100);
                this.updateStats(total, successCount, failedCount, retryCount);
            }, C.DEBOUNCE_DELAY);

            for (let i = 0; i < total; i += batchSize) {
                const batch = chapterIds.slice(i, i + batchSize);
                const batchPromises = batch.map((chapter, batchIndex) =>
                    this.downloadChapter(chapter.id, i + batchIndex, chapter.title)
                );

                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);

                batchResults.forEach((result, index) => {
                    if (result.success) {
                        successCount++;
                    } else {
                        failedCount++;
                    }
                    retryCount += result.retries || 0;
                });

                completed += batch.length;
                debouncedUpdate(completed, total, successCount, failedCount, retryCount);

                if (i + batchSize < total) {
                    await new Promise(resolve => setTimeout(resolve, Math.random() * C.CHAPTER_DOWNLOAD_DELAY + 200));
                }
            }

            this.state.downloadResults = results;

            if (this.state.config.autoRetryEnabled && failedCount > 0) {
                await this.autoRetryFailedChapters(results);
            }

            return results;
        }

        async autoRetryFailedChapters(results) {
            const failedChapters = results
                .map((result, index) => ({
                    chapter: this.state.chapters[index],
                    index: index,
                    result: result
                }))
                .filter(item => !item.result.success);

            if (failedChapters.length === 0) return;

            this.showNotification(`自动重试开始，共${failedChapters.length}个章节`);

            await this.retryFailedChapters(failedChapters, results);

            const successCount = results.filter(r => r.success).length;
            const failedCount = results.filter(r => !r.success).length;
            const retryCount = results.reduce((sum, r) => sum + (r.retries || 0), 0);

            this.updateStats(results.length, successCount, failedCount, retryCount);

            if (failedCount === 0) {
                this.showNotification('所有失败章节重试成功！');
            } else {
                this.showNotification(`自动重试完成，仍有${failedCount}个章节失败`, false);
            }
        }

        async retryFailedChapters(failedChapters, results) {
            let attempt = 1;
            let remainingFailed = [...failedChapters];

            while (attempt <= this.state.config.retryCount && remainingFailed.length > 0) {
                this.showNotification(`重试第${attempt}次，共${remainingFailed.length}个章节`);

                await new Promise(resolve => setTimeout(resolve, C.BATCH_RETRY_DELAY * attempt));

                const retryResults = await Promise.all(
                    remainingFailed.map(item =>
                        this.downloadChapter(item.chapter.id, item.index, item.chapter.title)
                    )
                );

                let newlySucceeded = 0;
                let newFailed = [];

                remainingFailed.forEach((item, index) => {
                    const result = retryResults[index];
                    results[item.index] = result;

                    if (result.success) {
                        newlySucceeded++;
                    } else {
                        newFailed.push(item);
                    }
                });

                this.showNotification(`重试完成，成功${newlySucceeded}个章节`);

                const successCount = results.filter(r => r.success).length;
                const failedCount = results.filter(r => !r.success).length;
                const retryCount = results.reduce((sum, r) => sum + (r.retries || 0), 0);
                this.updateStats(results.length, successCount, failedCount, retryCount);

                remainingFailed = newFailed;
                attempt++;
            }
        }

        async generateEPUB(bookInfo, chapters, contents, coverUrl) {
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
p { text-indent: 2em; margin: 0.8em 0; hyphens: auto; }
.book-info { margin: 1em 0; padding: 1em; background: #f8f8f8; border-radius: 5px; }
.book-info p { text-indent: 0; }`);

            let coverItem = '';
            if (coverUrl) {
                try {
                    const response = await Network.requestWithRetry(coverUrl, {
                        responseType: 'blob',
                        timeout: this.state.config.timeout * 2
                    }, this.state.config.retryCount);
                    oebps.file('Images/cover.jpg', response.response, { binary: true });

                    textFolder.file('cover.html', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/html">
<head>
    <title>封面</title>
    <link href="../Styles/main.css" rel="stylesheet"/></head><body><div style="text-align:center;"><img src="../Images/cover.jpg" alt="${bookInfo.title}封面" style="max-height: 60vh;"/></div><h1 style="margin-top: 2em; text-align:center;">${bookInfo.title}</h1><h2 style="text-align:center;">${bookInfo.author}</h2>
</body></html>`);

                    coverItem = '<item id="cover" href="Text/cover.html" media-type="application/xhtml+xml"/><item id="cover-image" href="Images/cover.jpg" media-type="image/jpeg"/>';
                } catch (e) {
                    console.warn('封面下载失败:', e);
                }
            }

            const formattedAbstract = bookInfo.abstract;
            const abstractParagraphs = formattedAbstract.split('\n').map(p => p.trim()).filter(p => p);

            textFolder.file('info.html', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/html">
<head>
    <title>书籍信息</title>
    <link href="../Styles/main.css" rel="stylesheet"/></head><body><h1>${bookInfo.title}</h1><div class="book-info"><p><strong>作者：</strong>${bookInfo.author}</p><p><strong>字数：</strong>${parseInt(bookInfo.wordCount)/10000}万字</p><p><strong>章节数：</strong>${bookInfo.chapterCount}</p></div><h2>简介</h2>${abstractParagraphs.map(p => `<p>${p}</p>`).join('')}<h2>免责声明</h2><p>本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。</p></body></html>`);

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
        }

        async startDownload(format) {
            if (this.state.isDownloading) return;

            const currentApi = Config.getCurrentApi();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return;
            }

            this.state.isDownloading = true;

            this.state.downloadStats = {
                total: 0,
                success: 0,
                failed: 0,
                retried: 0,
                retriedSuccess: 0
            };

            const buttons = document.querySelectorAll('.tamper-button.txt, .tamper-button.epub');
            buttons.forEach(btn => btn.disabled = true);
            if (this.state.uiElements.progressContainer) {
                this.state.uiElements.progressContainer.style.display = 'block';
            }

            const retrySettingsText = this.state.config.retryCount > 0
                ? ` (重试${this.state.config.retryCount}次)`
                : '';
            this.showNotification(`使用API: ${currentApi.name} 开始下载章节内容${retrySettingsText}...`);

            try {
                if (!this.state.bookInfo) {
                    this.state.bookInfo = await this.fetchBookInfo();
                }
                if (!this.state.chapters) {
                    this.state.chapters = await this.fetchChapters();
                }

                const chapterResults = await this.downloadChaptersBatch(this.state.chapters);
                const contents = chapterResults.map(result => result.content);
                const successCount = chapterResults.filter(r => r.success).length;
                const failedCount = chapterResults.filter(r => !r.success).length;
                const retryCount = chapterResults.reduce((sum, r) => sum + (r.retries || 0), 0);

                const updatedChapters = chapterResults.map((result, index) => ({
                    id: this.state.chapters[index].id,
                    title: result.title
                }));

                if (format === 'txt') {
                    let txtContent = this.state.bookInfo.infoText + '\n\n';
                    for (let i = 0; i < updatedChapters.length; i++) {
                        txtContent += `${updatedChapters[i].title}\n\n`;
                        txtContent += `${contents[i]}\n\n`;
                    }
                    saveAs(new Blob([txtContent], { type: 'text/plain;charset=utf-8' }), `${this.state.bookInfo.title}.txt`);
                } else if (format === 'epub') {
                    const epubBlob = await this.generateEPUB(this.state.bookInfo, updatedChapters, contents, this.state.bookInfo.thumb_url);
                    saveAs(epubBlob, `${this.state.bookInfo.title}.epub`);
                }

                let statsText = `下载完成！成功: ${successCount}, 失败: ${failedCount}`;
                if (retryCount > 0) {
                    const retriedSuccess = this.state.downloadStats.retriedSuccess;
                    statsText += `, 重试: ${retryCount}次 (成功${retriedSuccess}次)`;
                }

                this.showNotification(statsText);
            } catch (error) {
                console.error('下载过程出错:', error);
                let errorMsg = '下载失败: ' + error.message;
                if (error.message.includes('超时')) {
                    errorMsg += '\n建议：尝试调整设置中的超时时间或并发数';
                }
                this.showNotification(errorMsg, false);
            } finally {
                buttons.forEach(btn => btn.disabled = false);
                if (this.state.uiElements.progressContainer) {
                    this.state.uiElements.progressContainer.style.display = 'none';
                }
                this.state.isDownloading = false;
            }
        }

        async downloadCurrentChapter() {
            const chapterId = this.getChapterId();

            if (!chapterId) {
                this.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            const currentApi = Config.getCurrentApi();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return;
            }

            const urlTitle = U.getTitleFromUrl();
            const fallbackTitle = urlTitle || `第${chapterId}章`;

            const retrySettingsText = this.state.config.retryCount > 0
                ? ` (重试${this.state.config.retryCount}次)`
                : '';
            this.showNotification(`使用API: ${currentApi.name} 开始下载当前章节${retrySettingsText}...`);

            try {
                const result = await this.downloadChapter(chapterId, 0, fallbackTitle);

                if (result.success) {
                    let chapterContent = `章节：${result.title}\n\n`;
                    chapterContent += result.content;
                    chapterContent += '\n\n---\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。';

                    const sanitizedTitle = U.sanitizeFilename(result.title);
                    saveAs(new Blob([chapterContent], { type: 'text/plain;charset=utf-8' }), `${sanitizedTitle}.txt`);

                } else {
                    let errorMsg = `下载失败: ${result.content}`;
                    if (result.retries > 0) {
                        errorMsg += ` (已重试${result.retries}次)`;
                    }
                    this.showNotification(errorMsg, false);
                }
            } catch (error) {
                console.error('章节下载错误:', error);
                this.showNotification('下载失败: ' + error.message, false);
            }
        }

        updateStatusDisplay(indicator, statusKey, extraInfo = '') {
            if (!indicator) return;

            const statusConfig = {
                'disabled': { text: '自动处理已关闭', class: '' },
                'enabled': { text: '自动处理已开启', class: 'active' },
                'checking': { text: '正在检查...', class: 'monitoring' },
                'completed': { text: '处理完成', class: 'active' },
                'error': { text: '检测异常', class: 'idle' }
            };

            const config = statusConfig[statusKey] || { text: '未知状态', class: '' };
            let message = config.text;
            if (extraInfo) message += ` (${extraInfo})`;

            indicator.textContent = message;
            indicator.className = 'auto-replace-status';
            if (config.class) indicator.classList.add(config.class);
        }

        updateProgress(percentage) {
            if (this.state.uiElements.progressFill) {
                this.state.uiElements.progressFill.style.width = `${percentage}%`;
            }
        }

        updateStats(total, success, failed, retried = 0) {
            if (this.state.uiElements.totalStat) {
                this.state.uiElements.totalStat.textContent = total;
            }
            if (this.state.uiElements.successStat) {
                this.state.uiElements.successStat.textContent = success;
            }
            if (this.state.uiElements.failedStat) {
                this.state.uiElements.failedStat.textContent = failed;
            }
            if (this.state.uiElements.retryStat) {
                this.state.uiElements.retryStat.textContent = retried;
            }
        }

        showNotification(message, isSuccess = true) {
            const notification = document.createElement('div');
            notification.className = 'tamper-notification';
            notification.style.backgroundColor = isSuccess ? '#4CAF50' : '#F44336';
            notification.textContent = message;
            document.body.appendChild(notification);

            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transform = 'translateY(20px)';
                setTimeout(() => notification.remove(), 500);
            }, C.NOTIFICATION_DURATION);
        }
    }

    window.addEventListener('load', () => {
        const app = new FanqieEnhancer();

        window.addEventListener('beforeunload', () => {
            if (app && app.stopUrlObserver) {
                app.stopUrlObserver();
            }

            if (app && app.state && app.state.timers) {
                Object.values(app.state.timers).forEach(timer => {
                    if (timer) clearTimeout(timer);
                });
            }
        });
    });

})();
