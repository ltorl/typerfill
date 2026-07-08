(() => {
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", ""]);

  // Real English words ordered by frequency (~97k words, Google Books frequency list).
  // Used to complete a word that's still being typed (e.g. "he" -> "hello"). A tiny
  // local LLM asked to raw-continue a 1-2 letter prefix has almost no signal to work
  // with and tends to hallucinate non-English gibberish, so partial-word completion
  // is done with a plain dictionary lookup instead of a model call: deterministic,
  // instant, and always a real word.
  //
  // Loaded async and indexed by 1- and 2-letter prefix so lookups stay O(bucket
  // size) instead of scanning all ~97k words on every keystroke. Each bucket keeps
  // the words in their original frequency order, so the first match is the most
  // likely. A separate 1-letter index is needed alongside the 2-letter one because
  // a 2-letter-prefix bucket has no entries for single-letter prefixes like "h".
  const wordIndex1 = new Map();
  const wordIndex2 = new Map();
  const wordSet = new Set();
  let wordlistReady = false;

  function addToBucket(map, key, word) {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(word);
  }

  fetch(chrome.runtime.getURL("assets/wordlist.txt"))
    .then((r) => r.text())
    .then((text) => {
      for (const word of text.split("\n")) {
        if (!word) continue;
        addToBucket(wordIndex1, word.slice(0, 1), word);
        if (word.length >= 2) addToBucket(wordIndex2, word.slice(0, 2), word);
        wordSet.add(word);
      }
      wordlistReady = true;
    })
    .catch(() => {});

  function bestWordCompletion(prefix) {
    if (!wordlistReady) return "";
    const lower = prefix.toLowerCase();
    if (!lower) return "";
    const map = lower.length >= 2 ? wordIndex2 : wordIndex1;
    const bucket = map.get(lower.slice(0, Math.min(2, lower.length)));
    if (!bucket) return "";
    for (const w of bucket) {
      if (w.length > lower.length && w.startsWith(lower)) {
        return w.slice(lower.length);
      }
    }
    return "";
  }

  // AI's raw continuation of the word being typed, validated against the real-word
  // dictionary before use. The dictionary alone always returns a real word but has
  // no idea which one actually fits the sentence (e.g. "th" -> whatever the most
  // frequent "th" word overall is, regardless of context); the model has context but
  // (for a tiny local model) can't be trusted to spell a real word unsupervised. So
  // the model proposes a continuation of the exact prefix already typed, and it's
  // only accepted if prefix+continuation is an actual dictionary word — otherwise we
  // keep whatever the dictionary already suggested.
  function aiWordCompletion(context, prefix, onResult) {
    chrome.runtime.sendMessage({ type: "REQUEST_COMPLETE", context }, (response) => {
      if (!response || !response.ok) return;
      const raw = response.text || "";
      const m = raw.match(/^[A-Za-z']+/);
      if (!m) return;
      const candidate = (prefix + m[0]).toLowerCase();
      if (!wordSet.has(candidate)) return;
      onResult(m[0]);
    });
  }

  let currentEl = null;
  let debounceTimer = null;
  let generation = 0;
  let suggestion = null;
  let ghost = null;
  let mirror = null;

  const EDITABLE_SELECTOR = '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

  function editableRoot(el) {
    if (!el || el.nodeType !== 1) return null;
    return el.closest(EDITABLE_SELECTOR);
  }

  function isEligible(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
    return !!editableRoot(el);
  }

  // ---- ghost overlay ----

  function ghostEl() {
    if (!ghost) {
      ghost = document.createElement("div");
      ghost.id = "__typerfill_ghost";
      ghost.style.display = "none";
      document.documentElement.appendChild(ghost);
    }
    return ghost;
  }

  function hideGhost() {
    if (ghost) ghost.style.display = "none";
  }

  function showGhost(text, rect) {
    const g = ghostEl();
    g.textContent = text;
    g.style.font = rect.font;
    g.style.left = `${rect.left}px`;
    g.style.top = `${rect.top}px`;
    g.style.lineHeight = `${rect.height}px`;
    g.style.display = "block";
  }

  function clearSuggestion() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    suggestion = null;
    hideGhost();
  }

  // ---- context before cursor ----

  function contextBefore(el) {
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const active = sel.getRangeAt(0);
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(active.endContainer, active.endOffset);
      return range.toString().slice(-300);
    }
    const pos = el.selectionStart ?? el.value.length;
    return el.value.slice(Math.max(0, pos - 300), pos);
  }

  // ---- caret pixel position ----

  const MIRROR_PROPS = [
    "boxSizing", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontSize", "fontFamily",
    "lineHeight", "letterSpacing", "textTransform", "wordSpacing", "textIndent", "tabSize",
  ];

  function getMirror() {
    if (!mirror) {
      mirror = document.createElement("div");
      mirror.style.visibility = "hidden";
      mirror.style.position = "fixed";
      mirror.style.overflow = "hidden";
      document.documentElement.appendChild(mirror);
    }
    return mirror;
  }

  function inputCaretRect(el) {
    const div = getMirror();
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    div.style.top = `${rect.top}px`;
    div.style.left = `${rect.left}px`;
    div.style.width = `${rect.width}px`;
    div.style.whiteSpace = el.tagName === "TEXTAREA" ? "pre-wrap" : "pre";
    div.style.wordBreak = "break-word";
    for (const prop of MIRROR_PROPS) div.style[prop] = style[prop];

    const caretIndex = el.selectionStart ?? el.value.length;
    div.textContent = "";
    div.appendChild(document.createTextNode(el.value.substring(0, caretIndex)));
    const span = document.createElement("span");
    span.textContent = el.value.substring(caretIndex) || "​";
    div.appendChild(span);
    div.scrollTop = el.scrollTop;
    div.scrollLeft = el.scrollLeft;

    const spanRect = span.getBoundingClientRect();
    return { left: spanRect.left, top: spanRect.top, height: spanRect.height || rect.height, font: style.font };
  }

  function editableCaretRect(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) return null;
    const style = window.getComputedStyle(el);
    return { left: rect.left, top: rect.top, height: rect.height || parseFloat(style.lineHeight) || 16, font: style.font };
  }

  function caretRectFor(el) {
    return el.isContentEditable ? editableCaretRect(el) : inputCaretRect(el);
  }

  // ---- sanitize model output down to a single word/fragment ----

  function sanitize(text) {
    let s = text.trim().replace(/^["'`]+|["'`]+$/g, "");
    const nl = s.indexOf("\n");
    if (nl !== -1) s = s.slice(0, nl);
    const m = s.match(/\s/);
    if (m) s = s.slice(0, m.index);
    return s.trim();
  }

  // ---- request a completion ----

  function scheduleCompletion(el) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchCompletion(el), 300);
  }

  function showSuggestionIfStillFocused(el, cleaned) {
    if (!cleaned) return;
    const stillFocused = el === document.activeElement || (el.isContentEditable && el.contains(document.activeElement));
    if (!stillFocused) return;
    const rect = caretRectFor(el);
    if (!rect) return;
    suggestion = cleaned;
    showGhost(cleaned, rect);
  }

  function fetchCompletion(el) {
    if (!isEligible(el) || el.type === "password") return;
    const context = contextBefore(el);
    if (!context) return;

    const afterSpace = /\s$/.test(context);
    const match = context.match(/([A-Za-z']+)$/);
    const partialWord = !afterSpace && match ? match[1] : "";

    // Mid-word: show the dictionary's best guess immediately (instant, always a real
    // word), then ask the model to predict the word from context and upgrade to its
    // answer if that's also a real word — this is what actually makes the suggestion
    // relevant to the sentence instead of just "the most common word starting with
    // these letters".
    if (partialWord) {
      const myGeneration = ++generation;
      const completion = bestWordCompletion(partialWord);
      showSuggestionIfStillFocused(el, completion);
      aiWordCompletion(context, partialWord, (aiCompletion) => {
        if (myGeneration !== generation) return;
        showSuggestionIfStillFocused(el, aiCompletion);
      });
      return;
    }

    if (!afterSpace) return;

    const myGeneration = ++generation;
    chrome.runtime.sendMessage({ type: "REQUEST_COMPLETE", context }, (response) => {
      if (myGeneration !== generation) return;
      if (!response || !response.ok) return;
      const cleaned = sanitize(response.text || "");
      showSuggestionIfStillFocused(el, cleaned);
    });
  }

  // ---- insert suggestion at cursor ----

  function insertSuggestion(el, text) {
    if (el.isContentEditable) {
      document.execCommand("insertText", false, text);
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const newValue = el.value.slice(0, start) + text + el.value.slice(end);
    setter.call(el, newValue);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---- event wiring ----

  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && isEligible(t)))) {
        currentEl = t;
      } else {
        currentEl = editableRoot(t);
      }
      clearSuggestion();
    },
    true
  );

  document.addEventListener(
    "focusout",
    () => {
      currentEl = null;
      clearSuggestion();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!currentEl) return;
      const withinCurrent = e.target === currentEl || currentEl.contains(e.target);
      if (!withinCurrent) return;

      if (e.key === "Tab") {
        if (suggestion) {
          e.preventDefault();
          e.stopPropagation();
          insertSuggestion(currentEl, suggestion);
          clearSuggestion();
          scheduleCompletion(currentEl);
        }
        return;
      }

      if (e.key === "Escape") {
        if (suggestion) {
          e.preventDefault();
          e.stopPropagation();
          clearSuggestion();
        }
        return;
      }

      clearSuggestion();
      scheduleCompletion(currentEl);
    },
    true
  );

  window.addEventListener("scroll", hideGhost, true);
  window.addEventListener("resize", hideGhost, true);
})();
