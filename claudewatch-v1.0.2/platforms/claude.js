/**
 * Claude.ai platform adapter.
 * All claude.ai-specific DOM selectors and scraping logic lives here.
 * Future platforms (chatgpt.com, gemini.google.com) implement the same interface.
 */

export const PLATFORM_ID = 'claude';
export const PLATFORM_HOST = 'claude.ai';

// ---------- Selectors ----------
// Prefer data-testid and aria attributes — more stable than obfuscated CSS classes.

export const SELECTORS = {
  modelSelector: '[data-testid="model-selector-dropdown"]',
  conversationContainer: '[data-testid="conversation-content"]',
  conversationFallbacks: [
    'main [class*="conversation"]',
    'main [class*="chat"]',
    'main',
  ],
  userTurn: '[data-testid="user-message"], [data-user-message-bubble="true"]',
  assistantTurn: 'div[data-is-streaming]',
  stopStreamingButton: '[aria-label="Stop streaming"], [data-testid="stop-button"], [data-is-streaming="true"]',
  sendButton: '[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="send"]',
  inputField: '[data-testid="chat-input"], div[contenteditable="true"][class*="ProseMirror"], div[contenteditable="true"]',
  thinkingIndicator: '[data-testid="thinking-indicator"], [class*="thinking"]',
  usageLimitBanner: '[role="alert"], [class*="limit"], [class*="error"]',
  attachmentArea: '[data-testid="file-attachment"], [class*="attachment"]',
};

// Rate-limit / usage-limit message patterns
export const LIMIT_PATTERNS = [
  /usage\s+limit/i,
  /rate\s+limit/i,
  /you've\s+reached/i,
  /message\s+limit/i,
  /try\s+again/i,
  /too\s+many\s+requests/i,
];

// ---------- DOM Helpers ----------

export function getModelInfo() {
  const el = document.querySelector(SELECTORS.modelSelector);
  if (!el) return { model: 'unknown', adaptive: false };

  const label = el.getAttribute('aria-label') || el.textContent || '';
  // Strip "Model: " prefix
  const modelRaw = label.replace(/^Model:\s*/i, '').trim();

  const adaptive = /adaptive/i.test(modelRaw);
  const model = modelRaw.replace(/\s*adaptive\s*/i, '').trim() || 'unknown';

  return { model, adaptive };
}

export function getConversationContainer() {
  const primary = document.querySelector(SELECTORS.conversationContainer);
  if (primary) return primary;

  for (const sel of SELECTORS.conversationFallbacks) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

export function getLastAssistantTurn() {
  // Primary: data-is-streaming covers both active and completed assistant turns.
  let turns = document.querySelectorAll(SELECTORS.assistantTurn);
  if (turns.length) return turns[turns.length - 1];

  // Fallbacks — tried in order of specificity. Claude.ai occasionally renames
  // CSS classes but data-testid and role attributes are far more stable.
  const fallbacks = [
    '[data-testid="assistant-message"]',
    '[data-message-author-role="assistant"]',
    '[data-testid="ai-message"]',
  ];
  for (const sel of fallbacks) {
    turns = document.querySelectorAll(sel);
    if (turns.length) return turns[turns.length - 1];
  }
  return null;
}

export function getLastUserTurn() {
  const turns = document.querySelectorAll(SELECTORS.userTurn);
  return turns.length ? turns[turns.length - 1] : null;
}

export function isStreaming() {
  return !!document.querySelector(SELECTORS.stopStreamingButton);
}

export function extractTurnText(turnEl) {
  if (!turnEl) return '';
  // Target the response content div directly, skipping the sr-only header and action buttons
  const content = turnEl.querySelector('.font-claude-response, .standard-markdown, .progressive-markdown');
  const target = content || turnEl;
  const clone = target.cloneNode(true);
  clone.querySelectorAll('button, svg, [aria-hidden="true"]').forEach(el => el.remove());
  return (clone.textContent || clone.innerText || '').trim();
}

export function detectLimitMessage() {
  // Scan only the last assistant turn — prevents false positives from UI chrome (nav, buttons, etc.)
  const turns = document.querySelectorAll(SELECTORS.assistantTurn);
  const scope = turns.length ? turns[turns.length - 1] : null;
  if (!scope) return null;

  for (const pattern of LIMIT_PATTERNS) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (pattern.test(node.textContent)) {
        let el = node.parentElement;
        while (el && el !== scope) {
          const tag = el.tagName.toLowerCase();
          if (['p', 'div', 'span', 'section', 'article'].includes(tag)) {
            const msg = el.textContent.trim();
            if (msg.length < 500) return msg;
          }
          el = el.parentElement;
        }
        return node.textContent.trim();
      }
    }
  }
  return null;
}

