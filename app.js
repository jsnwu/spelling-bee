/* CSV & string helpers */
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

/* Application state */
const state = {
  words: [],
  currentIndex: 0,
  score: 0,
  /** All-time graded correct spellings (persisted); bees = floor(this / 10) */
  lifetimeCorrectCount: 0,
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
/** Graded correct spellings ever — used for all-time bee count (survives new games) */
const LIFETIME_CORRECT_STORAGE_KEY = "spellingBeeLifetimeCorrectCount";

/* ─— Honeycomb shell glow & full-list finish celebration (keep in sync with styles.css) —— */
/** ~ `--honeycomb-pulse-duration` (1.05s) + buffer; used for milestone glow + finish-cheer cleanup */
const HONEYCOMB_GLOW_TOTAL_MS = 1300;
const FINISH_CELEBRATION_DIALOG_DELAY_MS = 9000;
const FINISH_CELEBRATION_CLEANUP_MS = 12000;
const FINISH_CELEBRATION_BUZZ_MS = 8400;
const POPPER_POP_ROUNDS = 4;
const POPPER_POP_GAP_MS = 1200;
const FINISH_CELEBRATION_HONEYCOMB_PULSES = 5;
const FINISH_CELEBRATION_HONEYCOMB_GAP_MS = 1000;
const FINISH_CELEBRATION_POPPER_FADE_SEC = 0.7;
const FINISH_BEE_BURST_COUNT = 4;
const FINISH_BEES_PER_BURST = 9;
const FINISH_BEE_DELAY_STEP_SEC = 0.18;
const FINISH_BEE_DUR_MIN_SEC = 5.7;
const FINISH_BEE_DUR_SPREAD_SEC = 1.5;
const PARTY_POP_CONFETTI_COUNT = 36;
const PARTY_POP_STREAMER_COUNT = 16;

/** Prefer English, then names that usually indicate a female voice per OS/browser lists */
const TTS_FEMALE_NAME_PATTERNS = [
  /siri.*female/i,
  /female.*siri/i,
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

/** Picker: Aaron (US male), Samantha (US female), UK voices — match `name` or `voiceURI` (word-boundary) */
const TTS_PICKER_VOICE_NAME_RE = /\b(aaron|daniel|oliver|samantha)\b/i;

/** UK English — Daniel, Oliver are typical `en-GB` male voices in Safari */
const TTS_PICKER_VOICE_UK_EN_GB_RE = /\b(daniel|oliver)\b/i;

/** Short labels for the voice `<select>` — avoids Chrome’s long names like “Daniel (English (United Kingdom)) …” */
const TTS_PICKER_SLOT_DISPLAY = {
  aaron: "Aaron",
  daniel: "Daniel",
  oliver: "Oliver",
  samantha: "Samantha",
};

const dom = {
  fileInput: document.getElementById("csv-input"),
  fileName: document.getElementById("file-name"),
  wordCount: document.getElementById("word-count"),
  modeButtons: Array.from(document.querySelectorAll(".mode-button")),
  startGame: document.getElementById("start-game"),
  gameSection: document.getElementById("game-section"),
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
  appShell: document.querySelector(".app-shell"),
  finishCelebrationRoot: document.getElementById("finish-celebration-root"),
};

/** Last session bee count rendered in the header (for one-shot glow on new bees) */
let lastRenderedSessionBeeCount = 0;

let finishCelebrationCleanupTimerId = null;
let finishCelebrationSoundIntervalId = null;
let finishCelebrationHoneycombTimeoutIds = [];
let finishCelebrationStageFadeTimerId = null;
let honeycombGlowTimerId = null;
/** Wall-clock ms until honeycomb animation ends; used to delay advancing to the next word */
let honeycombGlowUntilMs = 0;
let goToNextWordDeferTimerId = null;
/** Reused so repeated correct answers do not create many AudioContexts */
let correctDingAudioContext = null;

function readStorageBool(key, whenNull) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return whenNull;
    return raw === "1";
  } catch (_) {
    return whenNull;
  }
}

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

