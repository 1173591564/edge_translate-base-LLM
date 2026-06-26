// ============================================================
// DeepSeek 智能翻译 - Popup 交互逻辑
// ============================================================

const $ = id => document.getElementById(id);

const els = {
  apiKeyInput: $('apiKeyInput'),
  toggleKeyBtn: $('toggleKeyBtn'),
  saveKeyBtn: $('saveKeyBtn'),
  keyStatus: $('keyStatus'),
  autoToggle: $('autoToggle'),
  translateBtn: $('translateBtn'),
  restoreBtn: $('restoreBtn'),
  progressSection: $('progressSection'),
  progressFill: $('progressFill'),
  statusText: $('statusText'),
};

// 当前状态
let hasApiKey = false;
let isTranslating = false;
let isTranslated = false;
let keyMasked = true;
let activeTabId = null;
let togglePending = false;

// ============================================================
// 初始化
// ============================================================

async function init() {
  const bgState = await sendBg('GET_STATE');
  hasApiKey = bgState.hasApiKey || false;

  if (hasApiKey) {
    els.apiKeyInput.value = 'sk-••••••••••••••••';
    els.apiKeyInput.dataset.hasKey = 'true';
    setKeyStatus('API Key 已配置', 'success');
  }

  els.autoToggle.checked = bgState.autoTranslate || false;
  updateUI();

  // 获取当前 tabId + Content Script 状态
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
      const contentState = await sendToContentScript(tab.id, { type: 'GET_CONTENT_STATE' });
      if (contentState) {
        isTranslated = contentState.isTranslated || false;
        isTranslating = contentState.isTranslating || false;
      }
    }
  } catch (e) { /* Content script 未加载 */ }

  updateUI();
}

// ============================================================
// UI 状态更新
// ============================================================

function updateUI() {
  if (isTranslating) {
    els.translateBtn.disabled = false;
    els.translateBtn.textContent = '取消翻译';
    els.translateBtn.classList.add('btn-cancel');
    els.translateBtn.classList.remove('btn-translate');
    els.progressSection.classList.remove('hidden');
  } else {
    els.translateBtn.classList.remove('btn-cancel');
    els.translateBtn.classList.add('btn-translate');
    els.translateBtn.disabled = !hasApiKey;

    if (isTranslated) {
      els.translateBtn.textContent = '重新翻译';
      els.restoreBtn.classList.remove('hidden');
    } else {
      els.translateBtn.textContent = '翻译此页';
      els.restoreBtn.classList.add('hidden');
      els.progressSection.classList.add('hidden');
    }
  }
}

function setKeyStatus(text, type) {
  els.keyStatus.textContent = text;
  els.keyStatus.className = 'hint' + (type ? ' ' + type : '');
}

function setStatus(text, type) {
  els.statusText.textContent = text;
  els.statusText.className = 'hint' + (type ? ' ' + type : '');
}

function setProgress(percent) {
  els.progressFill.style.width = percent + '%';
}

// ============================================================
// 事件绑定
// ============================================================

// 保存 API Key
els.saveKeyBtn.addEventListener('click', async () => {
  const val = els.apiKeyInput.value.trim();
  if (!val || val.includes('•')) {
    setKeyStatus('请输入有效的 API Key', 'error');
    return;
  }
  await sendBg('SAVE_API_KEY', { apiKey: val });
  hasApiKey = true;
  els.apiKeyInput.dataset.hasKey = 'true';
  setKeyStatus('API Key 已保存', 'success');
  updateUI();
});

// 显示/隐藏 API Key
els.toggleKeyBtn.addEventListener('click', () => {
  if (keyMasked) {
    els.apiKeyInput.type = 'text';
    if (els.apiKeyInput.dataset.hasKey === 'true') {
      els.apiKeyInput.value = '';
      els.apiKeyInput.placeholder = '输入新 Key 以替换...';
    }
  } else {
    els.apiKeyInput.type = 'password';
    if (els.apiKeyInput.dataset.hasKey === 'true') {
      els.apiKeyInput.value = 'sk-••••••••••••••••';
      els.apiKeyInput.placeholder = 'sk-xxxxxxxxxxxxxxxx';
    }
  }
  keyMasked = !keyMasked;
});

