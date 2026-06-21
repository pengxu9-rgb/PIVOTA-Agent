# Checkout consent model — what authorizes a charge

**Decision (2026-06-21, peng):** for the autonomous one-shot flow, the **verified delegated payment
authorization IS the buyer's consent to charge.** There is no Pivota-side human confirmation on that path,
by design. A separate human-UI confirmation flow exists for host-rendered card surfaces. Both are real,
both are fail-closed. This doc records the two flows so nobody later assumes a human click universally gates
charging — it does not.

This resolves the H1 finding from the 2026-06-21 protocol analysis (the README previously described only the
human-confirm flow, implying it gated all charges).

---

## The two flows

### Model A — `complete_checkout_session` (autonomous, ACP/AP2-native)

The one-shot flow a native frontier client (Claude/ChatGPT/Gemini) drives over the remote `/mcp` surface.

Pipeline ([`safety-kernel/src/protocol/canonicalExecutor.js:181`](../../safety-kernel/src/protocol/canonicalExecutor.js)):

```
createOrder (amount from the locked quote, not the caller)
  -> verifyPaymentAuthorization(payment_authorization, { order_id, user_ref, amount, currency, merchant_id, checkout_session_id })
  -> assertAttestation  (positive attestation; amount/currency/user_ref MUST match the authoritative order)
  -> kernel.mintConfirmation({ order_id })   // host-minted INTERNALLY; bound to order+buyer in the kernel
  -> kernel.submitPayment(...)               // charge once; amount/currency from the order
```

**Consent = the `payment_authorization`** — an ACP delegated payment token or an AP2 Checkout Mandate. The
buyer authorized it upstream (confirmed in ChatGPT → delegated token; or signed the AP2 mandate). It is
cryptographically verified and bound to *this* order's amount/currency/buyer/session before any charge
([`assertAttestation`, canonicalExecutor.js:340](../../safety-kernel/src/protocol/canonicalExecutor.js) — fail-closed: absence-of-throw is not success).

**The caller never supplies a confirmation token.** It is internal kernel plumbing (INV-3). Requiring an
additional Pivota-side human click here would break the native one-shot — there is no Pivota UI inside
ChatGPT's flow. **This is why delegated-auth-as-consent is the only workable model for Model A.**

Gates (fail-closed): `AGENT_CHECKOUT_STRICT=1` (or `/mcp` → 404) and `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED`
(or `complete_checkout_session` → `OPERATION_NOT_ALLOWED`). Both are currently off-charge in prod.

### Model B — `/checkout/confirm` → `submit_payment` (host-rendered card)

For surfaces where **Pivota's own host renders the checkout card** (App-SDK style) and shows a Confirm button.

```
host UI Confirm button (verified, signed action envelope)
  -> POST /checkout/confirm   (verifyUserAction -> kernel.mintConfirmation)  -> returns confirmation_token
  -> submit_payment (consumes confirmation_token)                            -> charge once
```

**Consent = a verified human UI action.** `verifyUserAction` in production is
[`verifyCheckoutConfirmationUserAction` (src/server.js:28390)](../../src/server.js): HMAC over
`(timestamp, user_ref, acp_session_id, order_id)` with a ≥16-char secret, a freshness window, and a
timing-safe compare. `/checkout/confirm` is host-only and **must not** be exposed as a model-callable tool
([`confirmationAction.js`](../../mcp-server/src/confirmationAction.js)). The legacy `confirm_payment` op is
disabled in strict mode ([src/server.js:28987](../../src/server.js)) — use `submit_payment` with the token.

Same charge gates as Model A (`AGENT_CHECKOUT_STRICT` + `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED`).

---

## Why both, and how to reason about them

| | Model A (`complete_checkout_session`) | Model B (`/checkout/confirm` + `submit_payment`) |
|---|---|---|
| Surface | native frontier client over `/mcp` (ChatGPT/Claude/Gemini) | Pivota-rendered host card (App-SDK) |
| Consent artifact | delegated payment token / AP2 mandate | signed human UI action |
| Confirmation token | self-minted internally | minted by `/checkout/confirm` |
| Human click on Pivota? | no (consent captured upstream) | yes |

They are **not substitutes** — they serve different surfaces. The shared, non-negotiable invariants live in
the kernel and apply to both: amount-from-quote (INV-1/2/5), single-use confirmation bound to
`(order_id, user_ref, amount)` (INV-3), idempotency / charge-once (INV-4), ownership/session binding (T7).

**Do not** assume `/checkout/confirm` gates `complete_checkout_session` — it does not; Model A self-mints.
**Do not** wire `/checkout/confirm` as a generic model-callable tool. Before flipping
`AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED=1`, confirm which model(s) the launching surface uses and that
the corresponding consent verifier is configured (`PAYMENT_ISSUERS_JSON` for Model A;
`CHECKOUT_CONFIRMATION_ACTION_SECRET` for Model B).