/**
 * Dev/testing only — query params are not persisted unless you submit answers.
 * Examples:
 *   ?debugLifetime=19 — bump lifetime bees only (header); not used for honeycomb glow
 *   ?debugScore=9 — session score after Start; next correct → 10 in this game → honeycomb glow (if bee progress on)
 *   ?debugScore=5&debugAttempts=5 — session score after Start (attempts defaults to score if omitted)
 */
function readDebugQueryParam(name) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    if (v === null || v === "") return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(99999, n));
  } catch (_) {
    return null;
  }
}

function applyDebugLifetimeFromQuery() {
  const n = readDebugQueryParam("debugLifetime");
  if (n === null) return;
  state.lifetimeCorrectCount = n;
}

function applyDebugSessionScoreFromQuery() {
  const score = readDebugQueryParam("debugScore");
  if (score === null) return;
  const attempts = readDebugQueryParam("debugAttempts");
  state.score = score;
  state.attempts = attempts !== null ? Math.max(score, attempts) : score;
  if (dom.scoreText) {
    dom.scoreText.textContent = `Score: ${state.score} / ${state.attempts}`;
  }
  updateProgressBees();
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
  clearGoToNextWordDeferTimer();
}

function loadLifetimeCorrectCount() {
  try {
    const raw = localStorage.getItem(LIFETIME_CORRECT_STORAGE_KEY);
    const n = raw === null ? 0 : parseInt(raw, 10);
    state.lifetimeCorrectCount = Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_) {
    state.lifetimeCorrectCount = 0;
  }
}

function persistLifetimeCorrectCount() {
  try {
    localStorage.setItem(LIFETIME_CORRECT_STORAGE_KEY, String(state.lifetimeCorrectCount));
  } catch (_) {
    /* ignore */
  }
}

/** All-time bee count for session summary (localStorage lifetime correct). */
function getLifetimeBeeCount() {
  return Math.min(BEE_PROGRESS_MAX_ICONS, Math.floor(state.lifetimeCorrectCount / 10));
}

/** Bee icons in the header: this game only — 1 per 10 correct in the current round. */
function getSessionBeeCount() {
  return Math.min(BEE_PROGRESS_MAX_ICONS, Math.floor(state.score / 10));
}

/* Honeycomb glow & full-list finish celebration */
function clearGoToNextWordDeferTimer() {
  if (goToNextWordDeferTimerId !== null) {
    clearTimeout(goToNextWordDeferTimerId);
    goToNextWordDeferTimerId = null;
  }
}

function clearFinishCelebrationHoneycombTimers() {
  for (const id of finishCelebrationHoneycombTimeoutIds) {
    clearTimeout(id);
  }
  finishCelebrationHoneycombTimeoutIds = [];
  const shell = dom.appShell;
  if (shell) {
    shell.classList.remove("app-shell--honeycomb-glow");
  }
  honeycombGlowUntilMs = 0;
}

function clearFinishCelebrationStageFadeTimer() {
  if (finishCelebrationStageFadeTimerId !== null) {
    clearTimeout(finishCelebrationStageFadeTimerId);
    finishCelebrationStageFadeTimerId = null;
  }
}

function clearFinishCelebrationCleanupTimer() {
  if (finishCelebrationCleanupTimerId !== null) {
    clearTimeout(finishCelebrationCleanupTimerId);
    finishCelebrationCleanupTimerId = null;
  }
  stopFinishCelebrationSounds();
  clearFinishCelebrationHoneycombTimers();
  clearFinishCelebrationStageFadeTimer();
}

/** Several honeycomb shines during the full-list celebration (poppers / bees). */
function triggerFinishCelebrationHoneycombGlows() {
  const shell = dom.appShell;
  if (!shell) return;
  if (honeycombGlowTimerId !== null) {
    clearTimeout(honeycombGlowTimerId);
    honeycombGlowTimerId = null;
  }
  clearFinishCelebrationHoneycombTimers();

  const pulses = FINISH_CELEBRATION_HONEYCOMB_PULSES;
  const gap = FINISH_CELEBRATION_HONEYCOMB_GAP_MS;

  for (let i = 0; i < pulses; i++) {
    const id = window.setTimeout(() => {
      shell.classList.remove("app-shell--honeycomb-glow");
      void shell.offsetWidth;
      shell.classList.add("app-shell--honeycomb-glow");
    }, i * gap);
    finishCelebrationHoneycombTimeoutIds.push(id);
  }

  const finalId = window.setTimeout(() => {
    shell.classList.remove("app-shell--honeycomb-glow");
    honeycombGlowUntilMs = 0;
  }, (pulses - 1) * gap + HONEYCOMB_GLOW_TOTAL_MS);
  finishCelebrationHoneycombTimeoutIds.push(finalId);
}

