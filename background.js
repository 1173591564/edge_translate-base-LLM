// ============================================================
// DeepSeek 智能翻译 - Background Service Worker
// 职责：API Key 安全管理 + DeepSeek API 调用 + 翻译调度
// ============================================================

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';
const MAX_CONCURRENT = 5;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// 全局状态（仅持久化 apiKey 和 autoTranslate）
let state = {
  apiKey: '',
  autoTranslate: false,
};

// Per-tab AbortController（替代全局单一变量）
const abortControllers = new Map(); // tabId -> AbortController

// Per-tab 取消标记（替代全局 cancelRequested）
const cancelFlags = new Map(); // tabId -> boolean

// 已自动翻译的 tab（防重复）
let autoTranslatedTabs = new Set();

// ============================================================
// 启动：从 storage 恢复持久状态
// ============================================================

async function loadState() {
  const stored = await chrome.storage.local.get(['apiKey', 'autoTranslate']);
  state.apiKey = stored.apiKey || '';
  state.autoTranslate = stored.autoTranslate || false;

  // 恢复 autoTranslatedTabs
  const session = await chrome.storage.session.get(['autoTranslatedTabs']);
  if (session.autoTranslatedTabs) {
    autoTranslatedTabs = new Set(session.autoTranslatedTabs);
  }
}

const stateReady = loadState();

// 持久化 autoTranslatedTabs
async function saveAutoTranslatedTabs() {
  await chrome.storage.session.set({
    autoTranslatedTabs: [...autoTranslatedTabs],
  });
}

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;
  const tabId = sender.tab?.id;

  switch (type) {
    case 'GET_STATE':
      stateReady.then(() => sendResponse({
        hasApiKey: !!state.apiKey,
        autoTranslate: state.autoTranslate,
      }));
      return true;

    case 'SAVE_API_KEY':
      handleSaveApiKey(data.apiKey).then(() => sendResponse({ ok: true }));
      return true;

    case 'TOGGLE_AUTO':
      handleToggleAuto().then(result => sendResponse(result));
      return true;

    case 'TRANSLATE_BATCHES': {
      const offset = data.offset || 0;
      const isIncremental = offset > 0;
      stateReady.then(() => {
        try {
          const info = kickOffTranslation(data.batches, tabId, offset, isIncremental);
          sendResponse(info);
        } catch (err) {
          sendResponse({ error: err.message });
        }
      });
      return true;
    }

    case 'CANCEL_TRANSLATE':
      if (tabId) {
        cancelFlags.set(tabId, true);
        const controller = abortControllers.get(tabId);
        if (controller) controller.abort();
      }
      sendResponse({ ok: true });
      break;

    // TRANSLATION_DONE 已移除：IIFE 内自行管理状态
  }
});

// ============================================================
// 处理器
// ============================================================

async function handleSaveApiKey(apiKey) {
  state.apiKey = apiKey;
  await chrome.storage.local.set({ apiKey });
}

async function handleToggleAuto() {
  state.autoTranslate = !state.autoTranslate;
  await chrome.storage.local.set({ autoTranslate: state.autoTranslate });
  return { autoTranslate: state.autoTranslate };
}

// ============================================================
// 翻译批次处理（核心）
// ============================================================

function kickOffTranslation(batches, tabId, offset = 0, isIncremental = false) {
  if (!state.apiKey) {
    throw new Error('请先配置 API Key');
  }

  // Per-tab AbortController
  const abortController = new AbortController();
  abortControllers.set(tabId, abortController);
  cancelFlags.delete(tabId);

  const totalBatches = batches.length;
  let successCount = 0;
  let failedCount = 0;

  // 信号量控制并发
  const semaphore = {
    count: 0,
    max: MAX_CONCURRENT,
    queue: [],
    async acquire() {
      if (this.count < this.max) { this.count++; return; }
      return new Promise(resolve => this.queue.push(resolve));
    },
    release() {
      this.count--;
      if (this.queue.length > 0) { this.count++; this.queue.shift()(); }
    },
  };

  (async () => {
    const tasks = batches.map(async (batch, batchIndex) => {
      await semaphore.acquire();
      try {
        // Per-tab 取消检查
        if (cancelFlags.get(tabId)) return;

        const translated = await translateOneBatch(batch, abortController.signal);

        // 逐批推送翻译结果到 content.js
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'BATCH_RESULT',
            data: { batchIndex: batchIndex + offset, translations: translated.translations },
          }).catch(() => {});
        }

        successCount++;

        // 增量翻译不广播进度（避免进度条回退）
        if (!isIncremental) {
          broadcastProgress(successCount + failedCount, totalBatches, tabId, failedCount);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(`[Translate] Batch ${batchIndex} failed:`, err);
        failedCount++;
        if (!isIncremental) {
          broadcastProgress(successCount + failedCount, totalBatches, tabId, failedCount);
        }
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled(tasks);

    // 仅在当前 controller 仍是自己时清理
    if (abortControllers.get(tabId) === abortController) {
      abortControllers.delete(tabId);
    }
    cancelFlags.delete(tabId);

    // 通知 content.js 所有批次完成
    const cancelled = cancelFlags.get(tabId) === true;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'ALL_BATCHES_DONE',
        data: { totalBatches, cancelled, isIncremental, failedCount },
      }).catch(() => {});
    }

    // 通知 Popup（携带 tabId 供过滤）
    chrome.runtime.sendMessage({
      type: 'TRANSLATION_COMPLETE',
      data: { cancelled, isIncremental, failedCount, tabId },
    }).catch(() => {});
  })();

  return { ok: true, totalBatches };
}

