// ============================================================
// DeepSeek 智能翻译 - Content Script
// 职责：DOM 文本提取 + 翻译替换 + 恢复原文 + SPA 监听
// ============================================================

(() => {
  if (window.__deepseekTranslator) return;
  window.__deepseekTranslator = true;

  // ============================================================
  // 常量
  // ============================================================

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
    'BR', 'HR', 'IMG', 'META', 'LINK',
  ]);

  const MAX_CHARS_PER_BATCH = 3000;
  const CJK_THRESHOLD = 0.35;
  const WATCHDOG_TIMEOUT = 5 * 60 * 1000; // 5 分钟

  // ============================================================
  // 原文缓存 + 状态
  // ============================================================

  const originalCache = new Map(); // Map<TextNode, string>（仅存文本，不存 parent）
  const recentTranslated = new WeakMap(); // WeakMap<Node, number>（不阻止 GC）
  const pendingIncrementalNodes = []; // 翻译期间暂存的新节点

  let isTranslating = false;
  let isTranslated = false;
  let _isApplyingDOM = false;
  let observer = null;
  let watchdogTimer = null;
  let pendingBatches = [];

  // ============================================================
  // 语言检测
  // ============================================================

  function detectPageLanguage() {
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT,
      { acceptNode: n => n.textContent.trim().length > 5 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT },
    );
    let sampledChars = 0, cjkChars = 0, nodeCount = 0, node;
    while ((node = walker.nextNode()) && nodeCount < 15) {
      const text = node.textContent.trim();
      sampledChars += text.length;
      const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
      if (cjk) cjkChars += cjk.length;
      nodeCount++;
    }
    if (sampledChars === 0) return 'empty';
    return (cjkChars / sampledChars) > CJK_THRESHOLD ? 'zh' : 'en';
  }

  // ============================================================
  // DOM 文本提取
  // ============================================================

  function hasSkippedAncestor(el) {
    let current = el;
    while (current && current !== document.body) {
      if (SKIP_TAGS.has(current.tagName)) return true;
      if (current.hasAttribute && current.hasAttribute('data-translated')) return true;
      current = current.parentElement;
    }
    return false;
  }

  function extractTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.textContent.trim();
          if (!text || text.length < 3) return NodeFilter.FILTER_REJECT;
          if (!/[a-zA-Z]{2,}/.test(text)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.hasAttribute('data-translated')) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (hasSkippedAncestor(parent)) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  // ============================================================
  // 分批
  // ============================================================

  function createBatches(textNodes) {
    const batches = [];
    let currentBatch = [], currentChars = 0;

    for (const node of textNodes) {
      const text = node.textContent.trim();
      const len = text.length;

      if (len > MAX_CHARS_PER_BATCH) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentChars = 0;
        }
        for (const sentence of splitLongText(text, MAX_CHARS_PER_BATCH)) {
          batches.push([{ node, text: sentence, chunk: true }]);
        }
        continue;
      }

      if (currentChars + len > MAX_CHARS_PER_BATCH && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      currentBatch.push({ node, text, chunk: false });
      currentChars += len;
    }

    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
  }

  function splitLongText(text, maxLen) {
    const parts = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxLen && current) {
        parts.push(current.trim());
        current = '';
      }
      if (para.length > maxLen) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sent of sentences) {
          if (current.length + sent.length + 1 > maxLen && current) {
            parts.push(current.trim());
            current = '';
          }
          if (sent.length > maxLen) {
            let remaining = sent;
            while (remaining.length > maxLen) {
              const cut = remaining.lastIndexOf(' ', maxLen);
              if (cut <= 0) {
                // 无空格时按 maxLen 硬切
                parts.push(remaining.slice(0, maxLen).trim());
                remaining = remaining.slice(maxLen);
              } else {
                parts.push(remaining.slice(0, cut).trim());
                remaining = remaining.slice(cut + 1);
              }
            }
            if (remaining.trim()) {
              if (current.length + remaining.length > maxLen && current) {
                parts.push(current.trim());
                current = '';
              }
              current += (current ? ' ' : '') + remaining;
            }
          } else {
            current += (current ? ' ' : '') + sent;
          }
        }
      } else {
        current += (current ? '\n\n' : '') + para;
      }
    }

    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  // ============================================================
  // DOM 替换（单批次渐进式）
  // ============================================================

  function applyBatchResult(batchIndex, translations) {
    const batch = pendingBatches[batchIndex];
    if (!batch || !translations) return;

    _isApplyingDOM = true;
    try {
      for (let ti = 0; ti < batch.length; ti++) {
        const { node, text } = batch[ti];
        const translated = (translations[ti]?.t || '').replace(/[\u200B-\u200F\uFEFF]/g, '');

        if (!translated || translated === text) continue;

        const lastTime = recentTranslated.get(node);
        if (lastTime && Date.now() - lastTime < 30000) continue;

        if (!document.contains(node)) continue;

        // 保存原文（仅首次，不存 parent 引用）
        if (!originalCache.has(node)) {
          originalCache.set(node, node.textContent);
        }

        // 保留原始前后空白
        const raw = node.textContent;
        const leading = raw.match(/^\s*/)?.[0] || '';
        const trailing = raw.match(/\s*$/)?.[0] || '';
        node.textContent = leading + translated + trailing;

        const parent = node.parentElement;
        if (parent) {
          parent.setAttribute('data-translated', 'true');
          if (!parent.hasAttribute('data-original')) {
            parent.setAttribute('data-original', originalCache.get(node));
          }
        }

        recentTranslated.set(node, Date.now());
      }
    } finally {
      _isApplyingDOM = false;
    }
  }

  // ============================================================
  // 翻译完成处理
  // ============================================================

  function finalizeTranslation(isIncremental, cancelled = false) {
    isTranslating = false;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;

    if (!isIncremental) {
      if (!cancelled) {
        isTranslated = true;
      } else if (originalCache.size > 0) {
        // 取消但有部分翻译内容
        isTranslated = true;
      }
      // 清空 pendingBatches（主翻译完成）
      pendingBatches = [];
      // 清理脱离 DOM 的缓存节点
      cleanupDeadNodes();
    }

    // 处理暂存的增量节点
    if (pendingIncrementalNodes.length > 0) {
      const pending = pendingIncrementalNodes.splice(0).filter(n => document.contains(n));
      if (pending.length > 0) {
        translateIncremental(pending);
      }
    }
  }

  // 清理脱离 DOM 的缓存节点
  function cleanupDeadNodes() {
    for (const node of originalCache.keys()) {
      if (!document.contains(node)) originalCache.delete(node);
    }
  }

  // ============================================================
  // 恢复原文
  // ============================================================

  function restoreOriginal() {
    _isApplyingDOM = true;

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    let restored = 0, failed = 0;

    try {
      for (const [node, originalText] of originalCache) {
        if (!document.contains(node)) { failed++; continue; }
        node.textContent = originalText;
        restored++;
      }

      document.querySelectorAll('[data-translated]').forEach(el => {
        el.removeAttribute('data-translated');
        el.removeAttribute('data-original');
      });
    } finally {
      _isApplyingDOM = false;
    }

    originalCache.clear();
    pendingBatches = [];
    pendingIncrementalNodes.length = 0;
    isTranslated = false;
    isTranslating = false;
    clearTimeout(watchdogTimer);

    return { restored, failed };
  }

  // ============================================================
  // 翻译主流程
  // ============================================================

  async function startTranslation() {
    if (isTranslating) return { error: '翻译进行中' };

    const lang = detectPageLanguage();
    if (lang === 'zh') return { error: '该页面已是中文' };
    if (lang === 'empty') return { error: '未检测到可翻译的内容' };

    if (isTranslated) restoreOriginal();

    isTranslating = true;

    // 看门狗：5 分钟超时自动重置状态
    watchdogTimer = setTimeout(() => {
      if (isTranslating) {
        console.warn('[Translate] Watchdog triggered, resetting state');
        isTranslating = false;
        pendingBatches = [];
      }
    }, WATCHDOG_TIMEOUT);

    startObserver();

    try {
      const textNodes = extractTextNodes();
      if (textNodes.length === 0) {
        clearTimeout(watchdogTimer);
        isTranslating = false;
        return { error: '未检测到可翻译的英文内容' };
      }

      const batches = createBatches(textNodes);
      const batchPayloads = batches.map(batch => batch.map(item => ({ text: item.text })));

      pendingBatches = batches;

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCHES',
        data: { batches: batchPayloads },
      });

      if (response.error) {
        clearTimeout(watchdogTimer);
        isTranslating = false;
        return { error: response.error };
      }

      return { ok: true, nodeCount: textNodes.length, batchCount: batches.length };
    } catch (err) {
      clearTimeout(watchdogTimer);
      isTranslating = false;
      if (originalCache.size > 0) isTranslated = true;
      return { error: err.message };
    }
  }

  // ============================================================
  // MutationObserver（SPA 兼容）
  // ============================================================

  function startObserver() {
    if (observer) observer.disconnect();

    let pendingNodes = [];
    let debounceTimer = null;

    observer = new MutationObserver((mutations) => {
      if (_isApplyingDOM) return;

      const newNodes = [];
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            if (/[a-zA-Z]{2,}/.test(added.textContent) && added.textContent.trim().length >= 3) {
              const parent = added.parentElement;
              if (parent && !parent.hasAttribute('data-translated') && !hasSkippedAncestor(parent)) {
                newNodes.push(added);
              }
            }
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            const walker = document.createTreeWalker(
              added, NodeFilter.SHOW_TEXT,
              {
                acceptNode(n) {
                  const t = n.textContent.trim();
                  if (!t || t.length < 3 || !/[a-zA-Z]{2,}/.test(t)) return NodeFilter.FILTER_REJECT;
                  const p = n.parentElement;
                  if (!p || p.hasAttribute('data-translated') || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
                  if (hasSkippedAncestor(p)) return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
                },
              },
            );
            let n;
            while ((n = walker.nextNode())) newNodes.push(n);
          }
        }
      }

      if (newNodes.length === 0) return;

      pendingNodes.push(...newNodes);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const nodes = pendingNodes.filter(n => document.contains(n));
        pendingNodes = [];
        if (nodes.length > 0) translateIncremental(nodes);
      }, 600);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function translateIncremental(nodes) {
    if (isTranslating) {
      // 翻译进行中：暂存而非丢弃
      pendingIncrementalNodes.push(...nodes);
      return;
    }

    isTranslating = true;

    // 增量翻译也设看门狗
    watchdogTimer = setTimeout(() => {
      if (isTranslating) {
        isTranslating = false;
        pendingBatches = [];
      }
    }, WATCHDOG_TIMEOUT);

    try {
      const batches = createBatches(nodes);
      const batchPayloads = batches.map(batch => batch.map(item => ({ text: item.text })));

      const offset = pendingBatches.length;
      pendingBatches.push(...batches);

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCHES',
        data: { batches: batchPayloads, offset },
      });

      if (response?.error) {
        clearTimeout(watchdogTimer);
        isTranslating = false;
        return;
      }
      // 结果通过 BATCH_RESULT / ALL_BATCHES_DONE 推送
    } catch (e) {
      clearTimeout(watchdogTimer);
      isTranslating = false;
    }
  }

  // ============================================================
  // 滚动监听
  // ============================================================

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (!isTranslated || isTranslating || _isApplyingDOM) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const allNodes = extractTextNodes();
      const unTranslated = allNodes.filter(n => !n.parentElement?.hasAttribute('data-translated'));
      if (unTranslated.length > 0) translateIncremental(unTranslated);
    }, 500);
  }, { passive: true });

  // ============================================================
  // 消息监听
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_TRANSLATE':
        startTranslation().then(result => sendResponse(result));
        return true;

      case 'RESTORE_ORIGINAL': {
        // 翻译进行中时先取消
        if (isTranslating) {
          chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATE' });
        }
        const result = restoreOriginal();
        sendResponse({ ok: true, ...result });
        break;
      }

      case 'AUTO_TRANSLATE':
        startTranslation().then(result => sendResponse(result));
        return true;

      case 'CANCEL_TRANSLATE_CONTENT':
        clearTimeout(watchdogTimer);
        isTranslating = false;
        pendingBatches = [];
        pendingIncrementalNodes.length = 0;
        sendResponse({ ok: true });
        break;

      case 'BATCH_RESULT': {
        const { batchIndex, translations } = message.data;
        applyBatchResult(batchIndex, translations);
        break;
      }

      case 'ALL_BATCHES_DONE': {
        const { isIncremental, cancelled } = message.data || {};
        finalizeTranslation(isIncremental, cancelled);
        break;
      }

      case 'GET_CONTENT_STATE':
        sendResponse({ isTranslating, isTranslated, nodeCount: originalCache.size });
        break;
    }
  });

  window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect();
    clearTimeout(watchdogTimer);
  });
})();