function stopFinishCelebrationSounds() {
  if (finishCelebrationSoundIntervalId !== null) {
    clearInterval(finishCelebrationSoundIntervalId);
    finishCelebrationSoundIntervalId = null;
  }
}

/** Short wing-buzz chirps while finish-celebration bees are on screen (Web Audio; reuses ding context). */
function playFinishCelebrationBeeBuzzes(durationMs) {
  stopFinishCelebrationSounds();
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
    const endAt = Date.now() + durationMs;
    const chirp = () => {
      if (Date.now() >= endAt) {
        stopFinishCelebrationSounds();
        return;
      }
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const f0 = 155 + Math.random() * 70;
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.72, now + 0.085);
      const g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.038 + Math.random() * 0.028, now + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(g);
      osc.start(now);
      osc.stop(now + 0.13);
    };
    chirp();
    finishCelebrationSoundIntervalId = window.setInterval(chirp, 138);
  } catch (_) {
    /* no-op */
  }
}

/** Soft “pop” when a party popper fires (pairs with visual burst). */
function playPartyPopperPop(delaySec = 0) {
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
    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.06);
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.07, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(g);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch (_) {
    /* no-op */
  }
}

function addPartyPopperBurst(originEl, side, density = 1) {
  const confettiColors = ["#ef4444", "#60a5fa", "#fbbf24", "#a78bfa", "#34d399", "#f472b6"];
  const streamerColors = ["#4ade80", "#fbbf24", "#38bdf8", "#c084fc", "#fb923c"];
  const nConfetti = Math.max(8, Math.round(PARTY_POP_CONFETTI_COUNT * density));
  const nStream = Math.max(4, Math.round(PARTY_POP_STREAMER_COUNT * density));

  for (let i = 0; i < nConfetti; i++) {
    const bit = document.createElement("span");
    bit.className = "finish-confetti-bit";
    const w = 4 + Math.random() * 5;
    const h = 5 + Math.random() * 9;
    bit.style.width = `${w}px`;
    bit.style.height = `${h}px`;
    bit.style.setProperty("--c", confettiColors[i % confettiColors.length]);
    let dx;
    let dy;
    if (side === "left") {
      dx = 100 + Math.random() * 320;
      dy = -(110 + Math.random() * 300);
    } else {
      dx = -(100 + Math.random() * 320);
      dy = -(110 + Math.random() * 300);
    }
    dx += (Math.random() - 0.5) * 80;
    dy += (Math.random() - 0.5) * 60;
    bit.style.setProperty("--dx", `${dx}px`);
    bit.style.setProperty("--dy", `${dy}px`);
    bit.style.animationDelay = `${Math.random() * 0.08}s`;
    bit.style.animationDuration = `${0.95 + Math.random() * 0.45}s`;
    originEl.appendChild(bit);
  }

  for (let i = 0; i < nStream; i++) {
    const rib = document.createElement("span");
    rib.className = "finish-streamer";
    rib.style.setProperty("--stream-c", streamerColors[i % streamerColors.length]);
    let dx;
    let dy;
    if (side === "left") {
      dx = 120 + Math.random() * 340;
      dy = -(130 + Math.random() * 280);
    } else {
      dx = -(120 + Math.random() * 340);
      dy = -(130 + Math.random() * 280);
    }
    rib.style.setProperty("--dx", `${dx}px`);
    rib.style.setProperty("--dy", `${dy}px`);
    rib.style.setProperty("--curl", `${-25 + Math.random() * 50}deg`);
    rib.style.animationDelay = `${Math.random() * 0.1}s`;
    rib.style.animationDuration = `${1.15 + Math.random() * 0.5}s`;
    originEl.appendChild(rib);
  }
}

