---
status: accepted
---

# Pivot: small-team re-explaining loop, not the enterprise handoff wedge

We build for **small, high-trust teams** (the founders' own startups and friend groups), **free**, with the wedge being the **"stop re-explaining" loop** — capture each person's AI **Sessions** across tools and let a teammate's agent query them (**Ask-why** + shared context) — and we **dogfood it on our own teams** before building anything else. Enterprises are the eventual payer, but a deferred hypothesis, not the starting customer. This supersedes [ADR 0002](./0002-top-down-org-purchase-handoff-led-wedge.md) on both counts: not top-down, and not handoff-led.

## Why we pivoted

ADR 0002 reasoned about a customer we have no evidence of — a VP Eng at a 10–50-dev org, buying top-down, with surveillance/governance dynamics. The founders are 18, build with friends, and have **never actually done a handoff**, so handoff-as-the-wedge was a guess. The pain they have genuinely lived is *re-explaining their reasoning* to teammates (and re-asking others to explain theirs). That maps to **Ask-why** — which ADR 0002 explicitly *rejected* as the headline. The lived pain contradicted the documented strategy. Build for who you are: a customer you can dogfood and validate this week beats a customer you can only imagine.

## Considered and rejected

- **Stay enterprise-first / handoff-led (ADR 0002).** Rejected: no founder-market fit, no access to the buyer, and the chilling-effect/surveillance gate makes enterprise the *hardest* place to start — even though it is where the money and moat ultimately live.

## Consequence

This is a *sequencing* decision, not an abandonment of the bigger prize. The money and the durable moat are still enterprise — the within-org network effect + accumulated context (see the moat section of [`business-spec.md`](../../business-spec.md)) — so the plan is: validate small and free where it's easy, monetise up-market later where it's hard. Two risks move to the front: **retention** (does the loop stay useful past novelty — the only near-term question that matters) and the **free→enterprise funnel** (our free users are not our future buyers). The privacy work in [ADR 0003](./0003-attribution-over-anonymity.md), [ADR 0004](./0004-summaries-are-a-view-not-privacy.md), and [ADR 0005](./0005-self-resume-is-the-funnel-not-the-wedge.md) is deferred to the enterprise stage, not needed for the dogfood. Handoff, standups, and flags become later Views, not the wedge.
