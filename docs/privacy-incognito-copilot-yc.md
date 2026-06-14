# Privacy, Incognito, Copilot & the YC Path

> Research memo answering three questions raised about taking Oh to YC, plus
> the next steps to turn Oh into a real company. Grounded in the current code
> (`src/scrub.ts`, `src/parse/*`, `src/capture.ts`), the ADRs, and
> [`startup-plan.md`](../startup-plan.md). Written 2026-06-14.
>
> **The framing that ties it together:** the long-term business is *agent
> history* — owning the verbatim record of how AI built a team's software.
> Privacy is not a tax on that business; it is the *precondition* for it. You
> only get to hold agent history at scale if people trust you to hold it. So
> questions (1) and (2) below are not defense — they are the moat-builder for
> the thing in question (3) and the data business beyond it.

---

## 1. Privacy & data-leak concerns

### What Oh actually holds (the honest threat model)

Start from facts, because the privacy story is much stronger than people
assume once you say precisely what leaves the machine:

- **Raw sessions never leave.** They already live in `~/.claude` / `~/.codex`.
  Oh keeps them local (README "How it works").
- **Only *reasoning* is embedded** — prompts, the assistant's explanation, and
  *one-line summaries* of tool actions. Raw file dumps, diffs, and tool output
  are dropped at parse time (`src/parse/claude.ts` drops `tool_result` bodies,
  keeps only an `isError` bit).
- **Secrets are masked before anything leaves** (`src/scrub.ts`), replaced with
  `«secret»`.
- **What lands in the Team Brain** (hosted Supabase): scrubbed reasoning chunks,
  their embeddings, and a small `exchange_metrics` row. Per-user auth + RLS as
  of ADR 0010 — `exchange_metrics` is readable only by its author.

**The one-line pitch this buys you:** *"Oh stores less of your code than your
IDE already sends to the model — no file contents, no diffs, no tool output,
secrets stripped before they leave the laptop."* Lead with data minimization;
it is genuinely true and it disarms the reflexive "you're hoovering up our
code" objection.

### The real concerns, ranked by how much they'll bite

1. **The scrub is a net, not a wall** (its own code comment says so). Regex
   catches known credential *shapes* (AWS, GitHub, OpenAI, Stripe, JWTs, PEM
   blocks, `name = value` assignments). It will miss: high-entropy secrets with
   no known prefix, secrets split across lines, internal hostnames/IPs, and —
   the big one — **PII and proprietary business logic stated in prose** ("the
   churn model weights enterprise accounts 3x", a customer's name in a bug
   report). The model never sees a "secret," but it's still sensitive.
   - **Fix path:** layer the scrub — add an entropy detector and a vetted
     ruleset (gitleaks / trufflehog / detect-secrets, already named in
     `technical-spec.md`), then an *optional* LLM/NER pass for PII before
     embedding for teams that want it. Make "Scrub goes mandatory" (Phase 1
     kill-item) mean *no code path around it*, and add a recall test: plant
     N known secrets, assert 0 survive.

2. **The store is a honeypot.** One multi-tenant Postgres holding many
   companies' reasoning is a single catastrophic target. RLS protects against
   *application* cross-tenant bugs; it does not protect against a leaked
   service key or a Postgres-level compromise.
   - **Fix path (tiered):** now — RLS + encryption at rest (Supabase default
     AES-256) + TLS in transit + rotate off any shared service-role key (ADR
     0010 already did this for users; audit that none remains). Enterprise —
     the *separable data plane* from `technical-spec.md`: per-tenant isolation,
     **deploy-in-their-cloud / self-host** (already first-class per ADR 0010),
     and **customer-managed keys (BYOK/CMEK)** so even Oh can't read the bytes.

