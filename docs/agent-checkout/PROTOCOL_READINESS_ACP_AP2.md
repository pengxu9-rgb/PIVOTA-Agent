# Protocol-readiness map: OpenAI ACP & Google AP2 — v2 (Codex-fact-checked 2026-06-02)

Corrected against the public specs (OpenAI Agentic Checkout spec + developers.openai.com/commerce,
agenticcommerce.dev, Stripe SPT docs, ap2-protocol.org v0.2) per `REVIEW_by_codex_of_ProtocolReadiness.md`.
Purpose: an accurate map of what each platform hands us for identity + payment, how we verify it, and how it
lands on the kernel — for the admission (BD) conversations and a fast integration.

---

## 0. The real #0: admission + feed (business, not engineering)
- **OpenAI Instant Checkout:** ACP is open to build against, but **live checkout in ChatGPT is approved-partners-only** — you must **apply for Instant Checkout** AND **make your product catalog/feed available to ChatGPT**. (My v1 omitted the feed/participation requirement.)
- **Google AP2:** the protocol is **open source** (implementable independently), but **moving real money still needs payment-provider/network/wallet relationships**, and native Gemini/AI-Mode checkout is a separate Google-surface path (UCP). There's no single "AP2 admission program" — treat Google-surface admission and PSP/network enablement as **separate gates**.

## 1. OpenAI ACP (Agentic Commerce Protocol / Instant Checkout)
**Role (✓):** the checkout lifecycle contract — create/update/retrieve/complete/cancel checkout session,
order events/webhooks, authoritative cart state, payment handoff. Merchant keeps orders/payments/fulfillment.

**Merchant of record (✓, corrected to "definite"):** the **merchant/seller is MoR** — explicit in OpenAI +
ACP seller docs, not merely program-dependent. Our kernel already locks MoR from the quote. (If Pivota ever
acts as marketplace/reseller, MoR is a *commercial* decision, not an ACP default.)

**Request authenticity (corrected):** every request is **bearer-authenticated AND signed** (`Authorization`,
`Signature`, `Timestamp`, idempotency, API-version headers). **This — not the buyer object — is how we know a
request genuinely came via OpenAI.** Exact key discovery/rotation/canonicalization/replay-window is
**onboarding-dependent** (not fully public) → an admission question.

**Buyer identity (CORRECTED — important):** ACP does **NOT** define a stable OpenAI-vouched per-buyer
subject. The buyer object is **contact fields** (`name`, `email`, optional phone) + an optional `customer_id`
that is the **merchant's own** customer id. → **`user_ref` cannot be derived from the ACP buyer object.**
Session linkage uses the **checkout-session id**; a stable cross-session buyer identity only exists if a
separate verified identity/account-linking mechanism is provided at integration. **Open question for admission.**

**Payment (corrected terminology + current schema):** generic ACP term is **Delegate Payment / delegated
payment token / payment handler** (Stripe `SharedPaymentToken`/SPT is ONE implementation; vault tokens
`vt_…` exist). ACP is **PSP-agnostic**. Current ACP (API version **`2026-01-30`**) uses **capability
negotiation**: `capabilities.payment.handlers` replaced `payment_provider.supported_payment_methods`, and
payment data moved from `{ token, provider }` to `{ handler_id, instrument: { credential: … } }`. (My v1 used
the old shape.)

**What Pivota must implement (ACP):** verify the **signed/bearer request** (onboarding keys); implement
**capability negotiation** (the main way to discover payment handlers, 3DS/interventions, PCI requirements,
extensions) on every checkout response; consume the checkout-session + buyer/contact data; charge via the
negotiated **delegated payment handler**; product **feed/catalog** for Instant Checkout. Keep `acp_state`
opaque. **Authorization-for-this-charge** in ACP is the user's checkout confirmation in ChatGPT that yields
the delegated token → that's what the kernel's INV-3 confirmation binds to.

## 2. Google AP2 (Agent Payments Protocol v0.2)
**Role (corrected, narrower):** AP2 secures **agent-performed payment AUTHORIZATION + dispute evidence**
inside a commerce protocol. **Processing/settlement stay with the Credential Provider / Network / Merchant
Payment Processor / payment instrument** — AP2 does not do settlement, and is payment-instrument-agnostic.

**Mandates (CORRECTED):** AP2 v0.2 defines **two** mandate types — **Checkout Mandate** and **Payment
Mandate** — each with **open and closed** forms for autonomous flows. (NOT "Intent→Cart→Payment"; that's
older explainer language.) Mandates are **SD-JWT VCs** (selective-disclosure JWTs with key binding) — **NOT
plain JWT/JWS.** They bind to a **merchant-signed Checkout JWT** via `checkout_hash`.

