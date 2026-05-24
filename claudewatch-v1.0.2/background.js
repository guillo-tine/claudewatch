/**
 * ClaudeWatch background service worker (Manifest V3).
 * Handles: anonymous identity, usage probing, Supabase submission, local stats,
 * and cross-device conversation sync.
 */

// ---- Debug ----
const CW_DEBUG = false; // set to true locally to trace issues; never true in a release build
const dbg = (...a) => { if (CW_DEBUG) console.log('[CW:bg]', new Date().toTimeString().slice(0,8), ...a); };

// ---- Config ----
const SUPABASE_URL = 'https://gjnlwtiqiwkjgobcbafo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqbmx3dGlxaXdramdvYmNiYWZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODExMjUsImV4cCI6MjA5NTA1NzEyNX0.6H2dJ2eUPQFTL73CC7Gt_gDokc-PNo8kPaurhtxTNb0';
const SUBMIT_COOLDOWN_MS = 30_000;
const MAX_QUEUE_SIZE = 50;

// ---- Cross-device sync: in-memory Set of conversation IDs captured via SSE ----
// Conversations in this set were active on THIS device; syncConversations updates
// their baseline but doesn't emit exchanges (already counted by EXCHANGE_COMPLETE).
// Resets on service-worker restart (~30 s idle in MV3), which is intentional:
// after restart the stored leafMsgIds are accurate, so no double-counting occurs.
const sseConversationIds = new Set();

// ---- Helpers ----

function supabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Prefer': 'return=minimal',
  };
}

async function generateUUID() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40;
  arr[8] = (arr[8] & 0x3f) | 0x80;
  const hex = [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ---- Identity ----

async function ensureIdentity() {
  const stored = await chrome.storage.local.get([
    'anonymousId', 'deviceFingerprint', 'installDate', 'tier',
  ]);

  if (stored.anonymousId) return stored;

  // First install
  dbg('ensureIdentity: first install — generating new identity');
  const anonymousId = await generateUUID();
  // screen is not available in service workers — omit width/height from fingerprint
  const fpSource = [
    navigator.userAgent,
    navigator.language,
    navigator.hardwareConcurrency,
    navigator.deviceMemory || 0,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].join('|');
  const deviceFingerprint = await sha256(fpSource);
  const installDate = new Date().toISOString();

  const identity = { anonymousId, deviceFingerprint, installDate, tier: 'unknown' };
  await chrome.storage.local.set(identity);
  dbg('ensureIdentity: new anonymousId', anonymousId.slice(0,8) + '…');

  // Fire install event to Supabase (non-blocking)
  submitToSupabase('install_events', {
    anonymous_id: anonymousId,
    device_fingerprint: deviceFingerprint,
    tier: 'unknown',
    install_date: installDate,
    user_agent_hash: await sha256(navigator.userAgent),
  }).catch(() => {});

  return identity;
}

// ---- Daily stats ----

async function getTodayStats() {
  const { todayStats } = await chrome.storage.local.get({ todayStats: null });
  const today = todayUTC();

  if (todayStats && todayStats.date === today) return todayStats;

  dbg('getTodayStats: new day, resetting stats');
  const fresh = {
    date: today,
    messagesSent: 0,
    tokensIn: 0,
    tokensOut: 0,
    attachmentTokens: 0,
    rateLimitsHit: 0,
    sessionDurationMinutes: 0,
  };
  await chrome.storage.local.set({ todayStats: fresh });
  return fresh;
}

async function updateStats(exchange) {
  const [todayStats, { allTimeStats }] = await Promise.all([
    getTodayStats(),
    chrome.storage.local.get({
      allTimeStats: { messagesSent: 0, tokensIn: 0, tokensOut: 0, rateLimitsHit: 0 },
    }),
  ]);

  todayStats.messagesSent += 1;
  todayStats.tokensIn += exchange.tokensIn || 0;
  todayStats.tokensOut += exchange.tokensOut || 0;
  todayStats.attachmentTokens += exchange.attachmentTokensEstimated || 0;
  if (exchange.hitLimit) todayStats.rateLimitsHit += 1;

  allTimeStats.messagesSent += 1;
  allTimeStats.tokensIn += exchange.tokensIn || 0;
  allTimeStats.tokensOut += exchange.tokensOut || 0;
  if (exchange.hitLimit) allTimeStats.rateLimitsHit += 1;

  await chrome.storage.local.set({ todayStats, allTimeStats });
  dbg('updateStats: today msgs=' + todayStats.messagesSent +
      ' tokIn=' + todayStats.tokensIn + ' tokOut=' + todayStats.tokensOut);
}

// ---- Supabase submission ----

let lastSubmitTime = 0;

async function submitToSupabase(table, record) {
  dbg('submitToSupabase:', table, JSON.stringify(record).slice(0, 120) + '…');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `Supabase ${table} insert failed: ${res.status} ${text}`;
    dbg('submitToSupabase FAILED:', msg);
    throw new Error(msg);
  }
  dbg('submitToSupabase OK:', table);
}

