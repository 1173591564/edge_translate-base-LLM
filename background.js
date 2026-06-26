// ============================================================
// DeepSeek 智能翻译 - Background Service Worker
// 职责：API Key 安全管理 + DeepSeek API 流式调用
// ============================================================

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

let state = { apiKey: '', autoTranslate: false };
const abortControllers = new Map();
const cancelFlags = new Map();
let autoTranslatedTabs = new Set();

// ============================================================
// 启动
// ============================================================

async function loadState() {
  const stored = await chrome.storage.local.get(['apiKey', 'autoTranslate']);
  state.apiKey = stored.apiKey || '';
  state.autoTranslate = stored.autoTranslate || false;
  // chrome.storage.session 可能不可用，用 try-catch 保护
  try {
    const session = await chrome.storage.session.get(['autoTranslatedTabs']);
    if (session.autoTranslatedTabs) autoTranslatedTabs = new Set(session.autoTranslatedTabs);
  } catch (e) {
    // 降级为内存存储
  }
}
const stateReady = loadState().catch(err => {
  console.error('[BG] loadState failed:', err);
});

async function saveAutoTranslatedTabs() {
  try {
    await chrome.storage.session.set({ autoTranslatedTabs: [...autoTranslatedTabs] });
  } catch (e) { /* 降级为内存存储 */ }
}

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, data } = message;
  const tabId = sender.tab?.id;

  switch (type) {
    case 'GET_STATE':
      stateReady.then(() => sendResponse({ hasApiKey: !!state.apiKey, autoTranslate: state.autoTranslate }));
      return true;

    case 'SAVE_API_KEY':
      handleSaveApiKey(data.apiKey).then(() => sendResponse({ ok: true }));
      return true;

    case 'TOGGLE_AUTO':
      handleToggleAuto().then(result => sendResponse(result));
      return true;

    case 'TRANSLATE_STREAM': {
      const isIncremental = data.isIncremental || false;
      stateReady.then(() => {
        try {
          kickOffStreamTranslation(data.items, tabId, isIncremental);
          sendResponse({ ok: true, count: data.items.length });
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
  }
});

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
// 流式翻译（单次 API 调用，逐行推送结果）
// ============================================================

function kickOffStreamTranslation(items, tabId, isIncremental) {
  if (!state.apiKey) throw new Error('请先配置 API Key');

  const abortController = new AbortController();
  abortControllers.set(tabId, abortController);
  cancelFlags.delete(tabId);

  const totalCount = items.length;

  (async () => {
    let successCount = 0;
    let failedCount = 0;

    try {
      // 构造 prompt：每行 [序号] 原文
      const lines = items.map((item, i) => `[${i}] ${item.text}`);
      const prompt = lines.join('\n');

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
          stream: true,
          thinking: { type: 'disabled' },
          max_tokens: 16384,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText}`);
      }

      // SSE 流式解析：逐 chunk 读取，检测完整 [N] 行后推送
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let currentLine = ''; // 累积当前行文本
      let lastPushedIndex = -1;
      let lineCount = 0; // 已检测到的完整行数

      while (true) {
        if (cancelFlags.get(tabId)) break;

        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const sseLines = sseBuffer.split('\n');
        sseBuffer = sseLines.pop();

        for (const sseLine of sseLines) {
          const trimmed = sseLine.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (!delta) continue;

            // 逐字符处理 delta，检测换行符切分行
            currentLine += delta;
            while (true) {
              const nlIdx = currentLine.indexOf('\n');
              if (nlIdx === -1) break;

              const completeLine = currentLine.slice(0, nlIdx);
              currentLine = currentLine.slice(nlIdx + 1);

              const match = completeLine.match(/^\[(\d+)\]\s*(.*)/);
              if (match) {
                const lineIndex = parseInt(match[1]);
                const translatedText = match[2].trim();
                if (lineIndex >= 0 && lineIndex < totalCount) {
                  successCount++;
                  if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                      type: 'LINE_RESULT',
                      data: { lineIndex, translated: translatedText },
                    }).catch(() => {});
                  }
                  if (!isIncremental) {
                    broadcastProgress(successCount + failedCount, totalCount, tabId, failedCount);
                  }
                }
              }
            }
          } catch (e) { /* 忽略不完整 JSON */ }
        }
      }

      // 处理最后一行（无换行符结尾）
      if (currentLine.trim()) {
        const match = currentLine.match(/^\[(\d+)\]\s*(.*)/);
        if (match) {
          const lineIndex = parseInt(match[1]);
          const translatedText = match[2].trim();
          if (lineIndex >= 0 && lineIndex < totalCount) {
            successCount++;
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                type: 'LINE_RESULT',
                data: { lineIndex, translated: translatedText },
              }).catch(() => {});
            }
            if (!isIncremental) {
              broadcastProgress(successCount + failedCount, totalCount, tabId, failedCount);
            }
          }
        }
      }

    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[Translate] Stream failed:', err);
        failedCount = totalCount - successCount;
      }
    }

    // 清理
    if (abortControllers.get(tabId) === abortController) {
      abortControllers.delete(tabId);
    }
    const cancelled = cancelFlags.get(tabId) === true;
    cancelFlags.delete(tabId);

    // 通知 content.js 完成
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'ALL_DONE',
        data: { cancelled, isIncremental, failedCount, totalCount },
      }).catch(() => {});
    }

    // 通知 Popup
    chrome.runtime.sendMessage({
      type: 'TRANSLATION_COMPLETE',
      data: { cancelled, isIncremental, failedCount, tabId },
    }).catch(() => {});
  })();
}

// ============================================================
// 自动翻译
// ============================================================

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    autoTranslatedTabs.delete(tabId);
    await saveAutoTranslatedTabs();
  }
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !/^https?:\/\//.test(tab.url)) return;
  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;
  if (autoTranslatedTabs.has(tabId)) return;
  autoTranslatedTabs.add(tabId);
  await saveAutoTranslatedTabs();
  await sleep(1500);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) {
    // Content script 未就绪，重试一次
    await sleep(500);
    try { await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' }); } catch (e2) {}
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await stateReady;
  if (!state.autoTranslate || !state.apiKey) return;
  autoTranslatedTabs.delete(details.tabId);
  await saveAutoTranslatedTabs();
  await sleep(1500);
  try {
    await chrome.tabs.sendMessage(details.tabId, { type: 'AUTO_TRANSLATE' });
  } catch (e) {
    await sleep(500);
    try { await chrome.tabs.sendMessage(details.tabId, { type: 'AUTO_TRANSLATE' }); } catch (e2) {}
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  autoTranslatedTabs.delete(tabId);
  abortControllers.delete(tabId);
  cancelFlags.delete(tabId);
  await saveAutoTranslatedTabs();
});

// ============================================================
// 工具函数
// ============================================================

function broadcastProgress(completed, total, tabId, failedCount = 0) {
  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    data: { completed, total, percent: Math.round((completed / total) * 100), failedCount, tabId },
  }).catch(() => {});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