**Buyer identity (corrected):** AP2's trust models are **User Credential** + **Trusted Agent Provider** —
SD-JWT VC issuers, holder/key-binding material, `cnf` agent keys. **No universal stable user `sub`/DID.** →
`user_ref` can only be derived **after** the verifier's trust policy identifies a stable user/account subject
in the credential/provider context. **Our generic JWT verifier is NOT sufficient for AP2** — it would need an
**SD-JWT VC verifier**.

**The merchant-side gate (CORRECTED — this is the key mapping):** for "this checkout is authorized," the
merchant verifies the **Checkout Mandate** (the **Payment Mandate** is verified by CP/network/MPP, not the
merchant alone). A correct gate must: verify the SD-JWT/delegate **chain** + **key binding** (`cnf`); confirm
`checkout_hash` matches the **current merchant-signed Checkout JWT**; evaluate **all open-mandate
constraints** (unknown constraint ⇒ **fail**); check open/closed binding (`sd_hash`); enforce
`exp`/`aud`/`nonce`/version (`vct`) + **replay/double-spend** (no overlapping presentations); and **return +
store signed receipts** (Checkout Receipt; MPP returns Payment Receipt) — receipts are first-class dispute
evidence. → **`mintConfirmation` should gate on a verified Checkout Mandate**, recording payment-credential/
MPP verification evidence when available.

**`acpAp2.js` reality:** its status strings (`mandate.captured`, etc.) are a **UI/status shim, NOT AP2
conformance** — v0.2 defines mandates/receipts/verifier duties, not those enums. Keep the shim only for UX.

## 3. How both map onto what we already have
| Need | ACP | AP2 | Our asset / gap |
|---|---|---|---|
| Request authenticity | bearer + `Signature`/`Timestamp` | SD-JWT VC chain + key binding | **net-new verifiers**; JWT verifier helps ACP-bearer only |
| WHO (`user_ref`) | **not in ACP** (contact + merchant customer_id) | mandate/credential subject via trust policy | **gap** — needs a provided identity mechanism (ACP) / SD-JWT VC trust policy (AP2) |
| Authorized THIS charge (INV-3) | delegated-token issuance (user confirmed in ChatGPT) | **verified Checkout Mandate** + `checkout_hash` | kernel confirmation token + `mintConfirmation` **gate** (net-new verifier) |
| Amount/currency/charge-once (INV-2/5) | server quote + handler | server quote + mandate cart | **kernel (done)** |
| Ownership/session (T7) | checkout-session id | mandate subject/holder | **kernel `_requireOrder` + T7 (done)** |
| Disputes | order events/webhooks | **signed receipts** | **gap** — store/return receipts (AP2) |

**Validated by Codex:** the kernel's deterministic, amount-from-quote, confirmation-token, idempotency,
charge-once, ownership design **is exactly AP2's threat model** (treat the agent/LLM as a potential
attacker; validation must be deterministic merchant-side code). So the merchant-side safety is the right,
protocol-agnostic foundation.

## 4. Net-new engineering (post-/at admission)
- **ACP:** signed-request verification (onboarding keys) + **capability negotiation** + delegated-handler
  charge + product feed. Buyer→`user_ref` only if a verified identity mechanism is provided.
- **AP2:** an **SD-JWT VC Checkout-Mandate verifier** (chain, key binding, `checkout_hash`, constraints,
  replay, `vct`/`aud`/`nonce`) + the **merchant-signed Checkout JWT** + **receipt** issue/store. This is the
  big one — and per Codex, **AP2 v0.2 is concrete enough to PROTOTYPE now** (SD-JWT VC verifier + test
  vectors), unlike ACP's onboarding-gated request-signing.
- The generic JWT verifier we built is a **partial primitive** (ACP bearer / any IdP-subject), **not** an AP2
  mandate verifier.

## 5. Open questions for admission (BD + eng checklist)
1. ACP: the request-**signing** key discovery/rotation/replay specifics (onboarding).
2. ACP: is there ANY verified per-buyer identity / account-linking, or is identity per-checkout-session only?
3. ACP: capability-negotiation handler set + **PCI** requirements per handler (Delegate Payment can carry raw
   card for L1 merchants → our SAQ-A/vault posture must be validated per handler, not assumed).
4. AP2: the production **trust lists / issuers / credential formats** + which CP/network/MPP rails.
5. Both: feed/catalog onboarding (ACP) and Google-surface vs independent AP2 use.

## 6. Recommendation
- **BD: pursue Instant Checkout participation (OpenAI) + product feed**, and the PSP/network relationships for
  AP2 — the real gates.
- **Eng now (optional, concrete):** the one thing buildable to-spec today is an **AP2 Checkout-Mandate SD-JWT
  VC verifier prototype** with test vectors (the v0.2 spec is concrete). ACP request-signing waits on
  onboarding keys. The kernel + the hardening already stand.
- **Don't** rely on the generic JWT verifier for AP2 (SD-JWT VC ≠ JWT), and **don't** treat `acpAp2.js`
  status strings as protocol conformance.
