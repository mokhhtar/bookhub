/* Litheca shared audio engine — used by the dynamic summary page AND the
   static book pages (replica rule: one engine, zero drift). Exposes the
   window.* API the widgets/dock call via onclick. Each page builds
   window.__audioSections and calls injectSectionPlayBtns() itself. */
(function () {
  // ── Audio engine v2: sentence-queue playlist ─────────────
  // The old engine fed the WHOLE summary to one SpeechSynthesisUtterance —
  // Chrome silently stops long utterances after a couple of minutes, speed
  // changes restarted from zero, and there was no progress or sections.
  // v2 chunks every section into sentences and plays a queue: short
  // utterances never trip Chrome's limit, position survives speed changes,
  // and progress/section skipping fall out for free.
  // Known platform limits (not fixable client-side): speech stops when a
  // phone locks its screen, and voice quality = the device's voices.
  let audioQueue = [];        // [{ text, section }]
  let audioIdx = 0;
  let audioOn = false;        // engine active (may be paused)
  let audioPausedFlag = false;
  let audioRate = 1.0;
  let audioVoice = null;

  // Prefer the device's best English voice — neural/natural voices first,
  // then Google/Microsoft-online, over whatever happens to be listed first.
  function pickAudioVoice() {
    const vs = (window.speechSynthesis.getVoices() || [])
      .filter(v => v.lang && v.lang.toLowerCase().startsWith("en"));
    // A voice the user explicitly picked in settings wins outright.
    const chosen = vs.find(v => v.name === audioVoiceName);
    if (chosen) return chosen;
    const score = v =>
      (/natural|neural|premium|enhanced/i.test(v.name) ? 8 : 0) +
      (/google/i.test(v.name) ? 4 : 0) +
      (/microsoft.+online/i.test(v.name) ? 4 : 0) +
      (v.localService ? 0 : 1);
    return vs.sort((a, b) => score(b) - score(a))[0] || null;
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { audioVoice = pickAudioVoice(); };
  }

  // Split text into speakable chunks: sentence boundaries, long sentences
  // broken again at commas — everything stays well under Chrome's stall zone.
  function chunkSentences(text) {
    const out = [];
    const sentences = String(text || "").replace(/\s+/g, " ")
      .match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || [];
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      while (s.length > 240) {
        let cut = s.lastIndexOf(",", 220);
        if (cut < 80) cut = s.lastIndexOf(" ", 220);
        if (cut < 80) cut = 220;
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
    }
    return out;
  }

  // Rebuilds the playlist from the rendered sections (set at render time
  // in window.__audioSections). Returns chunk count.
  function buildAudioQueue() {
    audioQueue = [];
    (window.__audioSections || []).forEach(sec => {
      chunkSentences(sec.text).forEach(t => audioQueue.push({ text: t, section: sec.label }));
    });
    return audioQueue.length;
  }

  function audioUi() {
    return {
      icon: document.getElementById("play-icon"),
      wave: document.getElementById("audio-wave"),
      status: document.getElementById("audio-status"),
      fill: document.getElementById("audio-progress-fill"),
    };
  }
  const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  const ICON_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

  // Inline widget + floating dock share state — mirror the play icon on both.
  function setPlayIcons(playing) {
    const svg = playing ? ICON_PAUSE : ICON_PLAY;
    const a = document.getElementById("play-icon");
    const b = document.getElementById("dock-play-icon");
    if (a) a.innerHTML = svg;
    if (b) b.innerHTML = svg;
  }
  function setDock(open) {
    const d = document.getElementById("audio-dock");
    if (d) d.classList.toggle("open", open);
    if (!open) {
      const s = document.getElementById("audio-settings");
      if (s) s.classList.remove("open");
    }
  }

  function updateAudioProgress() {
    const ui = audioUi();
    if (!audioQueue.length) return;
    const cur = audioQueue[Math.min(audioIdx, audioQueue.length - 1)];
    const pct = Math.round(audioIdx / audioQueue.length * 100);
    if (ui.status) ui.status.textContent = `${cur.section} · ${pct}%`;
    if (ui.fill) ui.fill.style.width = pct + "%";
    const ds = document.getElementById("dock-status");
    if (ds) ds.textContent = `${cur.section} · ${pct}%`;
  }

  // ── Ambience: delegated to the shared window.bhAmbience module in
  // main.js (Calm/Rain/Wind, all Web Audio-generated — also used
  // standalone by the free-book reader). Level changes take effect
  // immediately (instant preview, even before narration starts).
  function startAmbience() { if (window.bhAmbience) window.bhAmbience.start(); }
  function stopAmbience() { if (window.bhAmbience) window.bhAmbience.stop(); }
  window.setAudioAmbience = function (level) {
    if (window.bhAmbience) window.bhAmbience.setLevel(level);
    syncSettingsUi();
  };
  // Genre-based recommendation for the ★ in settings: atmospheric fiction
  // gets Rain/Wind, everything else the neutral Calm pad. Purely a
  // suggestion — the user always chooses.
  function recommendedAmbience() {
    const cats = (window.__bhCurrentCategories || []).join(" ").toLowerCase();
    if (/mystery|thriller|horror/.test(cats)) return "rain";
    if (/fantasy|adventure|science-fiction|sci-fi/.test(cats)) return "wind";
    return "calm";
  }

  // Voice + speed preferences (persisted).
  let audioVoiceName = localStorage.getItem("bh_audio_voice") || "";
  window.setAudioVoice = function (name) {
    audioVoiceName = name || "";
    localStorage.setItem("bh_audio_voice", audioVoiceName);
    audioVoice = pickAudioVoice();
    if (audioOn && !audioPausedFlag) { window.speechSynthesis.cancel(); speakCurrent(); }
  };
  window.setAudioRate = function (r) {
    audioRate = parseFloat(r) || 1;
    localStorage.setItem("bh_audio_rate", String(audioRate));
    const sel = document.getElementById("audio-speed");
    if (sel) sel.value = String(audioRate);
    if (audioOn && !audioPausedFlag) { window.speechSynthesis.cancel(); speakCurrent(); }
    syncSettingsUi();
  };
  audioRate = parseFloat(localStorage.getItem("bh_audio_rate") || "1") || 1;

  function populateVoiceList() {
    const sel = document.getElementById("aset-voice");
    if (!sel) return;
    const vs = (window.speechSynthesis.getVoices() || [])
      .filter(v => v.lang && v.lang.toLowerCase().startsWith("en"));
    sel.innerHTML = '<option value="">Auto (best available)</option>' +
      vs.map(v => `<option value="${v.name.replace(/"/g, "&quot;")}"${v.name === audioVoiceName ? " selected" : ""}>${v.name.replace(/</g, "&lt;")}</option>`).join("");
  }
  function syncSettingsUi() {
    const amb = window.bhAmbience;
    const lvl = amb ? amb.getLevel() : 0;
    const typ = amb ? amb.getType() : "calm";
    const rec = recommendedAmbience();
    document.querySelectorAll("#aset-speed .aset-pill").forEach(b =>
      b.classList.toggle("on", parseFloat(b.dataset.rate) === audioRate));
    document.querySelectorAll("#aset-amb .aset-pill").forEach(b =>
      b.classList.toggle("on", parseFloat(b.dataset.amb) === lvl));
    document.querySelectorAll("#aset-ambtype .aset-pill").forEach(b => {
      b.classList.toggle("on", b.dataset.ambtype === typ);
      // ★ marks the genre-recommended sound for THIS book.
      const star = b.dataset.ambtype === rec ? " ★" : "";
      b.textContent = b.dataset.label + star;
    });
  }
  window.toggleAudioSettings = function () {
    const s = document.getElementById("audio-settings");
    if (!s) return;
    populateVoiceList();
    syncSettingsUi();
    s.classList.toggle("open");
  };
  document.addEventListener("click", (e) => {
    const s = document.getElementById("audio-settings");
    const dock = document.getElementById("audio-dock");
    if (s && s.classList.contains("open") && dock && !dock.contains(e.target)) s.classList.remove("open");
  });
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest(".aset-pill");
    if (!t) return;
    if (t.dataset.rate) window.setAudioRate(t.dataset.rate);
    if (t.dataset.amb !== undefined) window.setAudioAmbience(t.dataset.amb);
    if (t.dataset.ambtype) {
      if (window.bhAmbience) window.bhAmbience.setType(t.dataset.ambtype);
      syncSettingsUi();
    }
  });

  function speakCurrent() {
    if (!audioOn) return;
    if (audioIdx >= audioQueue.length) { stopAudio(); return; }
    const u = new SpeechSynthesisUtterance(audioQueue[audioIdx].text);
    if (!audioVoice) audioVoice = pickAudioVoice();
    if (audioVoice) u.voice = audioVoice;
    u.rate = audioRate;
    // cancel() fires onend/onerror too — audioOn guards against advancing
    // the queue on an intentional stop/seek.
    u.onend = () => {
      if (!audioOn || audioPausedFlag) return;
      audioIdx += 1;
      updateAudioProgress();
      speakCurrent();
    };
    u.onerror = u.onend;
    window.speechSynthesis.speak(u);
  }

  function toggleAudio() {
    const ui = audioUi();
    if (audioOn) {
      if (audioPausedFlag) {
        audioPausedFlag = false;
        window.speechSynthesis.resume();
        // If resume() landed between chunks (utterance already ended while
        // paused), restart from the current index.
        if (!window.speechSynthesis.speaking) speakCurrent();
        setPlayIcons(true);
        if (ui.wave) ui.wave.classList.add("playing");
        startAmbience();
        updateAudioProgress();
      } else {
        audioPausedFlag = true;
        window.speechSynthesis.pause();
        setPlayIcons(false);
        if (ui.wave) ui.wave.classList.remove("playing");
        if (ui.status) ui.status.textContent = "Paused";
        const ds = document.getElementById("dock-status");
        if (ds) ds.textContent = "Paused";
        stopAmbience();
      }
      return;
    }
    if (!buildAudioQueue()) return;
    audioIdx = 0;
    audioOn = true;
    audioPausedFlag = false;
    window.speechSynthesis.cancel();
    setPlayIcons(true);
    if (ui.wave) ui.wave.classList.add("playing");
    setDock(true);
    startAmbience();
    updateAudioProgress();
    speakCurrent();
  }

  function stopAudio() {
    audioOn = false;
    audioPausedFlag = false;
    audioIdx = 0;
    window.speechSynthesis.cancel();
    stopAmbience();
    setDock(false);
    const ui = audioUi();
    setPlayIcons(false);
    if (ui.wave) ui.wave.classList.remove("playing");
    if (ui.status) ui.status.textContent = "Click play to listen";
    if (ui.fill) ui.fill.style.width = "0%";
  }

  // Speed change keeps the position: re-speak the CURRENT chunk at the new
  // rate (the old engine restarted the whole summary from zero).
  function changeAudioSpeed() {
    window.setAudioRate(document.getElementById("audio-speed").value || "1");
  }

  // Jump one sentence back/forward.
  window.audioSkipChunk = function (dir) {
    if (!audioOn) return;
    audioIdx = Math.max(0, Math.min(audioQueue.length - 1, audioIdx + dir));
    audioPausedFlag = false;
    window.speechSynthesis.cancel();
    setPlayIcons(true);
    updateAudioProgress();
    speakCurrent();
  };

  // Start playback from a named section (the ▶ chips beside chapter
  // headings). Works whether or not the engine was already running.
  window.audioPlayFromSection = function (label) {
    if (!audioQueue.length || !audioOn) {
      if (!buildAudioQueue()) return;
    }
    const i = audioQueue.findIndex(c => c.section === label);
    if (i < 0) return;
    audioOn = true;
    audioPausedFlag = false;
    audioIdx = i;
    window.speechSynthesis.cancel();
    setPlayIcons(true);
    setDock(true);
    startAmbience();
    const ui = audioUi();
    if (ui.wave) ui.wave.classList.add("playing");
    updateAudioProgress();
    speakCurrent();
  };

  // Inject a small ▶ beside each chapter heading inside the rendered
  // summary whose text matches an audio section (SoBrief-style).
  window.injectSectionPlayBtns = function () {
    // Both pages render chapters inside .ai-output (dynamic: #bh-summary
    // card; static book layout: the article body) — target it directly.
    const card = document.querySelector(".ai-output") ? document : null;
    if (!card || !window.__audioSections) return;
    const labels = new Set(window.__audioSections.map(s => s.label));
    card.querySelectorAll(".ai-output h2, .ai-output h3").forEach(h => {
      if (h.querySelector(".sec-play")) return;
      const label = (h.textContent || "").trim().slice(0, 70);
      if (!labels.has(label)) return;
      const b = document.createElement("button");
      b.className = "sec-play";
      b.title = "Listen from this section";
      b.setAttribute("aria-label", "Listen from this section");
      b.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      b.addEventListener("click", () => window.audioPlayFromSection(label));
      h.appendChild(b);
    });
  };

  // Jump to the previous/next SECTION boundary (Summary → Characters → …).
  window.audioSkipSection = function (dir) {
    if (!audioOn) return;
    const curSection = (audioQueue[audioIdx] || {}).section;
    let target = audioIdx;
    if (dir > 0) {
      while (target < audioQueue.length && audioQueue[target].section === curSection) target++;
    } else {
      // Back to the START of the current section; twice lands on previous.
      while (target > 0 && audioQueue[target - 1].section === curSection) target--;
      if (target === audioIdx && target > 0) {
        const prev = audioQueue[target - 1].section;
        while (target > 0 && audioQueue[target - 1].section === prev) target--;
      }
    }
    if (target >= audioQueue.length) { stopAudio(); return; }
    audioIdx = target;
    audioPausedFlag = false;
    window.speechSynthesis.cancel();
    updateAudioProgress();
    speakCurrent();
  };

  // Plain function declarations above are scoped to this IIFE — export
  // the ones the widget/dock markup calls via onclick.
  window.toggleAudio = toggleAudio;
  window.stopAudio = stopAudio;
  window.changeAudioSpeed = changeAudioSpeed;
})();
