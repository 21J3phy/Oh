---
status: accepted
---

# Privacy posture, dev-controlled incognito, and Copilot capture (the YC push)

Three product/strategy questions surfaced while preparing Oh for YC: (1) how to
address privacy/data-leak concerns, (2) whether to give developers an incognito
option that doesn't record prompts, and (3) whether Oh should capture **GitHub
Copilot**, the incumbent in orgs. This ADR records the decisions and the
business framing that ties them together. Grounded in the current code
(`src/scrub.ts`, `src/parse/*`, `src/capture.ts`), prior ADRs (0003, 0004,
0006, 0010), and [`startup-plan.md`](../../startup-plan.md).

**The unifying framing:** the long-term business is *agent history* — owning the
verbatim record of how AI builds a team's software, across tools. Privacy and
dev-control are not a tax on that business; they are the precondition for it.
You only get to hold agent history at scale if developers trust you to hold it.
So decisions (1) and (2) are moat-builders for (3) and the data business beyond
it — **trust is the wedge into the data business, never the data-mining pitch**
(consistent with business-spec's "post-training-data angle: do not lead with
it").

## Decision 1 — Privacy: lead with data minimization, harden in stages

**Lead the privacy story with what is already true:** Oh stores *less* of your
code than your IDE already sends to the model. Raw sessions never leave the
machine; only reasoning is embedded (prompts, assistant explanation, one-line
tool summaries); file contents, diffs, and tool output are dropped at parse
time; secrets are masked before anything leaves the laptop (`src/scrub.ts`).

Harden on the same staged schedule the docs already commit to (privacy as the
*gate to enterprise revenue*, not a day-1 build):

- **Now (dogfood):** audit that no shared service-role key remains post-ADR-0010;
  add a secret-recall test (plant N known secrets, assert 0 survive).
- **Design partners:** privacy policy + ToS + DPA + **subprocessor list** on the
  site (state that OpenAI/Anthropic *API* tiers don't train on data, unlike the
  consumer apps); `oh forget`; make "scrub mandatory" mean *no code path around
  it*, upgraded with entropy detection + a vetted ruleset (gitleaks/trufflehog)
  and an optional PII/NER pass.
- **Enterprise:** SOC 2 Type II (start Vanta/Drata early — it's a months-long
  clock, not a feature); self-host / deploy-in-their-cloud (first-class per ADR
  0010); BYOK/CMEK; SSO + audit log; no-standing-internal-access.

The honeypot risk (one multi-tenant store of many companies' reasoning) is
answered by RLS now and per-tenant isolation / BYOK at enterprise — the
separable data plane in `technical-spec.md`.

## Decision 2 — Ship dev-controlled incognito (advance-offset-and-discard)

Add a developer-controlled incognito mode. This operationalizes the open
question the docs already name as *the single biggest lever on the chilling
effect* — "developer control of the shared record" (technical-spec → Open
technical decisions) — and is the right answer to the chilling effect, as
opposed to anonymization (rejected, ADR 0003) or summary-as-shield (rejected,
ADR 0004).

**The rule that makes it real:** an incognito range must **advance the capture
offset and discard the bytes**, never merely skip — otherwise a later
`oh backfill` would recover the gap. And `oh status` / `oh insights` must
*show the hole* so the developer can verify nothing was kept. Incognito that
can't be audited is theater.

Levels, ship order:

1. **Global pause** — `oh pause` / `oh resume` (writes `~/.oh/incognito`;
   capture checks it, advances offsets, stores nothing; brief/status line shows
   "🔒 incognito"). *Ship now.*
2. **Per-session** — `OH_INCOGNITO=1` / start-of-session flag. *Ship now.*
3. **Per-prompt/exchange** — an in-prompt marker drops one exchange. *Later.*

The existing `repos` allowlist is already per-repo incognito-by-default.

**Accepted tradeoff:** an incognito exchange can't be `ask`'d later and breaks
Handoff continuity. That's the point — dev control over the record. For
enterprise, allow/disable becomes a Visibility-Policy knob.

## Decision 3 — Capture GitHub Copilot (CLI + VS Code) before YC

Add Copilot capture. Copilot is the incumbent in orgs by install base, so
"works where you already are" widens the app's relevance, and it is the purest
expression of Oh's actual wedge — **cross-tool neutrality** the labs and GitHub
are structurally disincentivized to build (ADR 0006).

Copilot is as capturable as Claude/Codex because it writes session data to
local files Oh can tail with the *same* architecture — **parser-only work, no
new infrastructure**:

| Surface | Location | Effort |
|---|---|---|
| **Copilot CLI** | `~/.copilot/session-state/` (prompts, responses, tools, files) | Low — ~`codex.ts`-sized; start here. |
| **Copilot in VS Code** (real org footprint) | `…/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` (`kind:0` meta, `kind:2` request/response) | Medium — no hooks needed; file-watch the dir. |
| **JetBrains Copilot** | plugin storage/logs | Higher — later. |
| Enterprise audit log | GitHub `action:copilot`, 180-day, SIEM | Complementary metadata only, not a capture source. |

Two Copilot-specific wedges: VS Code keeps *losing* Copilot chat history (open
`microsoft/vscode` bugs) — Oh's file-watch becomes the durable backup ("Copilot
forgets your chats; Oh keeps them"); and cross-tool means one memory across an
org's Copilot + Claude + Cursor mix, which no single vendor will build.

**Decision:** ship Copilot CLI + VS Code `chatSessions` capture as a parser pair
before the YC application. Defer the optional VS Code *extension* (per-turn
flush, in-IDE incognito toggle, brief/nudge) and JetBrains.

## Considered and rejected

- **Summary-only / anonymization as the privacy answer** — already rejected in
  ADRs 0003–0004. Dev-controlled incognito (Decision 2) is the chosen lever.
- **Treating enterprise audit logs as a Copilot capture source** — rejected;
  they carry metadata, not reasoning. Complementary credibility hook only.
- **Building enterprise privacy plumbing (SOC 2, BYOK, self-host) now** —
  rejected; staged to when its trigger (a paying enterprise) arrives.

## Consequence

Privacy posture, incognito, and Copilot reinforce each other: minimization +
dev-control make holding agent history defensible and acceptable, and Copilot
support makes the cross-tool memory layer real where most orgs already are.

**Action items (sequenced into the ~43 days to the YC Fall 2026 deadline,
July 27, 2026 — submit by ~July 20):**

- **Build (weeks 1–2):** Copilot CLI parser (`src/parse/copilot.ts`) + VS Code
  `chatSessions` file-tail; incognito v1 (`oh pause` + per-session, with the
  advance-and-discard rule and a visible hole in `oh status`).
- **Privacy (weeks 1–2):** audit out any residual shared key; secret-recall
  test; draft privacy policy + ToS + DPA + subprocessor list; buy a real domain
  (settle the "Oh" trademark question from business-spec).
- **Traction — the highest-leverage item (weeks 1–3):** pull Phase 1 forward;
  get **3–5 external teams** onboarded now; instrument and screenshot
  asks/dev/week, deflection count, week-3 retention — that chart is the
  application.
- **YC (weeks 3–6):** write the app + record the 1-minute founder video; have a
  founder agreement (vesting + IP) and clean cap table ready before any
  interview (incorporate only on acceptance); submit by ~July 20.
- **Frame agent history** as the long-term substrate with trust as the wedge —
  never the data-mining pitch.
</content>
