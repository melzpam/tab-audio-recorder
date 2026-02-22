// ─── State ────────────────────────────────────────────────────────────────────

let activeTab     = null;
let localState    = 'idle';   // 'idle' | 'recording' | 'paused'
let elapsedAtPoll = 0;
let timerBase     = null;
let timerInterval = null;
let sizeInterval  = null;
let currentSize   = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.md3-tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (tab) {
    const st = await sendMsg({ action: 'getState', tabId: tab.id });
    if (st) {
      localState    = st.state;
      elapsedAtPoll = st.elapsed;
      currentSize   = st.size || 0;
      timerBase     = st.state === 'recording' ? Date.now() : null;
    }
  }

  renderRecordingUI();
  if (localState === 'recording') { startTimer(); startSizePolling(); }

  loadHistory();

  document.getElementById('btn-start') .addEventListener('click', handleStart);
  document.getElementById('btn-pause') .addEventListener('click', handlePause);
  document.getElementById('btn-resume').addEventListener('click', handleResume);
  document.getElementById('btn-stop')  .addEventListener('click', handleStop);

  loadSettings();
  document.getElementById('folder-input').addEventListener('input', onFolderInput);
  document.querySelectorAll('.md3-chip').forEach(chip =>
    chip.addEventListener('click', () => insertAtCursor(chip.dataset.placeholder))
  );
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
});

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.md3-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === name)
  );
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === `panel-${name}`)
  );
  if (name === 'settings') { loadSettings(); }
}

// ─── Recording controls ───────────────────────────────────────────────────────

async function handleStart() {
  localState = 'recording'; elapsedAtPoll = 0; currentSize = 0; timerBase = Date.now();
  renderRecordingUI(); startTimer(); startSizePolling();
  await sendMsg({ action: 'startRecording' });
}

function handlePause() {
  elapsedAtPoll += Date.now() - timerBase; timerBase = null;
  stopTimer(); stopSizePolling();
  localState = 'paused'; renderRecordingUI();
  sendMsg({ action: 'pauseRecording', tabId: activeTab?.id });
}

function handleResume() {
  timerBase = Date.now(); localState = 'recording';
  renderRecordingUI(); startTimer(); startSizePolling();
  sendMsg({ action: 'resumeRecording', tabId: activeTab?.id });
}

function handleStop() {
  stopTimer(); stopSizePolling();
  elapsedAtPoll = 0; timerBase = null; currentSize = 0; localState = 'idle';
  renderRecordingUI();
  sendMsg({ action: 'stopRecording', tabId: activeTab?.id });
  setTimeout(loadHistory, 3000);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderRecordingUI() {
  const chip    = document.getElementById('state-chip');
  const label   = document.getElementById('state-label');
  const timerEl = document.getElementById('timer');
  const sizeEl  = document.getElementById('file-size');
  const s = localState;

  chip.className    = `state-chip ${s}`;
  label.textContent = { idle: 'Idle', recording: 'Recording', paused: 'Paused' }[s] || 'Idle';
  timerEl.className = `md3-timer ${s}`;
  timerEl.textContent = s === 'idle' ? '--:--' : formatTime(currentElapsed());
  sizeEl.textContent  = s !== 'idle' && currentSize > 0 ? formatBytes(currentSize) : '';

  document.getElementById('btn-start') .style.display = s === 'idle'      ? '' : 'none';
  document.getElementById('btn-pause') .style.display = s === 'recording' ? '' : 'none';
  document.getElementById('btn-resume').style.display = s === 'paused'    ? '' : 'none';
  document.getElementById('btn-stop')  .style.display = s !== 'idle'      ? '' : 'none';
}

function currentElapsed() {
  return elapsedAtPoll + (timerBase !== null ? Date.now() - timerBase : 0);
}

// ─── Timer ────────────────────────────────────────────────────────────────────

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (timerBase !== null)
      document.getElementById('timer').textContent = formatTime(currentElapsed());
  }, 100);
}

function stopTimer()  { clearInterval(timerInterval); timerInterval = null; }

// ─── Size polling ─────────────────────────────────────────────────────────────

