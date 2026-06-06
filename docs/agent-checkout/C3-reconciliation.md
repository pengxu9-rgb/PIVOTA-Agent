# C3 — Schema ↔ mapping reconciliation (Wave 1.5)

Goal: remove the contradictions between `docs/tool-schema.json` (LLM-facing), `src/schema.js`
(gateway zod), and `docs/pivota-api-mapping.md` (upstream), and align them to the v2 safe-checkout
contract — **without breaking concurrent in-flight work** on `src/server.js` and the integration
tests, which are being actively edited on this branch.

## Why this is a proposal + additive validator, not a direct schema rewrite

Two hard constraints discovered in the live tree:

1. **`src/schema.js` is intentionally loose.** Every business field is `z.any().optional()` under a
   `.passthrough()` object. It validates *shape of the envelope*, not money-path invariants. It also
   carries pre-existing duplicates (`preview_quote` listed twice in `OperationEnum`; `quote` twice in
   the payload) — harmless but worth a cleanup pass by the owner.
2. **The current gateway contract trusts the model amount.** `tests/integration/submit_payment_contract.test.js`
   asserts the gateway *forwards `expected_amount` unchanged to upstream*. That is the exact behavior
   the v2 contract removes (amount must come from the locked quote). Flipping it is a **coordinated
   migration**, not a silent schema edit — doing it unilaterally would break a test someone is actively
   writing (`src/server.js` has +275 uncommitted lines).

So C3 ships as: (a) this reconciliation ledger, (b) an **opt-in strict validator**
(`safety-kernel/src/contractValidation.js`) + **kernel-behind-invoke handler**
(`safety-kernel/src/invokeHandler.js`) that the server can wire in for the agent-commerce surface,
and (c) a migration path for the amount-trust flip.

## The contradiction ledger

| # | Field | `docs/tool-schema.json` (v1) | `src/schema.js` | `pivota-api-mapping.md` | v2 target | Status |
|---|---|---|---|---|---|---|
| 1 | `get_product_detail` | `product:{product_id,sku_id}` | `product: z.any()` | path needs `merchant_id`+`product_id` | require `merchant_id`+`product_id` | enforced in `contractValidation.js` |
| 2 | `create_order.items` | items `sku_id`+`qty` | `order: z.any()` | items need `merchant_id`,`product_id`,`qty`,`price` | **no item price**; require `order.quote_id`; price from quote | enforced |
| 3 | `submit_payment.expected_amount` | model-supplied amount | `payment: z.any()` | "forwards `total_amount` unchanged" | echo-only; charge from quote; mismatch → `PRICE_CHANGED` | enforced in kernel; **needs migration (below)** |
| 4 | idempotency | absent | absent | n/a | required on create_order/submit_payment/after_sales | enforced |
| 5 | confirmation | absent | absent | n/a | required on submit_payment | enforced |
| 6 | after-sales actions | enum: refund/return/exchange/support | `status: z.any()` | refund only | reject unsupported until connector lands | enforced |

## Migration path for drift #3 (the amount-trust flip)

This is the only change that alters existing behavior, so it ships gated:

1. **Add** `contractValidation.js` + `invokeHandler.js` (done — additive, 0 behavior change to existing routes).
2. **Introduce a flag** (e.g. `AGENT_CHECKOUT_STRICT=1`) in `src/server.js` dispatch. When on, the
   agent-commerce surface routes money ops through `createInvokeHandler(...).handle(...)`; when off,
   today's pass-through behavior is unchanged.
3. **Update `submit_payment_contract.test.js`** (coordinated with its owner): under strict mode the
   assertion becomes "charge amount equals the quote-locked total; a mismatched `expected_amount`
   yields `PRICE_CHANGED`," replacing "forwards expected_amount unchanged."
4. **Flip the default** to strict once the kernel is mounted server-side and the order store is durable.
5. **Then** tighten `src/schema.js` money-path fields from `z.any()` to the strict shapes (or simply
   delegate to `validateCanonical`) and regenerate `docs/tool-schema.json` from `tool-schema.v2.json`.

## Safe cleanups the file owner can take now (no behavior change)
- De-dupe `preview_quote` in `OperationEnum` and the duplicate `quote` field in `src/schema.js`.
- Point `docs/pivota-api-mapping.md` §2.4 note ("uses 'total_amount' not 'amount'") at the v2 rule
  that the amount is authoritative server-side, not caller-supplied.

## What this delivers
- The three drifts are **enforced** today for anyone routing through the kernel/handler.
- The live shared files are **untouched**, so no conflict with the in-flight `server.js` work.
- A concrete, low-risk migration to make strict mode the default.
