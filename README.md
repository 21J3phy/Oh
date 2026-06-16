# Oh — give your AI a past

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/oh-brain.svg)](https://www.npmjs.com/package/oh-brain)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

Your AI coding agent starts every session from zero. **Oh gives it a past.**

Every **Claude Code**, **Codex**, and **Copilot** session is captured into a
secret-scrubbed memory store your agent can recall — not lossy summaries like
*"user prefers pnpm"*, but the **verbatim record**: exact quotes, real code
blocks, full reasoning, cited to the moment it happened.

You get three things on top of that memory:

- **Recall** — your agent answers from every session it has ever had with you, across tools.
- **Ask** — a teammate's agent answers *"why is this the way it is?"* with citations, instead of interrupting you.
- **Insights** — your own coding measured from your own memory: time, tokens, friction. Visible only to you.

---

## Quick start

**Fully offline, no account, no keys** — the easiest way to try Oh, and the one
that works on a locked-down machine. Needs [Node 20+](https://nodejs.org).

```bash
npm install -g oh-brain
oh init --local --yes
oh backfill
```

That's it. The store lives on your disk (`~/.oh/local`) and an on-device model
does the rest — nothing leaves your machine. `oh backfill` reads your existing
Claude/Codex/Copilot history into memory (first run downloads a ~23 MB model).

Now restart Claude Code / Codex and ask your agent something like
*"what was I working on last week?"* — or try it straight from the terminal:

```bash
oh ask "what did I work on yesterday?"
```

> On Windows and the command isn't found, or the install errors out? See
> [Troubleshooting](#troubleshooting).

---

## Install options

Pick one. You can switch later by re-running `oh init` with a different flag.

| Mode | What it is | Setup |
|---|---|---|
| **Local** *(above)* | Fully offline. On-device store + model. No account, no keys, no network. | `oh init --local --yes` |
| **Insights-only** | The lightest install — counts tokens/time only. Never stores your prompts or code. | `oh init --insights-only --yes` |
| **Hosted** | We run the shared store. Team memory, no keys, no card. | `oh signup` → `oh team create "Acme"` → `oh init --yes` |
| **Self-host** | Your own Supabase + OpenAI key. Same features, your infrastructure. | `oh migrate` → `oh init` → `oh backfill` |

Every mode finishes with `oh backfill` to seed memory, then a restart of Claude
Code / Codex. Only **Hosted** and **Self-host** give you shared, team-wide
memory; **Local** and **Insights-only** are individual.

<details>
<summary><b>Hosted — full steps</b></summary>

```bash
npm install -g oh-brain
oh signup                 # email + password, logged in instantly
oh team create "Acme"     # or: oh team join <invite-code>
oh init --yes             # wires Claude Code, Codex & Copilot
oh backfill               # seed memory from your existing sessions
```

Restart Claude Code and Codex (approve the one-time Codex hook-trust prompt).
Teammates join with the invite code that `oh team` prints.

</details>

<details>
<summary><b>Self-host — full steps</b></summary>

One person sets up the shared store once:

1. Create a Supabase project (Postgres + pgvector — pgvector ships with Supabase).
2. `oh migrate` writes `~/.oh/schema.sql`. Paste it into the Supabase **SQL editor** and run it (it's idempotent).
3. Share the **project URL** and **secret key** with teammates over a password manager.

Then everyone runs `oh init` (it prompts for your name, the shared Supabase
URL + key, and your OpenAI key) followed by `oh backfill`, and restarts their
tools.

</details>

---

## Troubleshooting

Most install problems are on locked-down corporate machines (common on Windows).

**`oh` is not found after `npm install -g`.** npm's global folder isn't on your
PATH. Either add it — run `npm config get prefix`, then add the printed path
(append `\bin` on macOS/Linux) to your PATH — or skip the global install and run
it directly with `npx oh-brain <command>` (e.g. `npx oh-brain init --local --yes`).

**Permission / `EPERM` / `EACCES` errors during install.** You don't have admin
rights to npm's default global folder. Point npm at a folder you own and
reinstall:

```bash
# Windows (PowerShell)
npm config set prefix "$env:APPDATA\npm"
# macOS / Linux
npm config set prefix ~/.npm-global
```

Then re-run `npm install -g oh-brain`. Make sure that folder is on your PATH (see above).

**A network proxy or antivirus blocks the install or the model download.**
Use **Local mode** — it never touches the network after setup. For a fully
air-gapped box, copy `~/.oh/models` from a machine that has internet, then set
`OH_OFFLINE=1` so Oh never reaches for the network at all.

**`oh: command not recognized` in PowerShell, or scripts are blocked.** Your
execution policy may block npm shims. Use `npx oh-brain <command>`, or run from
Command Prompt instead of PowerShell.

**Node is too old.** Oh needs Node 20 or newer — check with `node --version` and
update from [nodejs.org](https://nodejs.org) if needed.

Still stuck? [Open an issue](https://github.com/21J3phy/Oh/issues) with the exact
command and the full error — it helps to know your OS and `node --version`.

---

## Commands

| Command | What it does |
|---|---|
| `oh init [--local \| --insights-only]` | Configure Oh and wire it into Claude Code, Codex & Copilot. |
| `oh backfill [--since 30d]` | Seed memory from your existing sessions. |
| `oh ask "<question>"` | Query your memory from the terminal (`--who`, `--repo`, `--since`). |
| `oh insights [--since 30d] [--repo R]` | Your time / token / friction report. Always your own sessions only. |
| `oh status` | Show config and how much is in memory. |
| `oh pause` / `oh resume` | Incognito — stop / resume recording. The paused stretch is never stored. |
| `oh signup` / `oh login` / `oh team` | Hosted account and team management. |
| `oh migrate` | Write the schema SQL to paste into your own Supabase (self-host). |

Run `oh` with no arguments for full help.

---

## How it works

```
Claude / Codex / Copilot session files  ──(Stop / SessionEnd hook)──▶  oh capture
   (~/.claude, ~/.codex, ~/.copilot)                                      │
                                                                          ▼
                              parse → group into exchanges → scrub secrets →
                              embed → store (Supabase pgvector, or local files)
                                                                          │
   your agent ── ask("why …?") ──▶ oh MCP server ────────────────────────┘
                ◀── ranked, cited excerpts (similarity + recency)
```

- **Capture is hook-driven, not a daemon.** On every `Stop` / `SessionEnd` it
  reads only what's new, so it never blocks your turn.
- **Only reasoning is embedded** — your prompts, the agent's explanation, and
  one-line summaries of tool actions. Raw file dumps, diffs, and tool output are
  dropped. Secrets are masked with `«secret»` *before* anything leaves your machine.
- **Raw sessions stay local** (they're already in `~/.claude` / `~/.codex`). The
  store holds only the scrubbed, embedded exchanges.
- **`ask` is thin** — it returns ranked, cited excerpts and *your* agent writes
  the answer. Results are re-ranked by similarity plus a recency boost, so a
  reversed decision surfaces the *current* version.
- **Local mode** swaps the two networked steps (embed, store) for on-device
  equivalents. Everything else is identical.

## Configuration (`~/.oh/config.json`)

| Field | Default | Meaning |
|---|---|---|
| `embeddingModel` | `text-embedding-3-small` (local: `Xenova/all-MiniLM-L6-v2`) | Fixed per store — the vector size is baked in. `OH_OFFLINE=1` forbids any model re-fetch. |
| `repos` | *(all)* | Allowlist of git projects to capture (substring-matched). Set it to track only your team's repo; omit to capture everything. |
| `includeThinking` | `true` | Include the agent's reasoning blocks in the embedded text. |
| `recencyHalfLifeDays` | `30` | Recency decay half-life for re-ranking. |
| `recencyWeight` | `0.25` | Weight of recency vs. similarity. |
| `brief` | `session` | Session-start brief: `session`, `daily`, or `off`. |

---

## Open source

The Oh **core** — this CLI/MCP package (`src/`), the self-host schema
(`migrations/`), and the agent skills (`skills/`) — is open source under the
[Apache License 2.0](./LICENSE). Use it, modify it, self-host it, free forever.
Only **Oh Cloud** (the hosted control plane in [`web/`](./web)) is commercial
([ADR 0012](./docs/adr/0012-apache-core-commercial-cloud.md)).

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues:
**don't** open a public issue; see [SECURITY.md](./SECURITY.md).

## Learn more

- [CONTEXT.md](./CONTEXT.md) — the domain language and core concepts.
- [docs/adr/](./docs/adr/) — the architecture and product decisions, with rationale.
- [implementation-plan.md](./implementation-plan.md) · [technical-spec.md](./technical-spec.md) — design detail.
