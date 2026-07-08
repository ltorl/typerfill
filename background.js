const DEFAULT_MODEL = "SmolLM2-360M-Instruct-q4f16_1-MLC";

let currentStatus = { state: "idle", progress: 0 };
let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing.length > 0) return;

    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs a local WebGPU language model for in-page autocomplete.",
    });
  })();

  return offscreenReady;
}

async function getSettings() {
  const { enabled, modelId } = await chrome.storage.local.get(["enabled", "modelId"]);
  return {
    enabled: enabled ?? true,
    modelId: modelId ?? DEFAULT_MODEL,
  };
}

async function maybePreload() {
  const { enabled, modelId } = await getSettings();
  if (!enabled) return;
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ target: "offscreen", type: "PRELOAD", payload: { modelId } }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["enabled"], ({ enabled }) => {
    if (enabled === undefined) chrome.storage.local.set({ enabled: true, modelId: DEFAULT_MODEL });
  });
  maybePreload();
});
chrome.runtime.onStartup.addListener(maybePreload);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Status pushed up from the offscreen document.
  if (message?.target === "background" && message.type === "STATUS") {
    currentStatus = { state: message.state, progress: message.progress, text: message.text, message: message.message };
    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status: currentStatus }).catch(() => {});
    return false;
  }

  if (message?.type === "GET_STATUS") {
    sendResponse({ status: currentStatus });
    return false;
  }

  if (message?.type === "REQUEST_COMPLETE") {
    (async () => {
      const { enabled, modelId } = await getSettings();
      if (!enabled) {
        sendResponse({ ok: false, error: "disabled" });
        return;
      }
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "COMPLETE", payload: { modelId, context: message.context } },
        (response) => sendResponse(response ?? { ok: false, error: "no response" })
      );
    })();
    return true; // async
  }

  if (message?.type === "SETTINGS_CHANGED") {
    maybePreload();
    return false;
  }

  return false;
});
