---
status: accepted
---

# Insights are computed from Metrics the Engine already reads — no LLM judging, self-first visibility

The first **Flags/Insights View** ships as **v0.1**: at Capture time the Engine keeps a small **Metrics** row per Exchange (tokens, durations, tool/error/interrupt counts — all parsed from the same JSONL files Capture already reads and currently discards), and three surfaces consume it:

1. **`oh insights`** — a pull report (CLI) over your own week: time anatomy (prompting vs agent working vs away), token economy (cache-hit rate, most expensive exchange), corrections/errors, rabbit-hole episodes, and fun stats. `--team` shows per-author aggregates.
2. **The rabbit-hole Nudge** — the one *in-the-moment* insight: when a session shows a trailing streak of correction/error exchanges, Capture writes a one-shot Nudge that the next Stop hook surfaces in-session ("N turns circling, ~Xk tokens — a fresh start is often cheaper"). Strictly one per Session, self-only.
3. **Weekly digest** — deferred to a follow-up; `oh insights` is its engine.

## Why

- **The data is already in hand.** Claude transcripts carry per-message `usage` (input/output/cache tokens) and `model`; Codex rollouts carry cumulative `token_count` events; both carry per-event timestamps, tool calls, `is_error` results, and interrupt markers (verified against real files 2026-06). The parser walks every event today and throws this away. Keeping it costs no new data source, no daemon, and **no embedding spend** — Metrics rows skip the embedding pipeline entirely.
- **Mechanical beats judged.** Token sums, timestamp gaps, and error streaks are cheap, deterministic, and explainable. An LLM "are you following good principles?" judge is expensive, unreliable, and reads as a nag from a tool whose adoption depends on *not* feeling like surveillance. Rejected for v0.1; if process insights ever land, they reduce to mechanical proxies (tests-before-commit, plan-before-large-diff).
- **Cadence is the product decision.** Corrective insights (the rabbit hole) are worth surfacing *during* the session — that is the only push. Reflective and fun insights are pull (`oh insights`) or weekly; daily pushes read as performance review.
- **Differentiation lives in the shared store.** Per-user token analytics exist elsewhere; only Oh holds *cross-person embedded reasoning*, so team-level insights (duplicate-effort detection, ask-deflection counts) are the durable edge. Duplicate-effort detection is deferred until the metrics base exists and false positives can be tuned.

## Visibility (consistent with ADR 0003 / CONTEXT.md Visibility Policy)

Metrics rows live in the shared Team Brain like everything else (they are far *less* sensitive than the reasoning text already stored). Display defaults: **individual numbers to the individual; team views show aggregates**. The Nudge is visible only in the author's own session. No manager reports in v0.1 — small high-trust teams, same stance as ADR 0006.

## Considered and rejected

- **LLM-judged "coding principles" scoring** — cost, reliability, and surveillance-smell (above).
- **Dollar amounts in reports** — requires a maintained per-model price table that goes stale; tokens are the honest unit. Revisit if a price feed becomes trivial.
- **A separate local metrics store** — splits the Engine's "one store, many Views" rule (ADR 0001) and breaks team aggregates.
- **Real-time mid-turn nudges** — would require blocking hooks or a daemon; the Stop-hook one-shot delivers 90% of the value at zero blocking risk.

## Consequence

Capture re-sweeps existing sessions once to backfill Metrics (offset state is versioned; embeddings are not redone). The Flags View in `technical-spec.md` is no longer hypothetical — the rabbit-hole Nudge is its first instance. Next candidates once retention proves out: weekly digest, duplicate-effort detection, ask-deflection stats, an `insights` MCP tool so agents can answer "how was my week?".
