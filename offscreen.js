// Map<tabId, { recorder: MediaRecorder, stream: MediaStream, chunks: Blob[] }>
const recordings = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  handleMessage(message)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      console.error('[offscreen] error:', e);
      sendResponse({ ok: false, error: e.message });
    });

  return true; // keep channel open for async response
});

async function handleMessage({ action, streamId, tabId, filename }) {
  switch (action) {
    case 'start':
      await startRecording(tabId, streamId, filename);
      break;
    case 'pause':
      pauseRecording(tabId);
      break;
    case 'resume':
      resumeRecording(tabId);
      break;
    case 'stop':
      stopRecording(tabId);
      break;
  }
}

async function startRecording(tabId, streamId, filename) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  // Echo the stream back to speakers — without this, tabCapture silences the tab
  const audioEl = new Audio();
  audioEl.srcObject = stream;
  audioEl.play();

  // Analyser for equalizer icon — reads frequency data and sends to background.
  // Connected to stream source only, NOT to destination (audioEl handles playback).
  let audioCtx;
  let levelIntervalId;
  try {
    audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 32;                  // 16 frequency bins — one per equalizer bar
    analyser.smoothingTimeConstant = 0.75;  // smooth decay between frames
    audioCtx.createMediaStreamSource(stream).connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount); // 16 values
    levelIntervalId = setInterval(() => {
      analyser.getByteFrequencyData(freqData);
      chrome.runtime.sendMessage(
        {
          target: 'background',
          action: 'levels',
          tabId,
          levels: Array.from(freqData), // all 16 bins → 16 radial bars
        },
        () => void chrome.runtime.lastError
      );
    }, 80); // ~12 fps
  } catch (e) {
    console.warn('[offscreen] AudioContext setup failed, no equalizer:', e);
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  const entry = { recorder, stream, chunks, audioEl, audioCtx, levelIntervalId, totalBytes: 0 };
  recordings.set(tabId, entry);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
      entry.totalBytes += e.data.size;
      chrome.runtime.sendMessage(
        { target: 'background', action: 'size', tabId, bytes: entry.totalBytes },
        () => void chrome.runtime.lastError
      );
    }
  };

  recorder.onstop = () => {
    clearInterval(levelIntervalId);
    audioCtx?.close();
    stream.getTracks().forEach((t) => t.stop());
    recordings.delete(tabId);

    if (chunks.length === 0) {
      console.warn('[offscreen] no audio chunks, skipping save');
      chrome.runtime.sendMessage({ target: 'background', action: 'save_failed', tabId });
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });

    // Convert to base64 data URL — the only reliable way to pass binary
    // data from offscreen to background service worker for chrome.downloads.
    const reader = new FileReader();
    reader.onload = () => {
      chrome.runtime.sendMessage(
        { target: 'background', action: 'save', tabId, dataUrl: reader.result, filename },
        () => void chrome.runtime.lastError
      );
    };
    reader.onerror = (e) => console.error('[offscreen] FileReader error:', e);
    reader.readAsDataURL(blob);
  };

  // Collect chunks every second to limit memory usage per chunk
  recorder.start(1000);
}

function pauseRecording(tabId) {
  const rec = recordings.get(tabId);
  if (rec?.recorder.state === 'recording') {
    rec.recorder.pause();
  }
}

function resumeRecording(tabId) {
  const rec = recordings.get(tabId);
  if (rec?.recorder.state === 'paused') {
    rec.recorder.resume();
  }
}

function stopRecording(tabId) {
  const rec = recordings.get(tabId);
  if (rec) {
    clearInterval(rec.levelIntervalId); // stop sending levels immediately
    rec.recorder.stop();
  }
}
