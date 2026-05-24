# ClaudeWatch Privacy Policy

Last updated: 2026-05-22

## What ClaudeWatch Is

ClaudeWatch is a browser extension that helps the community track Claude usage metrics. Its sole purpose is to surface patterns in usage limits that Anthropic does not publicly document.

## What We Collect

ClaudeWatch collects **only metadata** about your Claude sessions. At no point is any message content, prompt text, or AI response text transmitted or stored outside your device.

### Specifically, we collect:

| Field | Description |
|---|---|
| Anonymous ID | A randomly generated UUID created on first install. Not linked to your account or identity. |
| Device fingerprint (hashed) | A one-way SHA-256 hash of browser/device characteristics (user agent, screen size, timezone, etc.). The raw values are never transmitted — only the hash. Used server-side only to detect duplicate or bot submissions. |
| Token estimates | An estimated count of input and output tokens per exchange, computed locally using a JavaScript tokenizer. No actual text is sent. |
| Model name | Which Claude model was active (e.g. "Claude Sonnet 4.6"). |
| Adaptive mode | Whether extended thinking mode was enabled (boolean). |
| Response duration | How long the response took in milliseconds. |
| Tokens per second | Estimated output speed, derived from the above. |
| Rate limit events | Whether a usage or rate limit message appeared (boolean). If yes, the error string shown by Claude (e.g. "You've reached your usage limit") — not your message. |
| Usage percentage | Your usage bar value (0–100%) from the Claude settings page, polled every 15 minutes. |
| Reset timer | How many minutes until your usage resets, from the settings page. |
| Tier | Whether your account is Free or Pro, detected automatically from the usage page. |
| Attachment metadata | Whether attachments were present (boolean) and an estimated token count. File names and contents are never transmitted. |
| Install date | The date the extension was first installed. |
| User agent hash | A SHA-256 hash of your browser's user agent string. |

### What we do NOT collect:

- Any message you send to Claude
- Any response from Claude
- Your claude.ai username, email, or account details
- File names or file contents of attachments
- Your IP address (Supabase may log it as part of standard HTTP infrastructure, but we do not store or use it)
- Any browsing history on domains other than claude.ai
- Cookies or session tokens

## Display Name

If you choose to enter a display name in the extension settings, that name is stored locally and optionally shown next to your community board posts. It is entirely optional, not connected to your real identity, and can be changed or cleared at any time.

## Community Board

Community board posts are:
- Submitted anonymously under your random anonymous ID
- Capped at 280 characters
- Prohibited from containing links
- Moderated by community flagging (3 flags hides a post)

You should not include any personally identifying information in community posts.

## Data Retention

Exchange and usage data is retained indefinitely to support long-term trend analysis. Community posts are retained unless removed by flag moderation.

## Data Deletion

To request deletion of all data associated with your anonymous ID, open the extension, copy your anonymous ID from the Settings tab, and email louisxgui@gmail.com with the subject "Data deletion request" and your anonymous ID in the body. We will delete all records associated with that ID within 14 days.

Because the anonymous ID is not linked to your real identity, we cannot process deletion requests without the ID itself.

## Third-Party Services

Data is stored in [Supabase](https://supabase.com) (PostgreSQL database hosted on AWS). The public dashboard is hosted on [Vercel](https://vercel.com). No other third parties receive your data.

## Children

ClaudeWatch is not directed at children under 13. We do not knowingly collect data from minors.

## Changes

If we materially change what data is collected, we will increment the extension version and update this document. Continued use of the extension after a policy change constitutes acceptance.

## Contact

Questions about this privacy policy: louisxgui@gmail.com
