# Build — in-chat checkout preview + token auth + dark completion scaffolding

**Date:** 2026-07-13 · **Parent scope:** docs/in_chat_checkout_completion_scope_2026-07-13.md (Phases 0–4). This builds the **gate-independent top half** (Phase 1 + prerequisites + dark scaffolding). It deliberately does NOT build the payment-mandate / real completion (Phase 2–4), which are gated on the Shopify trusted-tier grant + legal + surface decisions.

## Hard money-safety bounds (non-negotiable — this is money-adjacent code)
- **`complete_checkout` can NEVER execute.** It stays hard-blocked in the client (no method; `callTool` throws). The "completion scaffolding" is dark INTERFACES + fail-closed guards around a call that remains blocked — NOT a working completion.
- **No payment. No `delegate_payment` / Shared Payment Token / Google Pay integration** — that is the gated bottom half, explicitly OUT OF SCOPE here. Do not wire any payment token flow.
- **No raw card / PII handling.** The `create_checkout` preview verification uses a SYNTHETIC sample US address (placeholder, not a real person), only to fetch shipping/tax quotes.
- All new behavior **flag-gated dark**; flag-off = byte-identical no-op. **No prod DB writes.** Credentials (client secret, JWT, signing key) **env-only, never logged**.

## Part A — Token-credential exchange (self-serve token tier)
Shopify's Dev Dashboard credential flow (verified from shopify.dev/docs/agents/get-started/authentication):
`POST https://api.shopify.com/auth/access_token` with `{ client_id, client_secret, grant_type:"client_credentials" }` → `access_token` (JWT, **60-min TTL**).
- Add a token-exchange helper to the buyer-agent client: read `UCP_AGENT_CLIENT_ID` / `UCP_AGENT_CLIENT_SECRET` from env → exchange → cache the JWT with refresh before the 60-min expiry. Feed the JWT into the EXISTING token-tier path (`Authorization: Bearer`). Never log the secret or JWT.
- Tier derivation: token (client creds present) > signed (signing key) > anonymous. Existing signed/anonymous paths unchanged.

## Part B — Phase 1: in-chat PRICED checkout preview (the real deliverable)
- Implement `create_checkout` / `update_checkout` via the client (checkout tools accept signed tier; token tier also fine). From a built cart → create a checkout with a synthetic sample shipping address → capture the **priced object**: line item, shipping options, tax, **grand total**, currency. Return a normalized `{ item, shipping_options, tax, total, currency, continue_url }` for in-chat display.
- Do NOT complete. The preview ends at the priced object + (optionally) the warm-handoff `continue_url` to pay. Reuse the live request shapes proven for create_cart (`params.arguments = { meta, checkout: {...} }` — confirm the exact `create_checkout` inputSchema live, as we did for create_cart).
- Wire it as an additive capability (flag `UCP_INCHAT_PREVIEW_ENABLED`, default off) — e.g. surfaced through the warm-handoff service as an enriched result; flag-off = today's warm-handoff behavior unchanged.

## Part C — Dark completion scaffolding (interfaces + fail-closed guards only)
- Flag `UCP_INCHAT_COMPLETION_ENABLED` (default off). A completion-gate module (mirror backend `evaluate_tier2_charge` fail-closed pattern) that returns DENY unless ALL of: flag on AND token-tier credential present AND merchant on a canary allowlist AND amount ≤ cap AND a valid buyer mandate object present AND master kill-switch not tripped. With everything absent (the default), it returns DENY.
- A buyer-consent / mandate **data model** (types/shape only): cart mandate + payment mandate fields, an audit-record shape. NO signing, NO payment token, NO issuance — just the interface the future Phase 2 fills.
- The gate module must NOT be able to call `complete_checkout` — it only computes eligibility; the client's hard-block stands. Add a test asserting that even with every gate flag flipped on in a test, `complete_checkout` STILL throws at the client (defense in depth).

## Verify
- Local jest: token-exchange (mock the token endpoint; assert refresh + no secret leak), create_checkout preview (fixture priced object → normalized shape), completion-gate (fail-closed matrix: default DENY; each condition independently DENYs), and the defense-in-depth test that complete_checkout throws regardless.
- **Live (cosrx, no purchase):** build a cart → `create_checkout` with a synthetic address → report the priced object (item, shipping option(s), tax, total). Confirm NO completion occurred. Redact nothing sensitive (it's a preview, no real buyer).
- CI is dead (Actions quota) — verify locally + the live preview.

## Out of scope (do NOT build)
Payment mandate wire / delegate_payment / Google Pay / Shared Payment Token; any real `complete_checkout`; the payment-auth UX; anything that moves or authorizes money. Those wait for the Shopify grant + legal + surface decision.