function startSizePolling() {
  if (sizeInterval) clearInterval(sizeInterval);
  sizeInterval = setInterval(async () => {
    if (!activeTab || localState === 'idle') return;
    const st = await sendMsg({ action: 'getState', tabId: activeTab.id });
    if (st?.size !== undefined) {
      currentSize = st.size;
      const el = document.getElementById('file-size');
      if (el) el.textContent = currentSize > 0 ? formatBytes(currentSize) : '';
    }
  }, 1000);
}

function stopSizePolling() { clearInterval(sizeInterval); sizeInterval = null; }

// ─── History ──────────────────────────────────────────────────────────────────

const IC_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

async function loadHistory() {
  const container = document.getElementById('history-list');
  const { history = [] } = await chrome.storage.local.get({ history: [] });

  if (!history.length) {
    container.innerHTML = '<div class="history-empty">No recordings yet</div>';
    return;
  }

  container.innerHTML = '';
  history.forEach((entry, i) => {
    const wrap = document.createElement('div');

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item-body">
        <div class="history-name-row">
          <span class="history-filename" title="${escHtml(entry.filename)}">${escHtml(leafName(entry.filename))}</span>
          <button class="md3-icon-btn icon-copy" title="Copy file:// link">${IC_COPY}</button>
        </div>
        <div class="history-meta">${escHtml(entry.domain)} · ${formatTime(entry.duration)} · ${formatDate(entry.timestamp)}</div>
      </div>
    `;

    // Filename click → show in Finder / Explorer with file highlighted
    item.querySelector('.history-filename').addEventListener('click', () => {
      chrome.downloads.show(entry.downloadId);
    });

    // Copy icon → clipboard with file:// URL
    item.querySelector('.icon-copy').addEventListener('click', async (e) => {
      await copyFileLink(entry.downloadId, e.currentTarget);
    });

    wrap.appendChild(item);
    if (i < history.length - 1) {
      const div = document.createElement('div');
      div.className = 'history-divider';
      wrap.appendChild(div);
    }
    container.appendChild(wrap);
  });
}

async function copyFileLink(downloadId, btn) {
  const items = await chrome.downloads.search({ id: downloadId });
  if (!items.length) return;
  const path = items[0].filename;
  const url  = path.startsWith('/') ? 'file://' + path : 'file:///' + path.replace(/\\/g, '/');
  await navigator.clipboard.writeText(url);
  btn.classList.add('icon-copied');
  setTimeout(() => btn.classList.remove('icon-copied'), 1500);
}

function leafName(path) { return path.replace(/^.*[/\\]/, ''); }

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const result = await chrome.storage.sync.get({
    filenameMask: 'recording-{title}-{date}',
    saveFolder: '',
    groupByDomain: false,
  });
  document.getElementById('mask-input').value         = result.filenameMask;
  document.getElementById('folder-input').value       = result.saveFolder;
  document.getElementById('cb-domain-groups').checked = result.groupByDomain;
  updateFolderHint();
}

function onFolderInput() { updateFolderHint(); }

function updateFolderHint() {
  const folder = document.getElementById('folder-input').value.trim();
  const hint   = document.getElementById('folder-hint');
  if (!folder) {
    hint.textContent = 'Subfolder within your Downloads directory';
  } else if (folder.startsWith('/') || /^[A-Za-z]:/.test(folder)) {
    hint.textContent = folder + '/';
  } else {
    hint.textContent = `~/Downloads/${folder}/`;
  }
}

async function saveSettings() {
  const mask          = document.getElementById('mask-input').value;
  const folder        = document.getElementById('folder-input').value.trim();
  const groupByDomain = document.getElementById('cb-domain-groups').checked;
  await chrome.storage.sync.set({ filenameMask: mask, saveFolder: folder, groupByDomain });
  const btn = document.getElementById('btn-save-settings');
  btn.textContent = '✓ Saved';
  btn.classList.add('saved');
  setTimeout(() => { btn.textContent = 'Save settings'; btn.classList.remove('saved'); }, 1500);
}

function insertAtCursor(text) {
  const input = document.getElementById('mask-input');
  const s = input.selectionStart, e = input.selectionEnd;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.focus();
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatBytes(b) {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ target: 'background', ...msg }, res => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

function safeDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    return parts.length > 1 ? parts.slice(0, -1).join('.') : host;
  }
  catch { return 'example'; }
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
