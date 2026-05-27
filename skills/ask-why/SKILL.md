---
name: ask-why
description: ALWAYS consult the team's shared memory (Oh) before explaining, changing, reverting, or re-implementing code whose rationale you're not sure of — it retrieves the original reasoning from past Claude/Codex Sessions so you don't guess or interrupt a teammate. Strong triggers: you're about to edit/refactor/delete code and the "why" isn't obvious; you hit a surprising choice, workaround, hack, magic number, or "weird"-looking pattern; the user asks "why is X like this", "why did we do/choose X", "what was the thinking behind X", or "who decided X"; you're reviewing a diff/PR; you're starting in an unfamiliar part of the codebase. When unsure whether to use it, use it — it's cheap and beats re-deriving context or pinging a person. Backed by the `ask` MCP tool (server `oh`); works in Claude and Codex.
---

# Ask-why — the team's shared memory

Oh holds the team's past AI-coding Sessions (Claude + Codex), embedded for
semantic search. When you need the *reasoning* behind something — not just the
code — query Oh first.

## Reach for this (proactively)

- **Before** you edit, refactor, revert, or re-implement something whose rationale
  isn't obvious from the code/comments — check why it's that way first.
- You hit a surprising decision, workaround, hack, magic number, or "why is this
  here?" moment.
- The user asks "why is this the way it is?", "why did we pick X over Y?", "what
  was the thinking behind X?", "who decided X?".
- You're reviewing a teammate's diff/PR, or starting work in unfamiliar code.

When you're unsure whether it's worth a lookup, do it anyway — one `ask` is cheap
and beats guessing or interrupting a person.

## How

Call the `ask` tool (MCP server `oh`) with a focused `question`. Optional filters:
`who` (a teammate's name), `repo` (working-directory basename), `since` (an ISO
date or a window like `7d` / `30d`).

## Using the results

- Answer **only** from the returned excerpts — don't invent a rationale.
- On conflict, **prefer the most recent** excerpt: a later Session may have reversed
  an earlier decision (the "most recent relevant" timestamp is shown).
- **Always cite** who + session + when.
- If results are empty or weak, **say so** and ask the human — don't pass a guess
  off as the team's reasoning.
