// Finds timestamp links YouTube auto-generates inside comments (e.g. "4:48")
// and overlays tick marks on the video progress bar, like chapter markers.
(function () {
  const BUCKET_SECONDS = 2; // merge mentions within 2s into one marker
  const TOAST_LEAD_BASE_SECONDS = 3;
  const TOAST_LEAD_MAX_EXTRA_SECONDS = 7; // caps lead time at 10s for very long comments
  const TOAST_LEAD_CHARS_PER_EXTRA_SECOND = 20; // +1s of lead per 20 characters of comment text
  // Roughly what the clamped (non-hovered) toast comment actually shows —
  // matches the CSS line-clamp in style.css. The reading-time bonus below is
  // budgeted against this, not the full comment, since text past this point
  // is hidden until you hover anyway.
  const TOAST_VISIBLE_CHAR_BUDGET = 140;

  const DEFAULT_SETTINGS = {
    markers: true,
    tooltip: true,
    toast: true,
    sound: true,
    toastPosition: 'top-right',
    soundVolume: 100, // percent, 0-150
    customSoundDataUrl: null,
    customSoundName: null,
  };

  const TOAST_POSITION_CLASSES = [
    'ytc-toast-pos-top-left',
    'ytc-toast-pos-top-center',
    'ytc-toast-pos-top-right',
    'ytc-toast-pos-bottom-left',
    'ytc-toast-pos-bottom-center',
    'ytc-toast-pos-bottom-right',
  ];

  const state = {
    videoId: null,
    duration: 0,
    hits: new Map(), // bucketKey -> { seconds, count, samples[] }
    seenLinks: new WeakSet(), // anchors already counted, so re-scans don't double-count
    observer: null,
    renderQueued: false,
    boundVideos: new WeakSet(),
    audioCtx: null,
    settings: { ...DEFAULT_SETTINGS },
    customAudioBuffer: null, // decoded once when customSoundDataUrl changes
    customAudioBufferFor: null, // which dataUrl the buffer above belongs to
    toastedHits: new Set(), // hits sound has already fired for on this approach
    dismissedHits: new Set(), // hits the user closed with the X, for this approach
    currentToastHit: null, // the hit the toast is currently showing, if any
    toastHoverPausedVideo: false, // true only if hovering the toast paused it ourselves
  };

  const getVideoId = () => new URLSearchParams(location.search).get('v');
  const getVideo = () => document.querySelector('video.html5-main-video');
  const getProgressBar = () => document.querySelector('.ytp-progress-bar-container');

  function formatTime(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(Math.floor(total % 60)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // --- settings -------------------------------------------------------

  function applySettings(settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...settings };
    decodeCustomSoundIfNeeded();
    queueRender();

    if (!state.settings.tooltip) hideTooltip(getProgressBar());

    if (!state.settings.toast && state.currentToastHit) {
      state.currentToastHit = null;
      hideApproachToast();
    } else if (state.currentToastHit) {
      // Position (or anything else) may have changed while a toast is on
      // screen — move it immediately instead of waiting for the next hit.
      positionToast();
    }
  }

  function loadSettings() {
    chrome.storage.local.get({ ytcSettings: DEFAULT_SETTINGS }, (res) => {
      applySettings(res.ytcSettings);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ytcSettings) return;
    applySettings(changes.ytcSettings.newValue);
  });

  // --- comment scanning -------------------------------------------------

  function parseSeconds(href) {
    if (!href) return null;
    try {
      const t = new URL(href, location.href).searchParams.get('t');
      if (!t) return null;
      if (/^\d+$/.test(t)) return parseInt(t, 10);
      const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
      if (!m || (!m[1] && !m[2] && !m[3])) return null;
      return +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0);
    } catch {
      return null;
    }
  }

  // Collection is deliberately independent of video duration: timestamps are
  // recorded whenever they are seen, and filtered against duration only at
  // render time. Otherwise anything scanned before metadata loads is lost.
  function collect(root) {
    if (!root || root.nodeType !== 1) return 0;

    // Query anchors unscoped, then filter by ancestry. Scoping the selector
    // to "#content-text a" breaks for mutation records whose added node sits
    // *below* #content-text, where #content-text is an ancestor, not a child.
    const anchors = [];
    if (root.matches?.('a[href*="t="]')) anchors.push(root);
    root.querySelectorAll?.('a[href*="t="]').forEach((a) => anchors.push(a));

    let added = 0;
    for (const a of anchors) {
      if (state.seenLinks.has(a)) continue;
      const body = a.closest('#content-text');
      if (!body) continue; // only timestamps written inside comment bodies
      const seconds = parseSeconds(a.getAttribute('href'));
      if (seconds === null) continue;

      state.seenLinks.add(a);
      const key = Math.round(seconds / BUCKET_SECONDS) * BUCKET_SECONDS;
      let hit = state.hits.get(key);
      if (!hit) {
        hit = { seconds, count: 0, samples: [] };
        state.hits.set(key, hit);
      }
      hit.count++;
      if (hit.samples.length < 3) {
        const text = body.textContent.trim().replace(/\s+/g, ' ');
        // Only a sanity cap against pathological essay-length comments —
        // the toast/tooltip themselves clamp what's shown by default and
        // expand to the rest on hover, so this isn't the thing truncating
        // display text anymore.
        if (text) hit.samples.push(text.slice(0, 600));
      }
      added++;
    }
    return added;
  }

  // --- progress bar markers -------------------------------------------

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      render();
    });
  }

  function render() {
    const bar = getProgressBar();
    if (!bar || !state.duration) return;

    bar.querySelectorAll('.ytc-timestamp-marker').forEach((el) => el.remove());
    if (!state.settings.markers) {
      hideTooltip(bar);
      return;
    }

    for (const hit of state.hits.values()) {
      if (hit.seconds < 0 || hit.seconds > state.duration) continue;

      const marker = document.createElement('div');
      marker.className = 'ytc-timestamp-marker';
      if (hit.count > 1) marker.classList.add('ytc-timestamp-marker-hot');
      marker.style.left = (hit.seconds / state.duration) * 100 + '%';
      marker.dataset.seconds = String(hit.seconds);
      bar.appendChild(marker);
    }

    bindHover(bar);
  }

  function ensureTooltip() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return null;
    let tip = player.querySelector('.ytc-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ytc-tooltip';
      player.appendChild(tip);
    }
    return tip;
  }

  function nearestHit(bar, clientX) {
    const rect = bar.getBoundingClientRect();
    if (!rect.width || !state.duration) return null;
    let best = null;
    let bestPx = Infinity;
    for (const hit of state.hits.values()) {
      if (hit.seconds > state.duration) continue;
      const px = Math.abs(rect.left + (hit.seconds / state.duration) * rect.width - clientX);
      if (px < bestPx) {
        bestPx = px;
        best = hit;
      }
    }
    return best && bestPx <= 12 ? best : null; // 12px grab radius
  }

  function showTooltip(hit, bar) {
    const tip = ensureTooltip();
    const player = document.querySelector('.html5-video-player');
    if (!tip || !player) return;

    tip.textContent = '';
    const time = document.createElement('div');
    time.className = 'ytc-tooltip-time';
    time.textContent = `${formatTime(hit.seconds)} · ${hit.count} comment${hit.count > 1 ? 's' : ''}`;
    tip.appendChild(time);
    for (const sample of hit.samples) {
      const line = document.createElement('span');
      line.className = 'ytc-tooltip-comment';
      line.textContent = sample;
      tip.appendChild(line);
    }

    const barRect = bar.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    tip.dataset.visible = 'true';

    const x = barRect.left - playerRect.left + (hit.seconds / state.duration) * barRect.width;
    const tipRect = tip.getBoundingClientRect();
    const left = Math.max(4, Math.min(x - tipRect.width / 2, playerRect.width - tipRect.width - 4));
    tip.style.left = left + 'px';
    tip.style.top = barRect.top - playerRect.top - tipRect.height - 14 + 'px';

    bar.querySelectorAll('.ytc-timestamp-marker').forEach((m) => {
      m.classList.toggle(
        'ytc-timestamp-marker-active',
        Math.abs(+m.dataset.seconds - hit.seconds) < 0.001
      );
    });
  }

  function hideTooltip(bar) {
    const tip = document.querySelector('.ytc-tooltip');
    if (tip) tip.dataset.visible = 'false';
    bar?.querySelectorAll('.ytc-timestamp-marker-active').forEach((m) =>
      m.classList.remove('ytc-timestamp-marker-active')
    );
  }

  // Hover is read off the progress bar container rather than the markers
  // themselves: YouTube layers hit-testing overlays over the bar, so a 3px
  // child often never receives a hover event of its own.
  function bindHover(bar) {
    if (bar.dataset.ytcHoverBound) return;
    bar.dataset.ytcHoverBound = '1';

    bar.addEventListener(
      'mousemove',
      (e) => {
        if (!state.settings.markers || !state.settings.tooltip) return;
        const hit = nearestHit(bar, e.clientX);
        if (hit) showTooltip(hit, bar);
        else hideTooltip(bar);
      },
      true
    );

    bar.addEventListener('mouseleave', () => hideTooltip(bar), true);

    // Snap to the exact timestamp when clicking on a marker. YouTube handles
    // the seek itself, so correct it afterwards rather than fighting it.
    bar.addEventListener(
      'click',
      (e) => {
        if (!state.settings.markers) return;
        const hit = nearestHit(bar, e.clientX);
        if (!hit) return;
        setTimeout(() => {
          const v = getVideo();
          if (v) v.currentTime = hit.seconds;
        }, 0);
      },
      true
    );
  }

  // --- "coming up" toast ------------------------------------------------
  //
  // Visibility and progress are both driven straight off the video's
  // currentTime via the timeupdate handler below, rather than a wall-clock
  // setTimeout/setInterval. That's what makes "pauses when the video is
  // paused" free: timeupdate simply stops firing while paused, so nothing
  // here advances until playback resumes.

  // The toast's own reading-time budget: how many extra seconds of lead a
  // comment earns based on its length, so long comments don't get cut off by
  // a fixed 3-second window. Capped so an extremely long comment can't push
  // the toast so far back it appears with no obvious reason.
  function leadSecondsFor(hit) {
    const text = hit.samples[0] || '';
    const visibleLength = Math.min(text.length, TOAST_VISIBLE_CHAR_BUDGET);
    const extra = Math.min(
      TOAST_LEAD_MAX_EXTRA_SECONDS,
      Math.floor(visibleLength / TOAST_LEAD_CHARS_PER_EXTRA_SECOND)
    );
    return TOAST_LEAD_BASE_SECONDS + extra;
  }

  function ensureToast() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return null;
    let toast = player.querySelector('.ytc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'ytc-toast';
      toast.innerHTML =
        '<button type="button" class="ytc-toast-close" aria-label="Dismiss">×</button>' +
        '<div class="ytc-toast-time"></div>' +
        '<div class="ytc-toast-comment"></div>' +
        '<div class="ytc-toast-progress"><div class="ytc-toast-progress-fill"></div></div>';
      player.appendChild(toast);

      toast.querySelector('.ytc-toast-close').addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.currentToastHit) state.dismissedHits.add(state.currentToastHit);
        state.currentToastHit = null;
        hideApproachToast();
      });

      // Hovering to read shouldn't let the moment slip by or have the toast
      // vanish mid-sentence — pause playback while the cursor is over it, and
      // only resume on leave if we're the ones who paused it (never override
      // a pause the user made themselves).
      toast.addEventListener('mouseenter', () => {
        const video = getVideo();
        if (video && !video.paused) {
          video.pause();
          state.toastHoverPausedVideo = true;
        }
      });
      toast.addEventListener('mouseleave', () => {
        const video = getVideo();
        if (video && state.toastHoverPausedVideo) video.play();
        state.toastHoverPausedVideo = false;
      });
    }
    return toast;
  }

  function positionToast() {
    const toast = document.querySelector('.ytc-toast');
    if (!toast) return;
    toast.classList.remove(...TOAST_POSITION_CLASSES);
    toast.classList.add('ytc-toast-pos-' + (state.settings.toastPosition || 'top-right'));
  }

  function showApproachToast(hit) {
    const toast = ensureToast();
    if (!toast) return;

    positionToast();
    toast.querySelector('.ytc-toast-time').textContent = `Coming up: ${formatTime(hit.seconds)}`;
    const commentEl = toast.querySelector('.ytc-toast-comment');
    commentEl.textContent = hit.samples[0] || '';
    commentEl.style.display = hit.samples[0] ? '' : 'none';
    toast.querySelector('.ytc-toast-progress-fill').style.width = '100%';

    // Force reflow so re-triggering restarts the fade-in transition instead
    // of being a no-op if the toast is already mid-transition.
    toast.classList.remove('ytc-toast-visible');
    void toast.offsetWidth;
    toast.classList.add('ytc-toast-visible');
  }

  function hideApproachToast() {
    const toast = document.querySelector('.ytc-toast');
    if (toast) toast.classList.remove('ytc-toast-visible');
  }

  function updateToastProgress(fraction) {
    const fill = document.querySelector('.ytc-toast-progress-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
  }

  // --- sound --------------------------------------------------------

  function ensureAudioCtx() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!state.audioCtx) state.audioCtx = new AudioCtx();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }

  // 0-150% maps to a gain of 0-1.5. Native <audio>/<video>.volume caps at 1.0
  // (100%), so going past that requires driving playback through a GainNode
  // instead, which can amplify past unity.
  function volumeGain() {
    const pct = typeof state.settings.soundVolume === 'number' ? state.settings.soundVolume : 100;
    return Math.max(0, Math.min(150, pct)) / 100;
  }

  function decodeCustomSoundIfNeeded() {
    const url = state.settings.customSoundDataUrl;
    if (!url) {
      state.customAudioBuffer = null;
      state.customAudioBufferFor = null;
      return;
    }
    if (state.customAudioBufferFor === url) return; // already decoded

    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((buf) => ensureAudioCtx().decodeAudioData(buf))
      .then((audioBuffer) => {
        state.customAudioBuffer = audioBuffer;
        state.customAudioBufferFor = url;
      })
      .catch(() => {
        state.customAudioBuffer = null;
        state.customAudioBufferFor = null;
      });
  }

  function playDefaultChime(ctx, destination) {
    const now = ctx.currentTime;
    const envelope = ctx.createGain();
    // Boosted well above the original 0.18 peak — that was the "too quiet"
    // complaint. This is the level at 100% volume; the outer gain node still
    // scales it further for the 0-150% setting.
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

  function playSound() {
    try {
      const ctx = ensureAudioCtx();
      const gainNode = ctx.createGain();
      gainNode.gain.value = volumeGain();
      gainNode.connect(ctx.destination);

      if (state.settings.customSoundDataUrl && state.customAudioBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = state.customAudioBuffer;
        src.connect(gainNode);
        src.start();
      } else {
        playDefaultChime(ctx, gainNode);
      }
    } catch {
      // Web Audio unavailable or blocked — sound is a non-essential extra.
    }
  }

  // --- playback-driven toast/sound triggering --------------------------
  //
  // Two different update rates on purpose: entering/leaving a marker's lead
  // window (show/hide the toast, fire the sound) only needs to be checked a
  // few times a second, so it rides on the video's own "timeupdate" event.
  // The progress *bar fill*, though, looked choppy at that rate — timeupdate
  // fires only ~4x/second in most browsers. That's driven by its own
  // requestAnimationFrame loop instead, reading currentTime fresh every
  // frame (~60fps). It still freezes correctly on pause, because currentTime
  // itself stops advancing — nothing extra needed for that part.

  function onTimeUpdate() {
    const video = getVideo();
    if (!video || !state.duration) return;
    const t = video.currentTime;

    let active = null;
    for (const hit of state.hits.values()) {
      if (hit.seconds > state.duration) continue;
      const leadStart = hit.seconds - leadSecondsFor(hit);
      if (t >= leadStart && t < hit.seconds) {
        active = hit;
        break;
      }
    }

    if (active && !state.dismissedHits.has(active)) {
      if (state.currentToastHit !== active) {
        state.currentToastHit = active;
        if (!state.toastedHits.has(active)) {
          state.toastedHits.add(active);
          if (state.settings.sound) playSound();
        }
        if (state.settings.toast) showApproachToast(active);
      }
    } else if (state.currentToastHit) {
      state.currentToastHit = null;
      hideApproachToast();
    }

    // Allow a hit to fire (and be dismissible) again if the user rewinds
    // past its lead window.
    for (const hit of state.toastedHits) {
      if (t < hit.seconds - leadSecondsFor(hit)) state.toastedHits.delete(hit);
    }
    for (const hit of state.dismissedHits) {
      if (t < hit.seconds - leadSecondsFor(hit)) state.dismissedHits.delete(hit);
    }
  }

  function tickToastProgress() {
    if (state.currentToastHit && state.settings.toast) {
      const video = getVideo();
      if (video) {
        const hit = state.currentToastHit;
        const leadStart = hit.seconds - leadSecondsFor(hit);
        updateToastProgress((hit.seconds - video.currentTime) / (hit.seconds - leadStart));
      }
    }
    requestAnimationFrame(tickToastProgress);
  }

  function bindTimeUpdate() {
    const video = getVideo();
    if (!video || state.boundVideos.has(video)) return;
    state.boundVideos.add(video);
    video.addEventListener('timeupdate', onTimeUpdate);
  }

  // --- lifecycle --------------------------------------------------------

  function syncDuration() {
    const v = getVideo();
    const d = v && v.duration;
    if (d && isFinite(d) && d !== state.duration) {
      state.duration = d;
      queueRender();
      return true;
    }
    return false;
  }

  function attachObserver() {
    const comments = document.querySelector('ytd-comments#comments');
    if (!comments || state.observer) return;

    state.observer = new MutationObserver((records) => {
      let added = 0;
      for (const r of records) {
        for (const node of r.addedNodes) added += collect(node);
      }
      if (added) queueRender();
    });
    state.observer.observe(comments, { childList: true, subtree: true });
  }

  function reset() {
    document.querySelectorAll('.ytc-timestamp-marker').forEach((el) => el.remove());
    document.querySelectorAll('.ytc-toast').forEach((el) => el.remove());
    state.observer?.disconnect();
    state.observer = null;
    state.hits.clear();
    state.seenLinks = new WeakSet();
    state.toastedHits = new Set();
    state.dismissedHits = new Set();
    state.currentToastHit = null;
    state.toastHoverPausedVideo = false;
    state.duration = 0;
    state.videoId = getVideoId();
  }

  function onNavigate() {
    const id = getVideoId();
    if (!id || id === state.videoId) return;
    reset();
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('yt-page-data-updated', onNavigate);

  // Single heartbeat drives everything: comments stream in lazily, metadata
  // arrives late, and YouTube re-renders the player chrome on its own
  // schedule (which can wipe our markers). Re-checking is cheaper than
  // tracking each of those individually.
  setInterval(() => {
    if (!getVideoId()) return;
    if (getVideoId() !== state.videoId) reset();

    syncDuration();
    attachObserver();
    bindTimeUpdate();

    // Sweep for anything the observer missed (nodes present before it attached).
    const comments = document.querySelector('ytd-comments#comments');
    const added = comments ? collect(comments) : 0;

    const bar = getProgressBar();
    const expected = bar
      ? [...state.hits.values()].filter(
          (h) => state.duration && h.seconds <= state.duration
        ).length
      : 0;
    const actual = bar ? bar.querySelectorAll('.ytc-timestamp-marker').length : 0;

    if (added || actual !== expected) queueRender();
  }, 1000);

  state.videoId = getVideoId();
  loadSettings();
  requestAnimationFrame(tickToastProgress);
})();
