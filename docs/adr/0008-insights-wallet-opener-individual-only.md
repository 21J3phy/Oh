---
status: accepted
---

# Sell the pairing — ask-why retains, Insights opens the wallet — and Insights are individual-only

Two decisions, made together because they constrain each other:

1. **The path to revenue is prosumer per-seat, led by Insights as the invoiceable value.** Ask-why's value ("fewer interruptions") is real but soft — hard to price, impossible to invoice. Insights lands on a budget line that already exists: every target team pays monthly for Claude/Codex seats and tokens, and the person paying has zero visibility into where it goes. The sellable product is the pairing: **ask-why is why the team keeps Oh installed daily; Insights is why the person with the credit card pays.** Neither sells alone.

2. **Insights are visible only to the individual dev. Full stop.** No `--who` (querying a teammate's numbers), no per-author team tables, no manager roll-ups. Your time anatomy, token economy, friction stats, and Nudges are yours. This *tightens* ADR 0007, which allowed team-visible aggregates; that allowance is withdrawn.

## Why individual-only

- **The trust line is the product.** Oh's wedge works because on a high-trust team everyone *wants* their why shared. The instant Insights reads as "your teammate (or boss) can see how often you rabbit-hole," capture itself becomes adversarial and the chilling effect (business-spec risk #5) arrives years early, killing the wedge to protect a side-feature. Reasoning is shared; *performance numbers* are not.
- **Aggregates don't hide anything on a 3-person team.** "Team rabbit-holes: 4" is trivially attributable. At our scale, aggregate visibility ≈ individual visibility, so the only safe default is self-only.
- **It doesn't break the sales story** — it sharpens it. The buyer-facing artifact becomes (a) **ask-deflection counts** ("Oh answered 14 questions this week that would have been interruptions") — a statement about *Oh's* output, not any dev's behaviour; (b) team-level *usage and spend totals* once a hosted tier exists and the org is the billing entity; (c) whatever a dev *chooses* to share (the "Oh Wrapped" screenshot is opt-in by nature). Per-person performance data is never the artifact.

## The sequence to the first dollar

1. **Retention proof on our own team** (unchanged, ADR 0006). Instrument ask-deflection counts now — the retention metric and the future first line of the pitch are the same number.
2. **Kill the unsellable setup.** Shared service-role key + bring-your-own OpenAI key + paste-SQL disqualifies any sale. The productization unit is one coherent chunk: `oh login` → hosted backend that provisions the team, owns the embedding key (we eat COGS — that's why a paid tier exists), enforces per-user auth/RLS, and is the billing entity. Scrub becomes mandatory here (first non-friend data, per technical-spec).
3. **~10 design-partner teams, free** — AI-native startups/agencies, 3–15 devs, already multi-tool. Weekly feedback; watch deflection + WAU.
4. **Per-seat price when it sticks** — order of $15/seat/month, free ≤3 seats with short retention. Caps map to real COGS (storage, embeddings, retention window), closing business-spec risk #4. Buyer = founder with a credit card; self-serve, no sales motion — this *sidesteps* the broken free→enterprise funnel (risk #2) instead of waiting on it.
5. **Enterprise only when a design partner grows into one.** The Visibility Policy apparatus (ADR 0003–0005 territory) stays deferred; individual-only Insights makes that conversation easier, not harder, when it comes.

## Considered and rejected

- **Team-aggregate Insights (ADR 0007's stance).** Rejected above — attribution-by-arithmetic on small teams, and the surveillance smell costs more than the dashboard is worth.
- **Selling Insights as a standalone "AI spend observability" product.** Datadog/Git AI territory (see business-spec competitive table); without ask-why's daily pull it's a dashboard nobody opens, and we'd be leading with the layer they already own.
- **Waiting for the enterprise funnel (pre-pivot plan).** Defers revenue years and rests on a funnel we flagged as possibly broken.
- **Dollar figures in v0.1 reports.** Still rejected for now (price tables go stale), but explicitly revisit the day a digest goes in front of a buyer — "$11 wasted" outsells "80k tokens."

## Consequence

- `oh insights` reports only the caller's own Sessions: `--who` and `--team` are removed; the per-author roll-up code goes with them. The Nudge was already self-only.
- **Honest limit:** in the v0 dogfood everyone shares one service-role key, so individual-only is enforced by convention, not the database. Real enforcement (RLS keyed to per-user auth) arrives with the hosted tier in step 2 — it is the same work, not an extra.
- ADR 0007's display-defaults paragraph is superseded on the team-aggregate point; everything else in it stands.
- The weekly digest (v0.2) is per-dev, delivered privately; any team-facing artifact is limited to deflection counts and org-level spend totals.
