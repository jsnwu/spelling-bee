function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ("")
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }

  out.push(cur.trim());
  return out;
}

// CSV parser with support for quotes + commas inside quotes.
function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length === 1 && !cols[0]) continue;
    const row = {};
    header.forEach((key, idx) => {
      row[key] = cols[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Safe for inserting user/word list text into HTML */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAnswerVariants(answer) {
  const w = String(answer || "").trim();
  if (!w) return [];

  const lower = w.toLowerCase();
  const variants = new Set([w, lower]);

  // Plurals
  variants.add(`${lower}s`);
  variants.add(`${lower}es`);

  // y -> ies (blueberry -> blueberries)
  if (lower.endsWith("y") && lower.length > 1) {
    variants.add(`${lower.slice(0, -1)}ies`);
  }

  // -ing / -ed
  variants.add(`${lower}ing`);
  variants.add(`${lower}ed`);

  // drop trailing e (bake -> baking/baked)
  if (lower.endsWith("e") && lower.length > 2) {
    variants.add(`${lower.slice(0, -1)}ing`);
    variants.add(`${lower.slice(0, -1)}ed`);
  }

  // consonant + y -> ied (carry -> carried)
  if (lower.endsWith("y") && lower.length > 2) {
    variants.add(`${lower.slice(0, -1)}ied`);
  }

  return Array.from(variants)
    .map((v) => v.trim())
    .filter(Boolean)
    // Prefer longer matches so "carried" masks before "carry"
    .sort((a, b) => b.length - a.length);
}

function maskAnswerWord(sentence, answer) {
  const text = String(sentence || "");
  const word = String(answer || "").trim();
  if (!text || !word) return text;

  const variants = buildAnswerVariants(word);
  if (variants.length === 0) return text;
  const escaped = variants.map(escapeRegExp).join("|");

  // Prefer whole-word-ish matches so we don't blank parts of other words.
  // Use Unicode letter boundaries when supported.
  try {
    const re = new RegExp(`(^|[^\\p{L}])(${escaped})(?=[^\\p{L}]|$)`, "giu");
    const masked = text.replace(re, "$1_____");
    if (masked !== text) return masked;
  } catch (_) {
    // Older browsers without Unicode property escapes.
  }

  // Fallback: simple case-insensitive replace.
  return text.replace(new RegExp(`(${escaped})`, "gi"), "_____");
}

const state = {
  words: [],
  currentIndex: 0,
  score: 0,
  attempts: 0,
  mode: "definition", // 'definition' | 'audio'
  lastPromptWord: null,
  /** Full definition text for TTS (including the answer word) */
  definitionForSpeech: "",
  /** Timeout id for scheduled auto-speak */
  autoSpeakTimeoutId: null,
  /** At least one graded submit this word — enables Next (skip) */
  hasSubmittedThisWord: false,
  /** Correct answer submitted — input locked; prevents duplicate scoring */
  answerLocked: false,
  /** Last graded spelling (trimmed, lowercased) for this word — blocks duplicate submits */
  lastGradedAnswerLower: "",
  /** Concise definition for audio mode; shown only after "Show hint" */
  audioHintDefinition: "",
  /** Auto TTS (and speak-after-next-word) only after "Start Spelling Bee" */
  roundStarted: false,
  gameSessionStartMs: null,
  /** Accumulated ms the session clock was paused due to idle (no game activity) */
  timerIdlePausedMs: 0,
  /** Wall-clock ms when idle pause started; null when clock is running */
  timerPausedSinceMs: null,
  /** `setTimeout` id for scheduling idle pause */
  idlePauseTimerId: null,
  /** Wrong graded submits: { word, typed } */
  misspellings: [],
  /** `setInterval` id for live session timer (when enabled) */
  sessionTimerId: null,
  /** Pending auto-advance after a correct answer */
  autoNextTimeoutId: null,
};

const SUBMIT_BUTTON_LABEL = "Submit";
const SUBMIT_BUTTON_NEXT_LABEL = ">>";
/** Delay before auto-advance to the next word after a correct answer (when enabled) */
const AUTO_ADVANCE_AFTER_CORRECT_MS = 2000;
/** No pointer/keyboard/input in the game area for this long → pause session timer until activity */
const IDLE_PAUSE_AFTER_MS = 10_000;
/** Bee icons beside “Spelling Round”: 1 to start, +1 each 10 correct (capped) */
const BEE_PROGRESS_ICON_SRC = "assets/bee-icon.png";
const BEE_PROGRESS_MAX_ICONS = 12;

/** Default TTS speed (auto-speak after each prompt) */
const SPEECH_RATE_DEFAULT = 0.9;
/** Slower playback when the user taps the speaker button */
const SPEECH_RATE_SPEAKER_BUTTON = 0.5;

const TTS_VOICE_STORAGE_KEY = "spellingBeeTTSVoiceURI";
const AUTO_NEXT_STORAGE_KEY = "spellingBeeAutoNextWord";
const SHOW_TIMER_STORAGE_KEY = "spellingBeeShowTimer";
const SHOW_BEE_PROGRESS_STORAGE_KEY = "spellingBeeShowBeeProgress";

/** Prefer English, then names that usually indicate a female voice per OS/browser lists */
const TTS_FEMALE_NAME_PATTERNS = [
  /female/i,
  /woman/i,
  /samantha/i,
  /karen\b/i,
  /moira/i,
  /tessa/i,
  /fiona/i,
  /serena/i,
  /victoria/i,
  /veena/i,
  /zira/i,
  /hazel/i,
  /susan/i,
  /allison/i,
  /\bava\b/i,
  /\bkate\b/i,
  /joanna/i,
  /\bivy\b/i,
  /sarah/i,
  /laura/i,
  /emily/i,
  /catherine/i,
  /martha/i,
  /heather/i,
  /linda/i,
  /microsoft zira/i,
];

const dom = {
  fileInput: document.getElementById("csv-input"),
  fileName: document.getElementById("file-name"),
  wordCount: document.getElementById("word-count"),
  modeButtons: Array.from(document.querySelectorAll(".mode-button")),
  startGame: document.getElementById("start-game"),
  gameSection: document.getElementById("game-section"),
  gameModeLabel: document.getElementById("game-mode-label"),
  promptArea: document.getElementById("prompt-area"),
  answerInput: document.getElementById("answer-input"),
  submitAnswer: document.getElementById("submit-answer"),
  gradeSelect: document.getElementById("grade-select"),
  selectedGradeHint: document.getElementById("selected-grade-hint"),
  configDetails: document.querySelector(".config-details"),
  gameOptionsDetails: document.getElementById("game-options-details"),
  downloadCsv: document.getElementById("download-csv"),
  showHint: document.getElementById("show-hint"),
  showAnswer: document.getElementById("show-answer"),
  nextWord: document.getElementById("next-word"),
  feedback: document.getElementById("feedback"),
  scoreText: document.getElementById("score-text"),
  stopGame: document.getElementById("stop-game"),
  sessionSummaryDialog: document.getElementById("session-summary-dialog"),
  sessionSummaryBody: document.getElementById("session-summary-body"),
  ttsVoiceSelect: document.getElementById("tts-voice-select"),
  gameTimer: document.getElementById("game-timer"),
  gameHeaderBees: document.getElementById("game-header-bees"),
  optionAutoNext: document.getElementById("option-auto-next"),
  optionShowBeeProgress: document.getElementById("option-show-bee-progress"),
  optionShowTimer: document.getElementById("option-show-timer"),
};

function updateSelectedGradeHint(text) {
  if (!dom.selectedGradeHint) return;
  dom.selectedGradeHint.textContent = text;
}

function updateSubmitButtonAppearance() {
  const btn = dom.submitAnswer;
  if (!btn) return;
  if (state.answerLocked) {
    btn.textContent = SUBMIT_BUTTON_NEXT_LABEL;
    btn.setAttribute("aria-label", "Next word");
    btn.disabled = false;
  } else {
    btn.textContent = SUBMIT_BUTTON_LABEL;
    btn.setAttribute("aria-label", "Submit spelling");
    const cur = dom.answerInput ? dom.answerInput.value.trim().toLowerCase() : "";
    const duplicateResubmit =
      state.hasSubmittedThisWord &&
      cur.length > 0 &&
      cur === state.lastGradedAnswerLower;
    btn.disabled = duplicateResubmit;
  }
}

function resetShowHintButton() {
  state.audioHintDefinition = "";
  if (dom.showHint) {
    dom.showHint.textContent = "Show hint";
    dom.showHint.classList.remove("show-hint-used");
    dom.showHint.classList.add("hidden");
    dom.showHint.disabled = true;
  }
}

if (dom.showHint && !dom.showHint.dataset.bound) {
  dom.showHint.dataset.bound = "1";
  dom.showHint.addEventListener("click", () => {
    if (state.mode !== "audio" || !dom.showHint) return;
    if (dom.showHint.disabled) return;
    const def = (state.audioHintDefinition || "").trim();
    if (!def) return;
    const answer = state.lastPromptWord || "";
    const lead = document.getElementById("audio-prompt-lead");
    if (!lead) return;
    lead.textContent = maskAnswerWord(def, answer);
    lead.classList.remove("audio-prompt-placeholder");
    lead.classList.add("hint-text");
    dom.showHint.disabled = true;
    dom.showHint.classList.add("show-hint-used");
  });
}

function updateWordCount() {
  const count = state.words.length;
  dom.wordCount.textContent = `${count} word${count === 1 ? "" : "s"} loaded`;
  dom.startGame.disabled = count === 0;
}

function formatDurationSeconds(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

function isShowTimerEnabled() {
  return dom.optionShowTimer?.checked === true;
}

function isShowBeeProgressEnabled() {
  if (!dom.optionShowBeeProgress) return true;
  return dom.optionShowBeeProgress.checked === true;
}

function isAutoNextEnabled() {
  return dom.optionAutoNext?.checked === true;
}

function stopSessionTimer() {
  if (state.sessionTimerId !== null) {
    clearInterval(state.sessionTimerId);
    state.sessionTimerId = null;
  }
  if (dom.gameTimer) dom.gameTimer.textContent = "0:00";
}

/** Active session duration in ms (excludes idle-paused periods) */
function getElapsedSessionMs() {
  if (!state.gameSessionStartMs) return 0;
  let ms = Date.now() - state.gameSessionStartMs - (state.timerIdlePausedMs || 0);
  if (state.timerPausedSinceMs) {
    ms -= Date.now() - state.timerPausedSinceMs;
  }
  return Math.max(0, ms);
}

function clearIdleSessionPause() {
  if (state.idlePauseTimerId !== null) {
    clearTimeout(state.idlePauseTimerId);
    state.idlePauseTimerId = null;
  }
  state.timerIdlePausedMs = 0;
  state.timerPausedSinceMs = null;
}

function pauseTimerForIdle() {
  if (!state.roundStarted || !state.gameSessionStartMs || state.timerPausedSinceMs) return;
  state.timerPausedSinceMs = Date.now();
  updateGameTimerLabel();
}

function resumeTimerFromIdle() {
  if (!state.timerPausedSinceMs) return;
  state.timerIdlePausedMs += Date.now() - state.timerPausedSinceMs;
  state.timerPausedSinceMs = null;
  updateGameTimerLabel();
}

function scheduleIdlePauseCheck() {
  if (state.idlePauseTimerId !== null) {
    clearTimeout(state.idlePauseTimerId);
    state.idlePauseTimerId = null;
  }
  if (!state.roundStarted || !state.gameSessionStartMs) return;
  state.idlePauseTimerId = window.setTimeout(() => {
    state.idlePauseTimerId = null;
    pauseTimerForIdle();
  }, IDLE_PAUSE_AFTER_MS);
}

function onGameActivity() {
  if (!state.roundStarted || !state.gameSessionStartMs) return;
  resumeTimerFromIdle();
  scheduleIdlePauseCheck();
}

function updateGameTimerLabel() {
  if (!dom.gameTimer || !state.gameSessionStartMs) return;
  const sec = getElapsedSessionMs() / 1000;
  dom.gameTimer.textContent = formatDurationSeconds(sec);
}

function startSessionTimer() {
  stopSessionTimer();
  if (!dom.gameTimer || !isShowTimerEnabled() || !state.roundStarted || !state.gameSessionStartMs) {
    return;
  }
  updateGameTimerLabel();
  state.sessionTimerId = window.setInterval(updateGameTimerLabel, 1000);
}

function clearAutoNextTimeout() {
  if (state.autoNextTimeoutId !== null) {
    clearTimeout(state.autoNextTimeoutId);
    state.autoNextTimeoutId = null;
  }
}

function beeProgressCount(score) {
  return Math.min(BEE_PROGRESS_MAX_ICONS, 1 + Math.floor(score / 10));
}

function updateProgressBees() {
  const wrap = dom.gameHeaderBees;
  if (!wrap || !dom.gameSection) return;
  const sectionVisible = !dom.gameSection.classList.contains("hidden") && state.words.length > 0;
  wrap.replaceChildren();
  if (!isShowBeeProgressEnabled()) {
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    wrap.setAttribute("aria-label", "Bee progress hidden");
    return;
  }
  wrap.hidden = false;
  if (!sectionVisible) {
    wrap.setAttribute("aria-hidden", "true");
    wrap.setAttribute("aria-label", "Progress bees");
    return;
  }
  wrap.removeAttribute("aria-hidden");
  const n = beeProgressCount(state.score);
  for (let i = 0; i < n; i++) {
    const img = document.createElement("img");
    img.src = BEE_PROGRESS_ICON_SRC;
    img.alt = "";
    img.className = "game-header-bee-img";
    img.decoding = "async";
    wrap.appendChild(img);
  }
  wrap.setAttribute(
    "aria-label",
    n <= 1
      ? "1 bee — another bee for each 10 correct answers"
      : `${n} bees — one more for each 10 correct answers`
  );
}

function syncGameChrome() {
  if (dom.stopGame) dom.stopGame.disabled = !state.roundStarted;
  if (dom.showAnswer) {
    dom.showAnswer.disabled = !(state.roundStarted && !!currentWord());
  }
  const showTimer = isShowTimerEnabled();
  if (dom.gameTimer) {
    const visible = state.roundStarted && showTimer;
    dom.gameTimer.hidden = !visible;
    if (!visible) {
      dom.gameTimer.textContent = "0:00";
    } else if (state.gameSessionStartMs) {
      updateGameTimerLabel();
    }
  }
  updateProgressBees();
}

function clearSessionTracking() {
  stopSessionTimer();
  clearAutoNextTimeout();
  clearIdleSessionPause();
  state.gameSessionStartMs = null;
  state.misspellings = [];
}

function fillSessionSummaryBody(elapsedMs) {
  if (!dom.sessionSummaryBody) return;
  const attempts = state.attempts;
  const correct = state.score;
  const pct = attempts > 0 ? Math.round((correct / attempts) * 100) : null;
  const elapsedSec = elapsedMs / 1000;
  const timeLine = `<p class="session-summary-line"><span class="session-summary-label">Time</span><span class="session-summary-value">${escapeHtml(
    formatDurationSeconds(elapsedSec)
  )}</span></p>`;
  const ratioLine = `<p class="session-summary-line"><span class="session-summary-label">Correct</span><span class="session-summary-value">${correct} / ${attempts}</span></p>`;
  const beesEarned = beeProgressCount(correct);
  const beeLine = `<p class="session-summary-line"><span class="session-summary-label">Bees earned</span><span class="session-summary-value">${beesEarned}</span></p>`;
  const pctLine =
    pct === null
      ? `<p class="session-summary-line"><span class="session-summary-label">Accuracy</span><span class="session-summary-value">—</span></p>`
      : `<p class="session-summary-line"><span class="session-summary-label">Accuracy</span><span class="session-summary-value">${pct}%</span></p>`;
  let missBlock;
  if (state.misspellings.length === 0) {
    missBlock = `<p class="session-summary-line"><span class="session-summary-label">Misspellings</span><span class="session-summary-value">None</span></p>`;
  } else {
    const items = state.misspellings
      .map(
        (row) =>
          `<li><span class="session-misspell-word">${escapeHtml(row.word)}</span> — you typed <span class="session-misspell-typed">${escapeHtml(
            row.typed
          )}</span></li>`
      )
      .join("");
    missBlock = `<p class="session-summary-line"><span class="session-summary-label">Misspellings</span><span class="session-summary-value">${state.misspellings.length}</span></p><ul class="session-misspell-list">${items}</ul>`;
  }
  dom.sessionSummaryBody.innerHTML = `${timeLine}${ratioLine}${beeLine}${pctLine}${missBlock}`;
}

function openSessionSummaryDialog(elapsedMs) {
  fillSessionSummaryBody(elapsedMs);
  if (dom.sessionSummaryDialog && typeof dom.sessionSummaryDialog.showModal === "function") {
    dom.sessionSummaryDialog.showModal();
  }
}

function handleStopGame() {
  if (!state.roundStarted) return;
  const elapsedMs = getElapsedSessionMs();
  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }
  clearAutoNextTimeout();
  clearIdleSessionPause();
  stopSessionTimer();
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  state.roundStarted = false;
  state.gameSessionStartMs = null;
  openSessionSummaryDialog(elapsedMs);
  syncGameChrome();
  renderPrompt();
}

function hideGameSection() {
  if (dom.gameSection) dom.gameSection.classList.add("hidden");
  state.roundStarted = false;
  clearSessionTracking();
  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  syncGameChrome();
}

/** First word visible once a list is loaded; no TTS until Start is clicked */
function showSpellingRoundCard() {
  if (!dom.gameSection) return;
  if (state.words.length === 0) {
    hideGameSection();
    return;
  }
  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  state.roundStarted = false;
  state.currentIndex = 0;
  state.score = 0;
  state.attempts = 0;
  state.hasSubmittedThisWord = false;
  state.answerLocked = false;
  state.lastGradedAnswerLower = "";
  clearSessionTracking();
  dom.scoreText.textContent = "Score: 0 / 0";
  dom.gameSection.classList.remove("hidden");
  renderPrompt();
  syncGameChrome();
}

function toCsvValue(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCurrentWordsCsv() {
  const rows = state.words && state.words.length ? state.words : null;
  const header = ["word", "sentense", "pronounce", "definition"];
  const lines = [header.join(",")];

  if (!rows) {
    lines.push(
      [
        "Apple",
        'I ate a red apple for lunch.',
        "AP-uhl",
        "A round fruit with firm flesh",
      ].map(toCsvValue).join(",")
    );
    lines.push(
      [
        "Yacht",
        "The yacht sailed across the ocean.",
        "YAHT",
        "A large pleasure boat",
      ].map(toCsvValue).join(",")
    );
    downloadCsv("words-template.csv", lines.join("\n"));
    return;
  }

  for (const row of rows) {
    const word = (row.word || row.term || "").trim();
    const sentense = (row.sentense || row.sentence || row.meaning || "").trim();
    const pronounce = (row.pronounce || "").trim();
    const definition = (row.definition || "").trim();
    lines.push([word, sentense, pronounce, definition].map(toCsvValue).join(","));
  }

  downloadCsv("words-export.csv", lines.join("\n"));
}

function gradeValueToCsvPath(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  return `words/${v}-grade-words.csv`;
}

function loadWordsFromCsvText(csvText, sourceLabel) {
  const rows = parseCsv(csvText);
  const filtered = rows.filter((row) => (row.word || row.term || "").trim().length > 0);
  if (filtered.length === 0) {
    state.words = [];
    updateWordCount();
    hideGameSection();
    return false;
  }

  shuffleInPlace(filtered);
  state.words = filtered;
  if (sourceLabel) dom.fileName.textContent = sourceLabel;
  updateWordCount();
  showSpellingRoundCard();
  return true;
}

function gradeValueToLabel(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  return v.replace(/(^\d+)/, "$1").replace(/st|nd|rd|th/i, (m) => m.toLowerCase());
}

function speakWord(word, rate = SPEECH_RATE_DEFAULT) {
  speakText(word, rate);
}

function normalizeVoiceLang(lang) {
  return String(lang || "").replace("_", "-").toLowerCase();
}

/** Only United States English voices */
function isEnUsVoice(v) {
  return normalizeVoiceLang(v.lang).startsWith("en-us");
}

/** Picker is limited to the Aaron and Samantha system voices (en-US) when present */
function isAaronOrSamanthaVoice(v) {
  const n = v.name || "";
  return /aaron/i.test(n) || /samantha/i.test(n);
}

function filterAllowedVoices(voices) {
  return (voices || []).filter((v) => isEnUsVoice(v) && isAaronOrSamanthaVoice(v));
}

function pickDefaultFemaleVoice(voices) {
  const pool = filterAllowedVoices(voices);
  if (!pool.length) return null;
  for (const re of TTS_FEMALE_NAME_PATTERNS) {
    const hit = pool.find((v) => re.test(v.name || ""));
    if (hit) return hit;
  }
  return pool[0];
}

function getSelectedTtsVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const allowed = filterAllowedVoices(voices);
  if (!allowed.length) return null;
  let saved = null;
  try {
    saved = localStorage.getItem(TTS_VOICE_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
  if (saved) {
    const match = allowed.find((v) => v.voiceURI === saved);
    if (match) return match;
  }
  return pickDefaultFemaleVoice(voices);
}

function populateTtsVoiceSelect(voices) {
  const sel = dom.ttsVoiceSelect;
  if (!sel) return;
  if (!voices.length) {
    sel.innerHTML = '<option value="">No voices available (try again)</option>';
    return;
  }
  const sorted = filterAllowedVoices(voices).sort((a, b) =>
    (a.name || "").localeCompare(b.name || "")
  );
  if (!sorted.length) {
    sel.innerHTML = '<option value="">Aaron / Samantha (en-US) not available</option>';
    return;
  }
  sel.innerHTML = "";
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  }
  let saved = null;
  try {
    saved = localStorage.getItem(TTS_VOICE_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
  const preferred = pickDefaultFemaleVoice(voices);
  if (saved && sorted.some((v) => v.voiceURI === saved)) {
    sel.value = saved;
  } else if (preferred) {
    sel.value = preferred.voiceURI;
    try {
      localStorage.setItem(TTS_VOICE_STORAGE_KEY, preferred.voiceURI);
    } catch (_) {
      /* ignore */
    }
  }
}

function initGameOptions() {
  if (dom.optionAutoNext) {
    try {
      const stored = localStorage.getItem(AUTO_NEXT_STORAGE_KEY);
      dom.optionAutoNext.checked = stored === null ? true : stored === "1";
    } catch (_) {
      dom.optionAutoNext.checked = true;
    }
  }
  if (dom.optionShowBeeProgress) {
    try {
      const stored = localStorage.getItem(SHOW_BEE_PROGRESS_STORAGE_KEY);
      dom.optionShowBeeProgress.checked = stored === null ? true : stored === "1";
    } catch (_) {
      dom.optionShowBeeProgress.checked = true;
    }
  }
  if (dom.optionShowTimer) {
    try {
      dom.optionShowTimer.checked = localStorage.getItem(SHOW_TIMER_STORAGE_KEY) === "1";
    } catch (_) {
      dom.optionShowTimer.checked = false;
    }
  }
  if (dom.optionAutoNext && !dom.optionAutoNext.dataset.bound) {
    dom.optionAutoNext.dataset.bound = "1";
    dom.optionAutoNext.addEventListener("change", () => {
      try {
        localStorage.setItem(AUTO_NEXT_STORAGE_KEY, dom.optionAutoNext.checked ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
    });
  }
  if (dom.optionShowBeeProgress && !dom.optionShowBeeProgress.dataset.bound) {
    dom.optionShowBeeProgress.dataset.bound = "1";
    dom.optionShowBeeProgress.addEventListener("change", () => {
      try {
        localStorage.setItem(SHOW_BEE_PROGRESS_STORAGE_KEY, dom.optionShowBeeProgress.checked ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      syncGameChrome();
    });
  }
  if (dom.optionShowTimer && !dom.optionShowTimer.dataset.bound) {
    dom.optionShowTimer.dataset.bound = "1";
    dom.optionShowTimer.addEventListener("change", () => {
      try {
        localStorage.setItem(SHOW_TIMER_STORAGE_KEY, dom.optionShowTimer.checked ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      if (state.roundStarted && state.gameSessionStartMs) {
        if (isShowTimerEnabled()) startSessionTimer();
        else stopSessionTimer();
      }
      syncGameChrome();
    });
  }
}

function initGameOptionsCloseOnOutsideClick() {
  if (!dom.gameOptionsDetails || dom.gameOptionsDetails.dataset.outsideClickBound) return;
  dom.gameOptionsDetails.dataset.outsideClickBound = "1";
  document.addEventListener("click", (e) => {
    const details = dom.gameOptionsDetails;
    if (!details || !details.open) return;
    const t = e.target;
    if (t && details.contains(t)) return;
    details.open = false;
  });
}

/** Resume / reset idle timer on interaction inside the spelling round (not setup UI). */
function initGameIdleTimer() {
  const el = dom.gameSection;
  if (!el || el.dataset.idleBound) return;
  el.dataset.idleBound = "1";
  const opts = { passive: true };
  for (const ev of ["pointerdown", "keydown", "input", "click", "focusin"]) {
    el.addEventListener(ev, onGameActivity, opts);
  }
}

function initTtsVoices() {
  if (!("speechSynthesis" in window) || !dom.ttsVoiceSelect) return;
  const refresh = () => {
    const voices = window.speechSynthesis.getVoices();
    populateTtsVoiceSelect(voices);
  };
  refresh();
  window.speechSynthesis.addEventListener("voiceschanged", refresh);
}

function speakText(text, rate = SPEECH_RATE_DEFAULT) {
  if (!("speechSynthesis" in window)) {
    alert("Text-to-speech is not supported in this browser.");
    return;
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.rate = rate;
  utterance.pitch = 1.0;
  const voice = getSelectedTtsVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || "en-US";
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/** Reused so repeated correct answers do not create many AudioContexts */
let correctDingAudioContext = null;

/** Short soft sine “ding” on correct spell (Web Audio API, no asset file) */
function playCorrectDing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    if (!correctDingAudioContext || correctDingAudioContext.state === "closed") {
      correctDingAudioContext = new AC();
    }
    const ctx = correctDingAudioContext;
    if (ctx.state === "suspended" && ctx.resume) {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const dur = 0.34;

    const ring = (freq, peak, delay) => {
      const t0 = now + delay;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      const g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    };

    ring(830, 0.055, 0);
    ring(1245, 0.022, 0.04);
  } catch (_) {
    /* no-op if audio blocked or unsupported */
  }
}

function currentWord() {
  return state.words[state.currentIndex] || null;
}

function scheduleAutoSpeak(delayMs = 1000) {
  if (!("speechSynthesis" in window)) return;

  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }

  const entry = currentWord();
  if (!entry) return;

  state.autoSpeakTimeoutId = window.setTimeout(() => {
    if (!state.roundStarted) return;
    const current = currentWord();
    if (!current) return;

    if (state.mode === "audio") {
      const word = (current.word || current.term || "").trim();
      if (word) speakWord(word);
    } else if (state.mode === "definition") {
      const text = (state.definitionForSpeech || "").trim();
      if (text) speakText(text);
    }
  }, delayMs);
}

function renderPrompt() {
  const entry = currentWord();
  if (!entry) {
    dom.promptArea.innerHTML = "<p>No more words. Great job!</p>";
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = true;
    dom.submitAnswer.textContent = SUBMIT_BUTTON_LABEL;
    dom.submitAnswer.setAttribute("aria-label", "Submit spelling");
    dom.nextWord.disabled = true;
    resetShowHintButton();
    syncGameChrome();
    return;
  }

  if (!state.roundStarted) {
    state.hasSubmittedThisWord = false;
    state.answerLocked = false;
    state.lastGradedAnswerLower = "";
    resetShowHintButton();

    if (state.mode === "definition") {
      dom.gameModeLabel.textContent = "Mode: Word in Sentence ➜ Spell the word";
      dom.promptArea.innerHTML = `<p class="helper-text prompt-standby">Click <strong>Start Spelling Bee</strong> in the section above to reveal the sentence and begin your round.</p>`;
    } else {
      dom.gameModeLabel.textContent = "Mode: Spoken word ➜ Spell the word";
      state.audioHintDefinition = "";
      state.definitionForSpeech = "";
      state.lastPromptWord = (entry.word || entry.term || "").trim();
      dom.promptArea.innerHTML = `<p class="helper-text prompt-standby">Click <strong>Start Spelling Bee</strong> in the section above to hear the word and begin your round.</p>`;
      if (dom.showHint) {
        dom.showHint.classList.add("hidden");
        dom.showHint.disabled = true;
      }
    }

    dom.answerInput.value = "";
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = true;
    dom.nextWord.disabled = true;
    updateSubmitButtonAppearance();
    dom.feedback.textContent = "";
    dom.feedback.className = "feedback-text";
    syncGameChrome();
    return;
  }

  // New prompt, reset enter/next state
  state.hasSubmittedThisWord = false;
  state.answerLocked = false;
  state.lastGradedAnswerLower = "";

  const word = (entry.word || entry.term || "").trim();
  // In our default CSV, "Sentense" is the full sentence prompt, and "Definition" is a concise meaning.
  const sentencePrompt = (entry.sentense || entry.sentence || "").trim();
  let definition = (sentencePrompt || entry.meaning || entry.definition || "").trim();

  if (state.mode === "definition") {
    resetShowHintButton();
    dom.gameModeLabel.textContent = "Mode: Word in Sentence ➜ Spell the word";

    // Remove surrounding quotes for both on-screen and spoken text
    let baseDefinition = definition.replace(/^"(.*)"$/, "$1");

    // Store the full sentence (with the word) for speech
    state.definitionForSpeech = baseDefinition || "";

    // Mask the word only in the on-screen version
    const displayDefinition = maskAnswerWord(baseDefinition, word);

    dom.promptArea.innerHTML = `
      <div class="prompt-label">Sentence</div>
      <div class="prompt-main-row">
        <div class="prompt-content">${escapeHtml(displayDefinition || "No definition provided.")}</div>
        <button
          id="speak-definition"
          class="ghost-button icon-button"
          type="button"
          aria-label="Speak sentence"
        >
          <span aria-hidden="true">🔊</span>
        </button>
      </div>
    `;
    const speakBtn = document.getElementById("speak-definition");
    if (speakBtn) {
      speakBtn.disabled = !state.definitionForSpeech;
      speakBtn.addEventListener("click", () => {
        if (state.mode !== "definition" || !state.definitionForSpeech) return;
        speakText(state.definitionForSpeech, SPEECH_RATE_SPEAKER_BUTTON);
      });
    }
  } else {
    const briefDefinition = String(entry.definition || entry.def || "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    state.audioHintDefinition = briefDefinition;

    dom.gameModeLabel.textContent = "Mode: Spoken word ➜ Spell the word";
    dom.promptArea.innerHTML = `
      <div class="prompt-label">Audio prompt</div>
      <div class="prompt-main-row">
        <div class="prompt-content">
          <div id="audio-prompt-lead" class="audio-prompt-placeholder" aria-live="polite"></div>
        </div>
        <button
          id="speak-word"
          class="ghost-button icon-button"
          type="button"
          aria-label="Speak word"
        >
          <span aria-hidden="true">🔊</span>
        </button>
      </div>
    `;
    const leadEl = document.getElementById("audio-prompt-lead");
    if (leadEl) {
      leadEl.textContent = "";
    }
    if (dom.showHint) {
      dom.showHint.classList.remove("show-hint-used");
      if (briefDefinition) {
        dom.showHint.classList.remove("hidden");
        dom.showHint.disabled = false;
      } else {
        dom.showHint.classList.add("hidden");
        dom.showHint.disabled = true;
      }
    }
    state.definitionForSpeech = "";
    state.lastPromptWord = word;

    const speakWordBtn = document.getElementById("speak-word");
    if (speakWordBtn) {
      speakWordBtn.disabled = !word;
      speakWordBtn.addEventListener("click", () => {
        if (state.mode !== "audio") return;
        const w = word;
        if (w) speakWord(w, SPEECH_RATE_SPEAKER_BUTTON);
      });
    }
  }

  dom.answerInput.value = "";
  dom.answerInput.disabled = false;
  dom.submitAnswer.disabled = false;
  dom.nextWord.disabled = !state.hasSubmittedThisWord;
  updateSubmitButtonAppearance();
  dom.feedback.textContent = "";
  dom.feedback.className = "feedback-text";
  dom.answerInput.focus();
  syncGameChrome();
}

function updateScore(correct) {
  if (correct) state.score += 1;
  state.attempts += 1;
  dom.scoreText.textContent = `Score: ${state.score} / ${state.attempts}`;
  updateProgressBees();
}

function handleSubmitAnswer() {
  const entry = currentWord();
  if (!entry) return;
  if (!state.roundStarted) return;
  onGameActivity();
  if (state.answerLocked) return;

  const userAnswer = dom.answerInput.value.trim().toLowerCase();
  const correctWord = String(entry.word || entry.term || "").trim();
  const correctLower = correctWord.toLowerCase();

  if (!userAnswer) return;

  if (state.hasSubmittedThisWord && userAnswer === state.lastGradedAnswerLower) {
    return;
  }

  state.hasSubmittedThisWord = true;
  if (dom.nextWord) dom.nextWord.disabled = false;

  const isCorrect = userAnswer === correctLower;
  updateScore(isCorrect);
  state.lastGradedAnswerLower = userAnswer;

  if (isCorrect) {
    state.answerLocked = true;
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = false;
    updateSubmitButtonAppearance();
    dom.feedback.innerHTML = `Correct! <span class="feedback-highlight-word">${escapeHtml(correctWord)}</span>`;
    dom.feedback.className = "feedback-text feedback-correct";
    playCorrectDing();
    if (isAutoNextEnabled()) {
      state.autoNextTimeoutId = window.setTimeout(() => {
        state.autoNextTimeoutId = null;
        if (!state.roundStarted || !state.answerLocked) return;
        goToNextWord();
      }, AUTO_ADVANCE_AFTER_CORRECT_MS);
    }
  } else {
    state.misspellings.push({
      word: correctWord,
      typed: dom.answerInput.value.trim(),
    });
    dom.answerInput.disabled = false;
    updateSubmitButtonAppearance();
    dom.feedback.innerHTML = `Not quite. The correct spelling is <span class="feedback-highlight-word">${escapeHtml(
      correctWord
    )}</span>. Try again.`;
    dom.feedback.className = "feedback-text feedback-incorrect";
    dom.answerInput.focus();
  }
}

function showCorrectAnswer() {
  const entry = currentWord();
  if (!entry) return;
  if (!state.roundStarted) return;
  const correctWord = String(entry.word || entry.term || "").trim();
  dom.feedback.innerHTML = `Answer: <span class="feedback-highlight-word">${escapeHtml(correctWord)}</span>`;
  dom.feedback.className = "feedback-text feedback-answer";
}

function goToNextWord() {
  clearAutoNextTimeout();
  if (!state.hasSubmittedThisWord) return;
  if (state.currentIndex < state.words.length - 1) {
    state.currentIndex += 1;
    renderPrompt();
    if (state.roundStarted) scheduleAutoSpeak(1000);
  } else {
    const elapsedMs = getElapsedSessionMs();
    if (state.autoSpeakTimeoutId !== null) {
      clearTimeout(state.autoSpeakTimeoutId);
      state.autoSpeakTimeoutId = null;
    }
    clearIdleSessionPause();
    stopSessionTimer();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    state.roundStarted = false;
    state.gameSessionStartMs = null;
    dom.promptArea.innerHTML =
      '<div class="prompt-content">You have reached the end of your list. 🎉</div>';
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = true;
    dom.submitAnswer.textContent = SUBMIT_BUTTON_LABEL;
    dom.submitAnswer.setAttribute("aria-label", "Submit spelling");
    dom.nextWord.disabled = true;
    resetShowHintButton();
    openSessionSummaryDialog(elapsedMs);
    syncGameChrome();
  }
}

// Event wiring
dom.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) {
    dom.fileName.textContent = "No file selected";
    state.words = [];
    updateWordCount();
    hideGameSection();
    return;
  }

  dom.fileName.textContent = file.name;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const text = String(event.target?.result || "");
      loadWordsFromCsvText(text, file.name);
      updateSelectedGradeHint(`Custom: ${file.name}`);
    } catch (err) {
      console.error(err);
      state.words = [];
      updateWordCount();
      hideGameSection();
    }
  };
  reader.onerror = () => {
    state.words = [];
    updateWordCount();
    hideGameSection();
  };

  reader.readAsText(file);
});

function loadSelectedGrade() {
  if (!dom.gradeSelect || !window.fetch) return;
  const path = gradeValueToCsvPath(dom.gradeSelect.value);
  if (!path) return;
  fetch(path)
    .then((res) => {
      if (!res.ok) throw new Error("Grade CSV not found");
      return res.text();
    })
    .then((text) => {
      const ok = loadWordsFromCsvText(text, `${path} (built-in)`);
      if (ok) {
        const selectedLabel =
          dom.gradeSelect.options[dom.gradeSelect.selectedIndex]?.textContent || dom.gradeSelect.value;
        updateSelectedGradeHint(`Built-in: ${selectedLabel}`);
      }
    })
    .catch(() => {
      /* Could not load grade CSV */
    });
}

if (dom.gradeSelect && !dom.gradeSelect.dataset.bound) {
  dom.gradeSelect.dataset.bound = "1";
  dom.gradeSelect.addEventListener("change", () => {
    loadSelectedGrade();
  });
}

if (dom.downloadCsv && !dom.downloadCsv.dataset.bound) {
  dom.downloadCsv.dataset.bound = "1";
  dom.downloadCsv.addEventListener("click", () => {
    exportCurrentWordsCsv();
  });
}

dom.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-mode");
    if (!mode) return;
    state.mode = mode;
    dom.modeButtons.forEach((b) => b.classList.toggle("selected", b === button));
    if (
      dom.gameSection &&
      !dom.gameSection.classList.contains("hidden") &&
      state.words.length > 0
    ) {
      renderPrompt();
    }
  });
});

dom.startGame.addEventListener("click", () => {
  if (state.words.length === 0) return;
  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  clearSessionTracking();
  shuffleInPlace(state.words);
  state.currentIndex = 0;
  state.score = 0;
  state.attempts = 0;
  state.roundStarted = true;
  state.gameSessionStartMs = Date.now();
  dom.scoreText.textContent = "Score: 0 / 0";
  dom.gameSection.classList.remove("hidden");
  renderPrompt();
  scheduleAutoSpeak(1000);
  syncGameChrome();
  startSessionTimer();
  onGameActivity();
  if (dom.configDetails) dom.configDetails.open = false;
  if (dom.gameOptionsDetails) dom.gameOptionsDetails.open = false;
});

if (dom.stopGame) {
  dom.stopGame.addEventListener("click", () => {
    handleStopGame();
  });
}

if (dom.sessionSummaryDialog && !dom.sessionSummaryDialog.dataset.bound) {
  dom.sessionSummaryDialog.dataset.bound = "1";
  dom.sessionSummaryDialog.addEventListener("click", (e) => {
    if (e.target === dom.sessionSummaryDialog) {
      dom.sessionSummaryDialog.close();
    }
  });
  dom.sessionSummaryDialog.addEventListener("close", () => {
    if (!state.roundStarted && state.words.length > 0) {
      renderPrompt();
    }
  });
}

dom.submitAnswer.addEventListener("click", () => {
  if (state.answerLocked) {
    goToNextWord();
  } else {
    handleSubmitAnswer();
  }
});

dom.answerInput.addEventListener("input", () => {
  if (!state.answerLocked) updateSubmitButtonAppearance();
});

dom.answerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (state.answerLocked) {
      onGameActivity();
      goToNextWord();
    } else {
      handleSubmitAnswer();
    }
    e.stopPropagation();
  }
});

// Global keyboard shortcuts
window.addEventListener("keydown", (e) => {
  // Enter: go to next word only after a correct answer (input locked); wrong answers use Enter to resubmit
  if (e.key === "Enter") {
    if (e.defaultPrevented) return;
    if (dom.gameSection.classList.contains("hidden")) return;
    if (!state.answerLocked) return;
    if (dom.nextWord.disabled) return;
    const t = e.target;
    if (t && t.tagName === "INPUT" && t.type === "file") return;
    if (t && typeof t.closest === "function" && t.closest("button")) return;
    e.preventDefault();
    onGameActivity();
    goToNextWord();
  }
  // Right arrow: go to next word (when game section is visible)
  if (e.key === "ArrowRight") {
    // Let Right Arrow move the caret while editing the answer field
    if (dom.answerInput && document.activeElement === dom.answerInput) return;
    if (!dom.gameSection.classList.contains("hidden") && !dom.nextWord.disabled) {
      e.preventDefault();
      onGameActivity();
      goToNextWord();
    }
  }
});

dom.showAnswer.addEventListener("click", () => {
  showCorrectAnswer();
});

dom.nextWord.addEventListener("click", () => {
  goToNextWord();
});

if (dom.ttsVoiceSelect && !dom.ttsVoiceSelect.dataset.bound) {
  dom.ttsVoiceSelect.dataset.bound = "1";
  dom.ttsVoiceSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(TTS_VOICE_STORAGE_KEY, dom.ttsVoiceSelect.value);
    } catch (_) {
      /* ignore */
    }
  });
}
initGameOptions();
initGameOptionsCloseOnOutsideClick();
initGameIdleTimer();
initTtsVoices();

// Load default CSV from words/3rd-grade-words.csv if available
(function loadDefaultCsv() {
  if (!window.fetch) return;

  fetch("words/3rd-grade-words.csv")
    .then((res) => {
      if (!res.ok) throw new Error("Default CSV not found");
      return res.text();
    })
    .then((text) => {
      const ok = loadWordsFromCsvText(text, "words/3rd-grade-words.csv (default)");
      if (!ok) return;
      if (dom.gradeSelect) dom.gradeSelect.value = "3rd";
      updateSelectedGradeHint("Built-in: 3rd grade (default)");
    })
    .catch(() => {
      // Fail silently; user can still upload a CSV manually.
    });
})();