3. **Subprocessors.** Data flows to OpenAI (embeddings, via Oh's proxy),
   Supabase (storage), Vercel (control plane), Anthropic (answer synthesis).
   Each needs a DPA and the "we don't train on your data" guarantee.
   - **Important and quotable:** OpenAI and Anthropic's *API/business* tiers do
     **not** train on submitted data by default (unlike the consumer apps).
     Say this explicitly and publish a **subprocessor list** — enterprises ask
     for it on the first call.

4. **Internal access.** Who at Oh can read customer reasoning? The credible
   answer is "no standing access" — engineers can't query tenant data without
   an audited, time-boxed grant. Cheap to promise now, expensive to retrofit
   after a breach.

5. **Compliance is a clock, not a feature.** **SOC 2 Type II** is the
   table-stakes enterprise ask and takes *months* of evidence collection.
   Start the readiness process (Vanta/Drata) early so the badge exists when
   the first enterprise asks — it can't be sprinted. GDPR/CCPA: data deletion
   (`oh forget --team`, already in the Phase-2 trigger), an EU data-residency
   option, DPA template, breach-notification plan.

### The roadmap (don't build enterprise plumbing for the dogfood)

| Stage | Privacy deliverables |
|---|---|
| **Now (dogfood)** | Data-minimization narrative; audit that no shared service key remains; secret-recall test. |
| **Design partners (Phase 2)** | Privacy policy + ToS + DPA on site; subprocessor list; `oh forget`; mandatory scrub w/ entropy + ruleset; incognito (§2). |
| **Enterprise (later)** | SOC 2 Type II; self-host / BYOC; BYOK/CMEK; SSO + audit log; no-standing-access; data-residency. |

This matches the staging the docs already commit to — privacy as the *gate to
enterprise revenue* (business-spec Top risks), built when its trigger arrives.

---

## 2. The incognito option

This is a genuinely good idea and it's cheap, because it operationalizes a
question the docs have already framed: *"Developer control of the shared record
— the single biggest lever on the chilling effect"* (technical-spec → Open
technical decisions). Ship a light version now; it's a strong trust/enterprise
talking point far out of proportion to its cost.

### How it fits the capture model

Capture is hook-driven: on `Stop`/`SessionEnd` a detached `oh capture` reads
only the *new* bytes of a session file (by stored offset), parses, scrubs,
embeds, upserts. Incognito hooks into exactly that seam.

**The one rule that makes it real:** an incognito range must **advance the
offset without storing**. If you merely skip capture, a later `oh backfill`
would sweep the gap back in. Incognito has to *consume and discard*, leaving a
permanent hole — and `oh status`/`oh insights` must show the hole so the dev
can verify it. Incognito that can't be audited is theater (every external
guide on AI "incognito" makes this exact point: it must actually not record,
not just hide the UI).

### Three levels (ship 1–2 now, the rest later)

1. **Global pause** — `oh pause` / `oh resume` (or `oh incognito on|off`)
   writes `~/.oh/incognito`; capture checks it, advances offsets, stores
   nothing; the session brief/status line shows "🔒 incognito — not
   recording." *(Ship now — a few hours.)*
2. **Per-session** — `OH_INCOGNITO=1` env var or a flag at session start, for
   "this whole spike is throwaway." *(Ship now — same plumbing.)*
3. **Per-prompt / per-exchange** — a marker in the prompt (e.g. a `[private]`
   tag or an `oh:private` line) drops just that exchange. *(Later — needs
   exchange-level grouping awareness.)*

Already-existing relative: the `repos` allowlist (capture scope) is *per-repo
incognito by default* — capture only the repos you opt in. Mention it; it's the
same trust lever at coarser grain.

### The honest tradeoff (say it out loud)

An incognito exchange can't be `ask`'d later and breaks Handoff continuity.
That's the accepted cost, and it's *why dev-control is the right answer to the
chilling effect* rather than anonymization (rejected in ADR 0003) or
summary-as-shield (rejected in ADR 0004). For enterprise, whether incognito is
allowed/disabled becomes a Visibility-Policy knob; for indie teams it's on and
dev-controlled.

---

## 3. Make it work for Copilot (the biggest strategic lever)

The instinct is right: **Copilot is the incumbent in orgs** by install base, so
"works where you already are" hugely widens the app's relevance — and it's the
purest expression of Oh's actual wedge, *cross-tool neutrality* (the labs and
GitHub are structurally disincentivized from making your Cursor/Claude history
flow anywhere but their own product; ADR 0006).

**The good news from the research: Copilot is as capturable as Claude/Codex,
because it writes session data to local files Oh can tail with the exact same
architecture — a new parser, no new infrastructure.**

