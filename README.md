# Typerfill

Free, in-browser autocomplete for any text field on the web. As you type, Typerfill predicts your next word and completes the word you're mid-typing — all powered by a language model that runs locally on your device via WebGPU. Nothing you type is ever sent to a server.

## Features

- **Works everywhere** — any `<input>`, `<textarea>`, or `contenteditable` field on any website (not google docs. if you how to fix this create a pull request)
- **100% local** — inference runs in-browser on WebGPU; no network calls, no accounts, no tracking
- **Free** — no sign-up, no subscription, no usage limits
- **Tab to accept** — ghost text appears as you type; press Tab to accept it, or keep typing to ignore it

## Install

1. Download the repo as a zip (see the download button on the project page, or `Code → Download ZIP` on GitHub).
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.
6. Start typing in any text field on the web.

## How it works

Typerfill splits autocomplete into two different problems, handled two different ways:

- **Next word** (after you finish a word and hit space) — sent to a small local LLM ([WebLLM](https://github.com/mlc-ai/web-llm)), which runs entirely on-device via WebGPU and raw-continues the text you've typed so far.
- **Mid-word completion** (while you're still typing a word) — first checked instantly against a ~97k-word frequency-ranked dictionary, then refined by asking the same local model to predict the word from context; the model's guess is only used if it actually forms a real dictionary word, so you never see hallucinated spelling.

The model itself loads once into a persistent `chrome.offscreen` document and stays warm across tabs/navigations, so there's no reload lag after the first load.

### Project layout

```
manifest.json         Extension manifest (Manifest V3)
background.js         Service worker — relays completion requests, manages the offscreen document
content.js             Injected into every page — detects focus/typing, shows ghost text, handles Tab/Escape
content.css            Ghost text styling
offscreen.html          Hosts the persistent WebLLM engine
src/offscreen.js       Source for the offscreen script (bundled — see below)
dist/offscreen.bundle.js  Built output actually loaded by offscreen.html
popup.html / popup.js  Toolbar popup — on/off toggle and model picker
assets/wordlist.txt    Frequency-ranked English word list used for mid-word completion
icons/                 Extension icons
index.html             This project's landing/download page
```

## Development

`src/offscreen.js` imports the `@mlc-ai/web-llm` npm package, which needs to be bundled into a plain script since Manifest V3 extension pages can't resolve bare ES module imports at runtime.

```bash
npm install
npx esbuild src/offscreen.js --bundle --outfile=dist/offscreen.bundle.js --format=iife --platform=browser
```

Re-run the esbuild command after any change to `src/offscreen.js`, then reload the extension in `chrome://extensions`.

Changes to `content.js`, `background.js`, `manifest.json`, `popup.*`, or `assets/wordlist.txt` don't require a rebuild — just reload the extension.

## License

ISC
