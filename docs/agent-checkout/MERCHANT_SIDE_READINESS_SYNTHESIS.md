# Merchant-side readiness — Claude × Codex reconciled synthesis (2026-06-02)

Compares `MERCHANT_SIDE_READINESS_claude.md` (independent web research) with
`MERCHANT_SIDE_READINESS_codex.md` (independent web research, tighter run). Net: **strong agreement on the
architecture; Codex added concrete primitives and corrected one of my conclusions.**

## Where we agree (high confidence)
- **Pivota = a merchant-side protocol EDGE, not program admission.** OpenAI pivoted to merchant-run checkout +
  product discovery; both ecosystems keep the **merchant as MoR**.
- **One canonical quote/order/payment engine; do NOT fork safety per ecosystem.** The kernel (quote-first,
  amount-from-quote, host-minted confirmation, idempotency, charge-once, ownership/T7) is the protocol-agnostic
  core — and it's exactly what AP2's threat model demands (treat the agent as an attacker; deterministic
  merchant-side validation).
- **Build a protocol-adapter layer** that normalizes ACP REST, UCP, and MCP into that one engine.
- **Product discovery/feed is required**, not optional (ChatGPT's new focus).
- **UCP Identity Linking is OAuth** → the JWT verifier we already built applies there. **AP2 = mandate (SD-JWT
  VC) verification** for payment authorization.

## What Codex added that I didn't have (concrete + valuable)
- **UCP discovery is concrete:** the merchant publishes a profile at **`/.well-known/ucp`** (`ucp.version`,
  `services`, `capabilities`, `payment_handlers`, `signing_keys`); platforms send a `UCP-Agent` header; the
  merchant returns the **active capability intersection** in every response.
- **UCP capability names:** `dev.ucp.shopping.checkout`, `dev.ucp.common.identity_linking`,
  `dev.ucp.shopping.order`, and **AP2 as a UCP extension** `dev.ucp.shopping.ap2_mandate` (optional but key for
  Gemini autonomous buys). **UCP capabilities map 1:1 to MCP tools.**
- **ACP delegated payment endpoint:** `POST /agentic_commerce/delegate_payment` — tokenizes a credential under
  an **allowance** (max amount, currency, checkout session, merchant, expiration, risk signals). Plus ACP
  **capability-negotiation + payment-handler RFCs** (handlers declare id/version/spec/PCI flag/PSP/schemas).

## What Codex CORRECTED in my analysis (important)
- **My "MCP is THE common door for both" was overstated.** Codex: **ACP-over-MCP is UNSETTLED** — OpenAI's
  public checkout page still says MCP support is "future," while the 2026-04-17 GitHub snapshot lists MCP. So:
  **MCP is first-class for UCP/Gemini, but ChatGPT's official production path is ACP REST + product feed.** We
  need **both** MCP (UCP/Gemini) **and** ACP REST+feed (ChatGPT) — not MCP alone.
- Identity is per-ecosystem, not one mechanism: **UCP = OAuth Identity Linking**, **ACP = signed requests
  (HMAC) + buyer fields** (no per-user subject), **AP2 = mandate verification**.

## Reconciled BUILD ORDER (the answer to "what next")
**0. (Have) the kernel** — the canonical safety engine. Keep it the single source of truth.

1. **Canonical protocol-adapter layer over the kernel.** One internal checkout contract (create/update/get/
   complete/cancel checkout session + order + payment-token verify); ACP REST, UCP, and MCP all normalize into
   it. The adapter may translate schemas but **cannot bypass** quote-first/amount-from-quote/idempotency/
   confirmation/ownership/charge-once. *(In our control, no platform deps — wraps what we have.)*

2. **UCP discovery + MCP tools first** (fastest Gemini/UCP path, and we have `mcp-server/`):
   - Publish **`/.well-known/ucp`** (version, services, capabilities, payment_handlers, signing_keys) + the
     active-intersection response behavior.
   - Expose the MCP commerce tools (capabilities↔tools 1:1): `search_catalog`/`get_product`,
     `create/update/get/complete/cancel_checkout_session`, `get_order`/order events,
     `start_identity_linking`, `delegate_payment`/`exchange_payment_token`, `get_capability_profile`. Every
     mutating tool takes an idempotency key + returns authoritative state; opaque protocol state preserved;
     MCP schema generated from the same canonical schemas.

3. **ACP product feed + the 5 checkout REST endpoints together** (ChatGPT's official path):
   `POST/GET /checkout_sessions[/{id}][/complete|/cancel]`, HMAC `Signature`/`Timestamp` (policy-configurable
   until the production contract fixes it), capability + payment-handler declarations, `order_created/updated`
   webhooks, and a structured **product feed** (price/availability/variants/policy links/freshness).

4. **Unified payment-token verifier** — ACP delegated token (allowance-bound) + UCP payment handlers + AP2
   Checkout-Mandate envelope, all binding to `(quote/session, merchant, amount, currency)` before
   authorize/capture. (Reuse the JWT verifier for UCP OAuth identity; SD-JWT VC verifier for AP2.)

5. **Cross-protocol conformance + replay tests** (golden traces for ACP REST, UCP, MCP) proving identical
   safety under retries/partial failures — before onboarding more merchants.

## The single recommendation
**Build #1 (canonical adapter over the kernel) + #2 (UCP `/.well-known/ucp` profile + the MCP commerce tools)
first.** It's the fastest path to a real "agents can call Pivota to transact" surface (Gemini/UCP + any MCP
client), it's **entirely in our control** (no admission, no platform secrets — it wraps our existing kernel +
`mcp-server/`), and it forces the one-canonical-engine discipline. ACP feed + REST is the immediate follow-on
for the ChatGPT path; payment verifiers + conformance tests close it out.