// 自动翻译开关（防竞态）
els.autoToggle.addEventListener('change', async () => {
  if (togglePending) {
    els.autoToggle.checked = !els.autoToggle.checked; // 回滚
    return;
  }
  togglePending = true;
  els.autoToggle.disabled = true;
  try {
    const result = await sendBg('TOGGLE_AUTO');
    els.autoToggle.checked = result.autoTranslate;
  } finally {
    togglePending = false;
    els.autoToggle.disabled = false;
  }
});

// 翻译 / 取消按钮
els.translateBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  activeTabId = tab.id;

  if (isTranslating) {
    // 取消翻译：通知 background + content.js
    await sendBg('CANCEL_TRANSLATE');
    try {
      await sendToContentScript(tab.id, { type: 'CANCEL_TRANSLATE_CONTENT' });
    } catch (e) { /* ignore */ }
    isTranslating = false;
    setStatus('翻译已取消', 'warning');
    updateUI();
    return;
  }

  // 开始翻译
  isTranslating = true;
  updateUI();
  els.progressSection.classList.remove('hidden');
  setProgress(0);
  setStatus('正在翻译... 0%', '');

  try {
    const result = await sendToContentScript(tab.id, { type: 'START_TRANSLATE' });

    if (result.error) {
      isTranslating = false;
      setStatus(result.error, 'error');
      updateUI();
      return;
    }

    if (result.ok) {
      setStatus(`正在翻译... 0%（${result.batchCount} 批）`, '');
    }
  } catch (err) {
    isTranslating = false;
    setStatus('翻译出错: ' + err.message, 'error');
    updateUI();
  }
});

// 恢复原文
els.restoreBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    const result = await sendToContentScript(tab.id, { type: 'RESTORE_ORIGINAL' });
    isTranslated = false;
    isTranslating = false;
    els.progressSection.classList.add('hidden');
    setStatus(`已恢复（${result.restored} 个节点）`, 'success');
    updateUI();
  } catch (err) {
    setStatus('恢复出错: ' + err.message, 'error');
  }
});

// ============================================================
// 监听 Background 进度/完成推送（按 tabId 过滤）
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROGRESS_UPDATE') {
    const { completed, total, percent, tabId, failedCount } = message.data;
    // 仅处理当前活动标签页的消息
    if (tabId && activeTabId && tabId !== activeTabId) return;
    setProgress(percent);
    const failInfo = failedCount > 0 ? `，${failedCount} 批失败` : '';
    setStatus(`正在翻译... ${percent}%（${completed}/${total} 批${failInfo}）`, '');
  }

  if (message.type === 'TRANSLATION_COMPLETE') {
    const { isIncremental, cancelled, failedCount, tabId } = message.data || {};
    // 仅处理当前活动标签页的消息
    if (tabId && activeTabId && tabId !== activeTabId) return;
    isTranslating = false;
    if (!isIncremental) {
      if (cancelled) {
        setStatus('翻译已取消', 'warning');
        isTranslated = false;
      } else {
        isTranslated = true;
        setProgress(100);
        const failInfo = failedCount > 0 ? `（${failedCount} 批失败）` : '';
        setStatus(`翻译完成${failInfo}`, 'success');
      }
    }
    updateUI();
  }
});

// ============================================================
// 工具函数
// ============================================================

function sendBg(type, data = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      resolve(response || {}); // 防御 undefined
    });
  });
}

// Content Script 未就绪时自动重试
async function sendToContentScript(tabId, message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        throw e;
      }
    }
  }
}

// 启动
init();
