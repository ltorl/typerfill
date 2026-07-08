const MODELS = [
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M (fastest)" },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B (balanced)" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B (best quality)" },
];

const enabledInput = document.getElementById("enabled");
const modelSelect = document.getElementById("model");
const statusEl = document.getElementById("status");

for (const m of MODELS) {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = m.label;
  modelSelect.appendChild(opt);
}

chrome.storage.local.get(["enabled", "modelId"], ({ enabled, modelId }) => {
  enabledInput.checked = enabled ?? true;
  modelSelect.value = modelId ?? MODELS[0].id;
});

enabledInput.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledInput.checked });
  chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
});

modelSelect.addEventListener("change", () => {
  chrome.storage.local.set({ modelId: modelSelect.value });
  chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED" });
});

function renderStatus(status) {
  if (!status) {
    statusEl.textContent = "";
    return;
  }
  if (status.state === "loading") {
    const pct = Math.round((status.progress || 0) * 100);
    statusEl.textContent = `Loading model… ${pct}%${status.text ? "\n" + status.text : ""}`;
  } else if (status.state === "ready") {
    statusEl.textContent = "Model ready.";
  } else if (status.state === "error") {
    statusEl.textContent = `Error: ${status.message || "unknown"}`;
  } else {
    statusEl.textContent = "Idle.";
  }
}

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => renderStatus(res?.status));
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATUS_UPDATE") renderStatus(msg.status);
});
