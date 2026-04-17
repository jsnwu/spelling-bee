# Spelling Bee Studio

A small browser-based spelling bee. Load a word list (CSV), pick a mode, and practice spelling. Everything runs locally in the page—no server-side game logic.

## Quick start

From the project root, serve the files over HTTP (needed for `fetch` of the default word list):

```bash
python -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

You can also run:

```bash
bash scripts/start.sh
```

(which starts the same server on port 8000).

## Default word list

If **`words/3rd-grade-words.csv`** is present, it is loaded automatically on startup. You can still upload a different CSV from the UI or pick another grade from the dropdown.

The bundled list uses columns: **`Word`**, **`Sentense`** (example sentence), **`Pronounce`**, **`Definition`** (short meaning used in audio mode).

## CSV format (uploads)

The parser expects a header row and comma-separated values (simple CSV—quote fields that contain commas).

- **`word`** (or **`term`**): the spelling answer.
- **`sentense`** / **`sentence`** / **`meaning`**: full sentence for **Word in Sentence** mode (the answer is masked on screen; the speaker reads the full sentence).
- **`definition`**: short meaning; in **Spoken word** mode it appears after **Show hint**.
- **`pronounce`**: optional (reference / your own notes; speech uses the browser’s text-to-speech on the word).

Example compatible with uploads:

```csv
word,sentense,pronounce,definition
Apple,"I ate a red apple for lunch.",AP-uhl,"A round fruit with firm flesh"
```

## Gameplay flow

1. **Load words** — Built-in grade lists or your CSV. When a list loads successfully, the **Spelling Round** card opens so you can see mode and score, but the actual prompt (sentence + speaker, or audio row) stays hidden until you start.
2. **Choose mode** — Default is **Word in Sentence → Spell**. You can switch before or between rounds; the card updates when the round is not active.
3. **Start Spelling Bee** — Shuffles the list, resets score, reveals the prompt, and enables automatic text-to-speech for new words (after a short delay). Manual **Speak** / **Show hint** still work anytime after start.
4. **Stop** — Ends the active round (cancels pending speech), then opens a **session summary** dialog with:
   - **Time** — Elapsed since you clicked Start (no live clock in the header).
   - **Correct / answered** — Graded submits in this session.
   - **Accuracy** — Percent correct over those attempts.
   - **Misspellings** — Each wrong submit (target word and what you typed). Finishing the last word in the list opens the same summary automatically.

After you close the summary (or from the pre-start state), click **Start** again for a fresh shuffled round.

## Game modes

1. **Word in Sentence → Spell** — Read the sentence (answer masked), optionally hear it with the speaker, type the word.
2. **Spoken word → Spell** — Hear the word (with optional hint), type the spelling.

Each new game shuffles the full list once; you play through every word in order until the end.

## Keyboard

- **Enter** — Submit answer; after a correct answer, **Enter** again advances (guarded so held Enter does not skip words).
- **Right Arrow** — Next word after you have submitted an answer for the current word (disabled while focus is in the answer field so you can move the caret).

## Project layout

| Path | Role |
|------|------|
| `index.html` | Page structure (including session summary `<dialog>`) |
| `styles.css` | Layout and theme |
| `app.js` | CSV load, game flow, speech, session stats |
| `words/3rd-grade-words.csv` | Default word list |
| `assets/bee-icon.png` | Header logo |

## License

See `LICENSE` in the repository.