async function flushQueue() {
  const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
  if (pendingQueue.length === 0) return;

  dbg('flushQueue: flushing', pendingQueue.length, 'queued items');
  const batch = pendingQueue.splice(0, 10); // process up to 10 at a time
  const failed = [];

  for (const item of batch) {
    try {
      await submitToSupabase(item.table, item.record);
    } catch (_) {
      failed.push(item);
    }
  }

  const remaining = [...failed, ...pendingQueue];
  dbg('flushQueue: done, failed=' + failed.length + ' remaining=' + remaining.length);
  await chrome.storage.local.set({ pendingQueue: remaining.slice(0, MAX_QUEUE_SIZE) });
}

async function queueOrSubmit(table, record) {
  const now = Date.now();
  if (now - lastSubmitTime < SUBMIT_COOLDOWN_MS) {
    dbg('queueOrSubmit: cooldown active, queuing', table);
    const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
    pendingQueue.push({ table, record });
    if (pendingQueue.length > MAX_QUEUE_SIZE) pendingQueue.shift();
    await chrome.storage.local.set({ pendingQueue });
    return;
  }

  lastSubmitTime = now;
  dbg('queueOrSubmit: submitting', table);
  try {
    await submitToSupabase(table, record);
    await flushQueue();
  } catch (_) {
    dbg('queueOrSubmit: submit failed, queuing for retry');
    const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
    pendingQueue.push({ table, record });
    if (pendingQueue.length > MAX_QUEUE_SIZE) pendingQueue.shift();
    await chrome.storage.local.set({ pendingQueue });
  }
}

// ---- Exchange handler ----

async function handleExchange(exchange) {
  const source = exchange.source || 'unknown';
  dbg('handleExchange:', {
    source,
    model: exchange.model,
    tokensIn: exchange.tokensIn,
    tokensOut: exchange.tokensOut,
    durationMs: exchange.responseDurationMs,
    tps: exchange.tokensPerSecond,
    hitLimit: exchange.hitLimit,
    partial: exchange.partial,
    convId: exchange.conversationId ? exchange.conversationId.slice(0,8) + '…' : '(none)',
  });

  const { anonymousId, deviceFingerprint, tier } = await ensureIdentity();

  // Validate numeric fields to avoid sending garbage from broken DOM reads
  const tokensIn  = Math.min(Math.max(0, parseInt(exchange.tokensIn)  || 0), 499999);
  const tokensOut = Math.min(Math.max(0, parseInt(exchange.tokensOut) || 0), 499999);
  const attachmentTokens = Math.min(Math.max(0, parseInt(exchange.attachmentTokensEstimated) || 0), 499999);
  const responseDurationMs = exchange.responseDurationMs != null
    ? Math.max(0, parseInt(exchange.responseDurationMs) || 0)
    : null;
  const tokensPerSecond = exchange.tokensPerSecond != null
    ? parseFloat(exchange.tokensPerSecond)
    : null;

  // Cap string fields that originate from DOM to prevent unbounded storage
  const model = String(exchange.model || 'unknown').slice(0, 100);
  const limitMessage = exchange.limitMessage ? String(exchange.limitMessage).slice(0, 500) : null;

  await updateStats({ ...exchange, tokensIn, tokensOut, attachmentTokensEstimated: attachmentTokens });

  // Persist model info so popup can display it
  await chrome.storage.local.set({ lastModel: model, lastAdaptive: !!exchange.adaptiveMode });

  // NOTE: 'source' is tracked internally for debugging only. It is NOT sent to
  // Supabase to avoid schema changes and remains invisible to users/the Vercel page.
  const record = {
    anonymous_id: anonymousId,
    device_fingerprint: deviceFingerprint,
    timestamp: exchange.timestamp,
    model,
    adaptive_mode: !!exchange.adaptiveMode,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    attachment_tokens_estimated: attachmentTokens,
    response_duration_ms: responseDurationMs,
    tokens_per_second: tokensPerSecond,
    hit_limit: !!exchange.hitLimit,
    limit_message: limitMessage,
    partial: !!exchange.partial,
    tier,
  };

  await queueOrSubmit('exchanges', record);
}

