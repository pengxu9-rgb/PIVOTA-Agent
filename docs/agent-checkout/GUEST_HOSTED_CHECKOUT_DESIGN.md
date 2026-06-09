# Guest hosted-checkout (grant-free) — design spec

**Goal:** let a keyless agent get a **hosted Stripe checkout URL** for a buyer who provides only an
email — no Pivota login, no delegated payment grant. The buyer authorizes payment by paying on the
hosted page. The agent can NEVER move money on its own.

## Why a new operation (not a tweak to complete_checkout_session)

`complete_checkout_session` → `kernel.submitPayment` is the **charge primitive** (it locks the order,
writes `charge_pending`, and calls the upstream charge). Whether that returns a hosted `requires_action`
surface or an autonomous charge depends on the upstream PSP — so it is NOT safe to bypass
`verifyPaymentAuthorization` *through* it. The grant exists precisely to gate that charge.

Instead add a **separate, structurally non-charging operation** that creates a hosted payment page and
returns its URL. It calls the backend's existing hosted endpoint, never `submitPayment`.

## Backend primitive (already exists)

`POST /agent/v2/payments/checkout-sessions` (`routes/agent_v2.py:1046`):
- input: `{ order_id, customer_email, shipping_address?, return_url?, market?, locale? }`
- requires the order state ∈ `{awaiting_checkout, draft}`
- mints a **hosted** Pivota checkout surface (checkout_session_id + URL); **does not charge**
- buyer pays on the hosted page → existing PSP webhook → order → `paid`

## New agent-side operation: `create_payment_link`

- **canonicalContract.js:** new op `create_payment_link` — `mutating: true`,
  `requiresUserRef: true`, **`requiresPaymentAuthz: false`**, MCP tool name `create_payment_link`.
- **canonicalExecutor.js:** handler:
  1. `kernel.createOrder({ idempotency_key, order: { quote_id: session_id, shipping_address } }, ctx)`
     — locks the server-side quote/amount (reuses all existing INV-1/5 protections + single-use quote).
  2. `upstream.createHostedCheckout({ order_id, customer_email, shipping_address, return_url }, ctx)`
     — calls the backend endpoint above. **No `submitPayment`, no `mintConfirmation`, no grant.**
  3. return `{ order_id, checkout_url, checkout_session_id, expires_at, status: 'awaiting_payment' }`.
- **upstream:** add `createHostedCheckout` to the http backend upstream (a POST to
  `/agent/v2/payments/checkout-sessions`, Bearer agent auth, forwards `agent_user_ref` = `ctx.user_ref`).
- **mcp-server/commerceToolSurface.js:** expose `create_payment_link` (allowlist args:
  `session_id`, `customer_email`, `shipping_address`, `return_url`, `idempotency_key`). Identity from
  the verified session only (already enforced).

## Safety invariants (must hold; cover in the adversarial review)

1. **No autonomous charge.** The op MUST NOT call `submitPayment`/charge. It only creates a hosted page;
   the order stays `created`/`awaiting_checkout` until the buyer pays and the webhook flips it.
2. **Server-side amount.** Amount/currency come from the locked quote via `createOrder`, never the caller.
3. **Identity.** `user_ref` from the verified OAuth/session; `customer_email` is contact only, NOT identity
   and NOT authority.
4. **Idempotency.** Reuse the user-scoped base-key pattern; a replay returns the same checkout URL,
   never a second order/session.
5. **Flag-gated.** New flag `AGENT_CHECKOUT_HOSTED_LINK_ENABLED` (default 0). When off → op returns
   `OPERATION_NOT_ALLOWED`. Independent of `AGENT_CHECKOUT_STRICT_SUBMIT_PAYMENT_ENABLED` (which keeps
   gating the autonomous-charge path).
6. **No grant path widened.** `complete_checkout_session` is unchanged — still requires the grant.

## Test plan

- executor: `create_payment_link` calls createOrder + createHostedCheckout, returns URL, and (assert)
  NEVER calls submitPayment (spy/mock the kernel).
- flag off → OPERATION_NOT_ALLOWED.
- amount-from-quote (adversarial pricing stub): a leaked caller amount cannot change the order total.
- idempotent replay → same checkout_session_id/url, one order.
- identity: body-supplied user_ref ignored; email is contact-only.
- e2e (test mode): keyless OAuth → create_checkout_session → create_payment_link → cs_test URL →
  buyer pays (4242) → webhook → paid; replay → no duplicate.

## Rollout
Behind `AGENT_CHECKOUT_HOSTED_LINK_ENABLED`. Adversarial review (per the money-path loop) BEFORE enabling.
Run the test-mode canary in a controlled window. submit_payment stays gated separately.
