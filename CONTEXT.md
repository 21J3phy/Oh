# Oh — The Memory Layer for AI-Coding Teams

Oh keeps the **verbatim** memory of a team's AI-coding sessions — exact quotes, code blocks, full reasoning, not the lossy summaries native agent-memory keeps — persistent across sessions, tools, and people, and builds useful things on it (one Engine, many Views; ADR 0001). The headline promise is **"your AI starts every session from zero — Oh gives it a past"**, useful at team-of-one (ADR 0009; avoid "supercharge with memory" as the hero — it reads as RAG). Three Views are live: **Recall** (your own agent answers from every past session, across tools), **Ask-why** (a teammate's agent answers *why* something was done, instead of interrupting the author to re-explain), and **Insights** (what your own memory says about your vibecoding — individual-only).

## Language

**Session**:
One continuous AI-agent coding conversation by one person (prompts, agent replies, tool calls, results).
_Avoid_: chat, log, transcript (reserve those for the stored artifact, not the live unit)

**Team Brain**:
The shared, secret-scrubbed store of all of a team's Sessions, queryable by any member's agent.
_Avoid_: database, archive, knowledge base

**Capture**:
Pulling a Session off a person's machine into the Team Brain, near-live.
_Avoid_: sync, upload, ingest

**Scrub**:
Removing secrets (keys, tokens, credentials) from a Session before it is stored. Mandatory before any other team's data is stored.
_Avoid_: redact, sanitize, clean

**Engine**:
The single core that Captures, Scrubs, indexes, and answers queries over Sessions. There is only one.

**View**:
A product feature built on the Engine. Every feature is a View; none owns its own data store.

**Ask-why**:
The View — and **the wedge** — that answers questions about the team's reasoning by retrieving the relevant Session(s) and synthesising a cited answer. Ask the shared brain *anything* (plans, decisions, "why is this the way it is?"), not just about a specific PR/commit; the hero query is code/decision **provenance**. See [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md).

**Handoff**:
The View that reconstructs a teammate's in-progress work as a resumable plan to continue. A *later* View — not the wedge (see [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md)).
_Avoid_: resume, takeover

**Daily Summary** (a.k.a. **Standup**):
The View that reports what a person *shipped* — anchored to merged work, not chat volume. A later View.

**Flag**:
An automatic finding the Engine raises against a Session (wasted tokens, leaked secret, skipped review). The first Flag shipped is the rabbit-hole **Nudge** (see [ADR 0007](./docs/adr/0007-insights-from-capture-metrics.md)).

**Metrics**:
The small per-Exchange row of mechanical facts (tokens, durations, tool/error/interrupt counts) the Engine keeps at Capture time, parsed from the same files Capture already reads. Never LLM-judged, never embedded.
_Avoid_: analytics, telemetry (those imply a separate collection pipeline; Metrics are a byproduct of Capture)

**Insights**:
The View that turns Metrics into a report — time anatomy (prompting vs agent working vs away), token economy, rabbit-hole episodes, fun stats. Pull-only (`oh insights`) and **visible only to the individual dev** — no teammate, team, or manager view, ever ([ADR 0008](./docs/adr/0008-insights-wallet-opener-individual-only.md); buyer-facing artifacts are limited to ask-deflection counts and org-level spend totals). See [ADR 0007](./docs/adr/0007-insights-from-capture-metrics.md) for the Metrics design.

**Nudge**:
The one push Insight: a one-shot, self-only, in-session note that the current Session is circling (a streak of correction/error Exchanges). Delivered by the next Stop hook; never blocks a turn; at most one per Session.

**Visibility Policy**:
The org-configured rule for who sees a Flag or Summary — the individual, the team in aggregate, or a named report to a manager. Security Flags always escalate. (Enterprise-stage; trivial for small high-trust teams.)

**Org**:
The team or company that owns its members' Sessions and sets the Visibility Policy. Free for small teams; the paying unit at enterprise scale (see [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md)).

## Relationships

- An **Org** has many members; each member produces many **Sessions**.
- The **Engine** **Captures** then **Scrubs** every **Session** before storing it in the **Team Brain**.
- **Views** (Ask-why, Handoff, Daily Summary, Flag, Insights) read the **Team Brain**; they never keep their own copy.
- **Insights** reads only **Metrics**; the **Nudge** is a **Flag** surfaced through the Capture hook.
- A member's agent reaches a **View** through a **Skill** (the trigger) that calls an **MCP** (the engine connection).
- **Flags** and **Daily Summaries** are exposed according to the **Org**'s **Visibility Policy**.

## Example dialogue

> **Dev:** "When I 'ask why' on a PR, am I reading my teammate's actual chat?"
> **Domain expert:** "No — Ask-why gives you a *cited answer* synthesised from their **Session**. You can click into the source moment, but the default is an answer, not a raw transcript. Reading the raw chat would make it a surveillance tool."
> **Dev:** "And Handoff?"
> **Domain expert:** "Same **Engine**, different **View** — and a *later* one. Ask-why explains the past; Handoff reconstructs the *present* state of unfinished work so your agent can continue it."

## Flagged ambiguities

- **"OS"** (from the brainstorm) — Taha's "repo of markdown files updated daily by AI agents." Dropped as a name; the surviving concept is the **Team Brain**, which is a queryable Session store, not a markdown repo.
- **"b2a"** — the original codename. Dropped in favour of the real name **Oh** (see business-spec).
- **"skill" vs "MCP"** — resolved: the **Skill** is the front door / trigger; the **MCP** is how it reaches the **Engine**. Two parts, not alternatives.
- **helper vs watcher** ("two products") — resolved: one **Engine**, two triggers. A human pulling an answer (Ask-why / Handoff) and the system auto-checking (Flags / Summaries) are the same query capability.
- **"personal"** — resolved to "one person (+ maybe one other)" = free tier; anything team-scale = paid **Org** (at enterprise scale).
- **"anonymous" / anonymization** — resolved: Oh is **attributed by design**, never anonymized. Anonymity was floated as a privacy fix and rejected — you can't anonymize work product (files, timing, and code style re-identify), and the **Org** pays *for* attribution. See [ADR 0003](./docs/adr/0003-attribution-over-anonymity.md).
- **"summary" as privacy** — resolved: a **Daily Summary** or **Ask-why** synthesis is a **View** (usability), not a privacy mechanism. The **Team Brain** keeps the raw **Session**; summarising does not reduce the chilling effect of **Capture**. See [ADR 0004](./docs/adr/0004-summaries-are-a-view-not-privacy.md).
- **"resume" / self-resume** — a developer's own agent querying their *own* past **Sessions** is **self-resume** (the free solo funnel), and is *not* **Handoff** — Handoff is always a *teammate's* in-progress work. Self-resume is the commodity on-ramp; Ask-why is the defensible wedge. See [ADR 0005](./docs/adr/0005-self-resume-is-the-funnel-not-the-wedge.md).
- **wedge: handoff vs ask-why** — resolved: the wedge is **Ask-why** (the re-explaining loop), *not* **Handoff**. The founders have never done a real handoff; the lived pain is re-explaining reasoning to teammates. See [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md) (supersedes [ADR 0002](./docs/adr/0002-top-down-org-purchase-handoff-led-wedge.md)).
