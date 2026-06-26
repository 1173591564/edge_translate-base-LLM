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

// ============================================================
// 初始化
// ============================================================

async function init() {
  // 从 Background 获取状态
  const bgState = await sendBg('GET_STATE');
  hasApiKey = bgState.hasApiKey;
  isTranslating = bgState.translating;

  if (hasApiKey) {
    els.apiKeyInput.value = 'sk-••••••••••••••••';
    els.apiKeyInput.dataset.hasKey = 'true';
    setKeyStatus('API Key 已配置', 'success');
  }

  els.autoToggle.checked = bgState.autoTranslate;
  updateUI();

  // 获取 Content Script 状态
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const contentState = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTENT_STATE' });
      if (contentState) {
        isTranslated = contentState.isTranslated;
        isTranslating = contentState.isTranslating;
      }
    }
  } catch (e) {
    // Content script 未加载
  }

  updateUI();
}

// ============================================================
// UI 状态更新
// ============================================================

function updateUI() {
  // 翻译按钮
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
    // 要显示：如果是遮罩值，先清空让用户输入新 Key
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

// 自动翻译开关
els.autoToggle.addEventListener('change', async () => {
  const result = await sendBg('TOGGLE_AUTO');
  els.autoToggle.checked = result.autoTranslate;
});

// 翻译 / 取消按钮
els.translateBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (isTranslating) {
    // 取消翻译
    await sendBg('CANCEL_TRANSLATE');
    isTranslating = false;
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
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'START_TRANSLATE' });

    if (result.error) {
      isTranslating = false;
      setStatus(result.error, 'error');
      updateUI();
      return;
    }

    if (result.ok) {
      // 翻译已启动，结果通过 TRANSLATION_COMPLETE 消息通知
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
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_ORIGINAL' });
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
// 监听 Background 进度推送
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROGRESS_UPDATE') {
    const { completed, total, percent } = message.data;
    setProgress(percent);
    setStatus(`正在翻译... ${percent}%（${completed}/${total} 批）`, '');
  }

  if (message.type === 'TRANSLATION_COMPLETE') {
    const { isIncremental } = message.data || {};
    isTranslating = false;
    if (!isIncremental) {
      isTranslated = true;
      setProgress(100);
      setStatus('翻译完成', 'success');
    }
    updateUI();
  }
});

// ============================================================
// 工具函数
// ============================================================

function sendBg(type, data = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, data }, resolve);
  });
}

// 启动
init();
