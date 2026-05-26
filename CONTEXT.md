# Oh — Shared Memory for AI-Coding Teams

The context layer for teams whose code is largely written by AI agents: it preserves the *reasoning* behind every change so teammates can continue, review, and understand each other's work.

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
Removing secrets (keys, tokens, credentials) from a Session before it is stored. Mandatory, pre-storage.
_Avoid_: redact, sanitize, clean

**Engine**:
The single core that Captures, Scrubs, indexes, and answers queries over Sessions. There is only one.

**View**:
A product feature built on the Engine. Every feature is a View; none owns its own data store.

**Handoff**:
The View that reconstructs a teammate's in-progress work as a resumable plan to continue. The lead View.
_Avoid_: resume, takeover

**Ask-why**:
The View that answers "why was this change made?" about a specific PR/commit, with a cited explanation drawn from the linked Session.

**Daily Summary** (a.k.a. **Standup**):
The View that reports what a person *shipped* — anchored to merged work, not chat volume.

**Flag**:
An automatic finding the Engine raises against a Session (wasted tokens, leaked secret, skipped review).

**Visibility Policy**:
The org-configured rule for who sees a Flag or Summary — the individual, the team in aggregate, or a named report to a manager. Security Flags always escalate.

**Org**:
The paying customer. Owns its team's Sessions and sets the Visibility Policy.

## Relationships

- An **Org** has many members; each member produces many **Sessions**.
- The **Engine** **Captures** then **Scrubs** every **Session** before storing it in the **Team Brain**.
- **Views** (Handoff, Ask-why, Daily Summary, Flag) read the **Team Brain**; they never keep their own copy.
- A member's agent reaches a **View** through a **Skill** (the trigger) that calls an **MCP** (the engine connection).
- **Flags** and **Daily Summaries** are exposed according to the **Org**'s **Visibility Policy**.

## Example dialogue

> **Dev:** "When I 'ask why' on a PR, am I reading my teammate's actual chat?"
> **Domain expert:** "No — Ask-why gives you a *cited answer* synthesised from their **Session**. You can click into the source moment, but the default is an answer, not a raw transcript. Reading the raw chat would make it a surveillance tool."
> **Dev:** "And Handoff?"
> **Domain expert:** "Same **Engine**, different **View**. Ask-why explains the past; Handoff reconstructs the *present* state of unfinished work so your agent can continue it."

## Flagged ambiguities

- **"OS"** (from the brainstorm) — Taha's "repo of markdown files updated daily by AI agents." Dropped as a name; the surviving concept is the **Team Brain**, which is a queryable Session store, not a markdown repo.
- **"b2a"** — the revived codename. Dropped in favour of a real name (**Relay** proposed).
- **"skill" vs "MCP"** — resolved: the **Skill** is the front door / trigger; the **MCP** is how it reaches the **Engine**. Two parts, not alternatives.
- **helper vs watcher** ("two products") — resolved: one **Engine**, two triggers. A human pulling an answer (Handoff / Ask-why) and the system auto-checking (Flags / Summaries) are the same query capability.
- **"personal"** — resolved to "one person (+ maybe one other)" = free tier; anything team-scale = paid **Org**.
