/**
 * ClaudeWatch content script — injected into https://claude.ai/*
 * Content scripts run as classic scripts (not ES modules), so all platform code
 * is loaded via dynamic import() using chrome.runtime.getURL().
 */

// ---- Debug ----
const CW_DEBUG = true;
const dbg = (...a) => { if (CW_DEBUG) console.log('[CW:ct]', new Date().toTimeString().slice(0,8), ...a); };

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
const CAPTURE_DEBOUNCE_MS = 1000;

// API data from interceptor.js (runs in MAIN world, posts via window.postMessage)
let _apiTokensIn = null;
let _apiTokensOut = null;

// Org ID from interceptor.js — needed for cross-device sync API calls
let _orgId = null;

// ---- Messages from interceptor.js (MAIN world → isolated world) ----

window.addEventListener('message', (evt) => {
  if (!evt.data?.__cw || evt.source !== window) return;

  if (evt.data.type === '__CW_TOKENS') {
    _apiTokensIn = evt.data.inputTokens ?? _apiTokensIn;
    _apiTokensOut = evt.data.outputTokens ?? _apiTokensOut;
    dbg('__CW_TOKENS received: in=' + _apiTokensIn + ' out=' + _apiTokensOut);
  }

  if (evt.data.type === '__CW_ORG_ID' && evt.data.orgId) {
    if (_orgId !== evt.data.orgId) {
      _orgId = evt.data.orgId;
      dbg('orgId set from interceptor:', _orgId.slice(0,8) + '…');
    }
  }

  if (evt.data.type === '__CW_USAGE_PCT' && evt.data.usagePercent != null) {
    const resetsIn = evt.data.resetsInMinutes ?? null;
    dbg('__CW_USAGE_PCT received:', evt.data.usagePercent + '%',
        resetsIn != null ? 'resetsIn=' + resetsIn + 'm' : 'resetsIn=unknown');
    chrome.runtime.sendMessage({
      type: 'USAGE_READING',
      usagePercent: Math.round(evt.data.usagePercent),
      resetsInMinutes: resetsIn,
      tier: 'unknown',
    }).catch(() => {});
  }

  if (evt.data.type === '__CW_USAGE_URL' && evt.data.url) {
    dbg('__CW_USAGE_URL received:', evt.data.url);
    chrome.storage.local.set({ cachedUsageUrl: evt.data.url });
    // Also extract orgId from the URL as a fallback (covers the case where
    // __CW_ORG_ID wasn't received yet, e.g. content-script reload)
    if (!_orgId) {
      const m = evt.data.url.match(/\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) { _orgId = m[1]; dbg('orgId extracted from usageUrl:', _orgId.slice(0,8) + '…'); }
    }
  }
});

// ---- Background message listener ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SYNC_CONVERSATIONS') {
    dbg('SYNC_CONVERSATIONS request received from background');
    handleConversationSync(msg)
      .then(result => sendResponse(result))
      .catch(err => {
        dbg('SYNC_CONVERSATIONS unhandled error:', err.message);
        sendResponse({ error: err.message, exchanges: [], newState: msg.convSyncState || {} });
      });
    return true; // async response
  }
});

// ---- Plan tier detection ----

function detectAndStoreTier() {
  if (!platform) return;
  try {
    const tier = platform.getPlanTier();
    if (tier !== 'unknown') {
      dbg('tier detected:', tier);
      chrome.storage.local.set({ tier });
    }
  } catch (_) {}
}

// ---- Init ----

