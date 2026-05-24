# About ClaudeWatch

## The Problem

Anthropic does not publicly document Claude's usage limits.

- They don't publish how many messages you get per hour or per day.
- They don't announce when those limits change.
- They don't explain the difference in limits between Free and Pro tiers.
- When you hit a limit, the error message often doesn't tell you when you can try again.

This leaves users in the dark. Community threads fill with questions: "Is Claude slow for anyone else today?" "Did they change the rate limits?" "What model am I actually on?" "Am I close to my limit?"

The answers are unknowable without data.

## The Solution

ClaudeWatch is community infrastructure to make those answers visible.

When you install ClaudeWatch, your browser silently records metadata about your Claude sessions — token estimates, response times, usage percentages, and whether you hit a limit. **No message content is ever collected or transmitted.** The extension never reads what you wrote or what Claude responded with.

This data, pooled anonymously across thousands of users, reveals:

- When limits are being hit more than usual (potential server-side changes)
- How response speed changes over time (proxy for infrastructure load)
- The distribution of usage percentages at limit-hit events (what "full" actually looks like)
- Differences in behavior between Free and Pro tiers
- Which models users are on and whether Adaptive mode is common

## What ClaudeWatch Is Not

ClaudeWatch is **not** a surveillance tool. It was designed from the ground up to collect the minimum possible data. Every collection decision was made by asking: "Can we learn the same thing without this field?" If yes, we don't collect it.

ClaudeWatch is **not** affiliated with Anthropic. It is an independent community project.

ClaudeWatch is **not** a competitor to Claude. We think Claude is remarkable. That's why the community wants better visibility into how to use it.

## The Design Principles

1. **No content, ever.** Token counts are computed locally and only the number is transmitted — not the text.
2. **Anonymous by default.** Your ID is a random UUID. There is no login, no email, no account.
3. **Transparent codebase.** The extension is open source. You can verify exactly what is sent.
4. **Community-owned.** The dashboard shows everyone's data. No private insights for the developer.

## The Mission

Anthropic is building some of the most significant AI systems in history. The community that relies on these tools deserves transparency about how they work — including the limits on access.

ClaudeWatch is one small step toward that transparency.