// ---- Usage reading handler (shared by USAGE_READING message and probe) ----

async function handleUsageReading({ usagePercent, resetsInMinutes, tier }) {
  // Validate — reject NaN, Infinity, or anything outside a plausible 0–100 range
  const pctNum = Number(usagePercent);
  if (!isFinite(pctNum) || pctNum < 0 || pctNum > 100) {
    dbg('handleUsageReading: invalid value rejected:', usagePercent);
    return;
  }
  usagePercent = Math.round(pctNum);

  const now = new Date().toISOString();

  const stored = await chrome.storage.local.get({
    sessionStartPercent: null,
    lastUsageSnapshot: null,
    tier: 'unknown',
  });

  // First reading of the session becomes the baseline for session delta
  const sessionStart = stored.sessionStartPercent ?? usagePercent;
  const sessionDelta = +(usagePercent - sessionStart).toFixed(1);

  const resolvedTier = (tier && tier !== 'unknown') ? tier : stored.tier;

  const snapshot = {
    usagePercent,
    resetsInMinutes,
    tier: resolvedTier,
    timestamp: now,
    sessionStart,
    sessionDelta,
  };

  await chrome.storage.local.set({
    lastUsageSnapshot: snapshot,
    tier: resolvedTier,
    sessionStartPercent: sessionStart,
  });

  const prev = stored.lastUsageSnapshot;
  const changed = !prev || Math.abs(prev.usagePercent - usagePercent) >= 1;

  dbg('handleUsageReading:', usagePercent + '%',
      'resetsIn=' + (resetsInMinutes != null ? resetsInMinutes + 'm' : 'unknown'),
      'sessionDelta=' + sessionDelta,
      'tier=' + resolvedTier,
      changed ? '(CHANGED — submitting)' : '(unchanged — skip)');

  // Submit to Supabase only if value changed by at least 1%
  if (changed) {
    const { anonymousId } = await ensureIdentity();
    await queueOrSubmit('usage_snapshots', {
      anonymous_id: anonymousId,
      usage_percent: usagePercent,
      resets_in_minutes: resetsInMinutes,
      tier: resolvedTier,
      timestamp: now,
    });
  }
}

// ---- Usage probe (fully automatic, no user action required) ----
//
// Tier 1 — passive scan: interceptor.js already scans every JSON API response
//   for usage % fields. If any normal page call contains usage data it is posted
//   immediately, no probing needed.
//
// Tier 2 — active candidate probing (invisible, no tabs):
//   On every page load, interceptor.js fires probeUsageCandidates() as soon as
//   the org ID is known. It tries ~3 plausible API paths (same-origin fetch with
//   implicit credentials). If any returns a valid usage %, it posts __CW_USAGE_URL
//   which content.js caches in storage. From that point on all probes are instant
//   and require no tabs.
//   cwFastProbe (injected via executeScript into an existing tab) mirrors the same
//   candidate logic for the periodic alarm path.
//
// Tier 3 — background tab fallback (at most once per 5 minutes):
//   Only reached when neither passive scan nor active probing has found the URL
//   yet (e.g. fresh install, first ever page load). Opens /settings/usage with
//   active:false. settings.js reads the rendered page, fires USAGE_READING, and
//   the tab is immediately closed. Once interceptor.js captures the URL from that
//   load, tier 3 is never needed again.

