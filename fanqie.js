// ==UserScript==
// @name          番茄小说增强工具
// @author        cctv
// @version       2025.11.23
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

/**
 * 番茄小说增强工具 - 优化版
 * 主要优化：代码结构重构、性能提升、错误处理增强、代码可读性改进
 */

(function() {
    'use strict';

    // ==============================
    // 常量定义模块
    // ==============================
    const Constants = Object.freeze({
        DEFAULT_TIMEOUT: 20000,
        DEFAULT_CHECK_INTERVAL: 5000,
        DEFAULT_AUTO_HIDE_DELAY: 3000,
        DEFAULT_CONCURRENT_REQUESTS: 2,
        MAX_RETRIES: 2,
        IDLE_TIMEOUT: 300000,
        URL_CHECK_INTERVAL: 300,
        SUCCESS_CODE: 520,
        API_FORMATS: {
            V1: 'v1',          // content在根级
            V2: 'v2'           // content在data中（不检查code）
        },
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
        CHAPTER_ID_PLACEHOLDER: '{chapterId}'
    });

    // ==============================
    // 工具函数模块
    // ==============================
    const Utils = {
        /**
         * 解码HTML实体
         * @param {string} str - 包含HTML实体的字符串
         * @returns {string} 解码后的字符串
         */
        decodeHtmlEntities: function(str) {
            const entities = {
                '&#34;': '"',
                '&#39;': "'",
                '&amp;': '&',
                '&lt;': '<',
                '&gt;': '>'
            };
            return str.replace(/&#34;|&#39;|&amp;|&lt;|&gt;/g, match => entities[match] || match);
        },

        /**
         * 清理文件名
         * @param {string} name - 原始文件名
         * @returns {string} 清理后的文件名
         */
        sanitizeFilename: function(name) {
            return name.replace(/[\\/*?:"<>|]/g, '').trim();
        },

        /**
         * 提取标题和内容
         * @param {string} htmlContent - HTML内容
         * @returns {Object} 包含标题和内容的对象
         */
        extractContentAndTitle: function(htmlContent) {
            let title = '';
            let content = htmlContent;

            try {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = htmlContent;

                // 提取标题
                const headerElement = tempDiv.querySelector('header');
                if (headerElement) {
                    const titleElement = headerElement.querySelector('.tt-title');
                    title = titleElement ? titleElement.textContent.trim() : headerElement.textContent.trim();
                    headerElement.remove();
                }

                // 提取内容
                const articleElement = tempDiv.querySelector('article');
                content = articleElement ? articleElement.innerHTML : tempDiv.innerHTML;
            } catch (error) {
                console.error('提取标题和内容时出错:', error);
            }

            // 从URL获取默认标题
            if (!title) {
                const pathname = window.location.pathname;
                const titleMatch = pathname.match(/\/reader\/\d+\/([^\/]+)/);
                title = titleMatch && titleMatch[1]
                    ? decodeURIComponent(titleMatch[1]).replace(/-/g, ' ')
                    : '未知章节';
            }

            return { title, content };
        },

        /**
         * 格式化内容
         * @param {string} content - 原始内容
         * @param {boolean} forText - 是否为文本格式
         * @returns {string} 格式化后的内容
         */
        formatContent: function(content, forText = true) {
            let formatted = this.decodeHtmlEntities(content)
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

                // 确保首行缩进
                if (!formatted.startsWith('  ') && formatted.length > 0) {
                    const firstNewline = formatted.indexOf('\n');
                    formatted = firstNewline === -1
                        ? '  ' + formatted
                        : '  ' + formatted.substring(0, firstNewline) + formatted.substring(firstNewline);
                }
            } else {
                formatted = formatted
                    .replace(/<p[^>]*>/g, '<p>')
                    .replace(/<br\/?>/g, '<br>')
                    .trim();
            }

            return formatted;
        },

        /**
         * 获取内容哈希值
         * @param {string} content - 内容字符串
         * @returns {string} 哈希值
         */
        getContentHash: function(content) {
            let hash = 0;
            for (let i = 0; i < content.length; i++) {
                const char = content.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16);
        },

        /**
         * 查找内容容器
         * @returns {HTMLElement|null} 内容容器元素
         */
        findContentContainer: function() {
            // 先尝试已知选择器
            for (const selector of Constants.CONTENT_CONTAINER_SELECTORS) {
                const container = document.querySelector(selector);
                if (container) return container;
            }

            // 智能查找
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

        /**
         * 等待内容容器出现
         * @param {number} timeout - 超时时间
         * @returns {Promise<HTMLElement>} 内容容器元素
         */
        waitForContentContainer: function(timeout = Constants.WAIT_FOR_CONTENT_TIMEOUT) {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                const checkInterval = 200;

                const checkContainer = () => {
                    const container = this.findContentContainer();
                    if (container) {
                        resolve(container);
                        return;
                    }

                    if (Date.now() - startTime > timeout) {
                        reject(new Error('超时未找到内容容器'));
                        return;
                    }

                    setTimeout(checkContainer, checkInterval);
                };

                checkContainer();
            });
        },

        /**
         * 防抖函数
         * @param {Function} func - 目标函数
         * @param {number} wait - 等待时间
         * @returns {Function} 防抖后的函数
         */
        debounce: function(func, wait = Constants.DEBOUNCE_DELAY) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        /**
         * 节流函数
         * @param {Function} func - 目标函数
         * @param {number} limit - 限制时间
         * @returns {Function} 节流后的函数
         */
        throttle: function(func, limit = Constants.THROTTLE_DELAY) {
            let inThrottle;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            };
        }
    };

    // ==============================
    // 配置管理模块
    // ==============================
    const Config = {
        /**
         * 获取API配置列表
         * @returns {Array} API配置列表
         */
        getApiConfigs: function() {
            const configs = GM_getValue('apiConfigs', []);
            // 数据迁移：移除旧的paramName属性和V3格式
            const migratedConfigs = configs.map(config => {
                const { paramName, ...newConfig } = config;
                // 如果是V3格式，迁移到V2
                if (newConfig.format === 'v3') {
                    newConfig.format = Constants.API_FORMATS.V2;
                }
                return newConfig;
            });
            if (migratedConfigs.length !== configs.length) {
                this.saveApiConfigs(migratedConfigs);
            }
            return migratedConfigs.length > 0 ? migratedConfigs : [this.getDefaultApiConfig()];
        },

        /**
         * 获取默认API配置
         * @returns {Object} 默认API配置
         */
        getDefaultApiConfig: function() {
            return {
                name: '默认API',
                url: '',
                format: Constants.API_FORMATS.V2,
                timeout: Constants.DEFAULT_TIMEOUT,
                concurrentRequests: Constants.DEFAULT_CONCURRENT_REQUESTS
            };
        },

        /**
         * 获取当前API索引
         * @returns {number} 当前API索引
         */
        getCurrentApiIndex: function() {
            return GM_getValue('currentApiIndex', 0);
        },

        /**
         * 设置当前API索引
         * @param {number} index - API索引
         */
        setCurrentApiIndex: function(index) {
            GM_setValue('currentApiIndex', index);
        },

        /**
         * 保存API配置列表
         * @param {Array} configs - API配置列表
         */
        saveApiConfigs: function(configs) {
            GM_setValue('apiConfigs', configs);
        },

        /**
         * 添加API配置
         * @param {Object} config - API配置
         * @returns {number} 新配置的索引
         */
        addApiConfig: function(config) {
            const configs = this.getApiConfigs();
            configs.push(config);
            this.saveApiConfigs(configs);
            return configs.length - 1;
        },

        /**
         * 更新API配置
         * @param {number} index - 配置索引
         * @param {Object} config - 新配置
         * @returns {boolean} 是否更新成功
         */
        updateApiConfig: function(index, config) {
            const configs = this.getApiConfigs();
            if (index >= 0 && index < configs.length) {
                configs[index] = {
                    ...configs[index],
                    ...config
                };
                this.saveApiConfigs(configs);
                return true;
            }
            return false;
        },

        /**
         * 删除API配置
         * @param {number} index - 配置索引
         * @returns {boolean} 是否删除成功
         */
        deleteApiConfig: function(index) {
            const configs = this.getApiConfigs();
            if (index >= 0 && index < configs.length && configs.length > 1) {
                configs.splice(index, 1);
                this.saveApiConfigs(configs);
                const currentIndex = this.getCurrentApiIndex();
                if (currentIndex >= index) {
                    this.setCurrentApiIndex(Math.max(0, currentIndex - 1));
                }
                return true;
            }
            return false;
        },

        /**
         * 获取当前API配置
         * @returns {Object} 当前API配置
         */
        getCurrentApiConfig: function() {
            const configs = this.getApiConfigs();
            const index = this.getCurrentApiIndex();
            return configs[Math.min(index, configs.length - 1)];
        },

        /**
         * 获取全局配置
         * @returns {Object} 全局配置
         */
        getGlobalConfig: function() {
            const currentApi = this.getCurrentApiConfig();
            return {
                apiUrl: currentApi.url,
                apiFormat: currentApi.format,
                concurrentRequests: currentApi.concurrentRequests,
                timeout: currentApi.timeout,

                autoReplaceEnabled: GM_getValue('autoReplaceEnabled', false),
                checkInterval: GM_getValue('checkInterval', Constants.DEFAULT_CHECK_INTERVAL),
                panelPosition: GM_getValue('panelPosition', 'right'),
                autoHideEnabled: GM_getValue('autoHideEnabled', true),
                autoHideDelay: GM_getValue('autoHideDelay', Constants.DEFAULT_AUTO_HIDE_DELAY)
            };
        },

        /**
         * 保存全局配置
         * @param {Object} config - 全局配置
         */
        saveGlobalConfig: function(config) {
            GM_setValue('autoReplaceEnabled', config.autoReplaceEnabled);
            GM_setValue('checkInterval', config.checkInterval);
            GM_setValue('panelPosition', config.panelPosition);
            GM_setValue('autoHideEnabled', config.autoHideEnabled);
            GM_setValue('autoHideDelay', config.autoHideDelay);
        }
    };

    // ==============================
    // 网络请求模块
    // ==============================
    const Network = {
        /**
         * 发起网络请求
         * @param {string} url - 请求URL
         * @param {Object} options - 请求选项
         * @returns {Promise<Object>} 响应对象
         */
        request: function(url, options = {}) {
            return new Promise((resolve, reject) => {
                const timeout = options.timeout || Constants.DEFAULT_TIMEOUT;
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

        /**
         * 带重试的网络请求
         * @param {string} url - 请求URL
         * @param {Object} options - 请求选项
         * @param {number} retries - 重试次数
         * @returns {Promise<Object>} 响应对象
         */
        requestWithRetry: async function(url, options = {}, retries = Constants.MAX_RETRIES) {
            for (let i = 0; i <= retries; i++) {
                try {
                    return await this.request(url, options);
                } catch (error) {
                    if (i === retries) throw error;
                    const delay = Math.pow(2, i) * 1000 + Math.random() * 500;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    };

    // ==============================
    // 主应用类
    // ==============================
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
                timers: {
                    urlCheckTimer: null,
                    autoHideTimer: null
                },
                currentEditingApiIndex: -1
            };

            this.init();
        }

        /**
         * 初始化应用
         */
        async init() {
            console.log('番茄小说增强工具初始化开始');

            if (!this.state.pageInfo) {
                console.log('番茄小说增强工具: 当前页面不支持');
                return;
            }

            this.removeVIPPrompt();
            this.createCSS();
            await this.createUI();
            this.setupEventListeners();
            this.startActivityMonitoring();

            // 确保API配置正确加载
            setTimeout(() => {
                this.updateApiSelectionDisplay();
            }, 100);

            if (this.state.pageInfo.type === 'reader') {
                this.startUrlObserver();
                setTimeout(() => this.initReaderPage(), 800);
            } else if (this.state.pageInfo.type === 'page') {
                await this.initPagePage();
            }

            console.log('番茄小说增强工具初始化完成');
        }

        /**
         * 获取页面信息
         * @returns {Object|null} 页面信息对象
         */
        getPageInfo() {
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

        /**
         * 移除VIP提示
         */
        removeVIPPrompt() {
            const removeElement = () => {
                const vipElement = document.querySelector('.muye-to-fanqie');
                if (vipElement) vipElement.remove();
            };

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.addedNodes.length) removeElement();
                });
            });

            removeElement();
            observer.observe(document.body, { childList: true, subtree: true });
        }

        /**
         * 创建CSS样式
         */
        createCSS() {
            const styles = `
                .tamper-container { position: fixed; top: 20px; background: #fff; border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 10px; z-index: 9999; width: 160px; font-size: 12px;
                    transition: all 0.3s ease; border: 1px solid #e8e8e8; }

                .tamper-container.right { right: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
                .tamper-container.left { left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
                .tamper-container.hidden.right { transform: translateX(140px); opacity: 0.9; }
                .tamper-container.hidden.left { transform: translateX(-140px); opacity: 0.9; }
                .tamper-container:hover { transform: translateX(0) !important; opacity: 1 !important; }

                .show-button { position: fixed; top: 20px; width: 30px; height: 60px;
                    background: #4CAF50; color: white; border: none; border-radius: 5px 0 0 5px; cursor: pointer;
                    font-size: 12px; writing-mode: vertical-rl; z-index: 10000; display: none; }
                .show-button.right { right: 0; }
                .show-button.left { left: 0; border-radius: 0 5px 5px 0; }

                .tamper-button { border: none; border-radius: 4px; padding: 6px 10px; margin: 3px 0; cursor: pointer;
                    font-size: 11px; width: 100%; text-align: center; transition: background-color 0.2s; }

                .tamper-button.txt { background: #4CAF50; color: #fff; }
                .tamper-button.epub { background: #2196F3; color: #fff; }
                .tamper-button.download-chapter { background: #FF9800; color: #fff; }
                .tamper-button.settings { background: #9C27B0; color: #fff; }
                .tamper-button.position { background: #795548; color: #fff; font-size: 10px; }
                .tamper-button.api-select { background: #FF5722; color: #fff; font-size: 10px; }
                .tamper-button.api-switch { background: #607D8B; color: #fff; font-size: 10px; width: 30px; }
                .tamper-button.manual-hide-button { background: #f44336; color: white; font-size: 10px; padding: 4px; }

                .stats-container { display: flex; justify-content: space-between; margin-top: 8px; font-size: 10px; }
                .stat-item { display: flex; flex-direction: column; align-items: center; flex: 1; }
                .stat-label { margin-bottom: 2px; color: #666; font-size: 9px; }
                .stat-value { font-weight: bold; font-size: 12px; }
                .success-value { color: #4CAF50; }
                .failed-value { color: #F44336; }

                .progress-bar { width: 100%; height: 6px; background-color: #f0f0f0; border-radius: 3px;
                    margin-top: 6px; overflow: hidden; }
                .progress-fill { height: 100%; background: #4CAF50; transition: width 0.3s ease; }

                .tamper-notification { position: fixed; bottom: 20px; right: 20px; color: white; padding: 15px;
                    border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 9999; font-size: 14px;
                    transition: all 0.3s ease; }

                .settings-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: #fff; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); padding: 15px;
                    z-index: 10000; width: 90%; max-width: 400px; display: none; max-height: 80vh; overflow-y: auto; }
                .settings-panel.active { display: block; }
                .settings-title { font-size: 16px; font-weight: bold; margin-bottom: 12px; text-align: center; }
                .settings-group { margin-bottom: 12px; padding: 10px; border-radius: 6px; background: #f8f9fa; }
                .settings-label { display: block; margin-bottom: 6px; font-weight: bold; font-size: 13px; }
                .settings-input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
                .settings-buttons { display: flex; justify-content: space-between; margin-top: 15px; }
                .settings-button { padding: 8px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
                .settings-save { background: #4CAF50; color: white; }
                .settings-cancel { background: #f44336; color: white; }

                .overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5);
                    z-index: 9999; display: none; }
                .overlay.active { display: block; }

                .replaced-content { background: #f8f9fa; border-radius: 6px; padding: 12px; margin: 6px 0;
                    border: 1px solid #4CAF50; }

                .auto-replace-status { text-align: center; margin: 6px 0; padding: 4px; font-size: 10px;
                    border-radius: 4px; background: #f0f0f0; color: #666; }
                .auto-replace-status.active { background: #e8f5e9; color: #2e7d32; }
                .auto-replace-status.monitoring { background: #e3f2fd; color: #1565c0; }
                .auto-replace-status.idle { background: #fff3e0; color: #f57c00; }
                .auto-replace-status.stable { background: #e8f5e9; color: #2e7d32; font-weight: bold; }

                .control-group { display: flex; gap: 4px; margin-bottom: 8px; justify-content: center; }

                .settings-toggle { margin-bottom: 12px; padding: 10px; border-radius: 6px; background: #f8f9fa; }
                .settings-toggle-label { display: flex; align-items: center; justify-content: space-between;
                    margin-bottom: 6px; font-weight: bold; font-size: 13px; }
                .settings-toggle-switch { position: relative; display: inline-block; width: 40px; height: 20px; }
                .settings-toggle-switch input { opacity: 0; width: 0; height: 0; }
                .settings-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
                    background-color: #ccc; transition: .4s; border-radius: 20px; }
                .settings-toggle-slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px;
                    bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
                input:checked + .settings-toggle-slider { background-color: #4CAF50; }
                input:checked + .settings-toggle-slider:before { transform: translateX(20px); }

                .chapter-title-container { text-align: center; margin: 12px 0; padding: 10px; }
                .chapter-title-container h1 { margin: 0; font-size: 18px; color: #333; }

                .api-selection { text-align: center; margin: 6px 0; padding: 4px; font-size: 9px; color: #666; }
                .api-format-indicator { text-align: center; margin: 2px 0; padding: 2px; font-size: 8px; color: #888; }

                /* API配置样式 */
                .api-config-section { margin: 15px 0; }
                .api-config-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
                .api-config-title { font-size: 14px; font-weight: bold; }
                .api-config-add { background: #4CAF50; color: white; border: none; padding: 4px 8px;
                    border-radius: 4px; cursor: pointer; font-size: 11px; }
                .api-config-list { max-height: 180px; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; }
                .api-config-item { padding: 8px; border-bottom: 1px solid #eee; cursor: pointer; }
                .api-config-item:last-child { border-bottom: none; }
                .api-config-item:hover { background: #f8f9fa; }
                .api-config-item.active { background: #e8f5e9; border-left: 2px solid #4CAF50; }
                .api-config-name { font-weight: bold; font-size: 12px; }
                .api-config-actions { display: flex; gap: 4px; }
                .api-config-edit, .api-config-delete { background: none; border: 1px solid #ddd; padding: 2px 6px;
                    border-radius: 3px; cursor: pointer; font-size: 10px; }
                .api-config-edit { color: #2196F3; border-color: #2196F3; }
                .api-config-delete { color: #F44336; border-color: #F44336; }
                .api-config-details { margin-top: 4px; font-size: 10px; color: #666; }

                /* API编辑表单 */
                .api-edit-form { display: none; margin: 12px 0; padding: 12px; background: #f8f9fa; border-radius: 6px; }
                .api-edit-row { margin-bottom: 8px; }
                .api-edit-label { display: block; margin-bottom: 4px; font-weight: bold; font-size: 11px; }
                .api-edit-input, .api-edit-select { width: 100%; padding: 6px; border: 1px solid #ddd;
                    border-radius: 3px; font-size: 11px; }
                .api-edit-buttons { display: flex; gap: 8px; margin-top: 12px; }
                .api-edit-save { background: #4CAF50; color: white; border: none; padding: 6px 12px;
                    border-radius: 3px; cursor: pointer; font-size: 11px; }
                .api-edit-cancel { background: #f44336; color: white; border: none; padding: 6px 12px;
                    border-radius: 3px; cursor: pointer; font-size: 11px; }

                .api-url-hint { font-size: 10px; color: #666; margin-top: 4px; font-style: italic; }
            `;

            GM_addStyle(styles);
        }

        /**
         * 创建UI界面
         */
        async createUI() {
            // 创建主面板
            const mainPanel = document.createElement('div');
            mainPanel.className = `tamper-container ${this.state.config.panelPosition}`;
            document.body.appendChild(mainPanel);
            this.state.uiElements.container = mainPanel;

            // API选择显示
            const apiSelection = document.createElement('div');
            apiSelection.className = 'api-selection';
            const apiFormatIndicator = document.createElement('div');
            apiFormatIndicator.className = 'api-format-indicator';
            mainPanel.appendChild(apiSelection);
            mainPanel.appendChild(apiFormatIndicator);
            this.state.uiElements.apiSelection = apiSelection;
            this.state.uiElements.apiFormatIndicator = apiFormatIndicator;

            // API切换按钮
            const apiSwitchGroup = document.createElement('div');
            apiSwitchGroup.className = 'control-group';

            const prevBtn = this.createButton('<', 'api-switch', () => this.switchToPrevApi());
            const apiSelectBtn = this.createButton('API', 'api-select', () => this.showSettingsPanel());
            const nextBtn = this.createButton('>', 'api-switch', () => this.switchToNextApi());

            apiSwitchGroup.appendChild(prevBtn);
            apiSwitchGroup.appendChild(apiSelectBtn);
            apiSwitchGroup.appendChild(nextBtn);
            mainPanel.appendChild(apiSwitchGroup);

            // 保存API选择按钮引用
            this.state.uiElements.apiSelectButton = apiSelectBtn;

            // 控制按钮组
            const controlGroup = document.createElement('div');
            controlGroup.className = 'control-group';
            const positionBtn = this.createButton('切换位置', 'position', () => this.togglePanelPosition());
            controlGroup.appendChild(positionBtn);
            mainPanel.appendChild(controlGroup);

            // 手动隐藏按钮
            const manualHideBtn = this.createButton('隐藏', 'manual-hide-button', () => this.manualHidePanel());
            mainPanel.appendChild(manualHideBtn);

            // 根据页面类型添加按钮
            if (this.state.pageInfo.type === 'page') {
                this.createPageButtons(mainPanel);
            } else if (this.state.pageInfo.type === 'reader') {
                this.createReaderButtons(mainPanel);
            }

            // 显示按钮
            const showButton = document.createElement('button');
            showButton.className = `show-button ${this.state.config.panelPosition}`;
            showButton.textContent = '工具';
            showButton.addEventListener('click', () => this.showPanel());
            document.body.appendChild(showButton);
            this.state.uiElements.showButton = showButton;

            // 设置面板和遮罩
            const overlay = document.createElement('div');
            overlay.className = 'overlay';
            overlay.addEventListener('click', () => this.hideSettingsPanel());
            document.body.appendChild(overlay);
            this.state.uiElements.overlay = overlay;

            const settingsPanel = this.createSettingsPanel();
            document.body.appendChild(settingsPanel);
            this.state.uiElements.settingsPanel = settingsPanel;

            // 立即更新API显示
            this.updateApiSelectionDisplay();
        }

        /**
         * 创建按钮
         * @param {string} text - 按钮文本
         * @param {string} className - 按钮类名
         * @param {Function} onClick - 点击事件处理函数
         * @returns {HTMLElement} 按钮元素
         */
        createButton(text, className, onClick) {
            const btn = document.createElement('button');
            btn.className = `tamper-button ${className}`;
            btn.textContent = text;
            btn.addEventListener('click', onClick);
            return btn;
        }

        /**
         * 创建页面类型按钮
         * @param {HTMLElement} panel - 父面板元素
         */
        createPageButtons(panel) {
            panel.appendChild(this.createButton('下载TXT', 'txt', () => this.startDownload('txt')));
            panel.appendChild(this.createButton('下载EPUB', 'epub', () => this.startDownload('epub')));
            panel.appendChild(this.createButton('设置', 'settings', () => this.showSettingsPanel()));

            // 进度条
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

            // 统计信息
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
            panel.appendChild(statsContainer);

            this.state.uiElements.progressContainer = progressContainer;
            this.state.uiElements.progressFill = progressFill;
            this.state.uiElements.totalStat = statsContainer.querySelector('.total-value');
            this.state.uiElements.successStat = statsContainer.querySelector('.success-value');
            this.state.uiElements.failedStat = statsContainer.querySelector('.failed-value');
        }

        /**
         * 创建阅读器类型按钮
         * @param {HTMLElement} panel - 父面板元素
         */
        createReaderButtons(panel) {
            panel.appendChild(this.createButton('下载本章', 'download-chapter', () => this.downloadCurrentChapter()));
            panel.appendChild(this.createButton('设置', 'settings', () => this.showSettingsPanel()));

            // 状态指示器
            const statusIndicator = document.createElement('div');
            statusIndicator.className = 'auto-replace-status';
            this.updateStatusDisplay(statusIndicator, this.state.config.autoReplaceEnabled ? 'enabled' : 'disabled');
            panel.appendChild(statusIndicator);
            this.state.uiElements.statusIndicator = statusIndicator;

            // 控制按钮
            const controlButtons = document.createElement('div');
            controlButtons.className = 'control-buttons';
            controlButtons.appendChild(this.createButton('处理', 'replace', () => this.manualReplaceContent()));
            controlButtons.appendChild(this.createButton('重置', 'reset', () => this.resetReplaceState()));
            panel.appendChild(controlButtons);
        }

        /**
         * 创建设置面板
         * @returns {HTMLElement} 设置面板元素
         */
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

                <!-- API配置部分 -->
                <div class="api-config-section">
                    <div class="api-config-header">
                        <div class="api-config-title">API配置管理</div>
                        <button class="api-config-add" id="addApiConfig">添加API</button>
                    </div>
                    <div class="api-config-list" id="apiConfigsList"></div>

                    <!-- API编辑表单 -->
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
                                <option value="v2">V2格式 (content在data中)</option>
                                <option value="v1">V1格式 (content在根级)</option>
                            </select>
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

            // 绑定事件
            panel.querySelector('#saveGlobalSettings').addEventListener('click', () => this.saveGlobalSettings());
            panel.querySelector('.settings-button.settings-cancel').addEventListener('click', () => this.hideSettingsPanel());

            // API配置事件
            panel.querySelector('#addApiConfig').addEventListener('click', () => this.addNewApiConfig());
            panel.querySelector('#saveApiConfig').addEventListener('click', () => this.saveApiConfig());
            panel.querySelector('#cancelApiEdit').addEventListener('click', () => this.cancelApiEdit());

            return panel;
        }

        /**
         * 设置事件监听器
         */
        setupEventListeners() {
            const container = this.state.uiElements.container;
            if (container) {
                container.addEventListener('mouseenter', () => this.showPanel());
                container.addEventListener('mouseleave', () => this.onPanelMouseLeave());
            }

            window.addEventListener('resize', Utils.debounce(() => {
                this.updatePanelPosition();
            }, Constants.DEBOUNCE_DELAY));
        }

        // ==============================
        // UI控制方法
        // ==============================

        /**
         * 显示面板
         */
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

        /**
         * 隐藏面板
         * @param {boolean} force - 是否强制隐藏
         */
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

        /**
         * 手动隐藏面板
         */
        manualHidePanel() {
            this.hidePanel(true);
        }

        /**
         * 面板鼠标离开事件
         */
        onPanelMouseLeave() {
            if (this.state.config.autoHideEnabled && this.isPanelVisible()) {
                this.setAutoHideTimer();
            }
        }

        /**
         * 设置自动隐藏计时器
         */
        setAutoHideTimer() {
            this.clearAutoHideTimer();

            if (this.state.config.autoHideEnabled) {
                this.state.timers.autoHideTimer = setTimeout(() => {
                    this.hidePanel(true);
                }, this.state.config.autoHideDelay);
            }
        }

        /**
         * 清除自动隐藏计时器
         */
        clearAutoHideTimer() {
            if (this.state.timers.autoHideTimer) {
                clearTimeout(this.state.timers.autoHideTimer);
                this.state.timers.autoHideTimer = null;
            }
        }

        /**
         * 检查面板是否可见
         * @returns {boolean} 是否可见
         */
        isPanelVisible() {
            const container = this.state.uiElements.container;
            return container && !container.classList.contains('hidden') && container.style.display !== 'none';
        }

        /**
         * 更新面板位置
         */
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

        /**
         * 切换面板位置
         */
        togglePanelPosition() {
            const newPosition = this.state.config.panelPosition === 'right' ? 'left' : 'right';
            this.state.config.panelPosition = newPosition;
            this.updatePanelPosition();
            Config.saveGlobalConfig(this.state.config);
            this.showNotification(`面板已切换到${newPosition === 'right' ? '右侧' : '左侧'}`);
        }

        // ==============================
        // API配置管理
        // ==============================

        /**
         * 切换到上一个API
         */
        switchToPrevApi() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();
            const prevIndex = (currentIndex - 1 + configs.length) % configs.length;

            Config.setCurrentApiIndex(prevIndex);
            this.applyApiChange();
        }

        /**
         * 切换到下一个API
         */
        switchToNextApi() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();
            const nextIndex = (currentIndex + 1) % configs.length;

            Config.setCurrentApiIndex(nextIndex);
            this.applyApiChange();
        }

        /**
         * 应用API变更
         */
        applyApiChange() {
            this.state.config = Config.getGlobalConfig();
            const currentApi = Config.getCurrentApiConfig();

            this.updateApiSelectionDisplay();
            this.resetContentReplaceState();

            const formatText = this.getFormatDisplayName(currentApi.format);
            this.showNotification(`已切换到API: ${currentApi.name} (格式: ${formatText})`);

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

        /**
         * 获取格式的显示名称
         * @param {string} format - 格式代码
         * @returns {string} 格式显示名称
         */
        getFormatDisplayName(format) {
            switch (format) {
                case Constants.API_FORMATS.V1:
                    return 'V1';
                case Constants.API_FORMATS.V2:
                    return 'V2';
                default:
                    return '未知';
            }
        }

        /**
         * 更新API选择显示
         */
        updateApiSelectionDisplay() {
            try {
                const currentApi = Config.getCurrentApiConfig();
                const apiConfigs = Config.getApiConfigs();

                // 更新API选择显示
                if (this.state.uiElements.apiSelection) {
                    this.state.uiElements.apiSelection.textContent = `API: ${currentApi.name}`;
                }

                // 更新API格式显示
                if (this.state.uiElements.apiFormatIndicator) {
                    const formatText = this.getFormatDisplayName(currentApi.format);
                    this.state.uiElements.apiFormatIndicator.textContent = `格式: ${formatText}`;
                }

                // 更新API选择按钮文本
                if (this.state.uiElements.apiSelectButton) {
                    this.state.uiElements.apiSelectButton.textContent = currentApi.name;
                }

            } catch (error) {
                console.error('更新API显示时出错:', error);
                // 显示默认信息
                if (this.state.uiElements.apiSelection) {
                    this.state.uiElements.apiSelection.textContent = 'API: 未知';
                }
                if (this.state.uiElements.apiFormatIndicator) {
                    this.state.uiElements.apiFormatIndicator.textContent = '格式: 未知';
                }
                if (this.state.uiElements.apiSelectButton) {
                    this.state.uiElements.apiSelectButton.textContent = 'API';
                }
            }
        }

        // ==============================
        // 设置面板方法
        // ==============================

        /**
         * 显示设置面板
         */
        showSettingsPanel() {
            if (this.state.uiElements.settingsPanel) {
                this.state.uiElements.settingsPanel.classList.add('active');
            }
            if (this.state.uiElements.overlay) {
                this.state.uiElements.overlay.classList.add('active');
            }

            // 加载当前设置
            const settingsPanel = this.state.uiElements.settingsPanel;
            if (settingsPanel) {
                const autoReplaceToggle = settingsPanel.querySelector('#autoReplaceToggle');
                const autoHideToggle = settingsPanel.querySelector('#autoHideToggle');
                const autoHideDelayInput = settingsPanel.querySelector('#autoHideDelayInput');

                if (autoReplaceToggle) autoReplaceToggle.checked = this.state.config.autoReplaceEnabled;
                if (autoHideToggle) autoHideToggle.checked = this.state.config.autoHideEnabled;
                if (autoHideDelayInput) autoHideDelayInput.value = this.state.config.autoHideDelay / 1000;
            }

            this.loadApiConfigsList();
        }

        /**
         * 隐藏设置面板
         */
        hideSettingsPanel() {
            if (this.state.uiElements.settingsPanel) {
                this.state.uiElements.settingsPanel.classList.remove('active');
            }
            if (this.state.uiElements.overlay) {
                this.state.uiElements.overlay.classList.remove('active');
            }

            // 隐藏API编辑表单
            const apiEditForm = this.state.uiElements.settingsPanel?.querySelector('#apiEditForm');
            if (apiEditForm) {
                apiEditForm.style.display = 'none';
            }
        }

        /**
         * 加载API配置列表
         */
        loadApiConfigsList() {
            const configs = Config.getApiConfigs();
            const currentIndex = Config.getCurrentApiIndex();

            const apiConfigsList = this.state.uiElements.settingsPanel?.querySelector('#apiConfigsList');
            if (!apiConfigsList) return;

            apiConfigsList.innerHTML = '';

            configs.forEach((config, index) => {
                const configItem = document.createElement('div');
                configItem.className = `api-config-item ${index === currentIndex ? 'active' : ''}`;

                // 显示API URL的前50个字符
                const displayUrl = config.url.length > 50
                    ? config.url.substring(0, 50) + '...'
                    : config.url;

                const formatText = this.getFormatDisplayName(config.format);

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
                `;

                // 点击切换API
                configItem.addEventListener('click', (e) => {
                    if (!e.target.closest('.api-config-actions')) {
                        Config.setCurrentApiIndex(index);
                        this.applyApiChange();
                        this.hideSettingsPanel();
                    }
                });

                // 编辑按钮
                const editBtn = configItem.querySelector('.api-config-edit');
                editBtn.addEventListener('click', () => this.editApiConfig(index));

                // 删除按钮
                const deleteBtn = configItem.querySelector('.api-config-delete');
                deleteBtn.addEventListener('click', () => this.deleteApiConfig(index));

                apiConfigsList.appendChild(configItem);
            });
        }

        /**
         * 添加新API配置
         */
        addNewApiConfig() {
            const newConfig = Config.getDefaultApiConfig();
            newConfig.name = `API ${Config.getApiConfigs().length + 1}`;
            this.editApiConfig(-1);
        }

        /**
         * 编辑API配置
         * @param {number} index - 配置索引
         */
        editApiConfig(index) {
            const configs = Config.getApiConfigs();
            const config = configs[index] || Config.getDefaultApiConfig();

            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            const apiEditForm = settingsPanel.querySelector('#apiEditForm');
            const apiNameInput = settingsPanel.querySelector('#apiNameInput');
            const apiUrlInput = settingsPanel.querySelector('#apiUrlInput');
            const apiFormatSelect = settingsPanel.querySelector('#apiFormatSelect');
            const apiTimeoutInput = settingsPanel.querySelector('#apiTimeoutInput');
            const apiConcurrentInput = settingsPanel.querySelector('#apiConcurrentInput');

            if (apiEditForm && apiNameInput && apiUrlInput && apiFormatSelect && apiTimeoutInput && apiConcurrentInput) {
                apiEditForm.style.display = 'block';
                apiEditForm.dataset.index = index;
                this.state.currentEditingApiIndex = index;

                apiNameInput.value = config.name || '';
                apiUrlInput.value = config.url || '';
                apiFormatSelect.value = config.format || Constants.API_FORMATS.V2;
                apiTimeoutInput.value = config.timeout / 1000 || Constants.DEFAULT_TIMEOUT / 1000;
                apiConcurrentInput.value = config.concurrentRequests || Constants.DEFAULT_CONCURRENT_REQUESTS;

                setTimeout(() => {
                    apiEditForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            }
        }

        /**
         * 保存API配置
         */
        saveApiConfig() {
            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            const apiEditForm = settingsPanel.querySelector('#apiEditForm');
            const apiNameInput = settingsPanel.querySelector('#apiNameInput');
            const apiUrlInput = settingsPanel.querySelector('#apiUrlInput');
            const apiFormatSelect = settingsPanel.querySelector('#apiFormatSelect');
            const apiTimeoutInput = settingsPanel.querySelector('#apiTimeoutInput');
            const apiConcurrentInput = settingsPanel.querySelector('#apiConcurrentInput');

            if (!apiEditForm || !apiNameInput || !apiUrlInput || !apiFormatSelect || !apiTimeoutInput || !apiConcurrentInput) {
                this.showNotification('表单元素缺失', false);
                return;
            }

            const index = parseInt(apiEditForm.dataset.index || '-1');
            const name = apiNameInput.value.trim() || '';
            const url = apiUrlInput.value.trim() || '';
            const format = apiFormatSelect.value || Constants.API_FORMATS.V2;
            const timeout = parseInt(apiTimeoutInput.value) * 1000 || Constants.DEFAULT_TIMEOUT;
            const concurrentRequests = parseInt(apiConcurrentInput.value) || Constants.DEFAULT_CONCURRENT_REQUESTS;

            if (!name) {
                this.showNotification('请输入API名称', false);
                return;
            }

            if (!url) {
                this.showNotification('请输入API地址', false);
                return;
            }

            // 检查是否包含占位符
            if (!url.includes(Constants.CHAPTER_ID_PLACEHOLDER)) {
                const confirmAdd = confirm(`API地址中未包含章节ID占位符 ${Constants.CHAPTER_ID_PLACEHOLDER}\n\n是否自动在URL末尾添加?\n\n(如果您的API不需要占位符，请点击取消)`);
                if (confirmAdd) {
                    const separator = url.includes('?') ? '&' : '?';
                    url = `${url}${separator}${Constants.CHAPTER_ID_PLACEHOLDER}`;
                }
            }

            const config = { name, url, format, timeout, concurrentRequests };

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

        /**
         * 取消API编辑
         */
        cancelApiEdit() {
            const apiEditForm = this.state.uiElements.settingsPanel?.querySelector('#apiEditForm');
            if (apiEditForm) {
                apiEditForm.style.display = 'none';
            }
            this.state.currentEditingApiIndex = -1;
        }

        /**
         * 删除API配置
         * @param {number} index - 配置索引
         */
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

        /**
         * 保存全局设置
         */
        saveGlobalSettings() {
            const settingsPanel = this.state.uiElements.settingsPanel;
            if (!settingsPanel) return;

            let settingsChanged = false;
            const newConfig = { ...this.state.config };

            const autoReplaceToggle = settingsPanel.querySelector('#autoReplaceToggle');
            const autoHideToggle = settingsPanel.querySelector('#autoHideToggle');
            const autoHideDelayInput = settingsPanel.querySelector('#autoHideDelayInput');

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

            if (settingsChanged) {
                this.state.config = newConfig;
                Config.saveGlobalConfig(newConfig);
                this.showNotification('全局设置已保存');
            } else {
                this.showNotification('未检测到变化');
            }
        }

        // ==============================
        // 内容处理方法
        // ==============================

        /**
         * 获取章节ID
         * @returns {string|null} 章节ID
         */
        getChapterId() {
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
        }

        /**
         * 构建API URL
         * @param {string} apiUrlTemplate - API URL模板
         * @param {string} chapterId - 章节ID
         * @returns {string} 构建后的API URL
         */
        buildApiUrl(apiUrlTemplate, chapterId) {
            if (!apiUrlTemplate || !chapterId) {
                throw new Error('API URL模板或章节ID缺失');
            }

            // 如果包含占位符，直接替换
            if (apiUrlTemplate.includes(Constants.CHAPTER_ID_PLACEHOLDER)) {
                return apiUrlTemplate.replace(new RegExp(Constants.CHAPTER_ID_PLACEHOLDER, 'g'), chapterId);
            }

            // 否则在URL末尾添加章节ID
            const separator = apiUrlTemplate.includes('?') ? '&' : '?';
            return `${apiUrlTemplate}${separator}${chapterId}`;
        }

        /**
         * 解析API响应
         * @param {Object} data - API响应数据
         * @param {string} format - API格式
         * @returns {string} 解析后的content
         */
        parseApiResponse(data, format) {
            switch (format) {
                case Constants.API_FORMATS.V1:
                    if (data.content === undefined || data.content === null) {
                        throw new Error('V1格式响应中缺少content字段');
                    }
                    return data.content;

                case Constants.API_FORMATS.V2:
                    // V2格式只检查content是否在data中，不检查code
                    if (!data.data || data.data.content === undefined || data.data.content === null) {
                        throw new Error('V2格式响应中缺少data.content字段');
                    }
                    return data.data.content;

                default:
                    throw new Error(`不支持的API格式: ${format}`);
            }
        }

        /**
         * 执行内容替换
         * @param {string} chapterId - 章节ID
         * @param {boolean} isAuto - 是否自动处理
         * @returns {boolean} 是否替换成功
         */
        async performContentReplace(chapterId, isAuto = false) {
            const currentApi = Config.getCurrentApiConfig();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return false;
            }

            if (this.state.replaceInProgress) return false;
            this.state.replaceInProgress = true;

            try {
                this.updateStatusDisplay(this.state.uiElements.statusIndicator, 'checking', 'API请求');

                // 构建API URL
                const apiUrl = this.buildApiUrl(currentApi.url, chapterId);

                const response = await Network.requestWithRetry(apiUrl, {
                    headers: { 'Accept': 'application/json' },
                    timeout: currentApi.timeout
                });

                if (!response.responseText.trim()) throw new Error('API返回空响应');

                const data = JSON.parse(response.responseText);
                const parsedContent = this.parseApiResponse(data, currentApi.format);

                const { title: chapterTitle, content: articleContent } = Utils.extractContentAndTitle(parsedContent);
                const formattedContent = Utils.formatContent(articleContent, false);

                let contentContainer;
                try {
                    contentContainer = await Utils.waitForContentContainer();
                } catch (error) {
                    contentContainer = Utils.findContentContainer();
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
                        contentHash: Utils.getContentHash(contentContainer.innerHTML),
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

        /**
         * 获取友好的错误信息
         * @param {Error} error - 错误对象
         * @returns {string} 友好的错误信息
         */
        getFriendlyErrorMessage(error) {
            if (error.message.includes('API返回空响应')) {
                return 'API返回空数据，可能章节不存在或API不可用';
            } else if (error.message.includes('请求超时')) {
                return 'API请求超时，请检查网络连接或调整超时设置';
            } else if (error.message.includes('JSON')) {
                return 'API返回格式错误，可能API已更新';
            } else if (error.message.includes('API返回错误:')) {
                return error.message;
            } else if (error.message.includes('缺少content字段')) {
                return 'API响应格式错误: ' + error.message;
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

        /**
         * 手动替换内容
         */
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

        /**
         * 重置替换状态
         */
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

        /**
         * 重置内容替换状态
         */
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

        // ==============================
        // URL观察器
        // ==============================

        /**
         * 启动URL观察器
         */
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

            this.state.timers.urlCheckTimer = setInterval(checkUrlChange, Constants.URL_CHECK_INTERVAL);

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

        /**
         * 停止URL观察器
         */
        stopUrlObserver() {
            if (this.state.timers.urlCheckTimer) {
                clearInterval(this.state.timers.urlCheckTimer);
                this.state.timers.urlCheckTimer = null;
            }
        }

        // ==============================
        // 初始化方法
        // ==============================

        /**
         * 初始化阅读器页面
         */
        async initReaderPage() {
            if (this.state.config.autoReplaceEnabled) {
                const chapterId = this.getChapterId();
                if (chapterId) {
                    await this.performContentReplace(chapterId, true);
                }
            }
        }

        /**
         * 初始化页面页面
         */
        async initPagePage() {
            try {
                this.state.bookInfo = await this.fetchBookInfo();
                this.state.chapters = await this.fetchChapters();
                this.updateStats(this.state.chapters.length, 0, 0);
            } catch (error) {
                console.error('初始化失败:', error);
                this.showNotification('初始化失败: ' + error.message, false);
            }
        }

        // ==============================
        // 活动监控
        // ==============================

        /**
         * 启动活动监控
         */
        startActivityMonitoring() {
            const throttledActivity = Utils.throttle(() => this.recordActivity(), Constants.THROTTLE_DELAY);

            // 桌面端事件
            ['mousemove', 'keydown', 'scroll', 'click'].forEach(eventType => {
                document.addEventListener(eventType, throttledActivity);
            });

            // 移动端触摸事件
            ['touchstart', 'touchend'].forEach(eventType => {
                document.addEventListener(eventType, throttledActivity, { passive: true });
            });

            // 检查空闲状态
            setInterval(() => this.checkIdleState(), 30000);
        }

        /**
         * 记录活动
         */
        recordActivity() {
            this.state.lastActivityTime = Date.now();
            if (this.state.contentReplaceState.isIdle) {
                this.state.contentReplaceState.isIdle = false;
                this.state.contentReplaceState.stableCount = 0;
            }
        }

        /**
         * 检查空闲状态
         */
        checkIdleState() {
            const now = Date.now();
            if (!this.state.contentReplaceState.isIdle && now - this.state.lastActivityTime > Constants.IDLE_TIMEOUT) {
                this.state.contentReplaceState.isIdle = true;
            }
        }

        // ==============================
        // 下载管理
        // ==============================

        /**
         * 获取书籍信息
         * @returns {Object} 书籍信息
         */
        async fetchBookInfo() {
            try {
                const response = await Network.requestWithRetry(
                    `https://i.snssdk.com/reading/bookapi/multi-detail/v/?aid=1967&book_id=${this.state.pageInfo.bookId}`,
                    { timeout: this.state.config.timeout }
                );
                const data = JSON.parse(response.responseText);

                if (!data.data?.[0]) throw new Error('未获取到书籍信息');

                const book = data.data[0];
                const formattedAbstract = book.abstract ? book.abstract.replace(/\s/g, '\n').replace(/\n{2,}/g, '\n') : '';

                return {
                    title: Utils.sanitizeFilename(book.book_name),
                    author: Utils.sanitizeFilename(book.author),
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

        /**
         * 获取章节列表
         * @returns {Array} 章节列表
         */
        async fetchChapters() {
            try {
                const response = await Network.requestWithRetry(
                    `https://fanqienovel.com/api/reader/directory/detail?bookId=${this.state.pageInfo.bookId}`,
                    { timeout: this.state.config.timeout }
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

        /**
         * 下载单个章节
         * @param {string} chapterId - 章节ID
         * @param {number} index - 章节索引
         * @param {string} chapterTitle - 章节标题
         * @returns {Object} 下载结果
         */
        async downloadChapter(chapterId, index, chapterTitle) {
            const currentApi = Config.getCurrentApiConfig();
            if (!currentApi.url) {
                return {
                    title: chapterTitle || `第${index + 1}章`,
                    content: `[错误: 请先在设置中配置API地址 (${currentApi.name})]`,
                    success: false
                };
            }

            try {
                // 构建API URL
                const apiUrl = this.buildApiUrl(currentApi.url, chapterId);

                const response = await Network.requestWithRetry(
                    apiUrl,
                    { headers: { 'Accept': 'application/json' }, timeout: currentApi.timeout }
                );

                if (!response.responseText.trim()) throw new Error('空响应');

                const data = JSON.parse(response.responseText);
                const parsedContent = this.parseApiResponse(data, currentApi.format);

                const { title: apiTitle, content: articleContent } = Utils.extractContentAndTitle(parsedContent);
                const finalTitle = apiTitle || chapterTitle || `第${index + 1}章`;

                return {
                    title: finalTitle,
                    content: Utils.formatContent(articleContent, true),
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
        }

        /**
         * 批量下载章节
         * @param {Array} chapterIds - 章节ID列表
         * @returns {Array} 下载结果列表
         */
        async downloadChaptersBatch(chapterIds) {
            const currentApi = Config.getCurrentApiConfig();
            const results = [];
            const total = chapterIds.length;
            let completed = 0;
            let successCount = 0;
            let failedCount = 0;

            const batchSize = currentApi.concurrentRequests;
            const debouncedUpdate = Utils.debounce((completed, total, successCount, failedCount) => {
                this.updateProgress((completed / total) * 100);
                this.updateStats(total, successCount, failedCount);
            }, Constants.DEBOUNCE_DELAY);

            for (let i = 0; i < total; i += batchSize) {
                const batch = chapterIds.slice(i, i + batchSize);
                const batchPromises = batch.map((chapter, batchIndex) =>
                    this.downloadChapter(chapter.id, i + batchIndex, chapter.title)
                );

                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);

                batchResults.forEach(result => {
                    result.success ? successCount++ : failedCount++;
                });

                completed += batch.length;
                debouncedUpdate(completed, total, successCount, failedCount);

                if (i + batchSize < total) {
                    await new Promise(resolve => setTimeout(resolve, Math.random() * Constants.CHAPTER_DOWNLOAD_DELAY + 200));
                }
            }

            return results;
        }

        /**
         * 生成EPUB文件
         * @param {Object} bookInfo - 书籍信息
         * @param {Array} chapters - 章节列表
         * @param {Array} contents - 章节内容列表
         * @param {string} coverUrl - 封面URL
         * @returns {Promise<Blob>} EPUB文件Blob
         */
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
                    });
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

        /**
         * 开始下载
         * @param {string} format - 下载格式
         */
        async startDownload(format) {
            if (this.state.isDownloading) return;

            const currentApi = Config.getCurrentApiConfig();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return;
            }

            this.state.isDownloading = true;
            const buttons = document.querySelectorAll('.tamper-button.txt, .tamper-button.epub');
            buttons.forEach(btn => btn.disabled = true);
            if (this.state.uiElements.progressContainer) {
                this.state.uiElements.progressContainer.style.display = 'block';
            }
            this.showNotification(`使用API: ${currentApi.name} 开始下载章节内容...`);

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

                this.showNotification(`下载完成！成功: ${successCount}, 失败: ${failedCount}`);
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

        /**
         * 下载当前章节
         */
        async downloadCurrentChapter() {
            const chapterId = this.getChapterId();

            if (!chapterId) {
                this.showNotification('未找到章节ID，请检查URL格式', false);
                return;
            }

            const currentApi = Config.getCurrentApiConfig();
            if (!currentApi.url) {
                this.showNotification(`请先在设置中配置API地址 (${currentApi.name})`, false);
                return;
            }

            this.showNotification(`使用API: ${currentApi.name} 开始下载当前章节...`);

            try {
                const result = await this.downloadChapter(chapterId, 0, '当前章节');

                if (result.success) {
                    let chapterContent = `章节：${result.title}\n\n`;
                    chapterContent += result.content;
                    chapterContent += '\n\n---\n免责声明：本工具仅为个人学习、研究或欣赏目的提供便利，下载的小说版权归原作者及版权方所有。';

                    const sanitizedTitle = Utils.sanitizeFilename(result.title);
                    saveAs(new Blob([chapterContent], { type: 'text/plain;charset=utf-8' }), `${sanitizedTitle}.txt`);

                    this.showNotification(`章节下载成功！${result.title}`);
                } else {
                    this.showNotification(`下载失败: ${result.content}`, false);
                }
            } catch (error) {
                console.error('章节下载错误:', error);
                this.showNotification('下载失败: ' + error.message, false);
            }
        }

        // ==============================
        // 辅助方法
        // ==============================

        /**
         * 更新状态显示
         * @param {HTMLElement} indicator - 状态指示器
         * @param {string} statusKey - 状态关键字
         * @param {string} extraInfo - 额外信息
         */
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

        /**
         * 更新进度条
         * @param {number} percentage - 进度百分比
         */
        updateProgress(percentage) {
            if (this.state.uiElements.progressFill) {
                this.state.uiElements.progressFill.style.width = `${percentage}%`;
            }
        }

        /**
         * 更新统计信息
         * @param {number} total - 总数
         * @param {number} success - 成功数
         * @param {number} failed - 失败数
         */
        updateStats(total, success, failed) {
            if (this.state.uiElements.totalStat) {
                this.state.uiElements.totalStat.textContent = total;
            }
            if (this.state.uiElements.successStat) {
                this.state.uiElements.successStat.textContent = success;
            }
            if (this.state.uiElements.failedStat) {
                this.state.uiElements.failedStat.textContent = failed;
            }
        }

        /**
         * 显示通知
         * @param {string} message - 通知消息
         * @param {boolean} isSuccess - 是否成功消息
         */
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
            }, Constants.NOTIFICATION_DURATION);
        }
    }

    // ==============================
    // 应用启动
    // ==============================
    window.addEventListener('load', () => {
        const app = new FanqieEnhancer();

        // 监听页面刷新或导航
        window.addEventListener('beforeunload', () => {
            if (app && app.stopUrlObserver) {
                app.stopUrlObserver();
            }

            // 清理所有计时器
            if (app && app.state && app.state.timers) {
                Object.values(app.state.timers).forEach(timer => {
                    if (timer) clearTimeout(timer);
                });
            }
        });
    });

})();