function schedulePartyPopperPops(burstL, burstR, leftPopEl, rightPopEl) {
  for (let r = 0; r < POPPER_POP_ROUNDS; r++) {
    const base = r * POPPER_POP_GAP_MS;
    const density = r === 0 ? 1 : 0.72;
    window.setTimeout(() => {
      if (burstL) {
        addPartyPopperBurst(burstL, "left", density);
      }
      playPartyPopperPop(0);
      leftPopEl.classList.add("finish-popper--pop");
      window.setTimeout(() => leftPopEl.classList.remove("finish-popper--pop"), 340);
    }, base);
    window.setTimeout(() => {
      if (burstR) {
        addPartyPopperBurst(burstR, "right", density);
      }
      playPartyPopperPop(0);
      rightPopEl.classList.add("finish-popper--pop");
      window.setTimeout(() => rightPopEl.classList.remove("finish-popper--pop"), 340);
    }, base + 170);
  }
}

/**
 * Party poppers (confetti + streamers) + bees flying + buzz + pop SFX when the full word list is cleared.
 * Skipped when prefers-reduced-motion (caller opens the summary dialog immediately).
 */
function triggerFinishCelebration() {
  const root = dom.finishCelebrationRoot;
  if (!root) return;
  clearFinishCelebrationCleanupTimer();
  root.innerHTML = "";
  root.setAttribute("aria-hidden", "true");

  const stage = document.createElement("div");
  stage.className = "finish-celebration-stage";
  stage.style.setProperty("--finish-popper-fade-sec", `${FINISH_CELEBRATION_POPPER_FADE_SEC}s`);

  const leftPop = document.createElement("div");
  leftPop.className = "finish-popper finish-popper--left";
  leftPop.setAttribute("aria-hidden", "true");
  leftPop.innerHTML = `<div class="finish-popper-body">
    <div class="finish-popper-cap finish-popper-cap--warm"></div>
    <div class="finish-popper-cone finish-popper-cone--warm"></div>
    <span class="finish-popper-string finish-popper-string--purple"></span>
  </div><div class="finish-popper-burst"></div>`;

  const rightPop = document.createElement("div");
  rightPop.className = "finish-popper finish-popper--right";
  rightPop.setAttribute("aria-hidden", "true");
  rightPop.innerHTML = `<div class="finish-popper-body">
    <div class="finish-popper-cap finish-popper-cap--cool"></div>
    <div class="finish-popper-cone finish-popper-cone--cool"></div>
    <span class="finish-popper-string finish-popper-string--red"></span>
  </div><div class="finish-popper-burst"></div>`;

  stage.appendChild(leftPop);
  stage.appendChild(rightPop);
  root.appendChild(stage);

  const burstL = leftPop.querySelector(".finish-popper-burst");
  const burstR = rightPop.querySelector(".finish-popper-burst");
  if (burstL || burstR) {
    schedulePartyPopperPops(burstL, burstR, leftPop, rightPop);
  }

  triggerFinishCelebrationHoneycombGlows();

  playFinishCelebrationBeeBuzzes(FINISH_CELEBRATION_BUZZ_MS);

  const beeSrc = BEE_PROGRESS_ICON_SRC;
  const burstCount = FINISH_BEE_BURST_COUNT;
  const beesPerBurst = FINISH_BEES_PER_BURST;
  let maxBeeEndSec = 0;
  for (let b = 0; b < burstCount; b++) {
    const t = burstCount <= 1 ? 0.5 : b / (burstCount - 1);
    const cx = 12 + t * 76 + (Math.random() - 0.5) * 8;
    const cy = 16 + Math.random() * 22;
    const delay = b * FINISH_BEE_DELAY_STEP_SEC;
    for (let i = 0; i < beesPerBurst; i++) {
      const wrap = document.createElement("span");
      wrap.className = "finish-bee-pop";
      wrap.style.setProperty("--cx", `${cx}%`);
      wrap.style.setProperty("--cy", `${cy}%`);
      const base = Math.random() * Math.PI * 2 + (i / beesPerBurst) * 0.4;
      const r0 = 42 + Math.random() * 68;
      for (let p = 1; p <= 4; p++) {
        const ang = base + p * 0.95 + (Math.random() - 0.5) * 0.55;
        const rp = r0 * (0.5 + Math.random() * 0.55);
        wrap.style.setProperty(`--p${p}x`, `${Math.cos(ang) * rp}px`);
        wrap.style.setProperty(`--p${p}y`, `${Math.sin(ang) * rp}px`);
      }
      const durSec = FINISH_BEE_DUR_MIN_SEC + Math.random() * FINISH_BEE_DUR_SPREAD_SEC;
      wrap.style.animationDelay = `${delay}s`;
      wrap.style.animationDuration = `${durSec}s`;
      maxBeeEndSec = Math.max(maxBeeEndSec, delay + durSec);
      const img = document.createElement("img");
      img.src = beeSrc;
      img.alt = "";
      img.className = "finish-bee-pop-img";
      img.decoding = "async";
      wrap.appendChild(img);
      root.appendChild(wrap);
    }
  }

  const fadeStartMs = Math.max(0, (maxBeeEndSec - FINISH_CELEBRATION_POPPER_FADE_SEC) * 1000);
  finishCelebrationStageFadeTimerId = window.setTimeout(() => {
    stage.classList.add("finish-celebration-stage--fade");
    finishCelebrationStageFadeTimerId = null;
  }, fadeStartMs);

  finishCelebrationCleanupTimerId = window.setTimeout(() => {
    clearFinishCelebrationStageFadeTimer();
    root.innerHTML = "";
    stopFinishCelebrationSounds();
    clearFinishCelebrationHoneycombTimers();
    finishCelebrationCleanupTimerId = null;
  }, FINISH_CELEBRATION_CLEANUP_MS);
}