export function getInputText() {
  const el = document.querySelector(SELECTORS.inputField);
  if (!el) return '';
  return (el.textContent || el.value || '').trim();
}

export function getAttachmentInfo() {
  const attachments = document.querySelectorAll(SELECTORS.attachmentArea);
  let hasAttachments = attachments.length > 0;
  let estimatedTokens = 0;

  attachments.forEach(el => {
    // Try to read file size from data attributes or child text
    const sizeAttr = el.getAttribute('data-file-size') || el.getAttribute('data-size');
    if (sizeAttr) {
      const bytes = parseInt(sizeAttr, 10);
      if (!isNaN(bytes)) {
        estimatedTokens += Math.ceil(bytes / 4);
      }
    } else {
      // Rough fallback: assume ~1000 tokens per attachment if size unknown
      estimatedTokens += 1000;
    }
  });

  return { hasAttachments, estimatedTokens };
}

export function getThinkingDuration() {
  const el = document.querySelector(SELECTORS.thinkingIndicator);
  if (!el) return null;

  const text = el.textContent || '';
  // Parse patterns like "Thought for 3.2s" or "Thinking: 5s"
  const match = text.match(/(\d+\.?\d*)\s*s/i);
  if (match) return Math.round(parseFloat(match[1]) * 1000); // ms
  return null;
}

// ---------- Plan tier detection ----------

export function getPlanTier() {
  // Primary: look for the exact plan badge spans Claude renders in the sidebar.
  // The HTML confirmed by the user: <span class="w-full truncate text-xs text-text-500 ...">Pro plan</span>
  const candidates = document.querySelectorAll('span.text-text-500, span[class*="text-text-5"]');
  for (const el of candidates) {
    const t = el.textContent.trim().toLowerCase();
    if (t === 'pro plan') return 'pro';
    if (t === 'free plan') return 'free';
    if (/^claude\s+max/.test(t)) return 'max';
    if (t === 'team plan') return 'team';
  }
  // Fallback: broader span scan (slower but catches any future class rename)
  for (const el of document.querySelectorAll('span')) {
    const t = el.textContent.trim().toLowerCase();
    if (t === 'pro plan') return 'pro';
    if (t === 'free plan') return 'free';
    if (/^claude\s+max/.test(t)) return 'max';
    if (t === 'team plan') return 'team';
  }
  return 'unknown';
}

// ---------- Usage page parsing (called from background.js fetch) ----------

export function parseUsagePage(htmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');

  const progressBar = doc.querySelector('[role="progressbar"]');
  const usagePercent = progressBar
    ? parseInt(progressBar.getAttribute('aria-valuenow') || '0', 10)
    : null;

  // Find reset timer text
  let resetsInMinutes = null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent;
    const match = t.match(/resets?\s+in\s+(?:(\d+)\s*hr?)?\s*(?:(\d+)\s*min?)?/i);
    if (match) {
      const hours = parseInt(match[1] || '0', 10);
      const mins = parseInt(match[2] || '0', 10);
      resetsInMinutes = hours * 60 + mins;
      break;
    }
  }

  // Detect tier
  let tier = 'unknown';
  const bodyText = (doc.body.textContent || '').toLowerCase();
  if (/\bpro\b/.test(bodyText)) tier = 'pro';
  else if (/\bfree\b/.test(bodyText)) tier = 'free';

  return { usagePercent, resetsInMinutes, tier };
}