// In-memory: last time we opened a background tab (resets on service-worker restart).
let lastTabProbeTime = 0;
const TAB_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Self-contained function injected into a tab via executeScript(world:'MAIN').
// Must not reference anything from the outer closure.
//
// Strategy:
//   1. If usageUrl is provided and still valid → use it directly.
//   2. Otherwise, try a list of candidate endpoints using window.__cw_orgId /
//      window.__cw_accountId (set by interceptor.js on normal page traffic).
//      This is the no-tab, zero-user-action discovery path.
// Returns: { urlValid, usagePercent, resetsInMinutes, discoveredUrl? }
//   discoveredUrl is set when a candidate URL was found (background.js caches it).
//   urlValid:false means the provided usageUrl is stale (caller should clear it).
function cwFastProbe(usageUrl) {
  // All helpers must be self-contained — no outer-closure references allowed.

  // Parser for the confirmed usage endpoint: /api/organizations/{orgId}/usage
  // { five_hour: { utilization: N, resets_at: "ISO" }, seven_day: { ... }, ... }
  // Returns the MAX utilization across all non-null windows + its reset time, or null.
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

  // Generic fallback scanner for any other endpoint that might have usage data.
  function findPct(obj, depth, parentKey) {
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
        const r = findPct(v, depth + 1, k);
        if (r != null) return r;
      }
    }
    return null;
  }

  async function tryUrl(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    const data = await res.json();
    // Try the known structure first, then the generic scanner
    const orgUsage = parseOrgUsage(data);
    if (orgUsage) return orgUsage;
    const pct = findPct(data);
    if (pct === null || pct < 0 || pct > 100) return null;
    return { usagePercent: pct, resetsInMinutes: null };
  }

  return (async () => {
    // --- Path 1: use the known cached URL ---
    if (usageUrl) {
      try {
        const hit = await tryUrl(usageUrl);
        if (hit) return { urlValid: true, ...hit };
        return { urlValid: false }; // non-200, non-JSON, or no usage % → stale
      } catch (_) {
        return { urlValid: false };
      }
    }

    // --- Path 2: construct URL directly from known pattern, fall back to candidates ---
    // /api/organizations/{orgId}/usage was confirmed by diagnostic output.
    const orgId     = (typeof window !== 'undefined' && window.__cw_orgId)     || null;
    const accountId = (typeof window !== 'undefined' && window.__cw_accountId) || null;
    if (!orgId && !accountId) return { urlValid: false };

    const candidates = [
      orgId     && `/api/organizations/${orgId}/usage`,   // confirmed — always try first
      orgId     && `/api/organizations/${orgId}`,
      orgId     && `/api/organizations/${orgId}/rate_limit_status`,
      accountId && `/api/accounts/${accountId}/usage`,
    ].filter(Boolean);

    for (const url of candidates) {
      try {
        const hit = await tryUrl(url);
        if (hit) return { urlValid: true, discoveredUrl: url, ...hit };
      } catch (_) {}
    }

    return { urlValid: false };
  })();
}

