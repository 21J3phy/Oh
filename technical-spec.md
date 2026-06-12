# Technical Spec — Oh

Shared memory for AI-coding teams. Capture each person's AI coding Sessions across tools, store them in a shared **Team Brain**, and expose it through an MCP-backed skill so a teammate's agent can **ask why a change was made — instead of interrupting the author to re-explain** (and, later, continue unfinished work, write standups, flag issues).

See [`CONTEXT.md`](./CONTEXT.md) for terminology and [`docs/adr/`](./docs/adr/) for the load-bearing decisions — especially [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md) (build for small teams, dogfood the loop), which reframes the scope below.

---

## Architecture: "one engine, many views"

All features read the same data. Build the core **once** (the Engine); every feature is a **View** on top. See [ADR 0001](./docs/adr/0001-one-engine-many-views.md). *(This is the eventual vision — see v0 below for what to actually build first.)*

### The Engine (shared Team Brain)

**1. Capture** — a lightweight per-dev client tails each AI tool's local session files and streams deltas up.
- Claude Code stores transcripts as append-only JSONL at `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl` — one event per line (user/assistant messages, `tool_use`, `tool_result`), timestamped. **Verify against current Claude Code docs before building.**
- Capture mechanism: a **file-watcher on the JSONL** (most robust) plus tool **hooks** (`SessionStart` / `Stop` / `SessionEnd` / `PostToolUse`) to flush promptly.
- **Cross-tool from the start** — Codex + Claude (what the team actually uses), because cross-tool neutrality is the wedge against platform risk (see [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md)). Add Cursor, Gemini CLI, etc. as you grow. (mnemo demonstrates multi-tool parsing is tractable.)
- **Latency:** the re-explaining loop tolerates some lag; near-live only becomes a hard requirement for Handoff (a later View).

**2. Scrub (pre-storage, before external data)** — secret detection/redaction on every chunk *before it leaves the machine*.
- Regex + entropy detection (gitleaks / detect-secrets / trufflehog rule-sets).
- Replace secrets with placeholders; emit a "secret detected" event.
- **The Team Brain must never hold a live credential** once it holds anyone-but-yourself's data. *Skippable for the founders' own dogfood; mandatory before another team's data lands.*

**3. Store + index** — per-person, per-project, per-session.
- Scrubbed transcript in Postgres / object storage. **The raw (scrubbed) Session is retained by design** — summaries and Ask-why synthesis are Views over it, not a replacement, and not a privacy mechanism. See [ADR 0004](./docs/adr/0004-summaries-are-a-view-not-privacy.md).
- Chunked + embedded into a vector store for semantic query (**Supabase + pgvector** when you need it).
- Metadata: who, when, repo, branch, files touched, tool calls, token counts, linked commits/PRs.

**4. Link to code** — connect a Session to the commit/PR it produced (the crux of "ask why about *this* change").
- Primary: inject a `Session-Id:` **git commit trailer** via a hook during agent runs.
- Fallback: correlate by repo + author + timestamp window + files touched.
- Plus: GitHub/GitLab webhook on PR open → match to recent Sessions.

**5. Query API** — semantic + structured query over the team's Sessions, **permission-filtered** by the Visibility Policy.
- Also serves *self-scoped* queries — a developer's agent over their *own* Sessions (self-resume / the free solo tier). Nearly free given the Engine, but the personal on-ramp, not a team View. See [ADR 0005](./docs/adr/0005-self-resume-is-the-funnel-not-the-wedge.md).

### The Views

