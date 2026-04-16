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

If **`words/words.csv`** is present, it is loaded automatically on startup. You can still upload a different CSV from the UI.

The bundled list uses columns: **`Word`**, **`Sentense`** (example sentence), **`Pronounce`**, **`Definition`** (short meaning used in audio mode).

## CSV format (uploads)

The parser expects a header row and comma-separated values (simple CSV—quote fields that contain commas).

- **`word`** (or **`term`**): the spelling answer.
- **`sentense`** / **`sentence`** / **`meaning`**: full sentence for **Sentence** mode (the answer is masked on screen; the speaker reads the full sentence).
- **`definition`**: short meaning; in **Spoken word** mode it appears after **Show hint**.
- **`pronounce`**: optional (reference / your own notes; speech uses the browser’s text-to-speech on the word).

Example compatible with uploads:

```csv
word,sentense,pronounce,definition
Apple,"I ate a red apple for lunch.",AP-uhl,"A round fruit with firm flesh"
```

## Game modes

1. **Definition → Spell** — Read the sentence (answer hidden), optionally hear it with the speaker, type the word.
2. **Spoken word → Spell** — Hear the word (with optional hint), type the spelling.

Each new game shuffles the full list once; you play through every word in order until the end.

## Keyboard

- **Enter** — Submit answer; after a correct answer, **Enter** again advances (guarded so held Enter does not skip words).
- **Right Arrow** — Next word after you have submitted an answer for the current word (disabled while focus is in the answer field so you can move the caret).

## Project layout

| Path | Role |
|------|------|
| `index.html` | Page structure |
| `styles.css` | Layout and theme |
| `app.js` | CSV load, game flow, speech |
| `words/words.csv` | Default word list |
| `assets/bee-icon.png` | Header logo |

## License

See `LICENSE` in the repository.