async function probeViaSettingsTab() {
  dbg('probeViaSettingsTab: opening background tab');
  // Guard: don't open a second probe tab if one is already in flight
  const stored = await chrome.storage.local.get({ probeTabId: null });
  if (stored.probeTabId != null) {
    try {
      await chrome.tabs.get(stored.probeTabId);
      dbg('probeViaSettingsTab: tab already open, skipping');
      return; // Tab still exists — let it finish
    } catch (_) {
      await chrome.storage.local.remove('probeTabId');
    }
  }

  try {
    // active: false → opens in the background without stealing focus.
    const tab = await chrome.tabs.create({
      url: 'https://claude.ai/settings/usage',
      active: false,
    });
    lastTabProbeTime = Date.now();
    await chrome.storage.local.set({ probeTabId: tab.id });
    dbg('probeViaSettingsTab: tab', tab.id, 'opened');

    // Safety net: force-close after 20 s if settings.js never fires.
    setTimeout(async () => {
      const s = await chrome.storage.local.get({ probeTabId: null });
      if (s.probeTabId === tab.id) {
        dbg('probeViaSettingsTab: safety-net close for tab', tab.id);
        chrome.tabs.remove(tab.id).catch(() => {});
        chrome.storage.local.remove('probeTabId');
      }
    }, 20000);
  } catch (err) {
    dbg('probeViaSettingsTab error:', err.message);
  }
}

// allowTabFallback: true for the 1-min alarm (may open a tab if needed);
//                  false for POLL_NOW from content.js (fast path only).
async function runUsageProbe(allowTabFallback = false) {
  try {
    // Only probe when claude.ai is actually open (confirms the user is logged in)
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    if (!claudeTabs.length) {
      dbg('runUsageProbe: no claude.ai tabs open, skipping');
      return;
    }

    const { cachedUsageUrl } = await chrome.storage.local.get({ cachedUsageUrl: null });
    dbg('runUsageProbe: tabs=' + claudeTabs.length + ' cachedUrl=' + (cachedUsageUrl || 'none'));

    // If the settings page is already open, run settings.js there directly —
    // it reads the live rendered DOM which is the most authoritative source.
    const settingsTabs = claudeTabs.filter(t => t.url && t.url.includes('/settings/usage'));
    if (settingsTabs.length) {
      dbg('runUsageProbe: settings tab open — injecting settings.js');
      chrome.scripting.executeScript({
        target: { tabId: settingsTabs[0].id },
        files: ['settings.js'],
      }).catch(() => {});
      return;
    }

    // --- Fast path: inject cwFastProbe into an existing chat tab ---
    const targetTab = claudeTabs.find(t => t.url && !t.url.includes('/settings/'));
    if (targetTab) {
      dbg('runUsageProbe: injecting cwFastProbe into tab', targetTab.id);
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: 'MAIN',
          func: cwFastProbe,
          args: [cachedUsageUrl],  // null is fine — cwFastProbe tries candidates
        });
        const result = results?.[0]?.result;
        dbg('runUsageProbe: probe result:', JSON.stringify(result));

        // Persist a URL newly discovered via candidate probing
        if (result?.discoveredUrl) {
          dbg('runUsageProbe: caching newly discovered URL:', result.discoveredUrl);
          await chrome.storage.local.set({ cachedUsageUrl: result.discoveredUrl });
        }
        // Clear a stale known URL so the tab fallback can rediscover a fresh one
        if (result?.urlValid === false && cachedUsageUrl) {
          dbg('runUsageProbe: clearing stale cachedUsageUrl');
          await chrome.storage.local.remove('cachedUsageUrl');
        }
        if (result?.usagePercent != null) {
          await handleUsageReading({
            usagePercent: result.usagePercent,
            resetsInMinutes: result.resetsInMinutes ?? null,
            tier: 'unknown',
          });
          return; // Done — no tab needed
        }
        dbg('runUsageProbe: no usage% from fast probe, falling through');
      } catch (err) {
        dbg('runUsageProbe: executeScript error:', err.message);
        // Tab navigated away etc. — fall through to tab fallback
      }
    }

    // --- Tab fallback: only if allowed and not triggered recently ---
    if (!allowTabFallback) {
      dbg('runUsageProbe: tab fallback not allowed (POLL_NOW path)');
      return;
    }
    const sinceLastTab = Date.now() - lastTabProbeTime;
    if (sinceLastTab < TAB_PROBE_INTERVAL_MS) {
      dbg('runUsageProbe: tab fallback throttled (' + Math.round(sinceLastTab/1000) + 's since last)');
      return;
    }

    await probeViaSettingsTab();
  } catch (err) {
    dbg('runUsageProbe error:', err.message);
  }
}

