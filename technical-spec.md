# Technical Spec — Oh

Shared memory for AI-coding teams. Capture every team member's AI coding sessions into one shared, secret-scrubbed "Team Brain," and expose it through a Claude Code skill so any teammate's agent can continue someone's work, ask why a change was made, auto-write standups, and flag issues.

See [`CONTEXT.md`](./CONTEXT.md) for terminology and [`docs/adr/`](./docs/adr/) for the load-bearing decisions.

---

## Architecture: "one engine, many views"

All features read the same data. Build the core **once** (the Engine); every feature is a **View** on top. See [ADR 0001](./docs/adr/0001-one-engine-many-views.md).

### The Engine (shared Team Brain)

**1. Capture** — a lightweight per-dev client tails each AI tool's local session files and streams deltas up *near-live*.
- Claude Code stores transcripts as append-only JSONL at `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl` — one event per line (user/assistant messages, `tool_use`, `tool_result`), timestamped. **Verify against current Claude Code docs before building.**
- Capture mechanism: a **file-watcher on the JSONL** (most robust) plus Claude Code **hooks** (`SessionStart` / `Stop` / `SessionEnd` / `PostToolUse`) to flush promptly.
- **v1 = Claude Code only.** Later: Cursor, Codex, Gemini CLI, etc. (mnemo demonstrates multi-tool parsing is tractable.)
- **Near-live is a hard requirement** — Handoff is useless on stale state. Summaries can lag; capture cannot.

**2. Scrub (mandatory, pre-storage)** — secret detection/redaction on every chunk *before it leaves the machine*.
- Regex + entropy detection (gitleaks / detect-secrets / trufflehog rule-sets).
- Replace secrets with placeholders; emit a "secret detected" event for the security View.
- **The Team Brain must never hold a live credential.** This is the price of being allowed to store anything — not an optional feature.

**3. Store + index** — per-person, per-project, per-session.
- Scrubbed transcript in Postgres / object storage.
- Chunked + embedded into a vector store for semantic query (**Supabase + pgvector** for v1).
- Metadata: who, when, repo, branch, files touched, tool calls, token counts, linked commits/PRs.

**4. Link to code** — connect a Session to the commit/PR it produced (the crux of "ask why about *this* change").
- Primary: inject a `Session-Id:` **git commit trailer** via a hook during agent runs.
- Fallback: correlate by repo + author + timestamp window + files touched.
- Plus: GitHub/GitLab webhook on PR open → match to recent Sessions.

**5. Query API** — semantic + structured query over the team's Sessions, **permission-filtered** by the org's Visibility Policy.

### The Views

| View | Trigger | Output |
|------|---------|--------|
| **Handoff** *(lead)* | Human, on demand | A *resumable plan + current state* of a teammate's unfinished work, dropped into the picker's agent. |
| **Ask-why** *(co-primary)* | Human, during PR review | A *synthesised answer with citations* (link to the exact Session moment). Never raw-transcript browsing. |
| **Daily Summary / Standup** | Automatic, EOD | What each person *shipped*, anchored to merged PRs/commits cross-checked with the Session (not chat volume). Dev sees their own; can add a correction. |
| **Flags** | Automatic, per session | Findings against a ruleset: token waste, secret leakage (always escalates), process compliance. Visibility = org-configurable. |

Handoff and Ask-why are the same retrieval pointed at different times — present vs past. Summaries and Flags are the same retrieval run automatically instead of on demand.

### Access layer

- A **Claude Code skill** is the front door — any teammate's Claude invokes Handoff/Ask-why naturally. It wraps an **MCP server** that calls the Query API. *Skill = trigger/UX; MCP = engine connection.*
- Optional web dashboard for summaries, flags, and admin.

### Data architecture & deployment — **key decision**

- Multi-tenant SaaS cloud ships fastest, but storing a company's entire AI-coding history (with proprietary code context) in *your* cloud is a hard enterprise-security sell.
- Design the **data plane separable from the control plane** so a **"deploy-in-their-cloud / self-host"** option exists from day one.
- Per-org isolation; SSO; RBAC enforcing the Visibility Policies.
- *Open decision — see below.*

### Suggested stack

- **Capture client:** TypeScript or Go CLI + file watcher + Claude Code hooks.
- **Backend:** Supabase (Postgres + pgvector + auth + storage) for v1.
- **Intelligence:** off-the-shelf embedding model for retrieval; Claude for summary/answer synthesis.
- **Access:** standard MCP server (Node/Python); a Claude Code skill packaging the calls.

---

## v1 scope (what actually ships)

- Claude Code only → Capture → Scrub → store/index for one team.
- Killer Views: **Handoff** + **Ask-why in PR review.**
- Org buys; SSO; basic admin; configurable visibility.
- **Defer:** other tools, the full Flags suite, fancy dashboards, the post-training-data play.

---

## De-risk before building

Prototype these four in order — each can cheaply confirm or kill the idea:

1. **Near-live capture** — watch `~/.claude/projects/*.jsonl` (+ hooks) and stream deltas; reconstruct a live session within seconds.
2. **Session → PR linkage** — commit-trailer injection + time/file correlation; measure match accuracy on real history.
3. **Secret-scrubbing recall** — run gitleaks/detect-secrets over real sessions; confirm near-zero key leakage *before storing anything*.
4. **Handoff quality** — on your *own* paused sessions, auto-generate a "continue here" context another agent can actually run with. This is the whole wedge; test it first.

---

## Open technical decisions

- **Data residency** — *default: cloud-first v1, but keep the data store liftable into a customer's own cloud without a rewrite.* Build true self-host only when the first enterprise demands it (and charge for it). ADR-worthy once committed.
- **Embedding/summarisation model** — managed API vs self-hosted (interacts with the self-host decision).
- **Capture transport** — file-watch daemon vs hook-driven push vs both.
