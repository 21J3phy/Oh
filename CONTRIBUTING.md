# Contributing to Oh

Thanks for wanting to make Oh better. Oh is the verbatim memory layer for
AI-coding teams — it captures every Claude Code / Codex / Copilot session so a
teammate's agent can ask *"why did we do it this way?"* and get the real answer.

## What's open, what's not

Oh is **open core** ([ADR 0012](./docs/adr/0012-apache-core-commercial-cloud.md)):

- **Apache-2.0 (contributions welcome):** the `oh-brain` CLI/MCP (`src/`), the
  self-host schema (`migrations/`), and the agent skills (`skills/`).
- **Commercial (not open for outside contribution):** the hosted control plane
  (`web/`, "Oh Cloud") and enterprise features. PRs touching `web/` will
  generally be declined unless coordinated with the maintainers first.

By submitting a contribution you agree it is licensed under Apache-2.0 (see
`LICENSE`), per the inbound-equals-outbound convention in section 5 of the
license.

## Dev setup

```bash
npm install
npm run build       # tsc -> dist/, then chmods the CLI
npm test            # node --test over test/*.test.ts
npm run typecheck   # tsc --noEmit
```

Run the CLI locally without a global install: `npm run dev -- <args>`
(e.g. `npm run dev -- status`).

## Before you open a PR

- **Read the relevant ADR first.** Architecture and product decisions live in
  [`docs/adr/`](./docs/adr/); the domain language is in
  [`CONTEXT.md`](./CONTEXT.md). If your change contradicts an accepted ADR,
  say so and why — that's a conversation worth having, not a blocker.
- **Tests stay green** (`npm test`) and **types stay clean** (`npm run typecheck`).
  Add a test for any behavior change.
- **Never commit secrets or captured sessions.** Oh scrubs secrets before
  anything leaves a machine; the test fixtures in `test/scrub.test.ts` are fake
  by design. Local state lives under `.oh/` and is git-ignored.
- Match the surrounding code's style and comment density. Small, focused PRs
  merge faster than big ones.

## Reporting bugs / proposing features

Open an issue using the templates. For anything security-related, **do not open
a public issue** — see [`SECURITY.md`](./SECURITY.md).
