/**
 * ClaudeWatch content script — injected into https://claude.ai/*
 * Content scripts run as classic scripts (not ES modules), so all platform code
 * is loaded via dynamic import() using chrome.runtime.getURL().
 */

// ---- Module handles (loaded in init) ----
let estimateTokens = null;
let platform = null;

// ---- State ----
let enabled = true;
let observer = null;
let modelObserver = null;
let currentExchange = null;
let streamStabilityTimer = null;
let lastCaptureTime = 0;
const STREAM_STABLE_DELAY = 500;
const CAPTURE_DEBOUNCE_MS = 1000; // prevent double-capture within 1s

// ---- Init ----

async function init() {
  try {
    // Dynamic imports — required because content scripts are not ES modules
    const [tokenizerModule, platformModule] = await Promise.all([
      import(chrome.runtime.getURL('lib/tokenizer.js')),
      import(chrome.runtime.getURL('platforms/claude.js')),
    ]);
    estimateTokens = tokenizerModule.estimateTokens;
    platform = platformModule;
  } catch (err) {
    logError('module_load', err);
    // Fallback tokenizer so exchange capturing still works
    estimateTokens = text => text ? Math.ceil(text.length / 3.5) : 0;
    return; // Can't attach DOM observers without platform selectors
  }

  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  enabled = extensionEnabled;
  if (!enabled) return;

  attachSendListeners();
  attachObserver();
  attachModelObserver();

  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('pushstate', handleNavigation);
}

function handleNavigation() {
  detachObserver();
  currentExchange = null;
  setTimeout(() => {
    attachSendListeners();
    attachObserver();
    attachModelObserver();
  }, 800);
}

// Intercept History.pushState so SPA navigation is detectable
(function patchHistory() {
  const orig = history.pushState.bind(history);
  history.pushState = function (...args) {
    orig(...args);
    window.dispatchEvent(new Event('pushstate'));
  };
})();

// ---- Model change tracking ----

function attachModelObserver() {
  if (modelObserver) { modelObserver.disconnect(); modelObserver = null; }
  const btn = document.querySelector('[data-testid="model-selector-dropdown"]');
  if (!btn) {
    setTimeout(attachModelObserver, 1500);
    return;
  }
  // Read and store on first attach
  if (platform) {
    const { model, adaptive } = platform.getModelInfo();
    if (model !== 'unknown') chrome.storage.local.set({ lastModel: model, lastAdaptive: adaptive });
  }
  modelObserver = new MutationObserver(() => {
    if (!platform) return;
    const { model, adaptive } = platform.getModelInfo();
    chrome.storage.local.set({ lastModel: model, lastAdaptive: adaptive });
  });
  modelObserver.observe(btn, { attributes: true, attributeFilter: ['aria-label'] });
}

// ---- Send detection ----

function attachSendListeners() {
  // Use capture-phase delegation so React's event handling doesn't block us
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('click', onDocumentClick, true);
}

function onKeydown(e) {
  if (!enabled || !estimateTokens) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    const active = document.activeElement;
    if (active && active.closest('[data-testid="chat-input"], [contenteditable="true"]')) {
      captureUserSend();
    }
  }
}

function onDocumentClick(e) {
  if (!enabled || !estimateTokens) return;
  if (e.target.closest('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"]')) captureUserSend();
}

function captureUserSend() {
  // Debounce: ignore if another capture happened within 1s (keydown + click can both fire)
  const now = Date.now();
  if (now - lastCaptureTime < CAPTURE_DEBOUNCE_MS) return;
  lastCaptureTime = now;

  try {
    const text = platform.getInputText();
    const { hasAttachments, estimatedTokens: attachmentTokensEstimated } = platform.getAttachmentInfo();
    const { model, adaptive } = platform.getModelInfo();
    const tokensIn = estimateTokens(text);

    currentExchange = {
      timestamp: new Date().toISOString(),
      model,
      adaptiveMode: adaptive,
      tokensIn,
      hasAttachments,
      attachmentTokensEstimated,
      sendAt: now,
      partial: false,
    };

    // Refresh usage % immediately after each send rather than waiting for the alarm
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
  } catch (err) {
    logError('captureUserSend', err);
  }
}

// ---- MutationObserver — stream completion ----

function attachObserver() {
  try {
    const container = platform.getConversationContainer();
    observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  } catch (err) {
    logError('attachObserver', err);
  }
}

function detachObserver() {
  if (observer) { observer.disconnect(); observer = null; }
  clearTimeout(streamStabilityTimer);
}

function onMutation() {
  if (!currentExchange) return;
  clearTimeout(streamStabilityTimer);
  streamStabilityTimer = setTimeout(onStreamStable, STREAM_STABLE_DELAY);
}

function onStreamStable() {
  if (platform.isStreaming()) {
    streamStabilityTimer = setTimeout(onStreamStable, STREAM_STABLE_DELAY);
    return;
  }
  // If the assistant response hasn't appeared in the DOM yet (happens during the
  // thinking/loading gap), keep waiting rather than capturing an empty turn.
  if (!platform.getLastAssistantTurn()) {
    streamStabilityTimer = setTimeout(onStreamStable, STREAM_STABLE_DELAY);
    return;
  }
  captureResponseComplete(false);
}

function captureResponseComplete(partial) {
  if (!currentExchange) return;

  try {
    const now = Date.now();
    const responseDurationMs = now - currentExchange.sendAt;
    const assistantTurn = platform.getLastAssistantTurn();
    const responseText = platform.extractTurnText(assistantTurn);
    const tokensOut = estimateTokens(responseText);
    const tokensPerSecond = responseDurationMs > 0
      ? parseFloat((tokensOut / (responseDurationMs / 1000)).toFixed(2))
      : null;

    const limitMessage = platform.detectLimitMessage();
    const thinkingDuration = platform.getThinkingDuration();

    const exchange = {
      ...currentExchange,
      completedAt: new Date().toISOString(),
      tokensOut,
      responseDurationMs,
      tokensPerSecond,
      hitLimit: !!limitMessage,
      limitMessage: limitMessage ? limitMessage.slice(0, 500) : null,
      thinkingDurationMs: thinkingDuration,
      partial: !!partial,
    };

    chrome.runtime.sendMessage({ type: 'EXCHANGE_COMPLETE', exchange });
  } catch (err) {
    logError('captureResponseComplete', err);
  } finally {
    currentExchange = null;
  }
}

// ---- Partial capture on tab close ----

window.addEventListener('beforeunload', () => {
  if (currentExchange) {
    try { captureResponseComplete(true); } catch (_) {}
  }
});

// ---- Error logging (local only, never transmitted) ----

function logError(context, err) {
  try {
    chrome.storage.local.get({ errorLog: [] }, ({ errorLog }) => {
      errorLog.push({ context, message: err?.message, ts: Date.now() });
      if (errorLog.length > 50) errorLog.splice(0, errorLog.length - 50);
      chrome.storage.local.set({ errorLog });
    });
  } catch (_) {}
}

// ---- Start ----
init().catch(err => logError('init', err));
