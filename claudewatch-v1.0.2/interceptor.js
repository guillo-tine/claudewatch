/**
 * ClaudeWatch fetch interceptor — runs in the page's MAIN world (see manifest.json).
 * Overrides window.fetch to intercept Claude's SSE streaming API responses and extract
 * real token counts. Also scans JSON responses for usage percentage data.
 *
 * When a JSON response is found to contain a usage percentage, the request URL is
 * posted as __CW_USAGE_URL so content.js can cache it — enabling future probes to
 * call that endpoint directly without opening any new tabs.
 *
 * Communicates with content.js (isolated world) via window.postMessage using the
 * __cw sentinel so messages are distinguishable from page traffic.
 */

(function () {
  if (window.__cw_installed) return;
  window.__cw_installed = true;

  // ---- Debug ----
  const CW_DEBUG = false; // set to true locally to trace issues; never true in a release build
  const dbg = (...a) => { if (CW_DEBUG) console.log('[CW:ix]', new Date().toTimeString().slice(0,8), ...a); };

  dbg('interceptor installed');

  // Cached IDs discovered from API request URLs — read by the background probe.
  window.__cw_orgId = null;
  window.__cw_accountId = null;

  const _fetch = window.fetch.bind(window);

  // Extract org / account UUIDs from API request paths.
  function extractIds(input) {
    try {
      const url = (input && typeof input === 'object' && input.url) ? input.url : String(input);
      const orgM = url.match(/\/api\/(?:bootstrap|organizations)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (orgM && orgM[1] !== window.__cw_orgId) {
        window.__cw_orgId = orgM[1];
        dbg('orgId discovered:', window.__cw_orgId.slice(0,8) + '…');
        // Broadcast org ID to content.js (isolated world) so it can use it for sync API calls.
        post('__CW_ORG_ID', { orgId: window.__cw_orgId });
        // First time we see the org ID — automatically probe candidate endpoints to
        // discover the usage URL without requiring the user to visit /settings/usage.
        if (!window.__cw_urlProbed) {
          window.__cw_urlProbed = true;
          dbg('first orgId seen — launching probeUsageCandidates');
          probeUsageCandidates(window.__cw_orgId).catch(() => {});
        }
      }
      const acctM = url.match(/\/api\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (acctM && acctM[1] !== window.__cw_accountId) {
        window.__cw_accountId = acctM[1];
        dbg('accountId discovered:', window.__cw_accountId.slice(0,8) + '…');
      }
    } catch (_) {}
  }

  // Parse the confirmed usage endpoint: /api/organizations/{orgId}/usage
  // Structure: { five_hour: { utilization: N, resets_at: "ISO" }, seven_day: { ... }, ... }
  // Returns the MAX utilization across all non-null time windows plus its reset time,
  // or null if the data doesn't look like a usage response.
  function parseOrgUsage(data) {
    const windows = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus',
                     'seven_day_cowork', 'seven_day_omelette'];
    let best = null;
    for (const w of windows) {
      const wd = data[w];
      if (!wd || typeof wd.utilization !== 'number') continue;
      const util = Math.round(wd.utilization);
      if (util < 0 || util > 100) continue;
      let resetsInMinutes = null;
      if (wd.resets_at) {
        const ms = new Date(wd.resets_at) - Date.now();
        if (ms > 0) resetsInMinutes = Math.round(ms / 60000);
      }
      if (!best || util > best.util) best = { util, resetsInMinutes };
    }
    return best ? { usagePercent: best.util, resetsInMinutes: best.resetsInMinutes } : null;
  }

  // Proactively probe the usage endpoint as soon as the org ID is known.
  // The URL pattern /api/organizations/{orgId}/usage was confirmed by diagnostic output.
  // Falls back to a short candidate list for future-proofing. Completely invisible —
  // runs in the existing page context using the original fetch, no new tabs opened.
  async function probeUsageCandidates(orgId) {
    const candidates = [
      `/api/organizations/${orgId}/usage`,   // confirmed endpoint — try first
      `/api/organizations/${orgId}`,
      `/api/organizations/${orgId}/rate_limit_status`,
    ];

    for (const url of candidates) {
      dbg('probeUsageCandidates trying:', url);
      try {
        const res = await _fetch(url, { credentials: 'include' });
        if (!res.ok) { dbg('probeUsageCandidates non-OK:', res.status, url); continue; }
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) { dbg('probeUsageCandidates non-JSON:', ct, url); continue; }
        const data = await res.json();

        // Try the known structure first, then the generic scanner
        const orgUsage = parseOrgUsage(data);
        if (orgUsage != null) {
          dbg('probeUsageCandidates HIT (parseOrgUsage):', orgUsage.usagePercent + '%',
              'resetsIn=' + orgUsage.resetsInMinutes + 'm', 'from', url);
          post('__CW_USAGE_PCT', { usagePercent: orgUsage.usagePercent, resetsInMinutes: orgUsage.resetsInMinutes });
          post('__CW_USAGE_URL', { url });
          return;
        }
        const pct = findUsagePct(data);
        if (pct != null && pct >= 0 && pct <= 100) {
          dbg('probeUsageCandidates HIT (findUsagePct):', pct + '%', 'from', url);
          post('__CW_USAGE_PCT', { usagePercent: pct, resetsInMinutes: null });
          post('__CW_USAGE_URL', { url });
          return;
        }
        dbg('probeUsageCandidates no usage data at:', url);
      } catch (e) { dbg('probeUsageCandidates error for', url, ':', e.message); }
    }
    dbg('probeUsageCandidates exhausted all candidates without a hit');
  }

  // Normalise a request input to a plain URL string.
  // Only keeps relative paths or claude.ai URLs — ignores third-party endpoints.
  function toUrl(input) {
    try {
      const s = (input && typeof input === 'object' && input.url) ? input.url : String(input);
      if (s.startsWith('/')) return s;                        // relative path — always keep
      if (s.startsWith('https://claude.ai')) return s;       // absolute claude.ai URL
    } catch (_) {}
    return '';
  }

  window.fetch = async function (...args) {
    extractIds(args[0]);
    const requestUrl = toUrl(args[0]);

    let response;
    try {
      response = await _fetch(...args);
    } catch (err) {
      throw err;
    }

    const ct = response.headers.get('content-type') || '';

    // Intercept SSE streaming responses (Claude's message completion endpoint)
    if (ct.includes('text/event-stream')) {
      try {
        const [body1, body2] = response.body.tee();
        parseSSE(body2); // non-blocking
        return new Response(body1, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (_) {
        return response;
      }
    }

    // Scan JSON responses for usage data
    if (ct.includes('application/json')) {
      try {
        const clone = response.clone();
        clone.json().then(data => scanJson(data, requestUrl)).catch(() => {});
      } catch (_) {}
    }

    return response;
  };

  async function parseSSE(body) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let inputTokens = null;
    let outputTokens = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'message_start' && evt.message?.usage) {
              inputTokens = evt.message.usage.input_tokens ?? inputTokens;
              dbg('SSE message_start: input_tokens=' + inputTokens);
            }
            if (evt.type === 'message_delta' && evt.usage) {
              outputTokens = evt.usage.output_tokens ?? outputTokens;
              dbg('SSE message_delta: output_tokens=' + outputTokens);
            }
            const pct = findUsagePct(evt);
            if (pct != null) {
              dbg('SSE usage% found in event:', pct + '%', '(type=' + evt.type + ')');
              // resetsInMinutes not available from raw SSE events — pass null explicitly
              post('__CW_USAGE_PCT', { usagePercent: pct, resetsInMinutes: null });
            }
          } catch (_) {}
        }
      }
    } catch (_) {
      try { reader.cancel(); } catch (_) {}
    }

    if (inputTokens != null || outputTokens != null) {
      dbg('parseSSE complete: inputTokens=' + inputTokens + ' outputTokens=' + outputTokens);
      post('__CW_TOKENS', { inputTokens, outputTokens });
    } else {
      dbg('parseSSE complete: no token counts found in stream');
    }
  }

  function scanJson(data, requestUrl) {
    if (!data || typeof data !== 'object') return;

    // Try the known usage endpoint structure first (correct field names + max across windows)
    const orgUsage = parseOrgUsage(data);
    if (orgUsage != null) {
      dbg('scanJson HIT (parseOrgUsage):', orgUsage.usagePercent + '%',
          'resetsIn=' + orgUsage.resetsInMinutes + 'm', 'from', requestUrl || '(unknown)');
      post('__CW_USAGE_PCT', { usagePercent: orgUsage.usagePercent, resetsInMinutes: orgUsage.resetsInMinutes });
      if (requestUrl) post('__CW_USAGE_URL', { url: requestUrl });
      return;
    }

    // Generic fallback for any other endpoint that might contain usage data
    const pct = findUsagePct(data);
    if (pct != null) {
      dbg('scanJson HIT (findUsagePct):', pct + '%', 'from', requestUrl || '(unknown)');
      post('__CW_USAGE_PCT', { usagePercent: pct, resetsInMinutes: null });
      if (requestUrl) post('__CW_USAGE_URL', { url: requestUrl });
    }
  }

  function findUsagePct(obj, depth, parentKey) {
    if (!obj || typeof obj !== 'object') return null;
    depth = depth || 0;
    if (depth > 6) return null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'number') {
        if (/usage.*(pct|percent|fraction|ratio)|percent.*usage|quota.*used|used.*quota|limit.*(pct|percent)|message.*limit.*(pct|percent)/i.test(k)) {
          return v <= 1 && v >= 0 ? Math.round(v * 100) : Math.round(v);
        }
        if (parentKey && /quota|limit|usage|rate/i.test(parentKey) &&
            /^(pct|percent|fraction|ratio|used)$/i.test(k) &&
            v >= 0 && v <= 100) {
          return v <= 1 ? Math.round(v * 100) : Math.round(v);
        }
      }
      if (v && typeof v === 'object') {
        const r = findUsagePct(v, depth + 1, k);
        if (r != null) return r;
      }
    }
    return null;
  }

  function post(type, payload) {
    window.postMessage({ __cw: true, type, ...payload }, '*');
  }
})();