| Surface | Where the data lives | Effort | Notes |
|---|---|---|---|
| **Copilot CLI** | `~/.copilot/session-state/` — prompts, responses, tools used, files modified | **Low** (~Codex-parser sized) | Structurally identical to what Oh already does. Add `src/parse/copilot.ts`, wire a hook/watcher. Start here. |
| **Copilot in VS Code** (the real org footprint — most usage is in-IDE) | `…/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl` — self-contained JSONL: `kind:0` session meta, `kind:2` request/response | **Medium** | No hooks in VS Code, but none needed — **file-watch the `chatSessions` dir**. Same capture model, new parser. |
| **Copilot in JetBrains** | plugin storage / logs (differs) | **Higher** | A JetBrains plugin or log parse. Later. |
| **Enterprise audit log** | GitHub audit log, `action:copilot`, 180-day retention, SIEM streamable | n/a (complementary) | **Metadata only — not the reasoning.** Not a capture source, but an enterprise credibility hook ("integrates with your existing audit stream"). |

### Two bonus wedges Copilot specifically hands you

- **VS Code loses Copilot chat history** — there's a wall of open `microsoft/vscode`
  issues about chat vanishing on restart, workspace rename, or malformed JSONL.
  Oh's file-watch *backs it up* the moment it's written: *"Copilot forgets your
  chats; Oh keeps them forever, across machines and tools."* The bug is your
  feature.
- **Cross-tool is the whole point.** An org on Copilot that also lets a few devs
  use Claude/Cursor gets *one* memory across all of it — which no single vendor
  will ever build, because it's incentive-incompatible for them.

### Recommendation

Ship **Copilot CLI + VS Code `chatSessions` file-tail** as a parser pair before
the YC application — it's concrete, demoable, and turns "we support Claude +
Codex" into "we're the neutral memory layer across the tools 90% of orgs
actually use." Defer the optional VS Code *extension* (cleaner per-turn flush +
the incognito toggle + brief/nudge surfaces in-IDE) and JetBrains to after.

---

## 4. Turning this into a real business + the YC path

### The clock (corrected)

**YC Fall 2026 regular deadline is July 27, 2026** — **~43 days** from today,
not 50. Decisions by Aug 28; batch Oct–Dec in SF. YC reviews late apps but you
lose nothing by hitting the deadline and you keep optionality. Plan to **submit
by ~July 20** to leave slack.

### What YC actually evaluates (and where Oh stands)

