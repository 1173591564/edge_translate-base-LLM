// ============================================================
// DeepSeek 智能翻译 - Background Service Worker
// 职责：API Key 安全管理 + DeepSeek API 调用 + 翻译调度
// ============================================================

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_CONCURRENT = 3;
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

loadState();

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

    case 'TRANSLATE_BATCHES':
      handleTranslateBatches(data.batches, sender.tab?.id)
        .then(results => sendResponse(results))
        .catch(err => sendResponse({ error: err.message }));
      return true;

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

async function handleTranslateBatches(batches, tabId) {
  if (!state.apiKey) {
    throw new Error('请先配置 API Key');
  }

  state.translating = true;
  state.cancelRequested = false;
  currentAbortController = new AbortController();

  const results = [];
  let completedCount = 0;
  const totalBatches = batches.length;

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

  const tasks = batches.map(async (batch, batchIndex) => {
    await semaphore.acquire();
    try {
      if (state.cancelRequested) return;

      const translated = await translateOneBatch(batch, currentAbortController.signal);
      results[batchIndex] = translated;
      completedCount++;

      // 推送进度到 Popup
      broadcastProgress(completedCount, totalBatches);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(`[Translate] Batch ${batchIndex} failed:`, err);
      results[batchIndex] = { error: err.message };
      completedCount++;
      broadcastProgress(completedCount, totalBatches);
    } finally {
      semaphore.release();
    }
  });

  try {
    await Promise.allSettled(tasks);
  } catch (e) {
    // 忽略（各任务内部已处理）
  }

  state.translating = false;
  currentAbortController = null;

  return { results, cancelled: state.cancelRequested };
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
      // 401 不重试（Key 问题）
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
  if (changeInfo.status !== 'complete') return;
  if (!state.autoTranslate || !state.apiKey) return;

  // 防止重复翻译
  if (autoTranslatedTabs.has(tabId)) return;
  autoTranslatedTabs.add(tabId);

  // 延迟 800ms 等待 SPA 路由稳定
  await sleep(800);

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) {
    // Content script 可能未加载（如 chrome:// 页面）
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
