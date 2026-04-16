// Simple CSV parser for basic comma-separated values without complex quoting.
function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
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
};

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
  showHint: document.getElementById("show-hint"),
  showAnswer: document.getElementById("show-answer"),
  nextWord: document.getElementById("next-word"),
  feedback: document.getElementById("feedback"),
  scoreText: document.getElementById("score-text"),
};

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
    const lead = document.getElementById("audio-prompt-lead");
    if (!lead) return;
    lead.textContent = def;
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

function speakWord(word) {
  speakText(word);
}

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    alert("Text-to-speech is not supported in this browser.");
    return;
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return;
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.rate = 0.9;
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
    dom.nextWord.disabled = true;
    resetShowHintButton();
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
    dom.gameModeLabel.textContent = "Mode: Definition ➜ Spell the word";

    // Remove surrounding quotes for both on-screen and spoken text
    let baseDefinition = definition.replace(/^"(.*)"$/, "$1");

    // Store the full sentence (with the word) for speech
    state.definitionForSpeech = baseDefinition || "";

    // Mask the word only in the on-screen version
    let displayDefinition = baseDefinition;
    if (word && displayDefinition) {
      const escapedWord = word.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      const wordRegex = new RegExp(escapedWord, "gi");
      displayDefinition = displayDefinition.replace(wordRegex, "_____");
    }

    dom.promptArea.innerHTML = `
      <div class="prompt-label">Sentence</div>
      <div class="prompt-main-row">
        <div class="prompt-content">${displayDefinition || "No definition provided."}</div>
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
        speakText(state.definitionForSpeech);
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
        if (w) speakWord(w);
      });
    }
  }

  dom.answerInput.value = "";
  dom.answerInput.disabled = false;
  dom.submitAnswer.disabled = false;
  dom.nextWord.disabled = !state.hasSubmittedThisWord;
  dom.feedback.textContent = "";
  dom.feedback.className = "feedback-text";
  dom.answerInput.focus();
}

function updateScore(correct) {
  if (correct) state.score += 1;
  state.attempts += 1;
  dom.scoreText.textContent = `Score: ${state.score} / ${state.attempts}`;
}

function handleSubmitAnswer() {
  const entry = currentWord();
  if (!entry) return;
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
    dom.submitAnswer.disabled = true;
    dom.answerInput.disabled = true;
    dom.feedback.textContent = `Correct! ${correctWord}`;
    dom.feedback.className = "feedback-text feedback-correct";
    playCorrectDing();
  } else {
    dom.submitAnswer.disabled = false;
    dom.answerInput.disabled = false;
    dom.feedback.textContent = `Not quite. You typed "${userAnswer}", the correct spelling is "${correctWord}". Try again, or use Next to skip.`;
    dom.feedback.className = "feedback-text feedback-incorrect";
    dom.answerInput.focus();
  }
}

function showCorrectAnswer() {
  const entry = currentWord();
  if (!entry) return;
  const correctWord = String(entry.word || entry.term || "").trim();
  dom.feedback.textContent = `Answer: ${correctWord}`;
  dom.feedback.className = "feedback-text feedback-answer";
}

function goToNextWord() {
  if (!state.hasSubmittedThisWord) return;
  if (state.currentIndex < state.words.length - 1) {
    state.currentIndex += 1;
    renderPrompt();
    scheduleAutoSpeak(1000);
  } else {
    dom.promptArea.innerHTML =
      '<div class="prompt-content">You have reached the end of your list. 🎉</div>';
    dom.answerInput.disabled = true;
    dom.submitAnswer.disabled = true;
    dom.nextWord.disabled = true;
    resetShowHintButton();
    if (state.autoSpeakTimeoutId !== null) {
      clearTimeout(state.autoSpeakTimeoutId);
      state.autoSpeakTimeoutId = null;
    }
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
    return;
  }

  dom.fileName.textContent = file.name;
  dom.loadStatus.textContent = "Loading words…";

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const text = String(event.target?.result || "");
      const rows = parseCsv(text);
      const filtered = rows.filter((row) => (row.word || row.term || "").trim().length > 0);

      if (filtered.length === 0) {
        dom.loadStatus.textContent = "No rows with a 'word' column were found.";
        state.words = [];
      } else {
        shuffleInPlace(filtered);
        state.words = filtered;
        dom.loadStatus.textContent = `Loaded ${filtered.length} words successfully.`;
      }
      updateWordCount();
    } catch (err) {
      console.error(err);
      dom.loadStatus.textContent = "Failed to parse CSV. Please check the format.";
      state.words = [];
      updateWordCount();
    }
  };
  reader.onerror = () => {
    dom.loadStatus.textContent = "Error reading file.";
    state.words = [];
    updateWordCount();
  };

  reader.readAsText(file);
});

dom.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-mode");
    if (!mode) return;
    state.mode = mode;
    dom.modeButtons.forEach((b) => b.classList.toggle("selected", b === button));
  });
});

dom.startGame.addEventListener("click", () => {
  if (state.words.length === 0) return;
  // Shuffle words at the start of every new game so order is fresh
  shuffleInPlace(state.words);
  state.currentIndex = 0;
  state.score = 0;
  state.attempts = 0;
  dom.scoreText.textContent = "Score: 0 / 0";
  dom.gameSection.classList.remove("hidden");
  renderPrompt();
   // Auto-speak after 1 second for the first word
  scheduleAutoSpeak(1000);
});

dom.submitAnswer.addEventListener("click", () => {
  handleSubmitAnswer();
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

// Load default CSV from words/words.csv if available
(function loadDefaultCsv() {
  if (!window.fetch) return;

  fetch("words/words.csv")
    .then((res) => {
      if (!res.ok) throw new Error("Default CSV not found");
      return res.text();
    })
    .then((text) => {
      const rows = parseCsv(text);
      const filtered = rows.filter((row) => (row.word || row.term || "").trim().length > 0);
      if (filtered.length === 0) return;

      shuffleInPlace(filtered);
      state.words = filtered;
      dom.fileName.textContent = "words/words.csv (default)";
      dom.loadStatus.textContent = `Loaded ${filtered.length} words from default list.`;
      updateWordCount();
    })
    .catch(() => {
      // Fail silently; user can still upload a CSV manually.
    });
})();

