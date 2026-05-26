---
status: accepted
---

# Attribution over anonymity

Every **Session** in the **Team Brain** is stamped with its author, and we will not anonymize it. Anonymity was floated as a way to defuse the privacy/surveillance worry and rejected, because (a) you cannot anonymize work product — files touched, commit timing, and code style re-identify a developer in a few guesses — and (b) the buyer is paying *for* attribution: **Handoff** ("continue *Alice's* work") and **Ask-why** ("why did *Bob* do this?") are meaningless without a name on the work.

## Consequence

Privacy can never be pitched as "it's anonymous." The developer-trust problem has to be solved another way — by making the personal value of Handoff outweigh the discomfort of being captured, not by hiding who did what. See [ADR 0004](./0004-summaries-are-a-view-not-privacy.md) and the chilling-effect risk in [`business-spec.md`](../../business-spec.md).
