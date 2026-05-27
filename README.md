# Oh — v0 (`ask`)

Shared memory for a small AI-coding team. Oh captures each person's AI-coding
**Sessions** across **Claude Code** and **Codex**, embeds the *reasoning* into a
shared store, and exposes one tool — **`ask`** — so a teammate's agent can answer
*"why is this code/plan the way it is?"* **instead of interrupting the author to
re-explain.**

This is the dogfood build. See [`implementation-plan.md`](./implementation-plan.md)
for the design and [ADR 0006](./docs/adr/0006-pivot-small-team-re-explaining-loop.md)
for why the wedge is the re-explaining loop.

## How it works

```
Claude/Codex session files  ──(Stop/SessionEnd hook)──▶  oh capture
   (~/.claude, ~/.codex)                                    │
                                                            ▼
                              parse → group into exchanges → scrub secrets →
                              embed (OpenAI) → upsert into Supabase (pgvector)
                                                            │
   teammate's agent ──ask("why …?")──▶ oh MCP server ──────┘
                       ◀── ranked, cited excerpts (similarity + recency)
```

- **Capture** is hook-driven, not a daemon. On every `Stop`/`SessionEnd` it
  spawns a detached `oh capture` that reads only what's new (byte/size offset),
  so it never blocks your turn.
- **Only reasoning is embedded** — your prompts, the assistant's explanation and
  reasoning, and one-line summaries of tool actions. Raw file dumps, diffs, and
  tool output are dropped. Secrets are masked with `«secret»` before anything
  leaves your machine.
- **Raw sessions stay local** (they're already in `~/.claude` / `~/.codex`). The
  shared store holds only the scrubbed, embedded exchanges.
- **`ask` is thin**: it returns ranked, cited excerpts and *your* agent
  synthesizes the answer. Results are re-ranked by **similarity + a recency
  boost**, so when a decision was reversed across Sessions you get the *current*
  one.

## Prerequisites

- **Node ≥ 20** (developed on 25).
- The team shares **one Supabase project** (Postgres + pgvector) — the Team Brain.
- An **OpenAI API key** per person (or one shared key) — used for embeddings.

## One-time project setup (one person does this)

1. Create a Supabase project for the team (Postgres + pgvector — pgvector ships
   with Supabase).
2. Apply the schema once: run `oh migrate` to write `~/.oh/schema.sql`, then
   paste it into the Supabase **SQL editor** (Dashboard → SQL editor) and Run.
   It's idempotent.
3. Share two things with each teammate over a **secure channel** (a password
   manager, not Slack): the **project URL** and the **`service_role` / secret
   key**. In v0 the whole team shares this one key — the accepted tradeoff for a
   few trusted people (real per-user auth comes when a non-friend team joins).

## Per-person setup (you and every teammate)

```bash
git clone <this repo> && cd oh
npm install        # also builds (prepare script)
npm link           # puts `oh` on your PATH
oh init
```

`oh init` prompts for:
- **your name** — how your Sessions are attributed (each person uses a different
  name, so `ask(… who: "alice")` works),
- the **shared Supabase URL + secret key** (identical for everyone on the team),
- **your OpenAI key**,

then shows and — with your confirmation, backing up every file first — wires
capture + `ask` into both tools:
- **Claude**: capture hook in `~/.claude/settings.json` (`Stop`/`SessionEnd`) +
  the `ask` MCP server in `~/.claude.json`.
- **Codex**: capture hook in `~/.codex/hooks.json` (`Stop`) + the `ask` MCP
  server in `~/.codex/config.toml`. *(Codex may ask you to trust the new hook on
  its next run.)*

Finally, seed from your existing history and restart your tools:

```bash
oh backfill        # or: oh backfill --since 30d
# restart Claude / Codex so they load the MCP server + hooks
```

> Every teammate runs `oh backfill` and leaves the hooks on, so their reasoning
> flows into the shared store — you can only `ask` about what teammates have
> captured. Rebuilding or moving the repo? Re-run `oh init`; the hook/MCP
> registration records absolute paths to this build.

## Daily use

Just code. Capture is automatic. When you (or your agent) want the *why* behind
something a teammate did, call the **`ask`** tool from inside Claude or Codex:

> "Use `ask`: why did we switch the queue from SQS to Redis?"

`ask(question, who?, repo?, since?)` — only `question` is required. `who` filters
to a teammate, `repo` to a project (working-dir basename), `since` to an ISO date
or a window like `7d` / `30d`.

## Commands

| Command | What it does |
|---|---|
| `oh init` | Configure, print schema, wire Claude + Codex. |
| `oh migrate` | (Re)write `~/.oh/schema.sql` to paste into Supabase. |
| `oh backfill [--since W]` | Seed the store from existing sessions. |
| `oh status` | Show config + chunk count in the Team Brain. |
| `oh capture --file F --tool T` · `oh capture --all` | Internal (wired by hooks). |
| `oh mcp` | Internal — the stdio MCP server. |
| `oh hook --tool T` | Internal — hook entrypoint. |

## Tuning (`~/.oh/config.json`)

| Field | Default | Meaning |
|---|---|---|
| `embeddingModel` | `text-embedding-3-small` | Must stay fixed for a store (1536-dim is baked into the schema). |
| `includeThinking` | `true` | Include assistant reasoning/thinking blocks in the embedded text. |
| `recencyHalfLifeDays` | `30` | Recency decay half-life for re-ranking. |
| `recencyWeight` | `0.25` | Weight of recency vs. cosine similarity. |

## Verify it works

- `npm test` — parsers (against your real sessions), scrub, the recency re-rank,
  config merging, and the MCP handshake.
- After `oh backfill`: `oh status` should show a non-zero chunk count.
- Plant a fake `AKIA…` key in a prompt, finish the turn, and confirm it lands as
  `«secret»` (capture scrubs before embed/store).
- The hero test (the **latest-authoritative** check): `ask` about a decision the
  team *reversed* across Sessions — it should surface the *current* one. Repeat
  from both Claude and Codex (proves cross-tool access).
- The real metric is **retention**: do teammates reach for `ask` unprompted in
  week 3?

## Not in v0 (deferred)

Full Scrub engine; Handoff / Standups / Flags; web dashboard; SSO/auth/RLS;
cross-machine raw drill-down; server-side answer synthesis. The shared
service-role key (no per-user auth) is the accepted tradeoff for a few trusted
people — real auth arrives when a non-friend team joins.