// ============================================================
// 单批次翻译（含重试）
// ============================================================

async function translateOneBatch(batch, signal) {
  const textArray = batch.map((item, i) => `[${i}] ${item.text}`);
  const prompt = buildPrompt(textArray);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'system',
              content: '你是专业的英中翻译引擎。将用户提供的英文文本逐行翻译为中文。' +
                       '每行以 [序号] 开头，你只需翻译 [序号] 后面的内容，保持相同的 [序号] 前缀输出。' +
                       '规则：专有名词保留英文原文（HuggingFace, React, Kubernetes, GitHub 等）；' +
                       '代码、变量名、URL 不翻译；技术术语用业界通用译法。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          stream: false,
          max_tokens: 8192,
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`API ${response.status}: ${errText}`);
        err.status = response.status;
        throw err;
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('API 返回空内容');

      const translations = parseResponse(content, batch.length);
      return { ok: true, translations };
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') throw err;
      if (err.status === 401) throw err;
      if (attempt < MAX_RETRIES) {
        await abortableSleep(RETRY_DELAY_MS * (attempt + 1), signal);
      }
    }
  }
  throw lastError;
}

// ============================================================
// Prompt 构造
// ============================================================

function buildPrompt(textLines) {
  return textLines.join('\n');
}

// ============================================================
// 纯文本行号解析
// ============================================================

function parseResponse(content, expectedCount) {
  const lines = content.split('\n').filter(l => l.trim());
  const result = [];

  for (let i = 0; i < expectedCount; i++) {
    const prefix = `[${i}] `;
    // 尝试匹配 [序号] 译文 格式
    const line = lines.find(l => l.startsWith(`[${i}]`));
    if (line) {
      result.push({ i, t: line.replace(/^\[\d+\]\s*/, '').trim() });
    } else if (lines[i]) {
      // 回退：按行号顺序对应
      result.push({ i, t: lines[i].replace(/^\[\d+\]\s*/, '').trim() });
    } else {
      result.push({ i, t: '' });
    }
  }

  return result;
}

// ============================================================
// 自动翻译：监听页面加载完成
// ============================================================

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    autoTranslatedTabs.delete(tabId);
    await saveAutoTranslatedTabs();
  }

  if (changeInfo.status !== 'complete') return;

  // URL 协议过滤：仅处理 http/https 页面
  if (!tab.url || !/^https?:\/\//.test(tab.url)) return;

  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;

  if (autoTranslatedTabs.has(tabId)) return;
  autoTranslatedTabs.add(tabId);
  await saveAutoTranslatedTabs();

  await sleep(800);

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) { /* Content script 可能未加载 */ }
});

// 监听 SPA 路由变化
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;

  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;

  autoTranslatedTabs.delete(details.tabId);
  await saveAutoTranslatedTabs();

  await sleep(800);

  try {
    await chrome.tabs.sendMessage(details.tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) { /* Content script 可能未就绪 */ }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  autoTranslatedTabs.delete(tabId);
  abortControllers.delete(tabId);
  cancelFlags.delete(tabId);
  await saveAutoTranslatedTabs();
});

// ============================================================
// 进度广播（携带 tabId 供 Popup 过滤）
// ============================================================

function broadcastProgress(completed, total, tabId, failedCount = 0) {
  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    data: {
      completed, total,
      percent: Math.round((completed / total) * 100),
      failedCount, tabId,
    },
  }).catch(() => {});
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 可被 AbortSignal 中止的 sleep
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
