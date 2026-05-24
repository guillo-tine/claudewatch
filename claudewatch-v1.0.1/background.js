/**
 * ClaudeWatch background service worker (Manifest V3).
 * Handles: anonymous identity, usage page polling, Supabase submission, local stats.
 */

// ---- Config ----
const SUPABASE_URL = 'https://gjnlwtiqiwkjgobcbafo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqbmx3dGlxaXdramdvYmNiYWZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODExMjUsImV4cCI6MjA5NTA1NzEyNX0.6H2dJ2eUPQFTL73CC7Gt_gDokc-PNo8kPaurhtxTNb0';
const USAGE_PAGE_URL = 'https://claude.ai/settings/usage';
const SUBMIT_COOLDOWN_MS = 30_000;
const MAX_QUEUE_SIZE = 50;

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

  // New day — reset
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
}

// ---- Supabase submission ----

let lastSubmitTime = 0;

async function submitToSupabase(table, record) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${table} insert failed: ${res.status} ${text}`);
  }
}

async function flushQueue() {
  const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
  if (pendingQueue.length === 0) return;

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
  await chrome.storage.local.set({ pendingQueue: remaining.slice(0, MAX_QUEUE_SIZE) });
}

async function queueOrSubmit(table, record) {
  const now = Date.now();
  if (now - lastSubmitTime < SUBMIT_COOLDOWN_MS) {
    // Queue it
    const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
    pendingQueue.push({ table, record });
    if (pendingQueue.length > MAX_QUEUE_SIZE) pendingQueue.shift();
    await chrome.storage.local.set({ pendingQueue });
    return;
  }

  lastSubmitTime = now;
  try {
    await submitToSupabase(table, record);
    await flushQueue();
  } catch (_) {
    const { pendingQueue = [] } = await chrome.storage.local.get({ pendingQueue: [] });
    pendingQueue.push({ table, record });
    if (pendingQueue.length > MAX_QUEUE_SIZE) pendingQueue.shift();
    await chrome.storage.local.set({ pendingQueue });
  }
}

// ---- Exchange handler ----

async function handleExchange(exchange) {
  const { anonymousId, deviceFingerprint, tier } = await ensureIdentity();

  // Validate numeric fields to avoid sending garbage from broken DOM reads
  const tokensIn  = Math.min(Math.max(0, parseInt(exchange.tokensIn)  || 0), 499999);
  const tokensOut = Math.min(Math.max(0, parseInt(exchange.tokensOut) || 0), 499999);
  const attachmentTokens = Math.min(Math.max(0, parseInt(exchange.attachmentTokensEstimated) || 0), 499999);
  const responseDurationMs = exchange.responseDurationMs != null
    ? Math.max(0, parseInt(exchange.responseDurationMs) || 0)
    : null;
  // Avoid 0 || null coercing a legitimate 0 value — use explicit null check
  const tokensPerSecond = exchange.tokensPerSecond != null
    ? parseFloat(exchange.tokensPerSecond)
    : null;

  // Cap string fields that originate from DOM to prevent unbounded storage
  const model = String(exchange.model || 'unknown').slice(0, 100);
  const limitMessage = exchange.limitMessage ? String(exchange.limitMessage).slice(0, 500) : null;

  await updateStats({ ...exchange, tokensIn, tokensOut, attachmentTokensEstimated: attachmentTokens });

  // Persist model info so popup can display it
  await chrome.storage.local.set({ lastModel: model, lastAdaptive: !!exchange.adaptiveMode });

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

// ---- Usage page polling ----

async function pollUsagePage() {
  try {
    const res = await fetch(USAGE_PAGE_URL, {
      credentials: 'include',
      headers: { 'Accept': 'text/html' },
    });
    if (!res.ok) return;

    const html = await res.text();
    const { parseUsagePage } = await import('./platforms/claude.js');
    const { usagePercent, resetsInMinutes, tier } = parseUsagePage(html);

    if (usagePercent === null) return;

    const { lastUsageSnapshot } = await chrome.storage.local.get({ lastUsageSnapshot: null });
    const now = new Date().toISOString();

    const changed =
      !lastUsageSnapshot ||
      lastUsageSnapshot.usagePercent !== usagePercent ||
      Date.now() - new Date(lastUsageSnapshot.timestamp).getTime() > 60 * 60 * 1000;

    const snapshot = { usagePercent, resetsInMinutes, tier, timestamp: now };
    await chrome.storage.local.set({ lastUsageSnapshot: snapshot, tier });

    if (changed) {
      const { anonymousId } = await ensureIdentity();
      await queueOrSubmit('usage_snapshots', {
        anonymous_id: anonymousId,
        usage_percent: usagePercent,
        resets_in_minutes: resetsInMinutes,
        tier,
        timestamp: now,
      });
    }
  } catch (_) {
    // Polling failure is non-fatal
  }
}


// ---- Message listener ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'EXCHANGE_COMPLETE') {
    handleExchange(msg.exchange).catch(() => {});
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATS') {
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
    chrome.storage.local.set({ extensionEnabled: msg.enabled });
    sendResponse({ ok: true });
  }

  if (msg.type === 'SET_DISPLAY_NAME') {
    chrome.storage.local.set({ displayName: msg.name });
    sendResponse({ ok: true });
  }

  if (msg.type === 'EXPORT_DATA') {
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

  if (msg.type === 'POLL_NOW') {
    pollUsagePage().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'USAGE_READING') {
    (async () => {
      const { usagePercent, resetsInMinutes, tier } = msg;
      const now = new Date().toISOString();

      const stored = await chrome.storage.local.get({
        sessionStartPercent: null,
        lastUsageSnapshot: null,
        tier: 'unknown',
      });

      // First reading of the session becomes the baseline
      const sessionStart = stored.sessionStartPercent ?? usagePercent;
      const sessionDelta = +(usagePercent - sessionStart).toFixed(1);

      const snapshot = {
        usagePercent,
        resetsInMinutes,
        tier: tier !== 'unknown' ? tier : stored.tier,
        timestamp: now,
        sessionStart,
        sessionDelta,
      };

      await chrome.storage.local.set({
        lastUsageSnapshot: snapshot,
        tier: snapshot.tier,
        sessionStartPercent: sessionStart,
      });

      // Submit to Supabase if value changed by at least 1%
      const prev = stored.lastUsageSnapshot;
      const changed = !prev || Math.abs(prev.usagePercent - usagePercent) >= 1;
      if (changed) {
        const { anonymousId } = await ensureIdentity();
        await queueOrSubmit('usage_snapshots', {
          anonymous_id: anonymousId,
          usage_percent: usagePercent,
          resets_in_minutes: resetsInMinutes,
          tier: snapshot.tier,
          timestamp: now,
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// ---- Install / startup ----

chrome.runtime.onInstalled.addListener(() => {
  ensureIdentity();
});

chrome.runtime.onStartup.addListener(() => {
  ensureIdentity();
  // Reset session baseline on browser restart so delta tracks this session only
  chrome.storage.local.remove('sessionStartPercent');
});