async function init() {
  dbg('init starting, url:', location.href);
  try {
    // Dynamic imports — required because content scripts are not ES modules
    const [tokenizerModule, platformModule] = await Promise.all([
      import(chrome.runtime.getURL('lib/tokenizer.js')),
      import(chrome.runtime.getURL('platforms/claude.js')),
    ]);
    estimateTokens = tokenizerModule.estimateTokens;
    platform = platformModule;
    dbg('modules loaded OK');
  } catch (err) {
    logError('module_load', err);
    dbg('module load FAILED:', err.message, '— using fallback tokenizer');
    // Fallback tokenizer so exchange capturing still works
    estimateTokens = text => text ? Math.ceil(text.length / 3.5) : 0;
    return; // Can't attach DOM observers without platform selectors
  }

  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  enabled = extensionEnabled;
  if (!enabled) {
    dbg('extension disabled — skipping observer attach');
    return;
  }

  // Restore orgId from cached usage URL (covers content-script reload after SW was idle)
  if (!_orgId) {
    const { cachedUsageUrl } = await chrome.storage.local.get({ cachedUsageUrl: null });
    if (cachedUsageUrl) {
      const m = cachedUsageUrl.match(/\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) { _orgId = m[1]; dbg('orgId restored from cachedUsageUrl:', _orgId.slice(0,8) + '…'); }
    }
  }

  // Sub-minute usage polling — faster than Chrome's 1-min alarm minimum.
  // POLL_NOW uses the cached API URL so no tabs are ever opened.
  setInterval(() => {
    dbg('POLL_NOW (30s interval)');
    chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
  }, 30000);

  attachSendListeners();
  attachObserver();
  attachModelObserver();
  // Delay tier detection so React has time to render the sidebar plan badge
  setTimeout(detectAndStoreTier, 2500);

  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('pushstate', handleNavigation);

  // Away-sync: if the last conversation sync is stale (>2 min), the tab was likely
  // closed while the user was active on another device or tab. Trigger an immediate
  // catch-up sync and show a brief toast so the user knows activity is being counted.
  const AWAY_THRESHOLD_MS = 2 * 60 * 1000;
  const { convSyncLastAt = null } = await chrome.storage.local.get({ convSyncLastAt: null });
  const isAway = !convSyncLastAt || (Date.now() - new Date(convSyncLastAt).getTime() > AWAY_THRESHOLD_MS);
  if (isAway) {
    dbg('init: sync state stale (lastAt=' + (convSyncLastAt || 'never') + ') — triggering away-sync');
    showSyncToast('ClaudeWatch: catching up on missed activity…');
    chrome.runtime.sendMessage({ type: 'AWAY_SYNC' })
      .then(r => { dbg('away-sync response:', r); hideSyncToast(); })
      .catch(err => { dbg('away-sync error:', err?.message); hideSyncToast(); });
  } else {
    dbg('init: sync state fresh, no away-sync needed');
  }

  dbg('init complete — convId:', getCurrentConvId() || '(none)');
}

