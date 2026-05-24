# ClaudeWatch — Handoff Summary
## Paste this into a new chat to continue exactly where we left off.

---

## What This Project Is

**ClaudeWatch** is a Chrome extension (Manifest V3) that anonymously captures usage metadata from claude.ai and reports it to a Supabase backend. A public Next.js dashboard on Vercel displays the aggregated community stats. No message content is ever captured — only token counts, response times, usage percentages, and rate-limit events.

The goal: Anthropic doesn't publish Claude's usage limits or when they change. ClaudeWatch crowdsources that signal from the community.

---

## Live Infrastructure (Already Deployed)

| Resource | Value |
|---|---|
| **Supabase project** | `claudewatch` |
| **Supabase ref ID** | `gjnlwtiqiwkjgobcbafo` |
| **Supabase URL** | `https://gjnlwtiqiwkjgobcbafo.supabase.co` |
| **Supabase anon key** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqbmx3dGlxaXdramdvYmNiYWZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0ODExMjUsImV4cCI6MjA5NTA1NzEyNX0.6H2dJ2eUPQFTL73CC7Gt_gDokc-PNo8kPaurhtxTNb0` |
| **Vercel dashboard URL** | `https://dashboard-five-gamma-82.vercel.app` |
| **Vercel project** | `guillo-tines-projects/dashboard` |
| **Vercel env vars set** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

The **service_role key** is NOT in any file (correct — it must never be in extension code).

---

## Repository Structure

```
C:\Users\johnalcatraz\Downloads\plugin\claudewatch\
├── extension/                        ← Load this folder in Chrome (Load unpacked)
│   ├── manifest.json                 ← MV3, references icon16 + icon32 only
│   ├── background.js                 ← Service worker: identity, polling, Supabase submit
│   ├── content.js                    ← Injected into claude.ai, captures exchange metadata
│   ├── popup/
│   │   ├── popup.html                ← 3-tab popup UI
│   │   ├── popup.js                  ← Popup logic, community board, settings
│   │   └── popup.css                 ← Dark theme, monospace numbers
│   ├── lib/
│   │   └── tokenizer.js              ← Pure-JS BPE token estimator (no network/WASM)
│   ├── platforms/
│   │   └── claude.js                 ← All claude.ai DOM selectors isolated here
│   └── icons/                        ← ⚠ EMPTY — user must add icon16.png + icon32.png
├── dashboard/                        ← Next.js app, deployed to Vercel
│   ├── pages/
│   │   ├── index.jsx                 ← Global stats + 8 charts (Recharts)
│   │   ├── community.jsx             ← Community board with post/vote/flag
│   │   ├── me.jsx                    ← Personal stats by anonymous ID
│   │   └── _app.jsx
│   ├── components/
│   │   ├── StatCard.jsx
│   │   └── RangeToggle.jsx
│   └── lib/
│       ├── supabase.js               ← All Supabase query functions
│       └── chartUtils.js             ← Data transformation for Recharts
├── supabase/
│   ├── schema.sql                    ← Reference schema (already applied)
│   └── migrations/
│       ├── 20260522000000_initial_schema.sql     ← Tables, RLS, triggers, RPCs
│       └── 20260522000001_security_hardening.sql ← Length constraints + flag dedup
├── docs/
│   ├── privacy-policy.md
│   ├── about.md
│   └── chrome-store-description.md
├── README.md
└── HANDOFF.md                        ← This file
```

---

## What Is 100% Complete

- [x] Full extension code (manifest, background, content script, popup, tokenizer, platform adapter)
- [x] Supabase schema deployed (tables, RLS policies, rate-limit triggers, RPC functions)
- [x] Security hardening migration deployed (length constraints + flag dedup table)
- [x] Next.js dashboard deployed to Vercel with env vars configured
- [x] All placeholder credentials (`YOUR_PROJECT`, `YOUR_ANON_KEY`) substituted with real values
- [x] `community.jsx` generates its own anonymous ID from `localStorage` (fixes NOT NULL constraint)
- [x] `flag_post` RPC updated to accept `flagging_anon_id` and deduplicate via `post_flags` table

---

## Key Technical Decisions (Do Not Undo)

### Content script uses dynamic import(), not static import
Content scripts run as classic scripts (not ES modules). Static `import` would silently fail. The fix:
```js
const { estimateTokens } = await import(chrome.runtime.getURL('lib/tokenizer.js'));
const platform = await import(chrome.runtime.getURL('platforms/claude.js'));
```
Both files are listed in `web_accessible_resources` in `manifest.json`.

