// State: Map<tabId, { state: 'recording'|'paused', filename: string, tabTitle: string }>
const tabStates = new Map();

const ICONS = {
  idle: 'icons/idle.png',
  recording: 'icons/recording.png',
  paused: 'icons/paused.png',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFilename(tabTitle) {
  const clean = (tabTitle || 'tab')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('-');
  return `recording-${clean || 'tab'}-${ts}.webm`;
}

function updateIcon(tabId, state) {
  chrome.action.setIcon({ path: ICONS[state] || ICONS.idle, tabId }, () => {
    // Suppress "No tab with id" errors when tab is already closed
    void chrome.runtime.lastError;
  });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Tab audio capture via MediaRecorder',
    });
  }
}

// ─── Start recording ──────────────────────────────────────────────────────────

async function startRecording(tab) {
  await ensureOffscreen();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    console.error('[background] tabCapture failed:', e);
    return;
  }

  const filename = makeFilename(tab.title);
  tabStates.set(tab.id, { state: 'recording', filename, tabTitle: tab.title });
  updateIcon(tab.id, 'recording');

  try {
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'start',
      streamId,
      tabId: tab.id,
      filename,
    });
  } catch (e) {
    console.error('[background] failed to reach offscreen:', e);
    tabStates.delete(tab.id);
    updateIcon(tab.id, 'idle');
  }
}

// ─── Icon click handler ───────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  const current = tabStates.get(tab.id);

  if (!current) {
    await startRecording(tab);
    return;
  }

  if (current.state === 'recording') {
    current.state = 'paused';
    updateIcon(tab.id, 'paused');
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', tabId: tab.id });
  } else if (current.state === 'paused') {
    current.state = 'recording';
    updateIcon(tab.id, 'recording');
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume', tabId: tab.id });
  }
});

// ─── Tab closed → stop recording ─────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.has(tabId)) {
    chrome.runtime.sendMessage(
      { target: 'offscreen', action: 'stop', tabId },
      () => void chrome.runtime.lastError // offscreen may already be gone
    );
  }
});

// ─── Message from offscreen ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return;

  if (message.action === 'save') {
    tabStates.delete(message.tabId);
    updateIcon(message.tabId, 'idle');

    // dataUrl is a base64-encoded data URL — chrome.downloads supports it directly
    chrome.downloads.download(
      { url: message.dataUrl, filename: message.filename, saveAs: false },
      (downloadId) => {
        void chrome.runtime.lastError;
        chrome.notifications.create(`rec-saved-${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/idle.png'),
          title: 'Recording Saved',
          message: message.filename,
        });
      }
    );
  }

  if (message.action === 'save_failed') {
    tabStates.delete(message.tabId);
    updateIcon(message.tabId, 'idle');
    console.warn('[background] save_failed for tab', message.tabId);
  }

  sendResponse({ ok: true });
  return true;
});
