# Oh — v0 Dogfood Implementation Plan

## Context

Per ADR 0006, Oh pivoted to the **re-explaining loop** for small high-trust teams (our own), dogfooded first. The v0 is a single tool — **`ask`**: capture each person's AI-coding Sessions across **Codex + Claude**, embed them into a shared store, and let a teammate's agent answer "why is this code/plan the way it is?" with a citation — instead of interrupting the author. Success = **retention** (do we keep using it past week 1?), not revenue. This plan turns `technical-spec.md` → "v0 — dogfood" into a concrete build.

## Grounding facts (machine recon — settled)

- **Repo:** greenfield, docs-only. GitHub remote `21J3phy/Oh`, default branch `main`.
- **Env:** Node v25.9.0 + npm, Docker 29.2.1, Python 3.14.3. → **stack is TypeScript/Node.**
- **Capture sources** (both append-only JSONL, both carry `cwd` + ISO timestamps → uniform tailing + repo attribution):
  - **Claude Code:** `~/.claude/projects/<path-encoded-cwd>/<session-uuid>.jsonl`. Events: `type` (user/assistant/tool-call/tool-result/…), `timestamp`, `cwd`, `sessionId`.
  - **Codex CLI:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<ulid>.jsonl`. Events: `type` (session_meta/event_msg/response_item/turn_context), `timestamp`, `payload`; `cwd` in first `session_meta` line.
- **Access:** BOTH tools support custom MCP servers (Claude: `.mcp.json`/`~/.claude.json`; Codex: `~/.codex/config.toml` `[mcp_servers.*]`) AND hooks (Claude: `~/.claude/settings.json`; Codex: `~/.codex/hooks.json`). Claude hooks pass `transcript_path` + `session_id` + `cwd` on stdin.

## What runs where

- **Cloud / shared (only infra provisioned):** **Supabase** (Postgres + pgvector) = the shared store. **OpenAI embeddings API** = metered call (capture + query time).
- **Local, per machine (code, nothing hosted):** capture **hook** → detached capture process; the **`ask` MCP server** (stdio subprocess spawned by Claude/Codex). Both read `~/.oh/config.json` (author, Supabase URL+key, OpenAI key).
- **Raw stays local** (already in `~/.claude` / `~/.codex`); Supabase holds only normalized + embedded exchanges (+ citation snippets). Cross-machine raw drill-down deferred.

## Decisions (resolved via grill)

1. **Topology** — ✅ **No backend.** Clients read/write Supabase directly; **TypeScript end-to-end**. Tradeoff: shared DB creds among the 3 (→ real auth when a non-friend team joins).
2. **Hosting** — ✅ **Supabase** (managed Postgres + pgvector), one shared project.
3. **Capture/chunk/embed** — ✅ Store raw locally; **embed reasoning only** (user prompts + assistant explanation + one-line tool-action summaries; no file dumps / raw tool output). **Diffs not indexed — linked.** Chunk by **exchange**. Embeddings: **OpenAI `text-embedding-3-small`** (1536-dim).
4. **`ask` output** — ✅ **Thin server returns ranked, cited chunks; calling agent synthesizes.** No LLM key in server. Server-side synthesis is a deferred additive upgrade.
5. **Secrets** — ✅ **Cheap regex guard** (gitleaks/detect-secrets-style patterns) applied before store/embed; matches → `«secret»`. Net, not wall. Full Scrub deferred.
6. **Ranking** — ✅ Hybrid **similarity + recency boost**; results carry `ts`; tool description tells agent to prefer recent on conflict. No explicit supersede-detection in v0.
7. **Distribution** — ✅ **Hooks, not a daemon.** Capture fires from `Stop`/`SessionEnd` hooks (detached/async, never blocks the turn; byte-offset tracking for incremental reads). `ask` = MCP tool (optional thin skill as front-door). Setup via **`oh init`** + one-time **`oh backfill`**.

## Components (single TS package `oh`, npm-distributed)

- `src/config.ts` — read/write `~/.oh/config.json`.
- `src/db.ts` — Supabase client; schema queries (upsert session/chunks, vector search).
- `src/embed.ts` — OpenAI `text-embedding-3-small` wrapper (batch).
- `src/scrub.ts` — regex secret guard (cloud keys, tokens, high-entropy `KEY=…`) → `«secret»`.
- `src/parse/claude.ts`, `src/parse/codex.ts` — each tool's JSONL → common events.
- `src/normalize.ts` — events → **Exchange** `{ sessionId, tool, author, repo, cwd, index, ts, reasoningText, toolSummaries[] }`.
- `src/capture.ts` — read file from saved offset (`~/.oh/offsets/<sessionId>`) → new exchanges → scrub → embed → upsert. Idempotent.
- `src/hook.ts` — hook entrypoint: parse stdin payload (transcript_path/cwd), spawn **detached** `oh capture`, exit immediately.
- `src/mcp.ts` — stdio MCP server exposing `ask`.
- `src/cli.ts` — `oh init`, `oh backfill` (+ internal `oh capture`, `oh mcp`, `oh hook`). `bin: { oh }`.

## Data model (Supabase)

- Extension: `create extension vector;`
- `sessions` — `id text pk` (sessionId/ulid), `tool`, `author`, `repo`, `cwd`, `started_at`, `last_seen_at`.
- `chunks` — `id`, `session_id fk`, `author`, `tool`, `repo`, `cwd`, `exchange_index`, `text`, `ts timestamptz`, `embedding vector(1536)`.
- Indexes: `hnsw (embedding vector_cosine_ops)`; btree on `(repo, ts)`, `(author)`.

## `ask` tool

- Signature: `ask(question: string, who?: string, repo?: string, since?: string)`.
- Flow: embed(question) → vector search top-N (~30) with optional filters → re-rank `similarity + λ·recency` → return top-k (~8) `[{ text, who, tool, repo, sessionId, ts }]` + "most recent relevant: <ts>".
- **Tool description (load-bearing):** answer **only** from results; **prefer most recent on conflict**; **always cite** who + session + ts; say **"no relevant context found"** when results are weak/empty.

## CLI

- **`oh init`** — prompt author + Supabase URL/key + OpenAI key → write `~/.oh/config.json` → run schema migration if absent → **register** (with confirm) the capture **hook** + `ask` **MCP server** in Claude (`~/.claude/settings.json` hooks + `~/.claude.json`/`.mcp.json`) and Codex (`~/.codex/hooks.json` + `config.toml [mcp_servers.oh]`).
- **`oh backfill [--since]`** — one-time scan of existing `~/.claude/projects` + `~/.codex/sessions` through the capture pipeline (seeds the store).

## Build sequence

1. Scaffold TS package (`package.json`, `tsconfig`, bin).
2. `config.ts` + `oh init` (config write only).
3. Supabase schema migration (extension + tables + indexes).
4. Parsers + `normalize.ts` → Exchanges. **Unit-test against real local session files** (redacted).
5. `scrub.ts` + `embed.ts` + `db.ts` upserts.
6. `capture.ts` (offset tracking). Validate via `oh backfill` on your own sessions.
7. `mcp.ts` `ask` (retrieval + ranking). Test standalone.
8. `hook.ts` + `oh init` registration (Claude + Codex); wire hooks → capture.
9. Register MCP server in both tools; test `ask` from inside Claude **and** Codex.
10. Dogfood: each person `oh init` + `oh backfill`; use for real.

## Verification (end-to-end)

- **Parsers:** sample real sessions → correct Exchanges (reasoning kept, file dumps/diffs dropped).
- **Capture:** `oh backfill` → `select count(*) from chunks` > 0, embeddings populated; plant a fake `AKIA…` key → confirm it's stored as `«secret»`.
- **`ask`:** from Claude Code, ask "why did we choose X over Y" about a real past decision → cited answer pulls the right session. **Latest-authoritative test:** ask about something the team reversed → returns the *current* decision. Repeat from **Codex** (proves cross-tool access).
- **Retention metric:** log `ask` calls per person/week — the real success signal.

## Deferred / out of scope (explicit)

Full Scrub engine; Handoff / Standups / Flags; web dashboard; SSO/auth/RLS; cross-machine raw drill-down; server-side answer synthesis; launchd auto-start; non-OpenAI embeddings; everything enterprise.
