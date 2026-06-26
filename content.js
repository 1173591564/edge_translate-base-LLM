// DeepSeek 智能翻译 - Content Script
(() => {
  if (window.__dsTranslate) return;
  window.__dsTranslate = true;

  // ---- 常量 ----
  const SKIP_TAGS = new Set([
    'SCRIPT','STYLE','CODE','PRE','KBD','SAMP','VAR','NOSCRIPT',
    'TEXTAREA','INPUT','SELECT','OPTION','SVG','MATH','CANVAS',
    'VIDEO','AUDIO','IFRAME','BR','HR','IMG','META','LINK',
  ]);
  const CJK_THRESHOLD = 0.35;

  // 块级元素：语义块分组的边界
  const BLOCK_TAGS = new Set([
    'P','H1','H2','H3','H4','H5','H6',
    'DIV','SECTION','ARTICLE','ASIDE','HEADER','FOOTER','NAV','MAIN',
    'LI','DT','DD','BLOCKQUOTE','FIGCAPTION','CAPTION','LEGEND',
    'SUMMARY','DETAILS','TD','TH','LABEL','FIELDSET',
  ]);

  // 稳定采样参数（像称重一样，连续 N 次采样稳定后才开始翻译）
  const SAMPLE_INTERVAL = 400;      // 采样间隔 ms
  const STABLE_THRESHOLD = 3;       // 单次采样 mutation 上限
  const REQUIRED_STABLE = 3;        // 连续稳定次数
  const STABILITY_TIMEOUT = 8000;   // 最大等待时间 ms
  const IDLE_TIMEOUT = 3000;         // 3秒无新内容→标记完成

  const CACHE_TTL = 30 * 60 * 1000; // URL 缓存 30 分钟
  const CACHE_MAX = 50;             // 最多缓存 50 个 URL

  // ---- 状态 ----
  const originalMap = new Map();    // TextNode -> 原文（用于恢复）
  let pendingBlocks = [];           // 当前翻译的语义块列表
  let doneIndices = new Set();      // 已完成的翻译索引（精确跟踪进度）
  let translating = false;
  let translated = false;
  let applying = false;             // 正在操作 DOM（MutationObserver 忽略）
  let observer = null;              // MutationObserver
  let completeTimer = null;          // 空闲完成定时器
  let qualityRetries = 0;            // 质量检查重试次数

  // ---- 页面内浮动状态组件 ----
  let widget = null;
  let widgetHideTimer = null;

  function injectWidgetStyles() {
    if (document.getElementById('__ds_translate_styles')) return;
    const s = document.createElement('style');
    s.id = '__ds_translate_styles';
    s.textContent = `
      #__ds_widget {
        position: fixed; top: 12px; right: 12px; z-index: 2147483647;
        display: flex; align-items: center; gap: 8px;
        padding: 8px 16px; border-radius: 24px;
        background: rgba(255,255,255,0.95);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        box-shadow: 0 2px 16px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; color: #444;
        cursor: pointer; user-select: none;
        opacity: 0; transform: translateY(-10px) scale(0.95);
        transition: all 0.35s cubic-bezier(0.34,1.56,0.64,1);
      }
      #__ds_widget.__ds_show {
        opacity: 1; transform: translateY(0) scale(1);
      }
      #__ds_widget.__ds_done {
        background: rgba(232,245,233,0.95); color: #2e7d32;
      }
      #__ds_widget.__ds_error {
        background: rgba(255,235,238,0.95); color: #c62828;
      }
      #__ds_widget .__ds_icon {
        width: 18px; height: 18px; flex-shrink: 0;
      }
      #__ds_widget.__ds_working .__ds_icon {
        animation: __ds_bounce 1s ease-in-out infinite;
      }
      #__ds_widget .__ds_text {
        white-space: nowrap; font-weight: 500;
      }
      #__ds_widget.__ds_working .__ds_text {
        background: linear-gradient(90deg, #4A90D9 0%, #7BB3F0 40%, #4A90D9 80%);
        background-size: 200% 100%;
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: __ds_shimmer 1.5s ease-in-out infinite;
      }
      #__ds_widget .__ds_bar {
        width: 48px; height: 3px; border-radius: 2px;
        background: #e0e0e0; overflow: hidden; flex-shrink: 0;
      }
      #__ds_widget .__ds_bar_fill {
        height: 100%; width: 0%; border-radius: 2px;
        background: linear-gradient(90deg, #4A90D9, #5BA3E8);
        transition: width 0.4s ease;
      }
      #__ds_widget.__ds_done .__ds_bar_fill { background: #66bb6a; width: 100% !important; }
      @keyframes __ds_shimmer {
        0% { background-position: 100% 50%; }
        100% { background-position: -100% 50%; }
      }
      @keyframes __ds_bounce {
        0%,100% { transform: translateY(0); }
        50% { transform: translateY(-3px); }
      }
    `;
    document.head.appendChild(s);
  }

  function showWidget(state, text) {
    injectWidgetStyles();
    if (!widget) {
      widget = document.createElement('div');
      widget.id = '__ds_widget';
      widget.innerHTML =
        '<svg class="__ds_icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>' +
        '</svg>' +
        '<span class="__ds_text"></span>' +
        '<div class="__ds_bar"><div class="__ds_bar_fill"></div></div>';
      widget.addEventListener('click', hideWidget);
      document.body.appendChild(widget);
    }
    clearTimeout(widgetHideTimer);
    widget.className = '__ds_show' + (state === 'working' ? ' __ds_working' : state === 'done' ? ' __ds_done' : state === 'error' ? ' __ds_error' : '');
    widget.querySelector('.__ds_text').textContent = text;
    widget.querySelector('.__ds_bar').style.display = state === 'done' || state === 'error' ? 'none' : '';
  }

  function updateWidgetProgress(percent) {
    if (!widget) return;
    const fill = widget.querySelector('.__ds_bar_fill');
    if (fill) fill.style.width = Math.min(100, Math.round(percent)) + '%';
  }

  function hideWidget() {
    clearTimeout(widgetHideTimer);
    if (widget) widget.classList.remove('__ds_show');
  }

  function autoHideWidget(delay = 2500) {
    widgetHideTimer = setTimeout(hideWidget, delay);
  }

  // ---- URL 缓存 ----
  function cacheKey() {
    const url = location.href.split('#')[0];
    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return 'tl_' + Math.abs(h);
  }

  async function loadCache() {
    const key = cacheKey();
    const r = await chrome.storage.local.get(key);
    const c = r[key];
    if (!c || Date.now() - c.ts > CACHE_TTL) {
      if (c) chrome.storage.local.remove(key);
      return null;
    }
    return c;
  }

  async function saveCache(map) {
    const translations = {};
    for (const [orig, trans] of map) {
      if (orig.trim().length >= 3) translations[orig.trim()] = trans.trim();
    }
    if (!Object.keys(translations).length) return;
    try {
      await chrome.storage.local.set({
        [cacheKey()]: { url: location.href.split('#')[0], translations, ts: Date.now() },
      });
      // 清理旧缓存
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all)
        .filter(([k]) => k.startsWith('tl_'))
        .sort((a, b) => b[1].ts - a[1].ts);
      const expired = entries.filter(([, v]) => Date.now() - v.ts > CACHE_TTL);
      const over = entries.slice(CACHE_MAX);
      const remove = [...new Set([...expired, ...over].map(([k]) => k))];
      if (remove.length) await chrome.storage.local.remove(remove);
    } catch {}
  }

  // 从 URL 缓存恢复翻译
  function applyUrlCache(cache) {
    const blocks = extractBlocks();
    let matched = 0;
    applying = true;
    try {
      for (const block of blocks) {
        const trans = cache.translations[block.text];
        if (trans && trans !== block.text) {
          applyTranslation(block, trans);
          matched++;
        }
      }
    } finally {
      applying = false;
    }
    return matched;
  }

  // ---- DOM 稳定性检测（连续采样，像称重一样等稳定后才记录）----
  function waitForStable() {
    return new Promise((resolve) => {
      let stableCount = 0;
      let mutations = 0;
      const started = Date.now();

      const obs = new MutationObserver(() => mutations++);
      obs.observe(document.body, { childList: true, subtree: true });

      const timer = setInterval(() => {
        const count = mutations;
        mutations = 0;

        if (count < STABLE_THRESHOLD) {
          stableCount++;
        } else {
          stableCount = 0; // 不稳定，重新开始计数
        }

        if (stableCount >= REQUIRED_STABLE || Date.now() - started > STABILITY_TIMEOUT) {
          clearInterval(timer);
          obs.disconnect();
          resolve();
        }
      }, SAMPLE_INTERVAL);
    });
  }

  // ---- 语言检测 ----
  function detectLanguage() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim().length > 5 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let chars = 0, cjk = 0, count = 0, node;
    while ((node = walker.nextNode()) && count < 15) {
      const t = node.textContent.trim();
      chars += t.length;
      const m = t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
      if (m) cjk += m.length;
      count++;
    }
    if (!chars) return 'empty';
    return (cjk / chars) > CJK_THRESHOLD ? 'zh' : 'en';
  }

  // ---- 文本提取 ----
  function hasSkipAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (SKIP_TAGS.has(cur.tagName)) return true;
      if (cur.hasAttribute?.('data-translated')) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function extractTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.textContent.trim();
        if (!t || t.length < 3 || !/[a-zA-Z]{2,}/.test(t)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || p.hasAttribute('data-translated') || SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (hasSkipAncestor(p) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // 找最近的块级祖先元素（语义块的边界）
  function findBlockAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (BLOCK_TAGS.has(cur.tagName)) return cur;
      cur = cur.parentElement;
    }
    return el; // 找不到块级祖先就用元素自身
  }

  // 将文本节点按块级祖先分组为语义块
  // 例: <p><strong>Bold</strong> text <em>here</em></p> → 合并为 "Bold text here"
  function extractBlocks() {
    const textNodes = extractTextNodes();
    const blocks = [];
    let i = 0;
    while (i < textNodes.length) {
      const ancestor = findBlockAncestor(textNodes[i].parentElement);
      const group = [textNodes[i]];
      let j = i + 1;
      while (j < textNodes.length && findBlockAncestor(textNodes[j].parentElement) === ancestor) {
        group.push(textNodes[j]);
        j++;
      }
      blocks.push({
        node: group[0],
        nodes: [...group],
        text: group.map(n => n.textContent.trim()).join(' '),
        blockEl: ancestor,
      });
      i = j;
    }
    return blocks;
  }

  // ---- 翻译应用 ----

  // 构建发送列表：多节点组用 «N»...«/N» 标记内联边界，让 LLM 决定切分位置
  function buildSendItems(blocks) {
    return blocks.map(block => {
      if (block.nodes.length <= 1) return { text: block.text };
      // 标记各节点边界：«1»第一段«/1» «2»第二段«/2» ...
      const marked = block.nodes.map((n, i) =>
        `\u00AB${i + 1}\u00BB${n.textContent.trim()}\u00AB/${i + 1}\u00BB`
      ).join(' ');
      return { text: marked };
    });
  }

  // 从 LLM 译文中解析 «N»...«/N» 标记，提取各节点的译文
  function parseNodeTranslations(translated, nodeCount) {
    const results = [];
    for (let i = 1; i <= nodeCount; i++) {
      const re = new RegExp(`\u00AB${i}\u00BB([\\s\\S]*?)\u00AB/${i}\u00BB`);
      const m = translated.match(re);
      results.push(m ? m[1].trim() : '');
    }
    return results;
  }

  function applyTranslation(block, translated) {
    const cleaned = translated.replace(/[\u200B-\u200F\uFEFF]/g, '');
    if (!cleaned || !block.node || !document.contains(block.node)) return;

    // 保存所有节点的原文
    for (const n of block.nodes) {
      if (!originalMap.has(n)) originalMap.set(n, n.textContent);
    }

    if (block.nodes.length === 1) {
      // 单节点：保留前后空白
      const raw = block.node.textContent;
      const lead = raw.match(/^\s*/)?.[0] || '';
      const trail = raw.match(/\s*$/)?.[0] || '';
      block.node.textContent = lead + cleaned + trail;
    } else {
      // 多节点组：从 LLM 译文中标记解析各节点内容
      const parts = parseNodeTranslations(cleaned, block.nodes.length);
      const hasParts = parts.some(p => p.length > 0);
      if (hasParts) {
        // 标记解析成功：精确分配到各节点
        for (let k = 0; k < block.nodes.length; k++) {
          if (document.contains(block.nodes[k])) {
            const raw = block.nodes[k].textContent;
            const lead = raw.match(/^\s*/)?.[0] || '';
            const trail = raw.match(/\s*$/)?.[0] || '';
            block.nodes[k].textContent = lead + (parts[k] || '') + trail;
          }
        }
      } else {
        // 标记解析失败（LLM 没保留标记）：全部译文放首节点，其余清空
        const raw = block.node.textContent;
        const lead = raw.match(/^\s*/)?.[0] || '';
        block.node.textContent = lead + cleaned;
        for (let k = 1; k < block.nodes.length; k++) {
          if (document.contains(block.nodes[k])) block.nodes[k].textContent = '';
        }
      }
    }

    // 在块级祖先上标记已翻译（确保子元素下次被跳过）
    const markEl = block.blockEl || block.node.parentElement;
    if (markEl) {
      markEl.setAttribute('data-translated', 'true');
      if (!markEl.hasAttribute('data-original')) {
        markEl.setAttribute('data-original', originalMap.get(block.node));
      }
    }
  }

  // ---- 恢复原文 ----
  function restore() {
    applying = true;
    clearTimeout(completeTimer);
    completeTimer = null;
    if (observer) { observer.disconnect(); observer = null; }
    try {
      for (const [node, text] of originalMap) {
        if (document.contains(node)) node.textContent = text;
      }
      document.querySelectorAll('[data-translated]').forEach(el => {
        el.removeAttribute('data-translated');
        el.removeAttribute('data-original');
      });
    } finally {
      applying = false;
    }
    originalMap.clear();
    pendingBlocks = [];
    translated = false;
    translating = false;
  }

  // ---- 翻译主流程 ----
  async function startTranslation() {
    if (translating) return { error: '翻译进行中' };
    const lang = detectLanguage();
    if (lang === 'zh') return { error: '该页面已是中文' };
    if (lang === 'empty') return { error: '未检测到可翻译内容' };
    if (translated) restore();

    // 1. 尝试 URL 缓存
    const cache = await loadCache();
    if (cache) {
      const matched = applyUrlCache(cache);
      if (matched > 0) {
        translated = true;
        startObserver();
        return { ok: true, count: matched, cached: true };
      }
    }

    // 2. 等待 DOM 稳定（连续采样，像称重一样）
    showWidget('working', '稳定页面中...');
    await waitForStable();

    // 3. 提取全部语义块
    const blocks = extractBlocks();
    if (!blocks.length) {
      showWidget('error', '未检测到可翻译内容');
      autoHideWidget();
      return { error: '未检测到可翻译的英文内容' };
    }

    translating = true;
    doneIndices = new Set();
    qualityRetries = 0;
    clearTimeout(completeTimer);
    completeTimer = null;
    startObserver();

    // 4. 一次性发送给 LLM（多节点组带标记）
    pendingBlocks = blocks;
    const items = buildSendItems(blocks);
    showWidget('working', `翻译中... 0/${blocks.length}`);

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'TRANSLATE', items });
      if (resp?.error) {
        translating = false;
        showWidget('error', resp.error);
        autoHideWidget();
        return { error: resp.error };
      }
      return { ok: true, count: blocks.length };
    } catch (err) {
      translating = false;
      showWidget('error', '翻译出错');
      autoHideWidget();
      return { error: err.message };
    }
  }

  // ---- MutationObserver（处理 SPA 动态新内容）----
  function startObserver() {
    if (observer) observer.disconnect();
    let pending = [];
    let timer = null;

    observer = new MutationObserver((mutations) => {
      if (applying) return;
      const nodes = [];
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            if (/[a-zA-Z]{2,}/.test(added.textContent) && added.textContent.trim().length >= 3) {
              const p = added.parentElement;
              if (p && !p.hasAttribute('data-translated') && !hasSkipAncestor(p)) nodes.push(added);
            }
          } else if (added.nodeType === Node.ELEMENT_NODE) {
            const w = document.createTreeWalker(added, NodeFilter.SHOW_TEXT, {
              acceptNode(n) {
                const t = n.textContent.trim();
                if (!t || t.length < 3 || !/[a-zA-Z]{2,}/.test(t)) return NodeFilter.FILTER_REJECT;
                const p = n.parentElement;
                if (!p || p.hasAttribute('data-translated') || SKIP_TAGS.has(p.tagName) || hasSkipAncestor(p))
                  return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              },
            });
            let n;
            while ((n = w.nextNode())) nodes.push(n);
          }
        }
      }
      if (!nodes.length) return;
      pending.push(...nodes);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const valid = pending.filter(n => document.contains(n));
        pending = [];
        if (!valid.length) return;
        // 按块级祖先分组
        const groups = [];
        let i = 0;
        while (i < valid.length) {
          const ancestor = findBlockAncestor(valid[i].parentElement);
          const g = [valid[i]];
          let j = i + 1;
          while (j < valid.length && findBlockAncestor(valid[j].parentElement) === ancestor) { g.push(valid[j]); j++; }
          groups.push({ node: g[0], nodes: [...g], text: g.map(n => n.textContent.trim()).join(' '), blockEl: ancestor });
          i = j;
        }
        translateIncremental(groups);
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 空闲超时后标记翻译完成
  function onTranslationIdle() {
    translating = false; // 质量检查 + 空闲等待全部结束后释放锁
    translated = true;
    showWidget('done', '翻译完成 ✓');
    autoHideWidget();
    // 保存翻译缓存
    const map = new Map();
    for (const block of pendingBlocks) {
      const t = block.node.textContent.trim();
      if (t && t !== block.text) map.set(block.text, t);
    }
    if (map.size) saveCache(map);
  }

  // LLM 翻译质量检查：抽样审核，有问题的重新翻译
  async function runQualityCheck() {
    const sampleSize = Math.min(10, pendingBlocks.length);
    if (!sampleSize) return false; // 无内容可检查

    // 随机抽样
    const step = Math.max(1, Math.floor(pendingBlocks.length / sampleSize));
    const sample = [];
    for (let i = 0; i < pendingBlocks.length && sample.length < sampleSize; i += step) {
      const block = pendingBlocks[i];
      if (!block.node || !document.contains(block.node)) continue;
      sample.push({
        index: i,
        original: block.text,
        translated: block.node.textContent.trim(),
      });
    }
    if (!sample.length) return false;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'QUALITY_CHECK',
        sample,
      });

      if (!result?.issues?.length) return false; // 质量通过

      // 有问题的块重新翻译
      showWidget('working', `质量修复 ${result.issues.length} 项...`);
      const badBlocks = result.issues
        .filter(i => i >= 0 && i < pendingBlocks.length && document.contains(pendingBlocks[i].node))
        .map(i => pendingBlocks[i]);

      if (!badBlocks.length) return false;

      const items = buildSendItems(badBlocks);
      translating = true;
      await chrome.runtime.sendMessage({ type: 'TRANSLATE', items });
      return true; // 已触发重新翻译
    } catch {
      return false;
    }
  }

  async function translateIncremental(groups) {
    if (translating) return;
    // 有新内容→取消空闲完成计时，切回“翻译中”
    clearTimeout(completeTimer);
    completeTimer = null;
    if (translated) {
      translated = false;
      showWidget('working', `翻译中... ${doneIndices.size}/${pendingBlocks.length}`);
    }
    translating = true;
    pendingBlocks.push(...groups);
    const items = buildSendItems(groups);
    try {
      await chrome.runtime.sendMessage({ type: 'TRANSLATE', items });
    } catch {
      translating = false;
    }
  }

  // ---- 消息处理 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'START_TRANSLATE':
      case 'AUTO_TRANSLATE':
        startTranslation().then(r => sendResponse(r));
        return true;

      case 'RESTORE': {
        if (translating) chrome.runtime.sendMessage({ type: 'CANCEL' });
        restore();
        sendResponse({ ok: true });
        break;
      }

      case 'LINE_RESULT': {
        const idx = msg.data.lineIndex;
        const block = pendingBlocks[idx];
        if (block) {
          applying = true;
          try { applyTranslation(block, msg.data.translated); }
          finally { applying = false; }
        }
        // 用 Set 精确跟踪已完成索引（去重、不溢出）
        if (idx >= 0 && idx < pendingBlocks.length) {
          doneIndices.add(idx);
        }
        if (pendingBlocks.length > 0) {
          const done = doneIndices.size;
          const total = pendingBlocks.length;
          const pct = Math.round((done / total) * 100);
          showWidget('working', `翻译中... ${done}/${total}`);
          updateWidgetProgress(pct);
        }
        break;
      }

      case 'ALL_DONE': {
        clearTimeout(completeTimer);
        if (!translated) {
          // 保持 translating=true 锁住，防止质量检查期间侧栏等动态内容触发并发翻译
          if (qualityRetries < 1) {
            qualityRetries++;
            runQualityCheck().then(() => {
              // 质量检查完成，释放锁并启动空闲计时器
              translating = false;
              completeTimer = setTimeout(onTranslationIdle, IDLE_TIMEOUT);
            });
          } else {
            // 已重试过，不再检查，直接启动空闲计时器
            translating = false;
            completeTimer = setTimeout(onTranslationIdle, IDLE_TIMEOUT);
          }
        } else {
          // 增量翻译的 ALL_DONE（非首次），直接释放锁
          translating = false;
        }
        break;
      }

      case 'TRANSLATE_ERROR':
        translating = false;
        showWidget('error', '翻译出错: ' + (msg.error || ''));
        autoHideWidget();
        break;

      case 'GET_STATE':
        sendResponse({ translating, translated, count: originalMap.size });
        break;
    }
  });

  // SPA URL 变化时重置
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'URL_CHANGED') {
      translated = false;
      translating = false;
      clearTimeout(completeTimer);
      completeTimer = null;
    }
  });

  window.addEventListener('beforeunload', () => {
    clearTimeout(completeTimer);
    if (observer) observer.disconnect();
  });
})();
