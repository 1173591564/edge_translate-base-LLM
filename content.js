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

  const CJK_THRESHOLD = 0.35;
  const WATCHDOG_TIMEOUT = 5 * 60 * 1000;

  // ============================================================
  // 状态
  // ============================================================

  const originalCache = new Map(); // Map<TextNode, string>
  const recentTranslated = new WeakMap();
  const pendingIncrementalNodes = [];

  let isTranslating = false;
  let isTranslated = false;
  let _isApplyingDOM = false;
  let observer = null;
  let watchdogTimer = null;

  // 扁平节点列表：pendingNodes[i] = { node, text }
  let pendingNodes = [];

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
  // 逐行 DOM 替换
  // ============================================================

  function applyLineResult(lineIndex, translatedText) {
    const item = pendingNodes[lineIndex];
    if (!item || !translatedText) return;

    const { node, text } = item;
    const translated = translatedText.replace(/[\u200B-\u200F\uFEFF]/g, '');

    if (!translated || translated === text) return;

    // 循环保护
    const lastTime = recentTranslated.get(node);
    if (lastTime && Date.now() - lastTime < 30000) return;

    if (!document.contains(node)) return;

    // 保存原文
    if (!originalCache.has(node)) {
      originalCache.set(node, node.textContent);
    }

    // 保留前后空白
    const raw = node.textContent;
    const leading = raw.match(/^\s*/)?.[0] || '';
    const trailing = raw.match(/\s*$/)?.[0] || '';

    _isApplyingDOM = true;
    try {
      node.textContent = leading + translated + trailing;

      const parent = node.parentElement;
      if (parent) {
        parent.setAttribute('data-translated', 'true');
        if (!parent.hasAttribute('data-original')) {
          parent.setAttribute('data-original', originalCache.get(node));
        }
      }

      recentTranslated.set(node, Date.now());
    } finally {
      _isApplyingDOM = false;
    }
  }

  // ============================================================
  // 翻译完成
  // ============================================================

  function finalizeTranslation(isIncremental, cancelled = false) {
    isTranslating = false;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;

    if (!isIncremental) {
      if (!cancelled || originalCache.size > 0) {
        isTranslated = true;
      }
      pendingNodes = [];
      cleanupDeadNodes();
    }

    // 处理暂存的增量节点
    if (pendingIncrementalNodes.length > 0) {
      const pending = pendingIncrementalNodes.splice(0).filter(n => document.contains(n));
      if (pending.length > 0) translateIncremental(pending);
    }
  }

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
    if (observer) { observer.disconnect(); observer = null; }

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
    pendingNodes = [];
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

    watchdogTimer = setTimeout(() => {
      if (isTranslating) {
        console.warn('[Translate] Watchdog triggered');
        isTranslating = false;
        pendingNodes = [];
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

      // 扁平列表：每个文本节点一个条目
      pendingNodes = textNodes.map(node => ({
        node,
        text: node.textContent.trim(),
      }));

      const items = pendingNodes.map(item => ({ text: item.text }));

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_STREAM',
        data: { items },
      });

      if (response.error) {
        clearTimeout(watchdogTimer);
        isTranslating = false;
        return { error: response.error };
      }

      return { ok: true, nodeCount: textNodes.length };
    } catch (err) {
      clearTimeout(watchdogTimer);
      isTranslating = false;
      if (originalCache.size > 0) isTranslated = true;
      return { error: err.message };
    }
  }

  // ============================================================
  // MutationObserver
  // ============================================================

  function startObserver() {
    if (observer) observer.disconnect();

    let pendingObservedNodes = [];
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

      pendingObservedNodes.push(...newNodes);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const nodes = pendingObservedNodes.filter(n => document.contains(n));
        pendingObservedNodes = [];
        if (nodes.length > 0) translateIncremental(nodes);
      }, 600);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function translateIncremental(nodes) {
    if (isTranslating) {
      pendingIncrementalNodes.push(...nodes);
      return;
    }

    isTranslating = true;

    watchdogTimer = setTimeout(() => {
      if (isTranslating) { isTranslating = false; pendingNodes = []; }
    }, WATCHDOG_TIMEOUT);

    try {
      const newItems = nodes.map(node => ({ node, text: node.textContent.trim() }));
      const offset = pendingNodes.length;
      pendingNodes.push(...newItems);

      const items = newItems.map(item => ({ text: item.text }));

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_STREAM',
        data: { items, isIncremental: true },
      });

      if (response?.error) {
        clearTimeout(watchdogTimer);
        isTranslating = false;
      }
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
        pendingNodes = [];
        pendingIncrementalNodes.length = 0;
        sendResponse({ ok: true });
        break;

      // 流式逐行结果
      case 'LINE_RESULT': {
        const { lineIndex, translated } = message.data;
        applyLineResult(lineIndex, translated);
        break;
      }

      // 全部完成
      case 'ALL_DONE': {
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