function handleNavigation() {
  const newConvId = getCurrentConvId();
  dbg('navigation detected, re-attaching observers, convId:', newConvId || '(none)');
  detachObserver();
  currentExchange = null;
  setTimeout(() => {
    attachSendListeners();
    attachObserver();
    attachModelObserver();
    detectAndStoreTier();
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

// ---- Conversation ID ----

function getCurrentConvId() {
  const m = location.pathname.match(/\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}

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
    if (model !== 'unknown') {
      dbg('model on attach:', model, adaptive ? '(adaptive)' : '');
      chrome.storage.local.set({ lastModel: model, lastAdaptive: adaptive });
    }
  }
  modelObserver = new MutationObserver(() => {
    if (!platform) return;
    const { model, adaptive } = platform.getModelInfo();
    dbg('model changed:', model, adaptive ? '(adaptive)' : '');
    chrome.storage.local.set({ lastModel: model, lastAdaptive: adaptive });
  });
  modelObserver.observe(btn, { attributes: true, attributeFilter: ['aria-label'] });
  dbg('model observer attached');
}

// ---- Send detection ----

function attachSendListeners() {
  // Use capture-phase delegation so React's event handling doesn't block us
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('click', onDocumentClick, true);
  dbg('send listeners attached');
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
    const conversationId = getCurrentConvId();

    dbg('captureUserSend:', {
      tokensIn, model,
      adaptive,
      hasAttachments,
      attachTokens: attachmentTokensEstimated,
      convId: conversationId ? conversationId.slice(0,8) + '…' : 'new',
    });

    // Reset interceptor data so prior exchange doesn't bleed into this one
    _apiTokensIn = null;
    _apiTokensOut = null;

    currentExchange = {
      timestamp: new Date().toISOString(),
      model,
      adaptiveMode: adaptive,
      tokensIn,
      hasAttachments,
      attachmentTokensEstimated,
      sendAt: now,
      partial: false,
      conversationId,
      source: 'sse_exact', // may be downgraded to 'dom_estimated' if SSE tokens unavailable
    };

    // Refresh usage % immediately after each send
    chrome.runtime.sendMessage({ type: 'POLL_NOW', activeConvId: conversationId }).catch(() => {});

    // Delayed poll 15 s after send — catches usage that updates slightly after the request
    setTimeout(() => {
      dbg('POLL_NOW +15s post-send');
      chrome.runtime.sendMessage({ type: 'POLL_NOW', activeConvId: conversationId }).catch(() => {});
    }, 15000);

  } catch (err) {
    logError('captureUserSend', err);
    dbg('captureUserSend error:', err.message);
  }
}

// ---- MutationObserver — stream completion ----

function attachObserver() {
  try {
    const container = platform.getConversationContainer();
    observer = new MutationObserver(onMutation);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    dbg('DOM mutation observer attached');
  } catch (err) {
    logError('attachObserver', err);
    dbg('attachObserver error:', err.message);
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
  const snap = currentExchange; // capture before the 200ms wait
  currentExchange = null;

  // Wait 200ms — gives the SSE interceptor's postMessage time to arrive before
  // we finalise the exchange. Both the SSE stream close and the last DOM mutation
  // happen at the same time; the stability timer adds 500ms on top, so 200ms is safe.
  setTimeout(() => {
    try {
      const now = Date.now();
      const responseDurationMs = now - snap.sendAt;

      // Prefer real token counts from the API interceptor; fall back to DOM estimation
      let tokensIn = snap.tokensIn;
      let tokensOut;
      let source;

      if (_apiTokensOut != null) {
        tokensOut = _apiTokensOut;
        if (_apiTokensIn != null) tokensIn = _apiTokensIn;
        source = 'sse_exact';
        dbg('captureResponseComplete: using SSE tokens', { tokensIn, tokensOut });
      } else {
        const assistantTurn = platform.getLastAssistantTurn();
        const responseText = platform.extractTurnText(assistantTurn);
        tokensOut = estimateTokens(responseText);
        source = 'dom_estimated';
        dbg('captureResponseComplete: SSE unavailable, DOM estimation', { tokensIn, tokensOut });
      }
      _apiTokensIn = null;
      _apiTokensOut = null;

      const tokensPerSecond = responseDurationMs > 0
        ? parseFloat((tokensOut / (responseDurationMs / 1000)).toFixed(2))
        : null;

      const limitMessage = platform.detectLimitMessage();
      const thinkingDuration = platform.getThinkingDuration();

      const exchange = {
        ...snap,
        tokensIn,
        completedAt: new Date().toISOString(),
        tokensOut,
        responseDurationMs,
        tokensPerSecond,
        hitLimit: !!limitMessage,
        limitMessage: limitMessage ? limitMessage.slice(0, 500) : null,
        thinkingDurationMs: thinkingDuration,
        partial: !!partial,
        source,
      };

      dbg('exchange complete:', {
        model: exchange.model,
        tokensIn: exchange.tokensIn,
        tokensOut: exchange.tokensOut,
        durationMs: exchange.responseDurationMs,
        tps: exchange.tokensPerSecond,
        source: exchange.source,
        hitLimit: exchange.hitLimit,
        partial: exchange.partial,
        convId: exchange.conversationId ? exchange.conversationId.slice(0,8) + '…' : 'new',
        thinkingMs: exchange.thinkingDurationMs,
      });

      chrome.runtime.sendMessage({ type: 'EXCHANGE_COMPLETE', exchange });

      // Delayed poll 15 s after response — usage % often updates after Claude finishes
      setTimeout(() => {
        dbg('POLL_NOW +15s post-response');
        chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
      }, 15000);

    } catch (err) {
      logError('captureResponseComplete', err);
      dbg('captureResponseComplete error:', err.message);
    }
  }, 200);
}

// ---- Partial capture on tab close ----

window.addEventListener('beforeunload', () => {
  if (currentExchange) {
    dbg('beforeunload — capturing partial exchange');
    try { captureResponseComplete(true); } catch (_) {}
  }
});

// ---- Cross-device conversation sync ----

// Extract a flat array of messages from the conversation detail API response.
// Handles multiple possible response shapes from the Claude API.
function extractMessages(detail) {
  if (Array.isArray(detail)) return detail;
  if (Array.isArray(detail.chat_messages)) return detail.chat_messages;
  if (Array.isArray(detail.messages)) return detail.messages;
  return [];
}

// Extract plain text from a single message object.
// Content may be a string or an array of typed content blocks.
function extractMessageText(msg) {
  if (!msg) return '';
  const content = msg.content ?? msg.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text')
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .join(' ');
  }
  return '';
}

/**
 * Called by background.js via SYNC_CONVERSATIONS message.
 * Fetches the conversation list, detects messages added on other devices/tabs
 * since last sync, estimates tokens, and returns synthetic exchanges + updated state.
 *
 * Double-counting prevention:
 *  - Conversations in sseConvIds were captured via SSE on this device. Their
 *    convSyncState baseline is updated to the current leaf (cheap — uses the
 *    already-fetched list) so future syncs won't re-count them, but no exchange
 *    is emitted (those tokens were already reported via EXCHANGE_COMPLETE).
 *  - On first sync (lastSyncedAt === null), all conversations get a baseline
 *    with zero tokens — no historical backfill ever occurs.
 */
async function handleConversationSync({ lastSyncedAt, convSyncState, sseConvIds }) {
  const isFirstSync = lastSyncedAt === null;
  const sseSet = new Set(sseConvIds || []);

  dbg('handleConversationSync start:', {
    isFirstSync,
    storedConvs: Object.keys(convSyncState || {}).length,
    sseCount: sseSet.size,
    orgId: _orgId ? _orgId.slice(0,8) + '…' : 'MISSING',
  });

  if (!_orgId) {
    dbg('handleConversationSync: orgId unknown — skipping (will retry next alarm)');
    return { exchanges: [], newState: convSyncState || {} };
  }

  if (!estimateTokens) {
    dbg('handleConversationSync: tokenizer not ready — skipping');
    return { exchanges: [], newState: convSyncState || {} };
  }

  const exchanges = [];
  const newState = { ...(convSyncState || {}) };

  try {
    const listRes = await fetch(
      `/api/organizations/${_orgId}/chat_conversations?limit=50&order_by=updated_at`,
      { credentials: 'include' }
    );
    if (!listRes.ok) {
      dbg('handleConversationSync: conv list fetch failed:', listRes.status);
      return { exchanges: [], newState };
    }
    const listData = await listRes.json();
    const conversations = Array.isArray(listData)
      ? listData
      : (listData.chat_conversations || listData.conversations || []);

    dbg('handleConversationSync: conversation list received, count:', conversations.length);

    for (const conv of conversations) {
      const convId   = conv.uuid;
      const currentLeaf = conv.current_leaf_message_uuid;
      const updatedAt   = conv.updated_at;
      const convModel   = conv.settings?.model || conv.model || 'unknown';
      const stored      = newState[convId];

      // --- SSE-captured conversation: update baseline, no exchange ---
      // The tokens were already reported via EXCHANGE_COMPLETE on this device.
      // We still update the stored leaf so future syncs (after SW restart clears
      // sseConversationIds) don't re-count these messages.
      if (sseSet.has(convId)) {
        if (!stored || stored.leafMsgId !== currentLeaf) {
          dbg('sync SSE conv', convId.slice(0,8), '— update baseline to', currentLeaf?.slice(0,8));
          newState[convId] = {
            leafMsgId: currentLeaf,
            tokensIn:  stored?.tokensIn  || 0,
            tokensOut: stored?.tokensOut || 0,
            updatedAt,
          };
        }
        continue;
      }

      // --- First time seeing this conversation, or first-ever sync ---
      // Store a zero-token baseline. No historical messages are ever counted.
      if (isFirstSync || !stored) {
        dbg('sync baseline conv', convId.slice(0,8), 'leaf=', currentLeaf?.slice(0,8));
        newState[convId] = { leafMsgId: currentLeaf, tokensIn: 0, tokensOut: 0, updatedAt };
        continue;
      }

      // --- No change since last sync ---
      if (stored.leafMsgId === currentLeaf) continue;

      // --- New messages on another device — fetch detail and count tokens ---
      dbg('sync conv', convId.slice(0,8), 'updated: leaf',
          stored.leafMsgId?.slice(0,8), '→', currentLeaf?.slice(0,8));

      try {
        const detailRes = await fetch(
          `/api/organizations/${_orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages`,
          { credentials: 'include' }
        );
        if (!detailRes.ok) {
          dbg('sync detail fetch failed for', convId.slice(0,8), ':', detailRes.status);
          continue;
        }
        const detail   = await detailRes.json();
        const messages = extractMessages(detail);
        dbg('sync conv', convId.slice(0,8), ': total messages in detail:', messages.length);

        // Slice to messages added after the last known leaf
        const lastKnownIdx = messages.findIndex(m => m.uuid === stored.leafMsgId);
        const newMessages  = lastKnownIdx >= 0 ? messages.slice(lastKnownIdx + 1) : [];

        if (newMessages.length === 0) {
          dbg('sync conv', convId.slice(0,8), ': leaf changed but no new messages found in slice');
          newState[convId] = { ...stored, leafMsgId: currentLeaf, updatedAt };
          continue;
        }

        // Count tokens per message
        let newTokIn = 0, newTokOut = 0;
        for (const msg of newMessages) {
          const text   = extractMessageText(msg);
          const tokens = estimateTokens(text);
          const sender = (msg.sender || msg.role || '').toLowerCase();
          if (sender === 'human' || sender === 'user') newTokIn  += tokens;
          else                                          newTokOut += tokens;
        }

        dbg('sync conv', convId.slice(0,8), ': new msgs=' + newMessages.length,
            'tokIn=' + newTokIn, 'tokOut=' + newTokOut, 'model=' + convModel);

        if (newTokIn > 0 || newTokOut > 0) {
          // source: 'api_estimated' marks cross-device exchanges internally.
          // NOT sent to Supabase; invisible to users but visible in debug logs.
          exchanges.push({
            timestamp:                updatedAt || new Date().toISOString(),
            model:                    convModel,
            adaptiveMode:             false,
            tokensIn:                 newTokIn,
            tokensOut:                newTokOut,
            hasAttachments:           false,
            attachmentTokensEstimated: 0,
            responseDurationMs:       null,
            tokensPerSecond:          null,
            hitLimit:                 false,
            limitMessage:             null,
            thinkingDurationMs:       null,
            partial:                  false,
            source:                   'api_estimated',
            conversationId:           convId,
          });
        }

        newState[convId] = {
          leafMsgId: currentLeaf,
          tokensIn:  (stored.tokensIn  || 0) + newTokIn,
          tokensOut: (stored.tokensOut || 0) + newTokOut,
          updatedAt,
        };

      } catch (detailErr) {
        dbg('sync detail error for', convId.slice(0,8), ':', detailErr.message);
      }
    }

    dbg('handleConversationSync complete: exchanges=' + exchanges.length +
        ' stateConvs=' + Object.keys(newState).length);
    return { exchanges, newState };

  } catch (err) {
    dbg('handleConversationSync top-level error:', err.message);
    return { exchanges: [], newState };
  }
}

// ---- Away-sync toast UI ----
// Shown briefly at the bottom-right of the Claude.ai page while the extension
// is catching up on messages that arrived while the tab was closed.

function showSyncToast(message) {
  const existing = document.getElementById('cw-sync-toast');
  if (existing) { existing.querySelector('.cw-toast-msg').textContent = message; return; }

  // Inject spin keyframe once
  if (!document.getElementById('cw-toast-style')) {
    const s = document.createElement('style');
    s.id = 'cw-toast-style';
    s.textContent = '@keyframes cw-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  const toast = document.createElement('div');
  toast.id = 'cw-sync-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
    'background:rgba(20,20,20,0.88)', 'color:#fff',
    'padding:10px 18px', 'border-radius:10px',
    'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'display:flex', 'align-items:center', 'gap:10px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
    'backdrop-filter:blur(6px)',
    'transition:opacity 0.4s',
  ].join(';');

  const spinner = document.createElement('span');
  spinner.style.cssText = 'display:inline-block;animation:cw-spin 0.9s linear infinite;font-size:15px';
  spinner.textContent = '↺';

  const label = document.createElement('span');
  label.className = 'cw-toast-msg';
  label.textContent = message;

  toast.appendChild(spinner);
  toast.appendChild(label);
  document.body.appendChild(toast);
  dbg('sync toast shown:', message);
}

function hideSyncToast() {
  const toast = document.getElementById('cw-sync-toast');
  if (!toast) return;
  toast.style.opacity = '0';
  setTimeout(() => { toast.remove(); dbg('sync toast hidden'); }, 450);
}

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
