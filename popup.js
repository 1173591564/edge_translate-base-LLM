// DeepSeek 智能翻译 - Popup
const $ = id => document.getElementById(id);

const els = {
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  saveKey: $('saveKey'),
  keyStatus: $('keyStatus'),
  autoToggle: $('autoToggle'),
  translateBtn: $('translateBtn'),
  restoreBtn: $('restoreBtn'),
  statusSection: $('statusSection'),
  statusText: $('statusText'),
};

let hasApiKey = false;
let isTranslating = false;
let isTranslated = false;
let keyMasked = true;
let tabId = null;

// ---- 初始化 ----
async function init() {
  const state = await bg('GET_STATE');
  hasApiKey = state.hasApiKey;

  if (hasApiKey) {
    els.apiKey.value = 'sk-••••••••••••••••';
    els.apiKey.dataset.hasKey = 'true';
    setKeyStatus('API Key 已配置', 'success');
  }

  els.autoToggle.checked = state.autoTranslate;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      tabId = tab.id;
      const cs = await sendTab(tab.id, { type: 'GET_STATE' });
      if (cs) {
        isTranslated = cs.translated;
        isTranslating = cs.translating;
      }
    }
  } catch {}

  updateUI();
}

// ---- UI 更新 ----
function updateUI() {
  if (isTranslating) {
    els.translateBtn.disabled = false;
    els.translateBtn.textContent = '取消翻译';
    els.translateBtn.classList.add('btn-cancel');
    els.translateBtn.classList.remove('btn-main');
    els.statusSection.classList.remove('hidden');
    els.statusText.textContent = '正在等待页面稳定并翻译...';
    els.statusText.className = 'hint shimmer-text';
  } else {
    els.translateBtn.classList.remove('btn-cancel');
    els.translateBtn.classList.add('btn-main');
    els.translateBtn.disabled = !hasApiKey;

    if (isTranslated) {
      els.translateBtn.textContent = '重新翻译';
      els.restoreBtn.classList.remove('hidden');
    } else {
      els.translateBtn.textContent = '翻译此页';
      els.restoreBtn.classList.add('hidden');
      els.statusSection.classList.add('hidden');
    }
  }
}

function setKeyStatus(text, type) {
  els.keyStatus.textContent = text;
  els.keyStatus.className = 'hint' + (type ? ' ' + type : '');
}

function setStatus(text, type, animate = false) {
  els.statusText.textContent = text;
  els.statusText.className = 'hint' + (type ? ' ' + type : '') + (animate ? ' shimmer-text' : '');
  if (text) els.statusSection.classList.remove('hidden');
}

// ---- 事件 ----
els.saveKey.addEventListener('click', async () => {
  const val = els.apiKey.value.trim();
  if (!val || val.includes('•')) { setKeyStatus('请输入有效的 API Key', 'error'); return; }
  await bg('SAVE_API_KEY', val);
  hasApiKey = true;
  els.apiKey.dataset.hasKey = 'true';
  setKeyStatus('API Key 已保存', 'success');
  updateUI();
});

els.toggleKey.addEventListener('click', () => {
  if (keyMasked) {
    els.apiKey.type = 'text';
    if (els.apiKey.dataset.hasKey === 'true') {
      els.apiKey.value = '';
      els.apiKey.placeholder = '输入新 Key 以替换...';
    }
  } else {
    els.apiKey.type = 'password';
    if (els.apiKey.dataset.hasKey === 'true') {
      els.apiKey.value = 'sk-••••••••••••••••';
    }
  }
  keyMasked = !keyMasked;
});

els.autoToggle.addEventListener('change', async () => {
  const result = await bg('TOGGLE_AUTO');
  els.autoToggle.checked = result.autoTranslate;
});

els.translateBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  tabId = tab.id;

  if (isTranslating) {
    await bg('CANCEL');
    isTranslating = false;
    setStatus('翻译已取消', 'warning');
    updateUI();
    return;
  }

  isTranslating = true;
  updateUI();
  setStatus('正在等待页面稳定并翻译...', '', true);

  try {
    const result = await sendTab(tab.id, { type: 'START_TRANSLATE' });
    if (result?.error) {
      isTranslating = false;
      setStatus(result.error, 'error');
      updateUI();
    } else if (result?.ok) {
      setStatus(`正在翻译 ${result.count} 个语义块...`, '', true);
    }
  } catch (err) {
    isTranslating = false;
    setStatus('翻译出错: ' + err.message, 'error');
    updateUI();
  }
});

els.restoreBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await sendTab(tab.id, { type: 'RESTORE' });
    isTranslated = false;
    isTranslating = false;
    setStatus('已恢复原文', 'success');
    updateUI();
  } catch (err) {
    setStatus('恢复出错: ' + err.message, 'error');
  }
});

// ---- 监听 background 推送 ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TRANSLATION_COMPLETE') {
    isTranslating = false;
    isTranslated = true;
    setStatus('翻译完成', 'success');
    updateUI();
  }
});

// ---- 工具函数 ----
function bg(type, data) {
  return new Promise(resolve => {
    const payload = data !== undefined
      ? (type === 'SAVE_API_KEY' ? { type, apiKey: data } : { type, ...data })
      : { type };
    chrome.runtime.sendMessage(payload, r => resolve(r || {}));
  });
}

async function sendTab(id, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await chrome.tabs.sendMessage(id, msg); }
    catch (e) { if (i < retries - 1) await new Promise(r => setTimeout(r, 500)); else throw e; }
  }
}

init();
