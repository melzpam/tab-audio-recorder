// State: Map<tabId, { state, filename, tabTitle, domain, startTime, pausedMs, pauseAt, lastTitleSec, finalElapsed }>
const tabStates = new Map();

const ICONS = {
  idle: 'icons/idle.png',
  recording: 'icons/recording.png',
  paused: 'icons/paused.png',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // Return SLD only — strip the TLD (last segment): youtube.com → youtube
    const parts = host.split('.');
    return parts.length > 1 ? parts.slice(0, -1).join('.') : host;
  } catch {
    return '';
  }
}

function applyMask(mask, title, domain) {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('-');
  const datetime = `${date}_${time}`;

  const safeTitle = (title || 'tab')
    .replace(/[^a-zA-Z0-9_\- ]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'tab';

  const safeDomain = (domain || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  return mask
    .replace(/{title}/g, safeTitle)
    .replace(/{domain}/g, safeDomain)
    .replace(/{date}/g, date)
    .replace(/{time}/g, time)
    .replace(/{datetime}/g, datetime);
}

async function makeFilename(tabTitle, domain) {
  const DEFAULT_MASK = 'recording-{title}-{date}';
  const result = await chrome.storage.sync.get({
    filenameMask: DEFAULT_MASK,
    saveFolder: '',
    groupByDomain: false,
  });
  const name = applyMask(result.filenameMask, tabTitle, domain) + '.webm';
  const safeDomain = (domain || 'unknown').replace(/[<>:"|?*\s]/g, '_');

  let folder = (result.saveFolder || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  folder = folder.replace(/[<>:"|?*]/g, '');
  const parts = [];
  if (folder) parts.push(folder);
  if (result.groupByDomain && domain) parts.push(safeDomain);
  parts.push(name);
  return parts.join('/');
}

function getElapsed(st) {
  if (st.state === 'paused') {
    return (st.pauseAt || Date.now()) - st.startTime - st.pausedMs;
  }
  return Date.now() - st.startTime - st.pausedMs;
}

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateIcon(tabId, state) {
  chrome.action.setIcon({ path: ICONS[state] || ICONS.idle, tabId }, () => {
    void chrome.runtime.lastError;
  });
}

function setDefaultTitle(tabId) {
  chrome.action.setTitle({ title: 'Record Tab Audio', tabId }, () => void chrome.runtime.lastError);
}

// ─── History ──────────────────────────────────────────────────────────────────

async function appendHistoryEntry(entry) {
  const result = await chrome.storage.local.get({ history: [] });
  const history = result.history;
  history.unshift(entry);
  if (history.length > 100) history.splice(100);
  await chrome.storage.local.set({ history });
}

// ─── Equalizer icon ───────────────────────────────────────────────────────────

function drawEqualizerIcon(tabId, levels) {
  try {
    const SIZE = 48;
    const NUM_BARS = 4;
    const GAP = 2;
    const BAR_W = Math.floor((SIZE - GAP * (NUM_BARS - 1)) / NUM_BARS);
    const START_X = Math.round((SIZE - (BAR_W * NUM_BARS + GAP * (NUM_BARS - 1))) / 2);
    const BOTTOM = SIZE - 1;
    const MAX_H = SIZE - 2;
    const MIN_H = 3;

    const bands = [
      Math.max(...levels.slice(0, 4)),
      Math.max(...levels.slice(4, 8)),
      Math.max(...levels.slice(8, 12)),
      Math.max(...levels.slice(12, 16)),
    ];

    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, BOTTOM, 0, BOTTOM - MAX_H);
    grad.addColorStop(0,   '#4ade80');
    grad.addColorStop(0.6, '#facc15');
    grad.addColorStop(1,   '#f87171');
    ctx.fillStyle = grad;

    for (let i = 0; i < NUM_BARS; i++) {
      const h = Math.round(MIN_H + (bands[i] / 255) * (MAX_H - MIN_H));
      ctx.fillRect(START_X + i * (BAR_W + GAP), BOTTOM - h, BAR_W, h);
    }

    chrome.action.setIcon(
      { imageData: ctx.getImageData(0, 0, SIZE, SIZE), tabId },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    console.error('[background] drawEqualizerIcon error:', e);
  }
}

// ─── Offscreen document ───────────────────────────────────────────────────────

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

  const domain = extractDomain(tab.url);
  const filename = await makeFilename(tab.title, domain);
  tabStates.set(tab.id, {
    state: 'recording',
    filename,
    tabTitle: tab.title,
    domain,
    startTime: Date.now(),
    pausedMs: 0,
    pauseAt: null,
    lastTitleSec: -1,
    finalElapsed: 0,
  });
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

// ─── Message handlers ─────────────────────────────────────────────────────────

function handleLevels({ tabId, levels }, sendResponse) {
  const st = tabStates.get(tabId);
  if (st) {
    if (st.state === 'recording') {
      drawEqualizerIcon(tabId, levels);
    }
    const elapsed = getElapsed(st);
    const sec = Math.floor(elapsed / 1000);
    if (sec !== st.lastTitleSec) {
      st.lastTitleSec = sec;
      const label = st.state === 'paused' ? '⏸' : '●';
      const time = elapsed >= 1000 ? formatTime(elapsed) : '0:00';
      chrome.action.setTitle(
        { title: `${label} ${time}`, tabId },
        () => void chrome.runtime.lastError
      );
    }
  }
  sendResponse({ ok: true });
}

function handleSave({ tabId, dataUrl, filename }, sendResponse) {
  const st = tabStates.get(tabId);
  const duration = st?.finalElapsed ?? 0;
  const tabTitle = st?.tabTitle || '';
  const domain = st?.domain || '';

  tabStates.delete(tabId);
  setDefaultTitle(tabId);
  updateIcon(tabId, 'idle');

  chrome.downloads.download(
    { url: dataUrl, filename, saveAs: false },
    (downloadId) => {
      void chrome.runtime.lastError;
      if (downloadId !== undefined) {
        appendHistoryEntry({ filename, domain, tabTitle, duration, timestamp: Date.now(), downloadId });
      }
    }
  );
  sendResponse({ ok: true });
}

function handleSaveFailed({ tabId }, sendResponse) {
  tabStates.delete(tabId);
  setDefaultTitle(tabId);
  updateIcon(tabId, 'idle');
  console.warn('[background] save_failed for tab', tabId);
  sendResponse({ ok: true });
}

function handleGetState({ tabId }, sendResponse) {
  const st = tabStates.get(tabId);
  if (!st || st.state === 'stopping') { sendResponse(null); return; }
  sendResponse({ state: st.state, elapsed: getElapsed(st), size: st.currentSize || 0 });
}

function handleSize({ tabId, bytes }, sendResponse) {
  const st = tabStates.get(tabId);
  if (st) st.currentSize = bytes;
  sendResponse({ ok: true });
}

async function handleStartRecording(message, sendResponse) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { sendResponse({ ok: false, error: 'No active tab' }); return; }
  await startRecording(tab);
  sendResponse({ ok: true });
}

function handlePauseRecording({ tabId }, sendResponse) {
  const st = tabStates.get(tabId);
  if (!st || st.state !== 'recording') { sendResponse({ ok: false }); return; }
  st.state = 'paused';
  st.pauseAt = Date.now();
  updateIcon(tabId, 'paused');
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause', tabId });
  sendResponse({ ok: true });
}

function handleResumeRecording({ tabId }, sendResponse) {
  const st = tabStates.get(tabId);
  if (!st || st.state !== 'paused') { sendResponse({ ok: false }); return; }
  st.pausedMs += Date.now() - st.pauseAt;
  st.pauseAt = null;
  st.state = 'recording';
  updateIcon(tabId, 'recording');
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume', tabId });
  sendResponse({ ok: true });
}

function handleStopRecording({ tabId }, sendResponse) {
  const st = tabStates.get(tabId);
  if (st) {
    st.finalElapsed = getElapsed(st);
    st.state = 'stopping';
  }
  chrome.runtime.sendMessage(
    { target: 'offscreen', action: 'stop', tabId },
    () => void chrome.runtime.lastError
  );
  sendResponse({ ok: true });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const HANDLERS = {
  levels:          handleLevels,
  save:            handleSave,
  save_failed:     handleSaveFailed,
  size:            handleSize,
  getState:        handleGetState,
  startRecording:  handleStartRecording,
  pauseRecording:  handlePauseRecording,
  resumeRecording: handleResumeRecording,
  stopRecording:   handleStopRecording,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'background') return;
  const handler = HANDLERS[message.action];
  if (!handler) return;
  const result = handler(message, sendResponse);
  if (result && typeof result.then === 'function') {
    result.catch(e => {
      console.error(`[background] handler error (${message.action}):`, e);
      sendResponse({ ok: false, error: e.message });
    });
  }
  return true; // keep channel open for async handlers
});

// ─── Tab closed → stop recording ─────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  const st = tabStates.get(tabId);
  if (st) {
    st.finalElapsed = getElapsed(st);
    st.state = 'stopping';
    chrome.runtime.sendMessage(
      { target: 'offscreen', action: 'stop', tabId },
      () => void chrome.runtime.lastError
    );
  }
});
