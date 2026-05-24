export default function Privacy() {
  return (
    <div className="page">
      <header className="header">
        <h1 className="logo">ClaudeWatch</h1>
        <nav className="nav">
          <a href="/" className="nav-link">Dashboard</a>
          <a href="/community" className="nav-link">Community</a>
          <a href="/privacy" className="nav-link active">Privacy</a>
        </nav>
      </header>

      <article className="policy">
        <h2>Privacy Policy</h2>
        <p className="updated">Last updated: 2026-05-22</p>

        <section>
          <h3>What ClaudeWatch Is</h3>
          <p>ClaudeWatch is a browser extension that helps the community track Claude usage metrics. Its sole purpose is to surface patterns in usage limits that Anthropic does not publicly document.</p>
        </section>

        <section>
          <h3>What We Collect</h3>
          <p>ClaudeWatch collects <strong>only metadata</strong> about your Claude sessions. At no point is any message content, prompt text, or AI response text transmitted or stored outside your device.</p>

          <h4>Specifically, we collect:</h4>
          <table>
            <thead>
              <tr><th>Field</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td>Anonymous ID</td><td>A randomly generated UUID created on first install. Not linked to your account or identity.</td></tr>
              <tr><td>Device fingerprint (hashed)</td><td>A one-way SHA-256 hash of browser/device characteristics. The raw values are never transmitted — only the hash. Used server-side only to detect duplicate or bot submissions.</td></tr>
              <tr><td>Token estimates</td><td>An estimated count of input and output tokens per exchange, computed locally. No actual text is sent.</td></tr>
              <tr><td>Model name</td><td>Which Claude model was active (e.g. "Claude Sonnet 4.6").</td></tr>
              <tr><td>Adaptive mode</td><td>Whether extended thinking mode was enabled (boolean).</td></tr>
              <tr><td>Response duration</td><td>How long the response took in milliseconds.</td></tr>
              <tr><td>Tokens per second</td><td>Estimated output speed, derived from the above.</td></tr>
              <tr><td>Rate limit events</td><td>Whether a usage or rate limit message appeared (boolean). If yes, the error string shown by Claude — not your message.</td></tr>
              <tr><td>Usage percentage</td><td>Your usage bar value (0–100%) from the Claude settings page, polled periodically.</td></tr>
              <tr><td>Reset timer</td><td>How many minutes until your usage resets, from the settings page.</td></tr>
              <tr><td>Tier</td><td>Whether your account is Free or Pro, detected from the usage page.</td></tr>
              <tr><td>Attachment metadata</td><td>Whether attachments were present (boolean) and an estimated token count. File names and contents are never transmitted.</td></tr>
              <tr><td>Install date</td><td>The date the extension was first installed.</td></tr>
              <tr><td>User agent hash</td><td>A SHA-256 hash of your browser's user agent string.</td></tr>
            </tbody>
          </table>

          <h4>What we do NOT collect:</h4>
          <ul>
            <li>Any message you send to Claude</li>
            <li>Any response from Claude</li>
            <li>Your claude.ai username, email, or account details</li>
            <li>File names or file contents of attachments</li>
            <li>Your IP address (Supabase may log it as part of standard HTTP infrastructure, but we do not store or use it)</li>
            <li>Any browsing history on domains other than claude.ai</li>
            <li>Cookies or session tokens</li>
          </ul>
        </section>

        <section>
          <h3>Display Name</h3>
          <p>If you choose to enter a display name in the extension settings, that name is stored locally and optionally shown next to your community board posts. It is entirely optional, not connected to your real identity, and can be changed or cleared at any time.</p>
        </section>

        <section>
          <h3>Community Board</h3>
          <p>Community board posts are submitted anonymously under your random anonymous ID, capped at 280 characters, prohibited from containing links, and moderated by community flagging. You should not include any personally identifying information in community posts.</p>
        </section>

        <section>
          <h3>Data Retention</h3>
          <p>Exchange and usage data is retained indefinitely to support long-term trend analysis. Community posts are retained unless removed by flag moderation.</p>
        </section>

        <section>
          <h3>Data Deletion</h3>
          <p>To request deletion of all data associated with your anonymous ID, open the extension, copy your anonymous ID from the Settings tab, and email <a href="mailto:louisxgui@gmail.com">louisxgui@gmail.com</a> with the subject "Data deletion request" and your anonymous ID in the body. We will delete all records associated with that ID within 14 days.</p>
          <p>Because the anonymous ID is not linked to your real identity, we cannot process deletion requests without the ID itself.</p>
        </section>

        <section>
          <h3>Third-Party Services</h3>
          <p>Data is stored in <a href="https://supabase.com" target="_blank" rel="noopener">Supabase</a> (PostgreSQL database hosted on AWS). The public dashboard is hosted on <a href="https://vercel.com" target="_blank" rel="noopener">Vercel</a>. No other third parties receive your data.</p>
        </section>

        <section>
          <h3>Children</h3>
          <p>ClaudeWatch is not directed at children under 13. We do not knowingly collect data from minors.</p>
        </section>

        <section>
          <h3>Changes</h3>
          <p>If we materially change what data is collected, we will increment the extension version and update this document. Continued use of the extension after a policy change constitutes acceptance.</p>
        </section>

        <section>
          <h3>Contact</h3>
          <p>Questions about this privacy policy: <a href="mailto:louisxgui@gmail.com">louisxgui@gmail.com</a></p>
        </section>
      </article>

      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #111; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
        a { color: #7ab; text-decoration: none; }
        a:hover { text-decoration: underline; }
      `}</style>

      <style jsx>{`
        .page { max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { display: flex; align-items: center; gap: 24px; margin-bottom: 32px; }
        .logo { font-family: 'Fira Mono', monospace; font-size: 18px; color: #7ab; }
        .nav { display: flex; gap: 16px; }
        .nav-link { color: #888; font-size: 13px; transition: color 0.15s; }
        .nav-link.active, .nav-link:hover { color: #e0e0e0; }

        .policy h2 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
        .updated { font-size: 11px; color: #555; margin-bottom: 32px; font-family: 'Fira Mono', monospace; }

        section { margin-bottom: 28px; }
        h3 { font-size: 15px; color: #ccc; margin-bottom: 10px; border-bottom: 1px solid #2d2d2d; padding-bottom: 6px; }
        h4 { font-size: 13px; color: #999; margin: 14px 0 8px; }
        p { color: #bbb; line-height: 1.7; margin-bottom: 10px; }
        strong { color: #e0e0e0; }

        table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
        th { text-align: left; padding: 8px 12px; background: #1a1a1a; color: #888; font-weight: 500; border-bottom: 1px solid #2d2d2d; }
        td { padding: 8px 12px; border-bottom: 1px solid #1e1e1e; color: #bbb; vertical-align: top; }
        td:first-child { color: #ccc; white-space: nowrap; width: 200px; }
        tr:hover td { background: #161616; }

        ul { list-style: none; padding: 0; }
        ul li { padding: 4px 0 4px 16px; color: #bbb; position: relative; line-height: 1.6; }
        ul li::before { content: '—'; position: absolute; left: 0; color: #555; }
      `}</style>
    </div>
  );
}
