/**
 * ClaudeWatch content script — injected into https://claude.ai/settings/usage
 * Reads the rendered usage percentage from the live DOM and reports it to background.js.
 * Does not open any tab or make any visible change — runs silently in whatever tab the user is in.
 */

function readAndReport() {
  const progressBar = document.querySelector('[role="progressbar"]');
  if (!progressBar) return; // React hasn't rendered yet — MutationObserver will retry

  const usagePercent = parseInt(progressBar.getAttribute('aria-valuenow') || '0', 10);

  let resetsInMinutes = null;
  const bodyText = document.body.textContent || '';
  const match = bodyText.match(/resets?\s+in\s+(?:(\d+)\s*h(?:rs?)?)?\s*(?:(\d+)\s*m(?:ins?)?)?/i);
  if (match && (match[1] || match[2])) {
    resetsInMinutes = parseInt(match[1] || '0', 10) * 60 + parseInt(match[2] || '0', 10);
  }

  let tier = 'unknown';
  const lower = bodyText.toLowerCase();
  if (/claude\s+max/i.test(bodyText)) tier = 'max';
  else if (/\bpro\b/.test(lower)) tier = 'pro';
  else if (/\bfree\b/.test(lower)) tier = 'free';

  chrome.runtime.sendMessage({ type: 'USAGE_READING', usagePercent, resetsInMinutes, tier });
}

// Watch for React to render the progressbar
const obs = new MutationObserver(() => {
  if (document.querySelector('[role="progressbar"]')) {
    obs.disconnect();
    readAndReport();
  }
});
obs.observe(document.body, { childList: true, subtree: true });
setTimeout(() => obs.disconnect(), 15000); // give up after 15s

// Also try immediately in case the page is already rendered
readAndReport();
