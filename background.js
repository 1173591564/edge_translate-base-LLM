// ============================================================
// DeepSeek 智能翻译 - Background Service Worker
// 职责：API Key 安全管理 + DeepSeek API 调用 + 翻译调度
// ============================================================

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_CONCURRENT = 5;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// 全局状态
let state = {
  apiKey: '',
  autoTranslate: false,
  translating: false,
  cancelRequested: false,
};

// 已自动翻译的 tab（防重复）
const autoTranslatedTabs = new Set();

// 当前翻译的 AbortController
let currentAbortController = null;

// ============================================================
// 启动：从 storage 恢复持久状态
// ============================================================

async function loadState() {
  const stored = await chrome.storage.local.get(['apiKey', 'autoTranslate']);
  state.apiKey = stored.apiKey || '';
  state.autoTranslate = stored.autoTranslate || false;
}

// 确保状态加载完成后再处理事件
const stateReady = loadState();

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;

  switch (type) {
    case 'GET_STATE':
      sendResponse({
        hasApiKey: !!state.apiKey,
        autoTranslate: state.autoTranslate,
        translating: state.translating,
      });
      break;

    case 'SAVE_API_KEY':
      handleSaveApiKey(data.apiKey).then(() => sendResponse({ ok: true }));
      return true;

    case 'TOGGLE_AUTO':
      handleToggleAuto().then(result => sendResponse(result));
      return true;

    case 'TRANSLATE_BATCHES': {
      const tabId = sender.tab?.id;
      const offset = data.offset || 0;
      const isIncremental = offset > 0;
      // 立即返回确认，翻译结果通过 BATCH_RESULT / ALL_BATCHES_DONE 推送
      try {
        const info = kickOffTranslation(data.batches, tabId, offset, isIncremental);
        sendResponse(info);
      } catch (err) {
        sendResponse({ error: err.message });
      }
      break;
    }

    case 'CANCEL_TRANSLATE':
      if (currentAbortController) {
        state.cancelRequested = true;
        currentAbortController.abort();
      }
      sendResponse({ ok: true });
      break;

    case 'TRANSLATION_DONE':
      state.translating = false;
      break;
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

  state.translating = true;
  state.cancelRequested = false;
  currentAbortController = new AbortController();

  const totalBatches = batches.length;
  let completedCount = 0;

  // 信号量控制并发
  const semaphore = {
    count: 0,
    max: MAX_CONCURRENT,
    queue: [],
    async acquire() {
      if (this.count < this.max) {
        this.count++;
        return;
      }
      return new Promise(resolve => this.queue.push(resolve));
    },
    release() {
      this.count--;
      if (this.queue.length > 0) {
        this.count++;
        this.queue.shift()();
      }
    },
  };

  // 异步执行所有批次，逐批推送结果到 content.js
  (async () => {
    const tasks = batches.map(async (batch, batchIndex) => {
      await semaphore.acquire();
      try {
        if (state.cancelRequested) return;

        const translated = await translateOneBatch(batch, currentAbortController.signal);

        // 逐批推送翻译结果到 content.js（渐进式 DOM 替换）
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'BATCH_RESULT',
            data: { batchIndex: batchIndex + offset, translations: translated.translations },
          }).catch(() => {});
        }

        completedCount++;
        broadcastProgress(completedCount, totalBatches);
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error(`[Translate] Batch ${batchIndex} failed:`, err);
        completedCount++;
        broadcastProgress(completedCount, totalBatches);
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled(tasks);

    state.translating = false;
    currentAbortController = null;

    // 通知 content.js 所有批次完成
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'ALL_BATCHES_DONE',
        data: { totalBatches, cancelled: state.cancelRequested, isIncremental },
      }).catch(() => {});
    }

    // 通知 Popup 翻译完成
    chrome.runtime.sendMessage({
      type: 'TRANSLATION_COMPLETE',
      data: { cancelled: state.cancelRequested },
    }).catch(() => {});
  })();

  // 立即返回批次总数
  return { ok: true, totalBatches };
}

// ============================================================
// 单批次翻译（含重试）
// ============================================================

