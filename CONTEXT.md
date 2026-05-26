# Oh — Shared Memory for AI-Coding Teams

The context layer for teams whose code is largely written by AI agents: it preserves the *reasoning* behind every change so a teammate's agent can answer *why* something was done — instead of interrupting the author to re-explain.

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
An automatic finding the Engine raises against a Session (wasted tokens, leaked secret, skipped review). A later View.

**Visibility Policy**:
The org-configured rule for who sees a Flag or Summary — the individual, the team in aggregate, or a named report to a manager. Security Flags always escalate. (Enterprise-stage; trivial for small high-trust teams.)

**Org**:
The team or company that owns its members' Sessions and sets the Visibility Policy. Free for small teams; the paying unit at enterprise scale (see [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md)).

## Relationships

- An **Org** has many members; each member produces many **Sessions**.
- The **Engine** **Captures** then **Scrubs** every **Session** before storing it in the **Team Brain**.
- **Views** (Ask-why, Handoff, Daily Summary, Flag) read the **Team Brain**; they never keep their own copy.
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
