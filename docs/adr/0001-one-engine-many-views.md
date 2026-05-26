# One engine, many views

The product exposes several features — handoff, ask-why, daily summaries, governance flags — that all read the same underlying data: captured, scrubbed, indexed AI-coding sessions. We build that capture → scrub → index → query core **once**, as a single Engine, and implement every feature as a **View** over it rather than as an independent product with its own pipeline or store.

We chose this over shipping separate tools (or letting features browse raw transcripts directly) because the features differ only in *trigger* (human-pulled vs automatic) and *output shape*, not in their underlying data — so unifying avoids duplicated capture/storage and keeps a single, consistent permission boundary.

**Consequence:** feature work is cheap once the Engine exists, but the Engine is the critical path — nothing ships until capture, scrub, and query are solid.