async function translateOneBatch(batch, signal) {
  const textArray = batch.map((item, i) => `[i:${i}] ${item.text}`);
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
              content: '你是专业的英中翻译引擎。只输出合法的 JSON 数组，不输出任何其他内容、不输出 markdown 代码块标记。',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          stream: false,
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
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError;
}

// ============================================================
// Prompt 构造
// ============================================================

function buildPrompt(textLines) {
  return `将以下英文翻译为中文，规则：
1. 专有名词保留英文原文（如 HuggingFace, React, Kubernetes, GitHub, TensorFlow, API, HTTP, JSON 等）
2. 代码、变量名、函数名、API 名、URL、命令 不翻译
3. 技术术语使用业界通用中文译法（如 machine learning → 机器学习）
4. 输出自然流畅的简体中文

严格按以下 JSON 数组格式输出，不要输出任何其他内容：
[{"i":0,"t":"译文"},{"i":1,"t":"译文"}]

${textLines.join('\n')}`;
}

// ============================================================
// 4 层响应解析容错
// ============================================================

function parseResponse(content, expectedCount) {
  // 第 1 层：去掉 markdown 代码块包裹
  let cleaned = content
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  // 第 2 层：直接解析
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return validateTranslations(arr, expectedCount);
  } catch (e) { /* continue */ }

  // 第 3 层：正则提取 JSON 数组
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) return validateTranslations(arr, expectedCount);
    } catch (e) { /* continue */ }
  }

  // 第 4 层：尝试逐行提取翻译文本（最后手段）
  return fallbackParse(cleaned, expectedCount);
}

function validateTranslations(arr, expectedCount) {
  const result = [];
  for (let i = 0; i < expectedCount; i++) {
    // 支持 {"i":N,"t":"..."} 和 {"id":N,"translated":"..."} 两种格式
    const item = arr.find(x => (x.i === i || x.id === i));
    if (item) {
      result.push({ i, t: item.t || item.translated || '' });
    } else if (arr[i]) {
      result.push({ i, t: arr[i].t || arr[i].translated || '' });
    } else {
      result.push({ i, t: '' }); // 缺失的保持空串，由 content.js 处理
    }
  }
  return result;
}

function fallbackParse(text, expectedCount) {
  // 尝试从每行提取翻译内容
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length >= expectedCount * 0.7) {
    return lines.slice(0, expectedCount).map((line, i) => ({
      i,
      t: line.replace(/^\[\d+\]\s*/, '').replace(/^["']|["']$/g, '').trim(),
    }));
  }
  // 完全解析失败，返回原文
  return Array.from({ length: expectedCount }, (_, i) => ({ i, t: '' }));
}

// ============================================================
// 自动翻译：监听页面加载完成
// ============================================================

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // URL 变化时清除已翻译记录，允许新页面触发自动翻译
  if (changeInfo.url) {
    autoTranslatedTabs.delete(tabId);
  }

  if (changeInfo.status !== 'complete') return;

  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;

  // 防止重复翻译
  if (autoTranslatedTabs.has(tabId)) return;
  autoTranslatedTabs.add(tabId);

  // 延迟 800ms 等待页面 JS 渲染稳定
  await sleep(800);

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) {
    // Content script 可能未加载（如 chrome:// 页面）
  }
});

// 监听 SPA 路由变化（pushState / replaceState）
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // 只处理主框架

  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;

  // 清除旧记录，允许新路由触发翻译
  autoTranslatedTabs.delete(details.tabId);

  await sleep(800);

  try {
    await chrome.tabs.sendMessage(details.tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) {
    // Content script 可能未就绪
  }
});

// Tab 关闭时清理记录
chrome.tabs.onRemoved.addListener(tabId => {
  autoTranslatedTabs.delete(tabId);
});

// ============================================================
// 进度广播
// ============================================================

function broadcastProgress(completed, total) {
  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    data: { completed, total, percent: Math.round((completed / total) * 100) },
  }).catch(() => {
    // Popup 可能已关闭，忽略
  });
}

// ============================================================
// 工具函数
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
