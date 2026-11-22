# Quiz Solver (Chrome extension, Manifest V3)

Press a shortcut and the extension finds the quiz questions on the page, works out the answers from your
knowledge base (offline algorithm) or from an LLM, and selects them. Every change is kept in a per-page history,
so you can undo, redo, or re-apply the solved answers after editing them by hand.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder (the one with `manifest.json`).
3. Pin the extension. Open the popup, create a context, and (for LLM mode) paste an API key.

## Shortcuts

### Manual mode (default shortcuts)

You select text on the page and press shortcuts. Nothing on the page gets clicked; the answer appears in a
notification and in the popup.

| Action | Default |
|---|---|
| The selected text is the **question** (starts a new question) | `Alt+Shift+Q` |
| Add the selected text as an **answer** (repeat for each answer) | `Alt+Shift+O` |
| **Solve as single choice** | `Alt+Shift+S` |
| **Solve as multiple choice** | `Alt+Shift+M` |

- If you select the question and its answers in one go (lines starting with `a)`, `B.`, `1)`, `-`…), the
  `Alt+Shift+Q` shortcut splits them automatically.
- If an answer selection spans several lines, each line becomes its own answer.
- In the popup, the **Manual question** card shows the saved question and answers. You can remove an answer
  there, or use the Solve single / Solve multi buttons.

### Answers box

After every solve, a small **Answers** box appears in the bottom-right corner. It lists each question's
letters and option text, e.g. `1. A,C  Red · Blue`.

- Questions the extension couldn't select on the page are marked **⚠ not selected**. Questions where the
  model's reply couldn't be read are marked **⚠ unparsed**.
- Manual-mode answers are added as `M1`, `M2`, ….
- **Alt+Shift+H** toggles the box on any page, including when the focus is inside an iframe. If the box
  isn't on the page yet, toggling it on shows the last answers.
- With *On-page notifications* off (or *Pop up the answers box* off), the box is filled in after every solve
  but stays hidden until you press Alt+Shift+H. Manual-mode notifications are hidden too; errors still show.
- **Opacity** slider in Options fades the box; it goes back to full opacity while you hover it.
- Click the header to collapse the box; ✕ closes it.
- To bring the box back after a page reload: popup → *Last run* → **Show answers on page**.

### Automatic mode

Detect the questions on the page and select the answers, plus undo, redo and re-apply.

| Action | Key on the page |
|---|---|
| **Solve page** | `Alt+Shift+P` or 4 fast clicks anywhere on the page |
| **Undo** | `Alt+Shift+U` |
| **Redo** | `Alt+Shift+Y` |
| **Re-apply** solved answers | `Alt+Shift+L` |
| Show / hide answers box | `Alt+Shift+H` |

These keys are handled inside the page (Chrome allows only four default extension shortcuts), so they work
on any page loaded after the extension was installed and only while the quiz solver is enabled. Tabs that were
already open need a reload. You can also add Chrome-wide keys at `chrome://extensions/shortcuts`.

## Popup

- **Algorithm / LLM** toggle.
- **Contexts**: expandable knowledge bases, each with a name and a long text. The radio button picks the
  active one. You can import `.txt`/`.md` files, and "No context" means the LLM uses general knowledge only.
- **LLM settings**: provider preset, API key (stored only in `chrome.storage.local`, never synced), model,
  base URL, web search, reasoning effort, max tokens, temperature, extra instructions, and *Test connection*.
- **Options**: viewport-only mode, on-page notifications, and a brief outline on the selected answers.
- **History**: timeline for the current page. You can restore any entry, undo, redo, re-apply, or clear it.
- **Last run**: each question with the options and answers chosen, plus the raw LLM output (useful for debugging).
- **Show detection**: outlines every detected question on the page for 8 s, so you can check what was found.

## How detection works (`src/content.js`)

- Handles native `radio`/`checkbox`, ARIA `role=radio|checkbox|option` (Google Forms, Microsoft Forms,
  React/Angular widgets), `<select>` dropdowns (Moodle "matching"), hidden-input + styled-label designs,
  Likert tables (column headers become the options), open shadow DOM, and iframes (injected into all frames).
- Grouping uses the radio `name`, then `radiogroup`/`listbox`, then the nearest shared ancestor. Flat layouts
  (`<p>Q1</p> options <p>Q2</p> options`) are split at the text between groups.
- Question text: known selectors first (`.qtext`, `[role=heading]`, `legend`, …). Otherwise it takes the
  visible text that comes before the options inside the question block. It also strips noise such as
  "Not yet answered", "Flag question", "Clear my choice" and the Slovene Moodle strings.
- Skips nav/header/footer, hidden question pages, disabled and `aria-hidden` controls, and settings dropdowns.
- Selecting: it tries a native `click()`, then a label click, then the native setter with `input`/`change`
  events (React-safe). ARIA widgets get a full pointer/mouse event sequence, then a keyboard fallback. Each
  step is verified before moving on.
