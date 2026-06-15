---
status: accepted
---

# Insights-only edition: count token/time usage, nothing else

Some teams (and some security reviews) want the *measurement* half of Oh without the *memory* half. The pitch "Oh stores the verbatim record of your sessions so your agent can recall it" is exactly the part a privacy-cautious org pushes back on — it stores prompts and code. But the Insights view (ADR 0007/0008) is built on **Metrics**: a small per-Exchange row of mechanical facts (tokens, durations, tool/error/interrupt counts) parsed from the same files, **never embedded, never LLM-judged**. Insights needs no stored text and no `ask` at all. So we ship a fourth shape: **insights-only** — capture writes only Metrics, and that's the whole product. It counts your token/time usage and keeps nothing else.

This is the lightest, most privacy-minimal Oh: no embeddings, no embedding model, no vector store, no `ask`, no MCP server, no ask-why skill — and **it never persists a single line of your prompts or code**, only numbers. Set up with `oh init --insights-only`.

## What changes (it's a subtraction, not a new pipeline)

Insights-only is `mode: "local"` (ADR 0013) plus an `insightsOnly` flag, and the flag only ever *removes* work:

- **Capture** computes Metrics exactly as before but skips the embed + chunk-store path entirely (`fresh = []` when `insightsOnly`). No text is scrubbed-then-stored, no embedder is ever constructed-and-called. The local file store accumulates only `metrics.jsonl` (+ the `sessions.json` and the last-session crumb the brief needs).
- **Wiring** registers the capture hook + statusline only. The `ask` MCP server is *not* registered in Claude/Codex, the ask-why skill is *not* installed, and Copilot (a pure MCP consumer) is skipped. `oh ask` and a manually-launched `oh mcp` both refuse with a pointer to `oh init --local`.
- **Everything downstream is untouched**: `oh insights`, the session-start brief, the daily history, the token-by-agent chart, the rabbit-hole nudge — all read Metrics, so all work identically.

## Consequences

- **No embedding runtime needed.** Unlike full local mode, insights-only never imports the on-device model (the optional `@huggingface/transformers` dependency) or downloads any weights — there is literally nothing to fetch and nothing to run beyond Node. The smallest possible footprint.
- **Tips degrade gracefully.** A few Insight *tips* quote the prompt that started a spiral or a pleasantry-only turn; those quotes come from chunk text, which insights-only doesn't keep. `generateTips` already tolerates missing text — the metrics-grounded tips (rabbit holes, most-expensive turns by token count) still fire; the quote-grounded ones simply don't appear. Accepted: the numbers are the product here, not the quotes.
- **The brief still says "where you left off"** — that line prefers the local last-session crumb (the tool's own session summary), which capture writes regardless of `insightsOnly`; it only falls back to chunk text, which is now absent.
- **Live Copilot capture is off** (it depends on the MCP server we no longer register); Copilot sessions are still counted via `oh backfill` / `oh capture --all`.
- **Upgrade is a re-init.** `oh init --local` (or hosted/self-host) turns memory + `ask` back on; a subsequent `oh backfill` embeds history from the raw session files, which never left the machine. Re-running plain `oh init` on an insights-only install is a no-op on the flag (checked first) so it never silently re-enables `ask`.

## Considered and rejected

- **Store text without embeddings** (so quote-tips survive) — rejected. The entire selling point is "only numbers, never your prompts." Keeping text to improve a tip would betray that, for marginal value.
- **A standalone `oh-insights` package** — rejected. It's the same capture/insights code minus two steps; a flag on the existing CLI avoids a second build/publish surface and lets a team flip to full Oh without reinstalling.
- **Gating on a new `mode` value instead of a flag** — the store and keyless setup are identical to local mode; a `mode: "metrics"` would duplicate that branch. The flag composes with `mode: "local"` cleanly.