/** One honeycomb pulse when session score hits each bee milestone (10, 20, … — same cadence as header bees). */
function maybeTriggerHoneycombGlowForBeeMilestone() {
  if (!state.roundStarted || !isShowBeeProgressEnabled()) return;
  const s = state.score;
  if (s <= 0 || s % 10 !== 0) return;
  const shell = dom.appShell;
  if (!shell) return;
  shell.classList.remove("app-shell--honeycomb-glow");
  void shell.offsetWidth;
  shell.classList.add("app-shell--honeycomb-glow");
  honeycombGlowUntilMs = Date.now() + HONEYCOMB_GLOW_TOTAL_MS;
  if (honeycombGlowTimerId !== null) {
    clearTimeout(honeycombGlowTimerId);
  }
  honeycombGlowTimerId = window.setTimeout(() => {
    shell.classList.remove("app-shell--honeycomb-glow");
    honeycombGlowTimerId = null;
    honeycombGlowUntilMs = 0;
  }, HONEYCOMB_GLOW_TOTAL_MS);
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
    lastRenderedSessionBeeCount = 0;
    return;
  }
  wrap.hidden = false;
  if (!sectionVisible) {
    wrap.setAttribute("aria-hidden", "true");
    wrap.setAttribute("aria-label", "Progress bees");
    return;
  }
  wrap.removeAttribute("aria-hidden");
  const n = getSessionBeeCount();
  const prevBeeCount = lastRenderedSessionBeeCount;
  for (let i = 0; i < n; i++) {
    const img = document.createElement("img");
    img.src = BEE_PROGRESS_ICON_SRC;
    img.alt = "";
    img.className = "game-header-bee-img";
    if (n > prevBeeCount && i >= prevBeeCount) {
      img.classList.add("game-header-bee-img--reward-enter");
    }
    img.decoding = "async";
    wrap.appendChild(img);
  }
  lastRenderedSessionBeeCount = n;
  wrap.setAttribute(
    "aria-label",
    n === 0
      ? "No bees this game yet — one bee for each 10 correct in this round"
      : n === 1
        ? "1 bee this game — one bee for each 10 correct in this round"
        : `${n} bees this game — one bee for each 10 correct in this round`
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
  const totalBeesAllTime = getLifetimeBeeCount();
  const beeLine = `<p class="session-summary-line"><span class="session-summary-label">Bees earned (all time)</span><span class="session-summary-value">${totalBeesAllTime}</span></p>`;
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

/** Name + URI — Safari/WebKit sometimes leave `name` sparse but put the voice id in `voiceURI` */
function pickerVoiceIdentityLabel(v) {
  return `${v.name || ""} ${v.voiceURI || ""}`;
}

/**
 * English locales for the voice picker. Safari often uses `en` or omits `lang` for built-in voices.
 * Only used together with `TTS_PICKER_VOICE_NAME_RE` — not a general “all English” filter.
 */
function isPickerLangUsEnglish(v) {
  const n = normalizeVoiceLang(v.lang);
  const id = pickerVoiceIdentityLabel(v);
  if (n.startsWith("en-us")) return true;
  if (n === "en") return true;
  if (n === "") return true;
  if (n.startsWith("en-gb") && TTS_PICKER_VOICE_UK_EN_GB_RE.test(id)) return true;
  return false;
}

function isAllowedPickerVoiceName(v) {
  return TTS_PICKER_VOICE_NAME_RE.test(pickerVoiceIdentityLabel(v));
}

/** One entry per name — Safari may list compact + enhanced duplicates (deduped by score). */
function pickerCanonicalSlot(v) {
  const id = pickerVoiceIdentityLabel(v);
  if (/\baaron\b/i.test(id)) return "aaron";
  if (/\bdaniel\b/i.test(id)) return "daniel";
  if (/\boliver\b/i.test(id)) return "oliver";
  if (/\bsamantha\b/i.test(id)) return "samantha";
  return null;
}

function ttsVoiceOptionLangTag(v) {
  const lang = normalizeVoiceLang(v.lang);
  if (lang.startsWith("en-gb")) return "en-GB";
  if (lang.startsWith("en-us")) return "en-US";
  if (lang === "en" || lang === "") {
    const slot = pickerCanonicalSlot(v);
    if (slot === "daniel" || slot === "oliver") return "en-GB";
    return "en-US";
  }
  return String(v.lang || "en-US").replace(/_/g, "-");
}

function ttsVoiceOptionLabel(v) {
  const slot = pickerCanonicalSlot(v);
  const title =
    slot && TTS_PICKER_SLOT_DISPLAY[slot] ? TTS_PICKER_SLOT_DISPLAY[slot] : (v.name || v.voiceURI);
  return `${title} (${ttsVoiceOptionLangTag(v)})`;
}

function pickerVoiceDedupeScore(v) {
  const name = (v.name || "").toLowerCase();
  let s = 0;
  if (/enhanced|premium|neural/i.test(name)) s += 100;
  if (/compact/i.test(name)) s -= 20;
  return s;
}

function filterAllowedVoices(voices) {
  const raw = (voices || []).filter((v) => isPickerLangUsEnglish(v) && isAllowedPickerVoiceName(v));
  const bySlot = new Map();
  for (const v of raw) {
    const slot = pickerCanonicalSlot(v);
    if (!slot) continue;
    const cur = bySlot.get(slot);
    if (!cur) {
      bySlot.set(slot, v);
      continue;
    }
    const sv = pickerVoiceDedupeScore(v);
    const sc = pickerVoiceDedupeScore(cur);
    if (sv > sc) {
      bySlot.set(slot, v);
    } else if (sv === sc && (v.voiceURI || "").localeCompare(cur.voiceURI || "") < 0) {
      bySlot.set(slot, v);
    }
  }
  const all = ["aaron", "daniel", "oliver", "samantha"]
    .map((k) => bySlot.get(k))
    .filter(Boolean);

  if (all.length > 2) {
    const pruned = ["aaron", "samantha"].map((k) => bySlot.get(k)).filter(Boolean);
    return pruned.length ? pruned : all.slice(0, 2);
  }

  return all;
}

function pickDefaultFemaleVoice(voices) {
  const pool = filterAllowedVoices(voices);
  if (!pool.length) return null;
  const label = (v) => pickerVoiceIdentityLabel(v);
  for (const re of TTS_FEMALE_NAME_PATTERNS) {
    const hit = pool.find((v) => re.test(label(v)));
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
    sel.innerHTML =
      '<option value="">Aaron / Daniel / Oliver / Samantha not found — check System Settings → Accessibility → Spoken Content</option>';
    return;
  }
  sel.innerHTML = "";
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = ttsVoiceOptionLabel(v);
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
    dom.optionAutoNext.checked = readStorageBool(AUTO_NEXT_STORAGE_KEY, true);
  }
  if (dom.optionShowBeeProgress) {
    dom.optionShowBeeProgress.checked = readStorageBool(SHOW_BEE_PROGRESS_STORAGE_KEY, true);
  }
  if (dom.optionShowTimer) {
    dom.optionShowTimer.checked = readStorageBool(SHOW_TIMER_STORAGE_KEY, false);
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
      if (!isShowBeeProgressEnabled()) {
        dom.appShell?.classList.remove("app-shell--honeycomb-glow");
        honeycombGlowUntilMs = 0;
        if (honeycombGlowTimerId !== null) {
          clearTimeout(honeycombGlowTimerId);
          honeycombGlowTimerId = null;
        }
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
  /* Safari often fills the voice list shortly after the first getVoices() (empty or partial) */
  window.setTimeout(refresh, 200);
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
      dom.promptArea.innerHTML = `<p class="helper-text prompt-standby">Click <strong>Start Spelling Bee</strong> in the section above to reveal the sentence and begin your round.</p>`;
    } else {
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
  if (correct) {
    state.score += 1;
    state.lifetimeCorrectCount += 1;
    persistLifetimeCorrectCount();
    maybeTriggerHoneycombGlowForBeeMilestone();
  }
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
  const glowEnd = honeycombGlowUntilMs;
  if (glowEnd && Date.now() < glowEnd) {
    const wait = Math.max(0, glowEnd - Date.now() + 80);
    goToNextWordDeferTimerId = window.setTimeout(() => {
      goToNextWordDeferTimerId = null;
      goToNextWord();
    }, wait);
    return;
  }
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
    const reduceMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || !dom.finishCelebrationRoot) {
      openSessionSummaryDialog(elapsedMs);
    } else {
      triggerFinishCelebration();
      window.setTimeout(() => {
        openSessionSummaryDialog(elapsedMs);
      }, FINISH_CELEBRATION_DIALOG_DELAY_MS);
    }
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

function syncGradeComboboxFromSelect() {
  const label = document.getElementById("grade-select-button-label");
  const list = document.getElementById("grade-select-dropdown");
  const sel = dom.gradeSelect;
  if (!label || !list || !sel) return;
  const opt = sel.options[sel.selectedIndex];
  label.textContent = opt ? opt.textContent.trim() : String(sel.value);
  list.querySelectorAll(".grade-select-option").forEach((li) => {
    const v = li.getAttribute("data-value");
    const selected = v === sel.value;
    li.classList.toggle("grade-select-option--selected", selected);
    li.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function initGradeCombobox() {
  const btn = document.getElementById("grade-select-button");
  const list = document.getElementById("grade-select-dropdown");
  const sel = dom.gradeSelect;
  if (!btn || !list || !sel || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  const sectionCard = btn.closest("section.card");

  function close() {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    sectionCard?.classList.remove("config-card--grade-dropdown-open");
  }

  function open() {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    sectionCard?.classList.add("config-card--grade-dropdown-open");
    syncGradeComboboxFromSelect();
  }

  function toggle() {
    if (list.hidden) open();
    else close();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  list.addEventListener("click", (e) => {
    const li = e.target.closest(".grade-select-option");
    if (!li || !list.contains(li)) return;
    e.stopPropagation();
    const v = li.getAttribute("data-value");
    if (!v) return;
    sel.value = v;
    syncGradeComboboxFromSelect();
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  });

  document.addEventListener("click", () => close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) {
      close();
    }
  });

  syncGradeComboboxFromSelect();
}

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
  applyDebugSessionScoreFromQuery();
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
loadLifetimeCorrectCount();
applyDebugLifetimeFromQuery();
initGameOptions();
initGameOptionsCloseOnOutsideClick();
initGradeCombobox();
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
      syncGradeComboboxFromSelect();
      updateSelectedGradeHint("Built-in: 3rd grade (default)");
    })
    .catch(() => {
      // Fail silently; user can still upload a CSV manually.
    });
})();

