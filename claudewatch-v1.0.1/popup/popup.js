/**
 * ClaudeWatch popup script.
 * Reads from background.js via chrome.runtime.sendMessage and from Supabase for community stats.
 */

const SUPABASE_URL = 'https://gjnlwtiqiwkjgobcbafo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqbmx3dGlxaXdramdvYmNiYWZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODExMjUsImV4cCI6MjA5NTA1NzEyNX0.6H2dJ2eUPQFTL73CC7Gt_gDokc-PNo8kPaurhtxTNb0';
const COMMUNITY_POLL_INTERVAL = 60_000;

// ---- Utility ----

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

function $(id) { return document.getElementById(id); }

function setNum(id, val) {
  const el = $(id);
  if (el) el.textContent = fmt(val);
}

// ---- Tab switching ----

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = $(`tab-${tab.dataset.tab}`);
    if (panel) panel.classList.add('active');

    if (tab.dataset.tab === 'community') loadCommunityStats();
  });
});

// Settings gear → jump to settings tab
$('settingsTab').addEventListener('click', () => {
  document.querySelector('[data-tab="settings"]').click();
});

// ---- Load local stats ----

async function loadStats() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, resolve);
  });
}

async function renderStats() {
  const data = await loadStats();
  if (!data) return;

  const { todayStats = {}, allTimeStats = {}, lastUsageSnapshot, tier, anonymousId, displayName, extensionEnabled } = data;

  setNum('today-messages', todayStats.messagesSent);
  setNum('today-tokens-in', todayStats.tokensIn);
  setNum('today-tokens-out', todayStats.tokensOut);
  setNum('today-attachments', todayStats.attachmentTokens);
  setNum('today-limits', todayStats.rateLimitsHit);

  setNum('all-messages', allTimeStats.messagesSent);
  setNum('all-tokens-in', allTimeStats.tokensIn);
  setNum('all-tokens-out', allTimeStats.tokensOut);
  setNum('all-limits', allTimeStats.rateLimitsHit);

  // Usage bar
  if (lastUsageSnapshot) {
    const pct = lastUsageSnapshot.usagePercent || 0;
    const bar = $('usage-bar');
    bar.style.width = `${pct}%`;
    bar.classList.toggle('high', pct >= 80);
    $('usage-pct').textContent = `${pct}%`;

    if (lastUsageSnapshot.resetsInMinutes != null) {
      const h = Math.floor(lastUsageSnapshot.resetsInMinutes / 60);
      const m = lastUsageSnapshot.resetsInMinutes % 60;
      $('usage-reset').textContent = `resets in ${h > 0 ? `${h}h ` : ''}${m}m`;
    }

    const delta = lastUsageSnapshot.sessionDelta;
    if (delta != null && delta !== 0) {
      $('usage-session-delta').textContent = `this session: ${delta >= 0 ? '+' : ''}${delta}%`;
    }
  }

  // Model / tier meta rows — escape values before injecting into innerHTML
  chrome.storage.local.get(['lastModel', 'lastAdaptive'], ({ lastModel, lastAdaptive }) => {
    if (lastModel) {
      $('model-row').innerHTML = `Model in use: <strong>${escapeHtml(lastModel)}${lastAdaptive ? ' Adaptive' : ''}</strong>`;
    }
  });

  if (tier && tier !== 'unknown') {
    $('tier-row').innerHTML = `Tier detected: <strong>${escapeHtml(tier.charAt(0).toUpperCase() + tier.slice(1))}</strong>`;
  }

  // Settings tab
  if (anonymousId) {
    $('anon-id').textContent = `${anonymousId.slice(0, 4)}…${anonymousId.slice(-4)}`;
    $('anon-id').title = anonymousId;
  }

  if (displayName) $('display-name').value = displayName;

  $('enabled-toggle').checked = extensionEnabled !== false;
}

// ---- Settings handlers ----

$('copy-id').addEventListener('click', () => {
  chrome.storage.local.get('anonymousId', ({ anonymousId }) => {
    if (anonymousId) navigator.clipboard.writeText(anonymousId);
  });
});

$('save-name').addEventListener('click', () => {
  const name = $('display-name').value.trim().slice(0, 32);
  chrome.runtime.sendMessage({ type: 'SET_DISPLAY_NAME', name });
});

$('enabled-toggle').addEventListener('change', e => {
  chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: e.target.checked });
});

