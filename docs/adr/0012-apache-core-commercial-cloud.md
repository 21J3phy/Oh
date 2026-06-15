---
status: accepted
---

# Open-core: Apache-2.0 core, commercial Cloud + enterprise

Oh moves from a single Elastic License 2.0 (ELv2) covering the whole repo to a
**split open-core model**, copied from Mastra's actual structure (not the
"free self-host / pay-to-host" myth):

- **Core → Apache License 2.0 (true OSI open source).** The `oh-brain` CLI/MCP
  package (`src/`), the self-host schema (`migrations/`), and the agent skills
  (`skills/`). Anyone may use, modify, build on, and self-host it for free,
  forever — including commercially.
- **Oh Cloud → commercial license.** The hosted multi-tenant control plane
  (`web/`): account/team management, billing, the embedding proxy, the
  dashboard. Source-available for transparency; may not be operated as a
  managed service for third parties without a written agreement (see
  `web/LICENSE`).
- **Enterprise features → commercial license.** SSO, audit logging,
  visibility-policy controls ([ADR 0003](./0003-attribution-over-anonymity.md)),
  and deploy-in-your-cloud. Deferred in build (per
  [ADR 0006](./0006-pivot-small-team-re-explaining-loop.md)) but reserved in
  license now.

## Why

ELv2 is *source-available*, not open source — so Oh could not honestly claim
the "open source" label, forfeiting the developer-trust and distribution that a
pre-traction, weak-network-effect product (the moat analysis in
[`business-spec.md`](../../business-spec.md)) most needs. ELv2's whole-product
no-hosting clause bought protection against strip-mining we don't need at zero
traction, at the cost of the one word that helps us grow.

Mastra's real model resolves this: a permissive Apache-2.0 core as the funnel
and community-credibility play, with the willingness-to-pay reserved in the
*enterprise + platform* layer, not the core. The protection against someone
re-hosting Oh is therefore **not** the core license (Apache permits hosting) —
it is that the valuable pieces (the operated control plane, enterprise
governance, the accumulated org context) are not Apache and not trivially
replicable.

## The billing boundary is value, not deployment

Self-host-vs-hosted is **not** the paywall. Hosting Oh (a Supabase project + an
embed proxy) is cheap and easy; "pay us so you don't run Supabase" is weak
monetization and is not where the moat lives. The paywall stays where
[`business-spec.md`](../../business-spec.md) already put it — **seats +
retention + enterprise controls**:

| Tier | License / deploy | Price |
|---|---|---|
| Self-host | Apache-2.0 core, your infra + keys | $0, unlimited |
| Hosted Free | Oh Cloud (commercial) | $0, 3 seats / 30-day retention |
| Hosted Team | Oh Cloud (commercial) | $15/seat/mo, unlimited |
| Enterprise | commercial | SSO, audit, deploy-in-your-cloud, SLA |

Self-host free is the **funnel + privacy/trust wedge** ("your memory in *your*
database"), not a revenue leak: the segment that self-hosts mostly would not
pay us to host anyway, and it converts into advocates and future
deploy-in-your-cloud enterprise deals.

## Considered and rejected

- **Stay all-ELv2.** Zero work, but cannot be marketed as open source; loses the
  OSS community and the legible open-core narrative YC investors recognize
  (PostHog, Sentry, Mastra).
- **"Free self-host, pay only to host" (the original instinct).** Rejected:
  monetizes convenience, not value; a competent team self-hosts free forever and
  never pays. Hosting is the frictionless default path, not the boundary.
- **Apache-2.0 the entire repo including the control plane.** Rejected: gives
  away the operated multi-tenant plane and enterprise governance — the layer the
  paying customer buys.

## Consequences

- `LICENSE` is now Apache-2.0; `web/LICENSE` is the commercial notice;
  `package.json` `license` is `Apache-2.0`; README and landing updated.
- The "core is open source" claim is now true and may be used in the YC
  application and in developer-facing distribution.
- Relicensing is a one-day task and explicitly **not** the YC gating item —
  traction is. Documented, then back to users.
