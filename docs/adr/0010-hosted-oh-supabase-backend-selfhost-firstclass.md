---
status: accepted
---

# Hosted Oh: Supabase-as-backend + Vercel functions for secrets; self-host stays first-class

The BYO-keys beta fails the 10-minute-stranger test (create a Supabase project, paste SQL, find a secret key) and gives pricing nothing to attach to. We ship **hosted Oh**: one Oh-owned multi-tenant store where onboarding is `oh signup` → `oh team create|join` → done. **Self-host remains a supported, documented mode** — same CLI, your own Supabase + OpenAI keys — both because ELv2 explicitly permits it and because "your memory can live in *your* database" is a real wedge with privacy-minded devs and, later, enterprises.

## Architecture (keeps "no backend we operate by hand")

- **Data plane: one Oh-owned Supabase project** (`oh-hosted`). New tables `teams`, `members`, `invites`; `team_id uuid` + `author_id uuid` added to `sessions` / `chunks` / `exchange_metrics` / `asks`.
- **Auth: Supabase Auth, email + password** for the beta CLI (`oh signup` / `oh login`). Boring and template-independent; magic-link/OTP is a later polish. The CLI stores the session (access + refresh token) in `~/.oh/config.json` and refreshes silently.
- **Multi-tenancy: RLS, not application code.** Clients keep talking directly to PostgREST with the **anon key + user JWT** — the same thin-client shape as v0, but the database now enforces:
  - `sessions` / `chunks`: readable/writable by members of the row's team.
  - `exchange_metrics`: **author-only for every operation** — ADR 0008's individual-only Insights graduates from convention to database guarantee.
  - `asks`: insert as yourself; team-readable (deflection counts are the team-visible artifact, per ADR 0008).
  - `teams` / `members` / `invites`: visible to members; mutated only through `security definer` RPCs (`create_team`, `join_team`).
- **Secrets plane: Vercel serverless function** (`/api/embed` on the landing-page project) holds the **OpenAI key** — users bring zero keys; embeddings are the COGS the Team tier prices in (ADR 0008). It verifies the caller's Supabase JWT, then proxies to OpenAI. Vercel rather than Supabase Edge Functions because our tooling can deploy + set env there end-to-end today, and the control plane will grow there anyway (Stripe webhooks, signup limits).
- **The CLI gains a `mode`**: `hosted` (URL + anon key baked into the package as constants — they are public by design) or `selfhost` (exactly today's config). Capture, ask, insights, brief, nudges are mode-agnostic above the db/embed layer.

## Migration of ourselves (tenant #1)

The v0 dogfood store is **disposable by construction** — raw sessions never left our machines, so `oh backfill` regenerates chunks + metrics into the hosted store for pennies. We pause the old project (also freeing the free-tier slot the hosted project needs) and re-onboard via the hosted flow. The `asks` log (a day old) is the only loss; accepted.

## Consequences / triggers pulled

- **Privacy policy + ToS are now due** (first stranger data on *our* infra — the hygiene table's trigger). Ship minimal honest pages with the hosted launch.
- The shared-service-key model dies in hosted mode; nobody ever sees a database secret.
- Free-tier caps (3 seats / 30-day retention) become *enforceable* (the data is ours to expire) — pricing stops being theoretical.
- Self-host docs move from "the way" to "an option" on the site and README.

## Considered and rejected

- **Supabase Edge Functions for the embed proxy** — no tooling path to set function secrets here; Vercel functions are deployable + configurable end-to-end today. Revisit if we consolidate planes later.
- **Magic-link/OTP-first auth** — depends on email-template contents we can't configure programmatically yet; password auth is testable end-to-end today.
- **A full custom API server** — premature; PostgREST + RLS + one serverless function covers v0.3. The API server emerges when billing/quotas demand it.