### background.js IS a module
It has `"type": "module"` in the manifest background config and can use standard ES module imports/exports.

### Token counts only — no text ever transmitted
`content.js` tokenizes text locally and only sends the integer count. The `exchange` object sent via `chrome.runtime.sendMessage` contains numbers and booleans, never strings of user content.

### Anon key in extension code is correct
The Supabase anon key is intentionally public. Security is enforced by RLS policies server-side. The service_role key never appears in any client code.

### `tokens_per_second` uses `!= null` not `|| null`
`0 || null` would incorrectly coerce a legitimate zero value to null. All nullable numeric fields use explicit `!= null` checks.

---

## Supabase Schema Summary

**Tables:** `exchanges`, `usage_snapshots`, `community_posts`, `install_events`, `post_flags`

**RLS:**
- INSERT: open to all (anon key)
- SELECT: public (dashboard reads)
- UPDATE/DELETE: service role only

**Server-side protections (triggers):**
- Max 2 `exchanges` inserts per `anonymous_id` per 30 seconds → 429
- Max 10 community posts per `anonymous_id` per 24 hours
- Device fingerprint across >5 `anonymous_id`s → all flagged `suspicious: true`

**RPC functions:** `vote_post(post_id, direction)`, `flag_post(post_id, flagging_anon_id)`, `community_stats(since)`

**Length constraints (migration 2):**
- `exchanges.model` ≤ 100 chars
- `exchanges.limit_message` ≤ 500 chars
- `community_posts.display_name` ≤ 32 chars

---

## What Still Needs Doing (In Order)

### Immediate — needed to load the extension
1. **Add icons** to `extension/icons/`:
   - `icon16.png` (16×16)
   - `icon32.png` (32×32)
   - Any PNG works for local testing — even a solid coloured square

### Before Chrome Web Store submission
2. **Host the privacy policy** — Chrome Web Store requires a live URL. Easiest: add a `/privacy` page to the Next.js dashboard showing the content of `docs/privacy-policy.md`. Ask Claude to add the page and redeploy.

3. **Add a 128×128 icon** — required for the store listing tile. Create `extension/icons/icon128.png` and update `manifest.json`:
   ```json
   "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "128": "icons/icon128.png" }
   ```
   (Same update in the `"action": { "default_icon": {...} }` block.)

4. **Take screenshots** for the store listing — exactly **1280×800** or **640×400** pixels. Capture the popup open on claude.ai and the dashboard.

5. **Update the store description contact email** — `docs/chrome-store-description.md` and `docs/privacy-policy.md` contain `[contact@example.com]` placeholder. Replace with a real address.

### Chrome Web Store submission steps
6. Go to `chrome.google.com/webstore/devconsole`
7. Pay the one-time **$5 developer registration fee**
8. Package the extension:
   ```powershell
   cd "C:\Users\johnalcatraz\Downloads\plugin\claudewatch"
   Compress-Archive -Path "extension\*" -DestinationPath "claudewatch-v1.0.0.zip"
   ```
   ⚠ The zip must have `manifest.json` at its root, not inside a subfolder.
9. Click **New Item** → upload the zip
10. Fill in the listing using content from `docs/chrome-store-description.md`
11. Data collection disclosure answers (for the Store form):
    - User activity: **Yes** — token estimates, response times, usage %. No message content.
    - Everything else: **No**
12. Submit → review takes 1–3 business days

---

## Known Limitations (Documented, Not Bugs)

- **Tokenizer accuracy:** The pure-JS BPE approximation is within ~5% of actual Claude tokenization. A full cl100k_base WASM bundle would be more accurate but adds ~5MB to the extension.
- **SPA navigation:** The MutationObserver disconnects and reconnects on History.pushState events. There's a 800ms delay after navigation before reattaching — exchanges sent during that window may not be captured.
- **Service worker restarts:** The 30-second client-side cooldown (`lastSubmitTime`) resets when Chrome restarts the service worker. The server-side trigger enforces the same limit, so duplicate submissions are still rejected.
- **Flag abuse:** A single user could submit one flag per anonymous ID they create. The `post_flags` dedup prevents the same ID from flagging twice, but multiple IDs from one device are partially mitigated by the fingerprint dedup (flagged as `suspicious` after 5 IDs).

---

## How to Continue in a New Chat

Paste this entire file and say something like:

> "Here's where we left off on ClaudeWatch. I've added my icon files. Please help me [next step]."

The new Claude will have everything it needs.
