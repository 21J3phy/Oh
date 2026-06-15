---
status: accepted
---

# Local mode: a fully-offline Oh that never leaves the machine

Hosted Oh (ADR 0010) clears the 10-minute-stranger test for individuals, but it fails the test that actually gates enterprise adoption: a security review. A regulated or security-locked org cannot approve a tool that ships its developers' verbatim AI-coding Sessions — code, reasoning, prompts — to a third-party cloud and a third-party embedding API, no matter how good the RLS story is. The procurement answer to "where does our source-derived data go?" has to be "nowhere." So we ship a third mode, **`local`**, alongside `hosted` and `selfhost`: the entire Engine runs on the developer's machine with **no cloud, no API, no account, no keys** — nothing leaves the box.

This is the easiest possible thing for an enterprise to adopt (a single `npm i -g`, no network egress to allow-list, no DPA to sign, no secret to provision) and the natural top-of-funnel for orgs that would never start with hosted. It is the same product — Recall and Ask-why over your own past Sessions — minus the *team* (a local store is single-machine by definition; the Team Brain is what hosted/selfhost sell).

## Architecture (it falls out of the existing seams)

The codebase already abstracts the two things that touch the network behind `createDb(cfg)` and `createEmbedder(cfg)`; capture, ask, insights, brief, and nudges are mode-agnostic above them (ADR 0010). Local mode is just a third implementation of each — no changes above the db/embed layer:

- **Store: plain files under `~/.oh/local`** — `chunks.jsonl`, `metrics.jsonl`, `asks.jsonl`, `sessions.json`. Deliberately boring and inspectable so a security reviewer can read exactly what is kept. Vector search is **brute-force cosine in memory**: for one developer's history (thousands of chunks, a few MB of float arrays) it is instant, and it keeps the install free of a database engine or native modules. Implements the same `Db` interface Supabase does.
- **Embeddings: an in-process model** (`@huggingface/transformers`, default `all-MiniLM-L6-v2`, 384-dim, ~23MB quantized) that runs in the Node process — no OpenAI, no per-query network call. Weights are fetched **once** into `~/.oh/models` and reused forever; on an air-gapped machine you copy that directory across and set `OH_OFFLINE=1` so it never reaches for the network at all. The runtime is an **optional dependency** loaded lazily, so non-local installs don't pay its weight.
- **Config: keyless.** `mode: "local"` validates with nothing but an `author` name. `oh init --local` writes it and wires Claude/Codex/Copilot exactly as the other modes do.

## Consequences

- **Enterprise on-ramp without a sales motion.** A dev (or a security team) can stand up Oh entirely inside the perimeter and evaluate it before any conversation about the Team Brain. The upgrade path to a shared brain is `oh init` into hosted/selfhost + `oh backfill` — the raw Sessions are still on disk, so re-capture is free (same disposable-by-construction property as ADR 0010's self-migration).
- **Embedding quality drops** vs `text-embedding-3-small` (1536-dim) — MiniLM is smaller and weaker. Accepted: for single-developer recall over one's own recent Sessions, "good enough and on-device" beats "best and exfiltrated." The store's dimension is the model's; a store can't mix models (same constraint as the cloud modes).
- **No team features in local mode**, by definition — Ask-why across teammates needs a shared store. Local sells Recall (your own past) and Insights (already individual-only, ADR 0008); it is the wedge's free, zero-trust tier.
- **A new optional dependency** (`@huggingface/transformers` + onnxruntime). It is optional and lazy, so it only lands when someone actually runs local mode.

## Considered and rejected

- **Self-host as the "private" answer** — selfhost still requires standing up Supabase and handing an OpenAI key your source-derived text. It is "your cloud," not "no cloud"; it does not pass the air-gap / no-egress bar that local clears.
- **A bundled native vector index (sqlite-vss / hnswlib)** — premature. Brute-force cosine over one dev's chunks is sub-millisecond and adds zero native build surface (the thing enterprises dislike most in a security review). Revisit only if a local store ever has to span a whole team.
- **Shipping the model weights inside the npm package** — bloats every install (including non-local) by tens of MB. Fetch-once-then-offline keeps the default install lean; air-gapped users pre-seed `~/.oh/models`.
