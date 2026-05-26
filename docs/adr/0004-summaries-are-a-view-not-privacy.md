---
status: accepted
---

# Summaries are a View, not a privacy mechanism

The **Team Brain** keeps the raw (secret-scrubbed) **Session**. **Daily Summary** and **Ask-why** synthesis are **Views** over that raw data for usability — not a privacy shield, and we will not pitch them as one. Summarizing does not address the real risk, the *chilling effect* (that being captured at all changes how a developer talks to the AI), because the deterrent is the recording, not the format it is stored in — and a summary clean enough to remove what embarrasses a developer has also dropped the messy reasoning that is the only thing the raw PR does not already tell you.

## Considered and rejected

- **Summary-only — discard the raw Session.** Genuinely reduces the chilling effect, but **Ask-why** can no longer cite a real source moment, you cannot answer *tomorrow's* new question against a Session you already threw away, and **Handoff breaks** — it needs the live, unedited state, not a tidy recap. Retained only as a fallback if validating the chilling-effect risk shows that raw capture is untenable.

## Consequence

Keeping raw buys citations, future Views, and live Handoff — but yields *zero* privacy on its own, so the entire developer-trust burden shifts onto other levers: lopsided personal Handoff value, a dev-approved/dev-visible shared record, capture scoped to shipped-artifact-linked work, and bounded retention. Those levers are still open (see [`technical-spec.md`](../../technical-spec.md) → Open technical decisions), and several trade against near-live Handoff.
