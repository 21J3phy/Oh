# Security Policy

Oh stores the verbatim record of developers' AI-coding sessions, so we take
security seriously — secret-scrubbing before data ever leaves a machine is a
core feature, not an add-on.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/21J3phy/Oh/security/advisories/new)
(the repository's **Security** tab → *Report a vulnerability*), including:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one),
- affected version / commit.

We aim to acknowledge within 72 hours and will keep you updated as we
investigate. We'll credit you in the fix unless you'd prefer to stay anonymous.

## In scope

- The `oh-brain` CLI/MCP core (`src/`) — capture, scrubbing, `ask`, hooks.
- The self-host schema and RLS policies (`migrations/`).
- The hosted control plane (`web/`) and its auth / RLS / embedding proxy.

Especially valuable: any way to **bypass secret-scrubbing**, read another
team's memory (RLS escape), or abuse the embedding proxy.

## Out of scope

- Vulnerabilities in third-party dependencies already tracked upstream
  (report those to the upstream project; tell us if Oh is exploitably affected).
- Findings that require a compromised local machine or stolen credentials.

## Supported versions

Oh is pre-1.0 and ships from `main`. Security fixes land on the latest release
of the `oh-brain` npm package; older versions are not patched.
