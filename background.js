// DeepSeek 智能翻译 - Background Service Worker
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

let apiKey = '';
let autoTranslate = false;
const autoTranslatedTabs = new Set();

// ---- 启动 ----
async function loadState() {
  const s = await chrome.storage.local.get(['apiKey', 'autoTranslate']);
  apiKey = s.apiKey || '';
  autoTranslate = s.autoTranslate || false;
}
const ready = loadState().catch(() => {});

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    case 'GET_STATE':
      ready.then(() => sendResponse({ hasApiKey: !!apiKey, autoTranslate }));
      return true;
    case 'SAVE_API_KEY':
      apiKey = msg.apiKey;
      chrome.storage.local.set({ apiKey }).then(() => sendResponse({ ok: true }));
      return true;
    case 'TOGGLE_AUTO':
      autoTranslate = !autoTranslate;
      chrome.storage.local.set({ autoTranslate }).then(() => sendResponse({ autoTranslate }));
      return true;
    case 'TRANSLATE':
      ready.then(() => translateStream(msg.items, tabId));
      sendResponse({ ok: true });
      return true;
    case 'QUALITY_CHECK':
      ready.then(() => checkQuality(msg.sample).then(r => sendResponse(r)));
      return true;
    case 'CANCEL': {
      const ctrl = abortControllers.get(tabId);
      if (ctrl) ctrl.abort();
      sendResponse({ ok: true });
      break;
    }
  }
});

// ---- 流式翻译 ----
const abortControllers = new Map();

async function translateStream(items, tabId) {
  if (!apiKey) return;
  const controller = new AbortController();
  abortControllers.set(tabId, controller);

  try {
    const lines = items.map((it, i) => `[${i}] ${it.text}`);

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是专业的英中翻译引擎。将用户提供的英文文本逐条翻译为中文。\n' +
              '每条以 [序号] 开头，你只需翻译 [序号] 后面的内容，保持相同的 [序号] 前缀输出。\n' +
              '严格要求：\n' +
              '1. 输入 N 条就输出 N 条，每条对应相同序号，不得多出任何条目\n' +
              '2. 每条只输出译文本身，不得添加解释、注释、括号说明或任何额外文字\n' +
              '3. 不得拆分或合并条目，不得在译文内使用换行\n' +
              '4. 忠实原文含义，不增不减；专有名词保留英文原文；代码、变量名、URL 不翻译\n' +
              '5. 技术术语用业界通用译法；保持自然流畅的中文表达\n' +
              '6. 原文中若含 «N»...«/N» 格式的标记，这是内联格式边界标记，必须在译文中原样保留对应位置，不得删除、修改或翻译这些标记',
          },
          { role: 'user', content: lines.join('\n') },
        ],
        temperature: 0.3,
        stream: true,
        max_tokens: 16384,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) throw new Error(`API ${resp.status}`);

    // SSE 解析：逐 chunk 读取，检测 [N] 行后推送给 content.js
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentLine = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const sseLines = buf.split('\n');
      buf = sseLines.pop();

      for (const sseLine of sseLines) {
        const trimmed = sseLine.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (!delta) continue;

          currentLine += delta;
          while (true) {
            const nl = currentLine.indexOf('\n');
            if (nl === -1) break;
            const line = currentLine.slice(0, nl);
            currentLine = currentLine.slice(nl + 1);
            const m = line.match(/^\[(\d+)\]\s*(.*)/);
            if (m) {
              const idx = parseInt(m[1]);
              if (idx >= 0 && idx < items.length) {
                chrome.tabs.sendMessage(tabId, {
                  type: 'LINE_RESULT',
                  data: { lineIndex: idx, translated: m[2].trim() },
                }).catch(() => {});
              }
            }
          }
        } catch {}
      }
    }

    // 处理最后一行（无换行结尾）
    const m = currentLine.trim().match(/^\[(\d+)\]\s*(.*)/);
    if (m) {
      const idx = parseInt(m[1]);
      if (idx >= 0 && idx < items.length) {
        chrome.tabs.sendMessage(tabId, {
          type: 'LINE_RESULT',
          data: { lineIndex: idx, translated: m[2].trim() },
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      chrome.tabs.sendMessage(tabId, { type: 'TRANSLATE_ERROR', error: err.message }).catch(() => {});
    }
  } finally {
    abortControllers.delete(tabId);
  }

  chrome.tabs.sendMessage(tabId, { type: 'ALL_DONE' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => {});
}

// ---- 翻译质量检查 ----
async function checkQuality(sample) {
  if (!apiKey || !sample?.length) return { issues: [] };
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是翻译质量审核员。检查以下英中翻译对，找出有问题的条目。\n' +
              '问题类型：1)译文仍含大量英文 2)译文未翻译(与原文相同) 3)译文质量极差 4)标记«»丢失\n' +
              '只输出有问题的编号，用逗号分隔。全部合格输出 NONE。\n' +
              '不要输出任何其他内容。',
          },
          { role: 'user', content: sample.map(s => `[${s.index}] 原文: ${s.original}\n译文: ${s.translated}`).join('\n\n') },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
    });
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    if (!text || text === 'NONE' || text === 'none') return { issues: [] };
    const indices = text.match(/\d+/g)?.map(Number) || [];
    return { issues: indices };
  } catch {
    return { issues: [] };
  }
}

// ---- 自动翻译 ----
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) autoTranslatedTabs.delete(tabId);
  if (info.status !== 'complete') return;
  if (!tab.url || !/^https?:\/\//.test(tab.url)) return;
  await ready;
  if (!autoTranslate || !apiKey) return;
  if (autoTranslatedTabs.has(tabId)) return;
  autoTranslatedTabs.add(tabId);
  await sleep(1500);
  try { await chrome.tabs.sendMessage(tabId, { type: 'AUTO_TRANSLATE' }); } catch {}
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await ready;
  if (!autoTranslate || !apiKey) return;
  autoTranslatedTabs.delete(d.tabId);
  await sleep(1500);
  try { await chrome.tabs.sendMessage(d.tabId, { type: 'AUTO_TRANSLATE' }); } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  autoTranslatedTabs.delete(tabId);
  abortControllers.delete(tabId);
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
