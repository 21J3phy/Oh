---
name: ask-why
description: Query the team's shared memory (Oh) to learn WHY code, a plan, or a decision is the way it is — retrieving a teammate's (or your own) past reasoning instead of interrupting anyone to re-explain. Use when you hit a non-obvious decision/workaround in code or docs, when the user asks "why is X like this" / "why did we choose X over Y" / "what was the thinking behind X", before changing or re-implementing something whose rationale is unclear, or when reviewing a teammate's change. Backed by the `ask` MCP tool (server `oh`), which works from both Claude and Codex.
---

# Ask-why — the team's shared memory

When you need the *reasoning* behind something rather than just the code, query Oh
instead of guessing or interrupting the author. Oh holds the team's past AI-coding
Sessions (Claude + Codex), embedded for semantic search.

## When to reach for this

- You hit a non-obvious decision, workaround, or design choice and the "why" isn't
  in the code or comments.
- The user asks "why is this the way it is?", "why did we pick X over Y?", "what
  was the thinking behind X?".
- You're about to change, revert, or re-implement something whose rationale is
  unclear — check the reasoning *before* you touch it.
- You're reviewing a teammate's PR/change and want the context behind it.

## How

Call the `ask` tool (MCP server `oh`) with a focused `question`. Add filters when
they help:

- `who` — a teammate's name, to scope to their Sessions.
- `repo` — the project (working-directory basename).
- `since` — an ISO date or a window like `7d` / `30d`.

You get back ranked, cited excerpts of past reasoning across Claude and Codex.

## Using the results

- Answer **only** from the returned excerpts — don't invent a rationale.
- On conflict, **prefer the most recent** excerpt: a later Session may have reversed
  an earlier decision. The "most recent relevant" timestamp is called out at the top.
- **Always cite** who + session + when for each claim you make.
- If results are empty or weak, **say so plainly** — then it's reasonable to ask the
  human. Don't pass off a guess as the team's reasoning.
