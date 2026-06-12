---
status: accepted
---

# Lead with "supercharge your AI with memory" — useful at n=1, verbatim where native memory is summary

Two positioning decisions, made together (2026-06-12, Nirav):

1. **The headline value is "supercharge your AI with memory," not "access between teammates."** The memory layer is useful at **team-of-one**: your own sessions across Claude Code and Codex become memory your agent can recall. Teammate access (ask-why) is the *multiplier* and the moat; Insights is the wallet-opener; but the front-door promise is that *your* AI gets smarter the day you install. Dogfood evidence: during the v0.2 build, `ask` answered a positioning question by citing the founder's own exchange from an hour earlier — unprompted proof that self-recall alone carries value.

2. **The named differentiator vs native "memory" features is verbatim vs summary.** Claude memory, Codex memories, Gemini, mem0-style tools all store *distilled facts* — lossy summaries like "user prefers pnpm." Oh stores the **scrubbed verbatim record**: exact quotes, actual code blocks, the full reasoning thread, citable to the session and moment it happened. (This is ADR 0004's "the raw Session is retained by design," promoted from architecture note to marketing claim.) When the answer matters, a summary can't reconstruct the why; the record can.

## What this amends

- **ADR 0005 ("self-resume is the funnel, not the wedge")** — *partially superseded.* Its monetization clause stands: solo use is free, the paying unit is team seats + retention (ADR 0008). Its **brand clause is withdrawn**: self-memory is no longer hidden from the pitch — it *is* the opening promise. 0005 feared anchoring the brand to a commodity; the answer to that is decision 2: we are not selling "memory" (commodity), we are selling the *verbatim, cross-tool, citable* record (not offered by any lab — and incentive-incompatible for them cross-tool).
- **ADR 0006/0008 sequencing** — unchanged. The wedge loop, kill-tests, and pricing all stand; this changes what the front door says, not what we build next.

## Why

- **Fixes cold start.** "Ask your teammates' agents" is worthless at n=1 and most signups start at n=1. "Your AI remembers everything it's ever done with you" is valuable in the first hour, before anyone invites a teammate.
- **Pre-empts the reflex objection.** Every dev now has some native memory feature; "isn't this built in?" is the first question. The answer is the pitch: *theirs summarizes, Oh remembers* — exactly, across tools, with citations.
- **The risk it creates** (competing head-on with commodity personal memory) is contained by what stays unique: cross-tool capture, team sharing, individual-only Insights, and the verbatim+cited retrieval itself.

## Consequence

- Landing page hero, README intro, business-spec category/one-liner, and CONTEXT.md preamble lead with supercharge + verbatim. The offerings are presented as **three**: Recall (yours, n=1), Shared memory (teammates), Insights (you only).
- The `ask` surfaces (MCP tool description, ask-why skill) mention self-recall, not only teammates.
- The competitive table's "personal agent memory" row names the distinction: facts/summaries vs verbatim record.