| What they weigh | Oh's hand |
|---|---|
| **Founders / why you** | You live the pain and dogfood the product — strong, if you tell it as a founded-from-our-own-loop story. |
| **Insight / "why now"** | Strong: AI now writes most of the code, so the bottleneck moved from *writing* to *re-explaining*; agent history didn't exist as a category two years ago. |
| **Traction** | The weak spot today. Fixable in 43 days (below). |
| **Market** | "Memory layer for the agentic-coding era" — big, and Copilot support makes the TAM story credible. |
| **Moat** | Honestly weak (you've documented it). Have the answer rehearsed: within-org network effect + accumulated why-graph + cross-tool neutrality the incumbents won't copy. |

### The single highest-leverage thing before applying: real retention data

YC funds at idea stage, but *evidence the loop is magic* is what separates a
fundable app from a hundred memory wrappers. Phase 0 ("prove on ourselves")
ends ~July 3 — right before the deadline. Two moves:

1. **Pull Phase 1 forward.** Onboarding is mostly shipped (hosted, no-keys, RLS,
   embed proxy). Get **3–5 *external* small teams** on it now (LinkedIn-launch
   network, YC-batch friends, agencies). Even a handful using `ask` *unprompted*
   with a deflection count is a killer data point.
2. **Instrument and screenshot the curve:** asks/dev/week, deflection count
   (`oh status` already reports "N interruptions deflected"), week-3 retention.
   That chart *is* the application.

### Concrete next steps, sequenced into the 43 days

**Weeks 1–2 (now → ~June 28) — build the demoable surface + seed users**
- Ship **Copilot capture** (CLI + VS Code file-tail). Biggest TAM-story unlock.
- Ship **incognito v1** (global pause + per-session). Trust talking point.
- Recruit **5 external design-partner teams**; get them onboarded this week.
- Draft **privacy policy + ToS + DPA + subprocessor list** for the site (also
  an enterprise-readiness signal). Buy a real **domain** (the "Oh" trademark
  problem is flagged in business-spec — settle it now; fallbacks listed there).

**Weeks 3–4 (~June 28 → July 12) — gather proof + write the app**
- Collect retention/deflection numbers from self + external teams; build the chart.
- Write the YC application; record the 1-minute founder video (casual, real).
- *(Optional signal)* kick off SOC 2 readiness in Vanta — costs little, reads well.

**Weeks 5–6 (July 12 → July 27) — polish + submit**
- Plug real numbers into the app; get it read by a YC alum/mentor.
- **Submit by ~July 20.** Hold incorporation until accepted/taking money — YC
  provides the standard docs — but have a **founder agreement (vesting + IP
  assignment) and a clean cofounder cap table** settled *before* the interview.

### How to talk about "agent history" as the long-term business (the dad's framing)

This is the moat and the multi-billion-dollar version of the story — but
**pitch it carefully.** The docs are right that you must *not* lead with "we'll
mine/sell the data" — it poisons the trust the product runs on, and the labs
have better raw data anyway (business-spec "post-training-data angle"). The
fundable framing:

> *Oh owns the verbatim record of how AI builds a team's software — across every
> tool. That record is the substrate for the next decade: team intelligence,
> provenance, agent onboarding, org-wide "why" search. We earn the right to hold
> it by storing less than the IDE already sends and by giving developers control
> of their own record. Trust is the wedge into the data business, not a tax on
> it.*

That's why §1 and §2 aren't side quests — **the privacy posture and the
incognito control are what make the agent-history business defensible and
acceptable at the same time.**

---

## TL;DR

1. **Privacy:** your real story is *data minimization* (no code/diffs/tool
   output, secrets stripped before leaving the laptop). Harden the scrub
   (entropy + ruleset + recall test), publish a subprocessor list + DPA, and
   stage SOC 2 / self-host / BYOK for enterprise. Don't over-build for the
   dogfood.
2. **Incognito:** cheap and high-trust. `oh pause` + per-session now; the rule
   that makes it real is *advance the offset and discard* (so backfill can't
   recover it) and *show the hole* so devs can verify. It's the right answer to
   the chilling effect — dev control, not anonymization.
3. **Copilot:** very feasible — same file-tail model. CLI (`~/.copilot/session-state/`)
   and VS Code (`workspaceStorage/<hash>/chatSessions/*.jsonl`) are parser-only
   work; ship both before YC. It's the truest expression of your cross-tool
   wedge and the bug-as-feature backup angle is real.
4. **YC / business:** deadline is **July 27 (~43 days)**, submit by ~July 20.
   The one thing that matters most: **real external-team retention/deflection
   data** — pull Phase 1 forward to get 3–5 teams on it now. Frame agent
   history as the long-term substrate, with trust as the wedge into it, never
   the data-mining pitch.

### Sources

- GitHub Copilot CLI session data — [docs.github.com](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle), [community discussion #129888](https://github.com/orgs/community/discussions/129888)
- VS Code Copilot Chat `chatSessions` JSONL storage — [microsoft/vscode #308730](https://github.com/microsoft/vscode/issues/308730), [#285059](https://github.com/microsoft/vscode/issues/285059)
- Copilot Chat local storage (`state.vscdb`) — [community discussion #69740](https://github.com/orgs/community/discussions/69740)
- Copilot enterprise audit logs (180-day, SIEM) — [GitHub Docs](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/review-audit-logs)
- AI "incognito"/temporary-chat patterns — [Transparency Coalition guide](https://www.transparencycoalition.ai/news/tcai-guide-how-to-stop-ai-chatbots-from-capturing-and-selling-your-personal-data)
- YC Fall 2026 deadline (July 27, 2026) — [zyner.io YC deadlines](https://zyner.io/blog/yc-application-deadline), [ycombinator.com/apply](https://ycombinator.com/apply)
</content>
</invoke>