$('export-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_DATA' }, ({ data }) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claudewatch-data.json';
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ---- Community stats ----

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

async function loadCommunityStats() {
  try {
    const since24h = new Date(Date.now() - 86400000).toISOString();

    // Aggregate stats via Supabase RPC
    const [statsData, posts] = await Promise.all([
      supabaseFetch(`rpc/community_stats?since=${encodeURIComponent(since24h)}`),
      supabaseFetch(`community_posts?flagged=eq.false&order=created_at.desc&limit=20`),
    ]);

    if (statsData) {
      setNum('c-active', statsData.active_users);
      setNum('c-avg-tokens', statsData.avg_tokens_out);
      setNum('c-limits', statsData.rate_limit_events);
      $('c-usage-pro').textContent = statsData.median_usage_pro != null ? `${statsData.median_usage_pro}%` : '—';
      $('c-usage-free').textContent = statsData.median_usage_free != null ? `${statsData.median_usage_free}%` : '—';
    }

    $('community-age').textContent = 'updated just now';
    renderPosts(posts || []);
  } catch (_) {
    $('community-age').textContent = 'offline';
  }
}

function renderPosts(posts) {
  const list = $('posts-list');
  if (!posts.length) {
    list.innerHTML = '<div class="dim loading-msg">No posts yet. Be the first!</div>';
    return;
  }

  list.innerHTML = '';
  posts.forEach(post => {
    const el = document.createElement('div');
    el.className = 'post-item';
    // post.id is a UUID from Supabase; escapeHtml is defense-in-depth
    const safeId = escapeHtml(String(post.id || ''));
    const ups = parseInt(post.upvotes) || 0;
    const downs = parseInt(post.downvotes) || 0;
    el.innerHTML = `
      <div class="post-text">${escapeHtml(post.content)}</div>
      <div class="post-meta">
        <button class="post-vote up" data-id="${safeId}" data-dir="up">▲ ${ups}</button>
        <button class="post-vote down" data-id="${safeId}" data-dir="down">▼ ${downs}</button>
        <button class="post-flag" data-id="${safeId}">flag</button>
      </div>
    `;
    list.appendChild(el);
  });

  // Attach vote/flag handlers
  list.querySelectorAll('.post-vote').forEach(btn => {
    btn.addEventListener('click', () => votePost(btn.dataset.id, btn.dataset.dir));
  });
  list.querySelectorAll('.post-flag').forEach(btn => {
    btn.addEventListener('click', () => flagPost(btn.dataset.id, btn));
  });
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function votePost(id, dir) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/vote_post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ post_id: id, direction: dir }),
    });
    loadCommunityStats();
  } catch (_) {}
}

async function flagPost(id, btn) {
  try {
    const { anonymousId } = await new Promise(resolve =>
      chrome.storage.local.get('anonymousId', resolve)
    );
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/flag_post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ post_id: id, flagging_anon_id: anonymousId }),
    });
    btn.textContent = 'flagged';
    btn.disabled = true;
  } catch (_) {}
}

// ---- Post compose ----

const postInput = $('post-input');
const charCount = $('char-count');
const URL_PATTERN = /https?:\/\/|www\.|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/;

postInput.addEventListener('input', () => {
  const len = postInput.value.length;
  charCount.textContent = `${len} / 280`;
  charCount.classList.toggle('near-limit', len > 240);
});

$('post-btn').addEventListener('click', async () => {
  const content = postInput.value.trim();
  if (!content) return;
  if (content.length > 280) return;
  if (URL_PATTERN.test(content)) {
    alert('Links are not allowed in community posts.');
    return;
  }

  const { anonymousId, displayName } = await new Promise(resolve =>
    chrome.storage.local.get(['anonymousId', 'displayName'], resolve)
  );

  const btn = $('post-btn');
  btn.disabled = true;
  btn.textContent = 'Posting…';

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/community_posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        anonymous_id: anonymousId,
        display_name: displayName || null,
        content,
      }),
    });

    if (res.ok) {
      postInput.value = '';
      charCount.textContent = '0 / 280';
      loadCommunityStats();
    } else {
      const err = await res.json().catch(() => ({}));
      alert(err.message || 'Post failed. You may have reached the daily limit.');
    }
  } catch (_) {
    alert('Network error. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post anonymously';
  }
});

// ---- Init ----

renderStats();

// Refresh stats every 30s while popup is open
setInterval(renderStats, 30_000);