// ---- Cross-device conversation sync ----

/**
 * Sends SYNC_CONVERSATIONS to an existing claude.ai content-script, which fetches
 * the conversation list and detail for any conversations updated since last sync.
 * Returns synthetic exchanges (source='api_estimated') for cross-device messages.
 * Called from the 1-minute alarm alongside runUsageProbe.
 */
async function syncConversations() {
  dbg('syncConversations start');
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    const targetTab = tabs.find(t => t.url && !t.url.includes('/settings/'));
    if (!targetTab) {
      dbg('syncConversations: no suitable claude.ai tab found');
      return;
    }

    const { convSyncState = {}, convSyncLastAt = null } =
      await chrome.storage.local.get({ convSyncState: {}, convSyncLastAt: null });

    dbg('syncConversations: sending to tab', targetTab.id,
        '| lastAt=' + (convSyncLastAt ? new Date(convSyncLastAt).toTimeString().slice(0,8) : 'never'),
        '| storedConvs=' + Object.keys(convSyncState).length,
        '| sseIds=' + sseConversationIds.size);

    let response;
    try {
      response = await chrome.tabs.sendMessage(targetTab.id, {
        type: 'SYNC_CONVERSATIONS',
        lastSyncedAt:  convSyncLastAt,
        convSyncState,
        sseConvIds:    [...sseConversationIds],
      });
    } catch (msgErr) {
      dbg('syncConversations: sendMessage failed (content script not ready?):', msgErr.message);
      return;
    }

    if (!response) {
      dbg('syncConversations: no response from content script');
      return;
    }
    if (response.error) {
      dbg('syncConversations: content script reported error:', response.error);
      return;
    }

    const { exchanges = [], newState } = response;
    dbg('syncConversations: received', exchanges.length, 'exchanges from content script');

    for (const exchange of exchanges) {
      dbg('syncConversations: processing api_estimated exchange:',
          exchange.model, 'tokIn=' + exchange.tokensIn, 'tokOut=' + exchange.tokensOut,
          'convId=' + (exchange.conversationId ? exchange.conversationId.slice(0,8) + '…' : '?'));
      await handleExchange(exchange);
    }

    if (newState) {
      await chrome.storage.local.set({
        convSyncState: newState,
        convSyncLastAt: new Date().toISOString(),
      });
      dbg('syncConversations: state saved, convs tracked:', Object.keys(newState).length);
    }

    dbg('syncConversations complete');
  } catch (err) {
    dbg('syncConversations error:', err.message);
  }
}