| View | Trigger | Output |
|------|---------|--------|
| **Ask-why** *(the wedge)* | Human, on demand / during review | A *synthesised answer with citations* to "why was this done?" — querying a teammate's reasoning instead of making them re-explain. Never raw-transcript browsing. |
| **Handoff** *(later)* | Human, on demand | A *resumable plan + current state* of a teammate's unfinished work, dropped into the picker's agent. |
| **Daily Summary / Standup** *(later)* | Automatic, EOD | What each person *shipped*, anchored to merged PRs/commits cross-checked with the Session. Dev sees their own; can add a correction. |
| **Flags** *(later)* | Automatic, per session | Findings against a ruleset: token waste, secret leakage, process compliance. Visibility = configurable. |
| **Insights** *(v0.1 — shipped)* | Pull (`oh insights`) + one in-session Nudge | Mechanical reports over capture-time **Metrics**: time anatomy (prompting vs agent working vs away), token economy/cache-hit rate, correction/error streaks (rabbit holes), fun stats. See [ADR 0007](./docs/adr/0007-insights-from-capture-metrics.md). |

Ask-why and Handoff are the same retrieval pointed at different times — past vs present. Summaries and Flags are the same retrieval run automatically instead of on demand.

### Access layer

- A **skill** is the front door — a teammate's agent invokes Ask-why naturally. It wraps an **MCP server** that calls the Query API. *Skill = trigger/UX; MCP = engine connection.*
- Optional web dashboard (later) for summaries, flags, and admin.

### Data architecture & deployment — **key decision (enterprise-stage)**

- Multi-tenant SaaS cloud ships fastest, but storing a company's entire AI-coding history in *your* cloud is a hard enterprise-security sell.
- Design the **data plane separable from the control plane** so a **"deploy-in-their-cloud / self-host"** option exists when an enterprise demands it.
- Per-org isolation; SSO; RBAC enforcing Visibility Policies.
- *Deferred until you move up-market — not needed for the dogfood.*

### Suggested stack

- **Capture client:** TypeScript or Go CLI + file watcher + tool hooks.
- **Backend:** Supabase (Postgres + pgvector + auth + storage) when you outgrow a flat shared store.
- **Intelligence:** off-the-shelf embedding model for retrieval; Claude for answer synthesis.
- **Access:** standard MCP server (Node/Python); a skill packaging the calls.

---

## v0 — dogfood (build this first)

The thinnest thing that solves the founders' own pain, run on their own teams. See [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md).

- **Cross-tool day one** (Codex + Claude): tail each tool's session files into a shared store.
- **Retrieval is the core — build it for real.** Chunk Sessions, embed the chunks (**pgvector** + an embedding API), and keep metadata (who, when, repo, linked commit) for optional filtering. Don't skip this: semantic search *is* the product, and coding Sessions are far too token-heavy to brute-force into a context window.
- **The one tool — `ask`:**

  ```
  ask(question, who?, repo?, since?)   // only `question` is required
  → { answer, citations: [{ teammate, session, when, snippet }] }
  ```

  Retrieve top-k relevant chunks across the team (filtered by who/repo/since when given), rank by **relevance + recency**, inject the raw chunks (compress to a summary only if they don't fit), and synthesise a cited answer. Hero query: "why is this code/plan the way it is?"
- **The hard part to nail: the *latest authoritative* answer.** When "the plan" evolved across several Sessions — one reversing another — `ask` must return the *current* decision, not a stale one. Relevance alone won't do it; rank with recency and prefer what supersedes. This is what the dogfood must stress-test.
- **Strip everything else:** no Scrub, no dashboard, no SSO, no Flags, no Handoff. Three friends who trust each other don't need them; add each only when its trigger arrives (someone else's data → Scrub; enterprise → SSO).
- **Milestone: retention, not revenue** — do your own teammates reach for it unprompted in week 3?

## v0.1 — Insights & Metrics (shipped on top of v0)

The first Flags-family View, per [ADR 0007](./docs/adr/0007-insights-from-capture-metrics.md). Design rule: **everything is parsed from files Capture already reads — no new data source, no LLM judging, no extra embedding spend.**

