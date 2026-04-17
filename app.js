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
  /** Concise definition for audio mode; shown only after "Show hint" */
  audioHintDefinition: "",
  /** Auto TTS (and speak-after-next-word) only after "Start Spelling Bee" */
  roundStarted: false,
  gameSessionStartMs: null,
  /** Wrong graded submits: { word, typed } */
  misspellings: [],
};

const SUBMIT_BUTTON_LABEL = "Submit";
const SUBMIT_BUTTON_NEXT_LABEL = ">>";

/** Default TTS speed (auto-speak after each prompt) */
const SPEECH_RATE_DEFAULT = 0.9;
/** Slower playback when the user taps the speaker button */
const SPEECH_RATE_SPEAKER_BUTTON = 0.5;

const dom = {
  fileInput: document.getElementById("csv-input"),
  fileName: document.getElementById("file-name"),
  loadStatus: document.getElementById("load-status"),
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
  downloadCsv: document.getElementById("download-csv"),
  showHint: document.getElementById("show-hint"),
  showAnswer: document.getElementById("show-answer"),
  nextWord: document.getElementById("next-word"),
  feedback: document.getElementById("feedback"),
  scoreText: document.getElementById("score-text"),
  stopGame: document.getElementById("stop-game"),
  sessionSummaryDialog: document.getElementById("session-summary-dialog"),
  sessionSummaryBody: document.getElementById("session-summary-body"),
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
  } else {
    btn.textContent = SUBMIT_BUTTON_LABEL;
    btn.setAttribute("aria-label", "Submit spelling");
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

function syncGameChrome() {
  if (dom.stopGame) dom.stopGame.disabled = !state.roundStarted;
}

function clearSessionTracking() {
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
  const ratioLine = `<p class="session-summary-line"><span class="session-summary-label">Correct</span><span class="session-summary-value">${correct} / ${attempts} <span class="session-summary-unit">answered</span></span></p>`;
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
  dom.sessionSummaryBody.innerHTML = `${timeLine}${ratioLine}${pctLine}${missBlock}`;
}

function openSessionSummaryDialog(elapsedMs) {
  fillSessionSummaryBody(elapsedMs);
  if (dom.sessionSummaryDialog && typeof dom.sessionSummaryDialog.showModal === "function") {
    dom.sessionSummaryDialog.showModal();
  }
}

function handleStopGame() {
  if (!state.roundStarted) return;
  const elapsedMs = state.gameSessionStartMs ? Date.now() - state.gameSessionStartMs : 0;
  if (state.autoSpeakTimeoutId !== null) {
    clearTimeout(state.autoSpeakTimeoutId);
    state.autoSpeakTimeoutId = null;
  }
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
    dom.loadStatus.textContent = "No rows with a 'word' column were found.";
    state.words = [];
    updateWordCount();
    hideGameSection();
    return false;
  }

  shuffleInPlace(filtered);
  state.words = filtered;
  if (sourceLabel) dom.fileName.textContent = sourceLabel;
  dom.loadStatus.textContent = `Loaded ${filtered.length} words.`;
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
    if (dom.showAnswer) dom.showAnswer.disabled = true;
    syncGameChrome();
    return;
  }

  if (!state.roundStarted) {
    state.hasSubmittedThisWord = false;
    state.answerLocked = false;
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
    if (dom.showAnswer) dom.showAnswer.disabled = true;
    syncGameChrome();
    return;
  }

  // New prompt, reset enter/next state
  state.hasSubmittedThisWord = false;
  state.answerLocked = false;

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
  if (dom.showAnswer) dom.showAnswer.disabled = false;
  dom.answerInput.focus();
  syncGameChrome();
}

function updateScore(correct) {
  if (correct) state.score += 1;
  state.attempts += 1;
  dom.scoreText.textContent = `Score: ${state.score} / ${state.attempts}`;
}

