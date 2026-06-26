// ============================================================
// DeepSeek 智能翻译 - Content Script
// 职责：DOM 文本提取 + 翻译替换 + 恢复原文 + SPA 监听
// ============================================================

(() => {
  // 防止重复注入
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

  // ============================================================
  // 原文缓存（用于恢复）
  // ============================================================

  const originalCache = new Map(); // Map<TextNode, { text, parent }>

  // ============================================================
  // 翻译状态
  // ============================================================

  let isTranslating = false;
  let isTranslated = false;
  let _isApplyingDOM = false; // MutationObserver 内部锁
  let observer = null;
  let currentBatches = null; // 当前翻译批次引用（用于渐进式接收结果）
  let appliedBatchCount = 0;
  let totalBatchCount = 0;
  const recentTranslated = new Map(); // Node -> timestamp（循环保护）

  // ============================================================
  // 语言检测（页面级）
  // ============================================================

  function detectPageLanguage() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: n => n.textContent.trim().length > 5 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT },
    );

    let sampledChars = 0;
    let cjkChars = 0;
    let nodeCount = 0;

    let node;
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
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.textContent.trim();
          // 跳过空白/过短
          if (!text || text.length < 3) return NodeFilter.FILTER_REJECT;
          // 必须包含至少 2 个连续英文字母
          if (!/[a-zA-Z]{2,}/.test(text)) return NodeFilter.FILTER_REJECT;

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // 跳过已翻译的
          if (parent.hasAttribute('data-translated')) return NodeFilter.FILTER_REJECT;
          // 跳过不可翻译的标签
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          // 跳过祖先中有 SKIP_TAGS 的
          if (hasSkippedAncestor(parent)) return NodeFilter.FILTER_REJECT;
          // 跳过 contenteditable
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }

    return nodes;
  }

  // ============================================================
  // 分批
  // ============================================================

  function createBatches(textNodes) {
    const batches = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const node of textNodes) {
      const text = node.textContent.trim();
      const len = text.length;

      // 超长单节点：强制拆分
      if (len > MAX_CHARS_PER_BATCH) {
        // 先 flush 当前批次
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentChars = 0;
        }
        // 按句子拆分长文本
        const sentences = splitLongText(text, MAX_CHARS_PER_BATCH);
        for (const sentence of sentences) {
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

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  function splitLongText(text, maxLen) {
    const parts = [];
    // 按段落 → 句子 → 空格优先级拆分
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxLen && current) {
        parts.push(current.trim());
        current = '';
      }
      if (para.length > maxLen) {
        // 按句子拆
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sent of sentences) {
          if (current.length + sent.length + 1 > maxLen && current) {
            parts.push(current.trim());
            current = '';
          }
          if (sent.length > maxLen) {
            // 按空格硬切
            let remaining = sent;
            while (remaining.length > maxLen) {
              const cut = remaining.lastIndexOf(' ', maxLen);
              if (cut <= 0) break;
              parts.push(remaining.slice(0, cut).trim());
              remaining = remaining.slice(cut + 1);
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
  // DOM 替换
  // ============================================================

  function applyTranslations(batches, results) {
    _isApplyingDOM = true;

    try {
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const result = results[bi];
        if (!result || !result.ok || !result.translations) continue;

        for (let ti = 0; ti < batch.length; ti++) {
          const { node, text, chunk } = batch[ti];
          const translation = result.translations[ti];
          const translated = translation?.t;

          if (!translated || translated === text) continue;

          // 循环保护：30 秒内不重复翻译同一节点
          const lastTime = recentTranslated.get(node);
          if (lastTime && Date.now() - lastTime < 30000) continue;

          // 检查节点是否仍在 DOM 中
          if (!document.contains(node)) continue;

          // 保存原文（仅首次）
          if (!originalCache.has(node)) {
            originalCache.set(node, {
              text: node.textContent,
              parent: node.parentElement,
            });
          }

          // 替换文本
          if (chunk) {
            // 长文本拆分的情况：直接替换（会丢失前后文关联，但可接受）
            node.textContent = translated;
          } else {
            node.textContent = translated;
          }

          // 标记父元素
          const parent = node.parentElement;
          if (parent) {
            parent.setAttribute('data-translated', 'true');
            // data-original 兜底备份（取首次保存的原文）
            if (!parent.hasAttribute('data-original')) {
              parent.setAttribute('data-original', originalCache.get(node).text);
            }
          }

          recentTranslated.set(node, Date.now());
        }
      }
    } finally {
      _isApplyingDOM = false;
    }
  }

  // ============================================================
  // 恢复原文
  // ============================================================

  function restoreOriginal() {
    _isApplyingDOM = true;

    // 暂停 MutationObserver
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    let restored = 0;
    let failed = 0;

    try {
      for (const [node, data] of originalCache) {
        if (!document.contains(node)) {
          failed++;
          continue;
        }
        node.textContent = data.text;
        restored++;
      }

      // 清除所有翻译标记
      document.querySelectorAll('[data-translated]').forEach(el => {
        el.removeAttribute('data-translated');
        el.removeAttribute('data-original');
      });
    } finally {
      _isApplyingDOM = false;
    }

    // 清空缓存
    originalCache.clear();
    recentTranslated.clear();
    isTranslated = false;

    return { restored, failed };
  }

  // ============================================================
  // 翻译主流程
  // ============================================================

  async function startTranslation() {
    if (isTranslating) return { error: '翻译进行中' };

    // 语言检测
    const lang = detectPageLanguage();
    if (lang === 'zh') return { error: '该页面已是中文' };
    if (lang === 'empty') return { error: '未检测到可翻译的内容' };

    // 如果已翻译，先恢复
    if (isTranslated) {
      restoreOriginal();
    }

    isTranslating = true;

    // 提前启动 MutationObserver，捕捉滚动时懒加载的新内容
    startObserver();

    try {
      // 1. 提取文本节点
      const textNodes = extractTextNodes();
      if (textNodes.length === 0) {
        isTranslating = false;
        return { error: '未检测到可翻译的英文内容' };
      }

      // 2. 分批
      currentBatches = createBatches(textNodes);
      totalBatchCount = currentBatches.length;
      appliedBatchCount = 0;

      const batchPayloads = currentBatches.map(batch =>
        batch.map(item => ({ text: item.text })),
      );

      // 3. 发送给 Background（不等待结果，结果通过 BATCH_RESULT 消息渐进式返回）
      chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCHES',
        data: { batches: batchPayloads },
      });

      // 立即返回，不阻塞。结果通过 BATCH_RESULT 消息逐批应用
      return { ok: true, nodeCount: textNodes.length, batchCount: currentBatches.length };
    } catch (err) {
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
      if (_isApplyingDOM) return; // 我们自己的 DOM 修改，跳过

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
            // 遍历新元素中的文本节点
            const walker = document.createTreeWalker(
              added,
              NodeFilter.SHOW_TEXT,
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

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  async function translateIncremental(nodes) {
    if (isTranslating) return;
    isTranslating = true;

    try {
      const batches = createBatches(nodes);
      const batchPayloads = batches.map(batch =>
        batch.map(item => ({ text: item.text })),
      );

      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCHES',
        data: { batches: batchPayloads },
      });

      if (response.error || response.cancelled) return;
      applyTranslations(batches, response.results);
    } catch (e) {
      // 增量翻译失败静默处理
    } finally {
      isTranslating = false;
    }
  }

  // ============================================================
  // 滚动监听：捕捉 IntersectionObserver 触发的懒加载文本
  // ============================================================

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (!isTranslated || isTranslating || _isApplyingDOM) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      // 重新扫描，找出未翻译的文本节点
      const allNodes = extractTextNodes();
      const unTranslated = allNodes.filter(n =>
        !n.parentElement?.hasAttribute('data-translated'),
      );
      if (unTranslated.length > 0) translateIncremental(unTranslated);
    }, 500);
  }, { passive: true });

  // ============================================================
  // 消息监听（Content Script 入口）
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_TRANSLATE':
        startTranslation().then(result => sendResponse(result));
        return true; // 异步响应

      case 'RESTORE_ORIGINAL': {
        const result = restoreOriginal();
        sendResponse({ ok: true, ...result });
        break;
      }

      case 'AUTO_TRANSLATE':
        startTranslation().then(result => sendResponse(result));
        return true;

      case 'BATCH_RESULT': {
        // 渐进式接收单批翻译结果，立即应用到 DOM
        const { batchIndex, result } = message.data;
        if (currentBatches && currentBatches[batchIndex] && result?.ok) {
          applyTranslations([currentBatches[batchIndex]], [result]);
          appliedBatchCount++;

          // 所有批次完成
          if (appliedBatchCount >= totalBatchCount) {
            isTranslated = true;
            isTranslating = false;
            currentBatches = null;
            chrome.runtime.sendMessage({ type: 'TRANSLATION_DONE' });
          }
        }
        break;
      }

      case 'GET_CONTENT_STATE':
        sendResponse({
          isTranslating,
          isTranslated,
          nodeCount: originalCache.size,
        });
        break;
    }
  });

  // 页面卸载时清理
  window.addEventListener('beforeunload', () => {
    if (observer) observer.disconnect();
  });
})();