// ---- Message listener ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'EXCHANGE_COMPLETE') {
    const exchange = msg.exchange;
    dbg('MSG EXCHANGE_COMPLETE: source=' + (exchange?.source || 'unknown') +
        ' model=' + exchange?.model +
        ' tokIn=' + exchange?.tokensIn + ' tokOut=' + exchange?.tokensOut +
        ' convId=' + (exchange?.conversationId ? exchange.conversationId.slice(0,8) + '…' : 'none'));

    // Track conversation as SSE-active to avoid double-counting in syncConversations
    if (exchange?.conversationId) {
      sseConversationIds.add(exchange.conversationId);
      dbg('sseConversationIds size:', sseConversationIds.size);
    }

    handleExchange(exchange).catch(() => {});
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATS') {
    dbg('MSG GET_STATS');
    Promise.all([
      getTodayStats(),
      chrome.storage.local.get({
        allTimeStats: { messagesSent: 0, tokensIn: 0, tokensOut: 0, rateLimitsHit: 0 },
        lastUsageSnapshot: null,
        tier: 'unknown',
        anonymousId: null,
        displayName: null,
        extensionEnabled: true,
      }),
    ]).then(([todayStats, rest]) => {
      sendResponse({ todayStats, ...rest });
    });
    return true; // async
  }

  if (msg.type === 'SET_ENABLED') {
    dbg('MSG SET_ENABLED:', msg.enabled);
    chrome.storage.local.set({ extensionEnabled: msg.enabled });
    sendResponse({ ok: true });
  }

  if (msg.type === 'SET_DISPLAY_NAME') {
    dbg('MSG SET_DISPLAY_NAME:', msg.name);
    chrome.storage.local.set({ displayName: msg.name });
    sendResponse({ ok: true });
  }

  if (msg.type === 'EXPORT_DATA') {
    dbg('MSG EXPORT_DATA');
    chrome.storage.local.get(null, data => {
      // Strip device fingerprint from export
      const safe = { ...data };
      delete safe.deviceFingerprint;
      delete safe.pendingQueue;
      delete safe.errorLog;
      sendResponse({ data: safe });
    });
    return true;
  }

  if (msg.type === 'AWAY_SYNC') {
    // Fired by content.js on tab (re)open when last sync was stale.
    // Runs syncConversations immediately so newly-arrived messages are counted
    // before the user sees the UI, then resolves so the toast can hide.
    dbg('MSG AWAY_SYNC: running immediate catch-up sync');
    syncConversations()
      .then(() => { dbg('AWAY_SYNC complete'); sendResponse({ ok: true }); })
      .catch(err => { dbg('AWAY_SYNC error:', err.message); sendResponse({ ok: false }); });
    return true; // async
  }

  if (msg.type === 'POLL_NOW') {
    // Fast path only — no background tabs from content-script-driven polls.
    // activeConvId (if present) pre-registers the conversation as SSE-active so
    // the concurrent sync doesn't count it again.
    if (msg.activeConvId) {
      sseConversationIds.add(msg.activeConvId);
      dbg('MSG POLL_NOW: activeConvId=' + msg.activeConvId.slice(0,8) + '… added to sseIds');
    } else {
      dbg('MSG POLL_NOW');
    }
    runUsageProbe(false).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'USAGE_READING') {
    // Sent by settings.js (when user visits /settings/usage) or interceptor.js.
    // If the reading came from the background probe tab we opened, close that tab
    // immediately — we have the data we needed.
    const senderTabId = _sender?.tab?.id ?? null;
    dbg('MSG USAGE_READING:', msg.usagePercent + '%', 'from tab', senderTabId);
    handleUsageReading({
      usagePercent:    msg.usagePercent,
      resetsInMinutes: msg.resetsInMinutes,
      tier:            msg.tier,
    }).then(async () => {
      if (senderTabId != null) {
        const s = await chrome.storage.local.get({ probeTabId: null });
        if (s.probeTabId === senderTabId) {
          dbg('USAGE_READING: closing probe tab', senderTabId);
          chrome.tabs.remove(senderTabId).catch(() => {});
          chrome.storage.local.remove('probeTabId');
        }
      }
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ---- Settings page injection (SPA navigation) ----
// Content scripts only fire on full-page loads. When the user navigates to
// /settings/usage via Claude's SPA router, we inject settings.js programmatically.

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && changeInfo.url.startsWith('https://claude.ai/settings/usage')) {
    dbg('tabs.onUpdated: injecting settings.js into tab', tabId);
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['settings.js'],
    }).catch(() => {});
  }
});

// ---- Alarm: periodic usage probe + cross-device sync ----

function setupAlarm() {
  // Probe every minute — Chrome's minimum alarm interval in MV3.
  chrome.alarms.create('usage-probe', { periodInMinutes: 1 });
  dbg('alarm created: usage-probe (1 min)');
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'usage-probe') {
    dbg('alarm fired: usage-probe');
    // allowTabFallback: true — the 1-min alarm may open a background tab
    // if no cached URL exists yet and 5 min have elapsed since the last tab open.
    runUsageProbe(true).catch(() => {});
    // Cross-device sync runs on the same cadence as the usage probe.
    syncConversations().catch(() => {});
  }
});

// ---- Install / startup ----

chrome.runtime.onInstalled.addListener(() => {
  dbg('onInstalled');
  ensureIdentity();
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  dbg('onStartup');
  ensureIdentity();
  setupAlarm();
  // Reset session baseline on browser restart so delta tracks this session only
  chrome.storage.local.remove('sessionStartPercent');
});
