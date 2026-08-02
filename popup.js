const DEFAULT_SETTINGS = {
  markers: true,
  tooltip: true,
  toast: true,
  sound: true,
  toastPosition: 'top-right',
  soundVolume: 100,
  customSoundDataUrl: null,
  customSoundName: null,
};

const MAX_CLIP_SECONDS = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // headroom under chrome.storage.local's ~10MB default quota

const checkboxes = {
  markers: document.getElementById('markers'),
  tooltip: document.getElementById('tooltip'),
  toast: document.getElementById('toast'),
  sound: document.getElementById('sound'),
};
const posButtons = Array.from(document.querySelectorAll('.pos-btn'));
const volumeInput = document.getElementById('volume');
const volumeLabel = document.getElementById('volumeLabel');
const soundDrop = document.getElementById('soundDrop');
const soundDropLabel = document.getElementById('soundDropLabel');
const soundFileInput = document.getElementById('soundFileInput');
const soundError = document.getElementById('soundError');
const browseSoundBtn = document.getElementById('browseSoundBtn');
const previewSoundBtn = document.getElementById('previewSoundBtn');
const resetSoundBtn = document.getElementById('resetSoundBtn');

let previewCtx = null;

function getSettings(cb) {
  chrome.storage.local.get({ ytcSettings: DEFAULT_SETTINGS }, (res) => {
    cb({ ...DEFAULT_SETTINGS, ...res.ytcSettings });
  });
}

function saveSettings(patch, cb) {
  getSettings((settings) => {
    const next = { ...settings, ...patch };
    chrome.storage.local.set({ ytcSettings: next }, () => {
      if (chrome.runtime.lastError) {
        showError('Could not save: ' + chrome.runtime.lastError.message);
      } else {
        cb?.(next);
      }
    });
  });
}

function showError(msg) {
  soundError.textContent = msg;
}

function applyToUI(settings) {
  for (const key in checkboxes) checkboxes[key].checked = settings[key];
  posButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.pos === settings.toastPosition));
  volumeInput.value = settings.soundVolume;
  volumeLabel.textContent = settings.soundVolume + '%';
  soundDropLabel.textContent = settings.customSoundName
    ? `🎵 ${settings.customSoundName}`
    : 'Default chime';
}

getSettings(applyToUI);

// --- simple toggles / position / volume --------------------------------

for (const key in checkboxes) {
  checkboxes[key].addEventListener('change', () => {
    saveSettings({ [key]: checkboxes[key].checked });
  });
}

posButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    posButtons.forEach((b) => b.classList.toggle('active', b === btn));
    saveSettings({ toastPosition: btn.dataset.pos });
  });
});

volumeInput.addEventListener('input', () => {
  volumeLabel.textContent = volumeInput.value + '%';
});
volumeInput.addEventListener('change', () => {
  saveSettings({ soundVolume: Number(volumeInput.value) });
});

// --- custom sound upload: browse / drag-drop / paste --------------------

function handleFile(file) {
  showError('');
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    showError('That file is not an audio clip.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showError('File is too large (max 8MB).');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showError('Could not read that file.');
  reader.onload = () => {
    const dataUrl = reader.result;
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.src = dataUrl;
    probe.addEventListener('loadedmetadata', () => {
      if (!isFinite(probe.duration) || probe.duration > MAX_CLIP_SECONDS + 0.05) {
        showError(`Clip is ${probe.duration.toFixed(1)}s — must be ${MAX_CLIP_SECONDS}s or shorter.`);
        return;
      }
      saveSettings({ customSoundDataUrl: dataUrl, customSoundName: file.name }, (settings) => {
        applyToUI(settings);
      });
    });
    probe.addEventListener('error', () => showError('Could not read that as an audio clip.'));
  };
  reader.readAsDataURL(file);
}

browseSoundBtn.addEventListener('click', () => soundFileInput.click());
soundDrop.addEventListener('click', () => soundFileInput.click());
soundDrop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') soundFileInput.click();
});

soundFileInput.addEventListener('change', () => {
  handleFile(soundFileInput.files[0]);
  soundFileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  soundDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    soundDrop.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  soundDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    soundDrop.classList.remove('dragover');
  })
);
soundDrop.addEventListener('drop', (e) => {
  handleFile(e.dataTransfer.files[0]);
});

// Paste anywhere in the popup (e.g. Ctrl+V after copying an audio file).
document.addEventListener('paste', (e) => {
  const file = Array.from(e.clipboardData?.files || [])[0];
  if (file) handleFile(file);
});

resetSoundBtn.addEventListener('click', () => {
  showError('');
  saveSettings({ customSoundDataUrl: null, customSoundName: null }, (settings) => {
    applyToUI(settings);
  });
});

// --- preview: mirrors the content script's own playback path (a GainNode,
// so preview at >100% actually sounds like it will on the video). ---------

function ensurePreviewCtx() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!previewCtx) previewCtx = new AudioCtx();
  if (previewCtx.state === 'suspended') previewCtx.resume();
  return previewCtx;
}

function playDefaultChime(ctx, destination) {
  const now = ctx.currentTime;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, now);
  envelope.gain.linearRampToValueAtTime(0.6, now + 0.01);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
  envelope.connect(destination);
  [880, 1108.73].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(envelope);
    const start = now + i * 0.08;
    osc.start(start);
    osc.stop(start + 0.35);
  });
}

previewSoundBtn.addEventListener('click', () => {
  showError('');
  getSettings((settings) => {
    const ctx = ensurePreviewCtx();
    const gainNode = ctx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(150, settings.soundVolume)) / 100;
    gainNode.connect(ctx.destination);

    if (settings.customSoundDataUrl) {
      fetch(settings.customSoundDataUrl)
        .then((res) => res.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
        .then((audioBuffer) => {
          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          src.connect(gainNode);
          src.start();
        })
        .catch(() => showError('Could not play the saved clip.'));
    } else {
      playDefaultChime(ctx, gainNode);
    }
  });
});