function handleSubmitAnswer() {
  const entry = currentWord();
  if (!entry) return;
  if (!state.roundStarted) return;
  if (state.answerLocked) return;

  const userAnswer = dom.answerInput.value.trim().toLowerCase();
  const correctWord = String(entry.word || entry.term || "").trim();
  const correctLower = correctWord.toLowerCase();

  if (!userAnswer) return;

  state.hasSubmittedThisWord = true;
  if (dom.nextWord) dom.nextWord.disabled = false;

  const isCorrect = userAnswer === correctLower;
  updateScore(isCorrect);

  if (isCorrect) {
    state.answerLocked = true;
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = false;
    updateSubmitButtonAppearance();
    dom.feedback.innerHTML = `Correct! <span class="feedback-highlight-word">${escapeHtml(correctWord)}</span>`;
    dom.feedback.className = "feedback-text feedback-correct";
    playCorrectDing();
  } else {
    state.misspellings.push({
      word: correctWord,
      typed: dom.answerInput.value.trim(),
    });
    dom.submitAnswer.disabled = false;
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
  if (!state.hasSubmittedThisWord) return;
  if (state.currentIndex < state.words.length - 1) {
    state.currentIndex += 1;
    renderPrompt();
    if (state.roundStarted) scheduleAutoSpeak(1000);
  } else {
    const elapsedMs = state.gameSessionStartMs ? Date.now() - state.gameSessionStartMs : 0;
    if (state.autoSpeakTimeoutId !== null) {
      clearTimeout(state.autoSpeakTimeoutId);
      state.autoSpeakTimeoutId = null;
    }
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
    if (dom.showAnswer) dom.showAnswer.disabled = true;
    openSessionSummaryDialog(elapsedMs);
    syncGameChrome();
  }
}

// Event wiring
dom.fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) {
    dom.fileName.textContent = "No file selected";
    dom.loadStatus.textContent = "";
    state.words = [];
    updateWordCount();
    hideGameSection();
    return;
  }

  dom.fileName.textContent = file.name;
  dom.loadStatus.textContent = "Loading words…";

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const text = String(event.target?.result || "");
      loadWordsFromCsvText(text, file.name);
      dom.loadStatus.textContent = `Loaded ${state.words.length} words successfully.`;
      updateSelectedGradeHint(`Custom: ${file.name}`);
    } catch (err) {
      console.error(err);
      dom.loadStatus.textContent = "Failed to parse CSV. Please check the format.";
      state.words = [];
      updateWordCount();
      hideGameSection();
    }
  };
  reader.onerror = () => {
    dom.loadStatus.textContent = "Error reading file.";
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
  dom.loadStatus.textContent = "Loading grade list…";
  fetch(path)
    .then((res) => {
      if (!res.ok) throw new Error("Grade CSV not found");
      return res.text();
    })
    .then((text) => {
      const ok = loadWordsFromCsvText(text, `${path} (built-in)`);
      if (ok) {
        dom.loadStatus.textContent = `Loaded ${state.words.length} words from ${path}.`;
        const selectedLabel =
          dom.gradeSelect.options[dom.gradeSelect.selectedIndex]?.textContent || dom.gradeSelect.value;
        updateSelectedGradeHint(`Built-in: ${selectedLabel}`);
      }
    })
    .catch(() => {
      dom.loadStatus.textContent = `Could not load ${path}.`;
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
  if (dom.configDetails) dom.configDetails.open = false;
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

dom.answerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (state.answerLocked) {
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
    goToNextWord();
  }
  // Right arrow: go to next word (when game section is visible)
  if (e.key === "ArrowRight") {
    // Let Right Arrow move the caret while editing the answer field
    if (dom.answerInput && document.activeElement === dom.answerInput) return;
    if (!dom.gameSection.classList.contains("hidden") && !dom.nextWord.disabled) {
      e.preventDefault();
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
      dom.loadStatus.textContent = `Loaded ${state.words.length} words from default list.`;
      if (dom.gradeSelect) dom.gradeSelect.value = "3rd";
      updateSelectedGradeHint("Built-in: 3rd grade (default)");
    })
    .catch(() => {
      // Fail silently; user can still upload a CSV manually.
    });
})();