- **Metrics (Engine):** Capture keeps one row per Exchange in `exchange_metrics` (same deterministic `<session>:<index>` id as chunks): `think_ms` (gap from previous Exchange's end to this prompt), `work_ms` (prompt → last agent event), token sums (input / output / cache-read / cache-write — Claude per-message `usage` deduped by message id; Codex cumulative `token_count` diffed per Exchange), tool-call / file-read / file-edit counts, tool-error count, interrupt + correction flags, model. Rows skip the embedding pipeline. Offset state is versioned so the first metrics-aware sweep backfills old sessions without re-embedding.
- **`oh insights [--since 7d] [--who NAME | --team] [--repo R]` (View):** client-side aggregation —
  - *Time anatomy:* prompting time (think gaps ≤ 5 min), away time (gaps 5–30 min; longer gaps excluded as "left for the day"), agent working time, wall clock.
  - *Token economy:* totals, cache-hit rate, most expensive Exchange (fresh tokens, not dollars — no price table to go stale).
  - *Friction:* corrections, tool errors, interrupts, rabbit-hole episodes (streaks ≥ 4 of correction/error Exchanges).
  - *Fun:* peak hour, busiest day, longest session.
  - Defaults: your own numbers; `--team` shows per-author aggregates only.
- **Rabbit-hole Nudge (Flag):** the detached capture runs the streak detector after upserting; if the *trailing* streak ≥ 4 it writes a one-shot nudge file under `~/.oh/nudges/`; the next Stop hook emits it as a `systemMessage` (never blocks, self-only, once per Session, then marked consumed).
- **Deferred next:** weekly digest (cron over `oh insights`), duplicate-effort detection (cross-author embedding proximity — needs false-positive tuning), ask-deflection counts, an `insights` MCP tool.

## v1 — first teams beyond your own (later)

- Capture → Scrub → store/index for a small team, across tools.
- Lead View: **Ask-why** / the re-explaining loop. Handoff, Standups, Flags stay deferred.
- **Defer all enterprise plumbing** (SSO, compliance, self-host, the visibility/chilling-effect apparatus) until the loop is proven and you're moving up-market.

---

## De-risk before building

The cheapest kill-test now is **dogfooding the loop**, not building infrastructure:

1. **Retrieval + answer quality (the wedge)** — across Codex + Claude, can `ask` find the *right, current* Session for a question and answer it usefully with a citation — including when the plan changed across sessions? If that beats just asking the person, you have something. **Test this first.**
2. **Retention** — do your teammates keep using it past the novelty (week 3+)? The only near-term metric that matters.
3. **Near-live capture** — tail each tool's session files (+ hooks), reconstruct a session within seconds. (Needed for Handoff later; the loop tolerates lag.)
4. **Session → PR linkage** — commit-trailer injection + time/file correlation; measure match accuracy. Needed for Ask-why-on-a-PR; deferrable for the raw loop.

Defer secret-scrubbing recall and Handoff-quality tests until you're past the dogfood and someone else's data (or an enterprise) is in play.

---

## Open technical decisions

- **Data residency (enterprise-stage)** — cloud-first, but keep the data store liftable into a customer's own cloud without a rewrite. Build true self-host only when the first enterprise demands it (and charge for it). ADR-worthy once committed.
- **Embedding/summarisation model** — managed API vs self-hosted (interacts with the self-host decision).
- **Capture transport** — file-watch daemon vs hook-driven push vs both.
- **Developer control of the shared record (enterprise-stage)** — fully automatic Capture vs a dev-approved/dev-editable record (self-report, not wiretap). The single biggest lever on the chilling effect (see [`business-spec.md`](./business-spec.md) Top risks), but it trades against near-live **Handoff**. Moot for small high-trust teams; ADR-worthy once you move up-market.
- **Retention** — keep raw Sessions indefinitely vs bounded retention with raw-discard after N days. Also bounds free-tier COGS.
- **Capture scope** — every Session vs only segments linked to shipped commits/PRs. Narrowing shrinks the surveilled surface but weakens Handoff on exploratory work.