- **Real (trusted) clicks**: some sites ignore clicks made by scripts (`event.isTrusted === false`). Under
  *Options → Click method*:
  - **Auto** (default): scripted clicks first; any answer that didn't register gets a real click.
  - **Always real**: real clicks for everything clickable.
  - **JS only**: never uses real clicks.

  Real clicks use Chrome's `chrome.debugger` API (`Input.dispatchMouseEvent`, the same mechanism Puppeteer
  and Playwright use), so the page receives genuine mouse events. For each click the extension:
  1. Scrolls the option into view.
  2. Works out its position in the top-level page, including inside cross-origin iframes (each frame asks
     its parent where it sits).
  3. Checks that nothing else covers that point, so it never clicks the wrong element.
  4. Clicks, then confirms the answer registered. If not, it tries the next target (input → label → option
     text), and presses Space on the focused control as a last resort.

  This needs the optional `debugger` permission, which you grant once from the popup. While it's clicking,
  Chrome shows its "started debugging this browser" bar; the extension detaches as soon as it's done.
  *Last run* shows a per-click log.
- History entries refer to questions by fingerprint (radio name → question+options hash → options hash
  + text similarity), not by DOM node. That's why restore still works after a reload or re-render.

## LLM mode (`src/lib/llm.js`, `src/lib/prompt.js`)

- **One request per solve.** The knowledge base goes into a stable system prompt that doesn't change between
  solves, so the provider can cache it: Anthropic uses `cache_control`, while OpenAI and Gemini cache
  automatically. Re-sending the same context costs only a fraction of the normal input price.
- Questions are numbered and options lettered `A, B, C…`, and the model answers `1: B` / `2: A, C`.
- The parser handles markdown, `<think>` blocks, `1) b`, `Question 2 - A and D`, glued `AC`, inline
  `1:B 2:C`, a bare `C`, and answers given as option text. If the model answers a question twice, the last
  answer counts.
- Four wire formats cover almost every provider: OpenAI-compatible Chat Completions, OpenAI Responses,
  Anthropic Messages and Google Gemini. Presets are included for Gemini, Claude, OpenAI, OpenRouter,
  Perplexity, DeepSeek, Groq, Mistral and Ollama, plus *Custom endpoint*.
- If a model rejects a parameter (temperature, reasoning effort, `max_tokens` naming, the search tool), the
  extension drops it and retries automatically, and shows a warning under *Last run*.
- Web search is a tool the model calls **only when the knowledge base doesn't have the answer**.

### Which LLM? (low cost, web search, fast)

**Recommended: Google Gemini `gemini-3.1-flash-lite` with Grounding with Google Search** (the default preset).
- Around $0.25 / $1.50 per million input/output tokens. A typical solve (10 questions, plus a cached
  knowledge base) costs a fraction of a cent.
- Search runs only when the model decides it needs it. The first 5,000 grounded prompts per month are free,
  then $14 per 1,000 search queries. There's also a free tier in AI Studio.
- One of the fastest models available. Keep reasoning effort at `low` or `minimal` for speed.

**Alternative: Claude Haiku 5.5** (`claude-haiku-5-5`) at $0.10 / $0.50 per million tokens, which is even
cheaper per token. Web search costs $10 per 1,000 searches and has to be enabled for your organisation in the
Anthropic Console. Use reasoning effort `low` to keep it fast.

Others: OpenAI `gpt-5.4-mini` with `web_search` ($10 per 1,000 calls), or Perplexity `sonar` (always searches,
so it's slower and costs more per question). Prices change, so check the provider's pricing page.

## Algorithm mode (`src/lib/algorithm.js`)

This mode works offline and makes no API calls. It splits the knowledge base into sentences and indexes them
with BM25 (Unicode-aware, with a light English and Slovene stemmer). An option scores high when a sentence
relevant to the question contains that option's distinctive terms. It also handles true/false statements,
"which is NOT" questions (including options the knowledge base explicitly negates), "all/none of the above",
and multi-select thresholds. It's fast and free, but less accurate than an LLM on reasoning questions.

## Development

```bash
npm install                      # playwright-core (only for the e2e test)
npm test                         # unit tests: parser, prompt, algorithm
npm run test:e2e -- "C:\path\to\chrome.exe"   # loads the extension in Chromium and runs the fixtures
```

`test/fixtures/` has a Moodle-like page, a Google-Forms-like ARIA page, and a page with flat layouts,
tables, shadow DOM and hidden questions.

## Limitations

- Supports multiple-choice questions only (radio, checkbox, dropdown, listbox). Text inputs, drag-and-drop
  and image-hotspot questions aren't filled in.
- Custom dropdowns that only render their options after they're opened aren't detected. Native `<select>`
  elements behind Select2, Chosen or Choices.js are supported.
- Closed shadow roots and cross-origin canvases can't be read.
- Without the `debugger` permission, answers on sites that only accept real clicks show up as "could not be
  clicked". Native `<select>` dropdowns are always set by script, since real clicks would open the browser's
  own dropdown menu. ARIA radio groups can't be cleared on undo, because there's nothing to click that
  deselects them.
- Only use it where it's allowed. Many exams and proctoring systems ban tools like this.
