# Isolated patch — route agent `submit_payment` to the direct merchant-PSP surface

**Purpose:** make the gateway return the merchant's PSP surface (the one `create_order` already created) for agent `submit_payment`, instead of a `pivota_hosted_checkout` page (which the gateway rejects). This is the ONLY change needed.

**CRITICAL — apply to a CLEAN baseline, not the current working tree.**
- The current local `PIVOTA-Agent` tree has ~122 unrelated dirty files + HEAD `22481cf2` ≠ deployed `d22fb2e`. **Do NOT `railway up` from it** — it would ship all that WIP to the live gateway.
- Apply these hunks on top of the **deployed `d22fb2e` state committed to `main`**, review, then deploy deliberately.
- Reviewed by Claude; implemented by Codex (gpt-5.5 xhigh). Tests pass (see bottom). Stripe path well-grounded; **Adyen normalization is inferred — validate against a real Adyen test response before relying on it.**

Files touched: `src/server.js`, `tests/integration/submit_payment_contract.test.js`, `tests/integration/checkout_rollout_canary.test.js`. (And follow-up: `tests/integration/checkout_timing_headers.test.js`, see end.)

---

## 1. `src/server.js` — add two helpers (after `buildCheckoutSessionV2Body`, before `buildSearchProductsV2Body`)

```js
function buildSubmitPaymentV1Body({
  payload = {},
  payment = {},
  checkoutSessionBody = {},
} = {}) {
  const explicitPaymentMethod =
    payment?.payment_method && typeof payment.payment_method === 'object' && !Array.isArray(payment.payment_method)
      ? payment.payment_method
      : payment?.paymentMethod && typeof payment.paymentMethod === 'object' && !Array.isArray(payment.paymentMethod)
        ? payment.paymentMethod
        : {};
  const paymentMethodType = firstNonEmptyString(
    explicitPaymentMethod.type,
    explicitPaymentMethod.payment_method_type,
    explicitPaymentMethod.paymentMethodType,
    payment?.payment_method_hint,
    payment?.paymentMethodHint,
    payload?.payment_method_hint,
    payload?.paymentMethodHint,
    'card',
  );

  return pruneEmptyFields({
    order_id: firstNonEmptyString(
      checkoutSessionBody?.order_id,
      payment?.order_id,
      payment?.orderId,
      payload?.order_id,
      payload?.orderId,
    ),
    payment_method: pruneEmptyFields({
      ...explicitPaymentMethod,
      type: paymentMethodType,
    }),
    idempotency_key: firstNonEmptyString(
      payment?.idempotency_key,
      payment?.idempotencyKey,
      payload?.idempotency_key,
      payload?.idempotencyKey,
    ),
    save_payment_method:
      payment?.save_payment_method === true || payment?.savePaymentMethod === true ? true : undefined,
  });
}

function shouldSubmitPaymentUseExistingOrderMerchantPspSurface(checkoutSessionBody = {}) {
  return (
    !firstNonEmptyString(checkoutSessionBody?.payment_handler_id) &&
    !firstNonEmptyString(checkoutSessionBody?.payment_handler_type)
  );
}
```

---

## 2. `src/server.js` — `case 'submit_payment':` routing (in the operation switch in `handleInvokeRequest`)

**BEFORE** (direct submits always went to v2 hosted checkout-sessions):
```js
      case 'submit_payment': {
        const payment = payload.payment || {};
        requestBody = buildCheckoutSessionV2Body({
          payload, payment, metadata, clientChannel, gatewayRequestId,
        });
        if (!requestBody.quote_id || requestBody.expected_amount == null) {
          return res.status(400).json({
            status: 'failure', code: 'expected_amount_required', reason: 'expected_amount_required',
            message: 'submit_payment requires quote_id and expected_amount from a locked quote',
          });
        }
        break;
      }
```

**AFTER** (direct/card → v1 reuse of the create_order PSP surface; delegated handlers stay v2):
```js
      case 'submit_payment': {
        const payment = payload.payment || {};
        const checkoutSessionBody = buildCheckoutSessionV2Body({
          payload, payment, metadata, clientChannel, gatewayRequestId,
        });
        if (!checkoutSessionBody.quote_id || checkoutSessionBody.expected_amount == null) {
          return res.status(400).json({
            status: 'failure', code: 'expected_amount_required', reason: 'expected_amount_required',
            message: 'submit_payment requires quote_id and expected_amount from a locked quote',
          });
        }
        if (shouldSubmitPaymentUseExistingOrderMerchantPspSurface(checkoutSessionBody)) {
          url = `${PIVOTA_API_BASE}/agent/v1/payments`;
          upstreamMethod = 'POST';
          requestBody = buildSubmitPaymentV1Body({ payload, payment, checkoutSessionBody });
          if (!requestBody.order_id) {
            return res.status(400).json({
              status: 'failure', code: 'order_id_required', reason: 'order_id_required',
              message: 'submit_payment requires order_id from create_order',
            });
          }
        } else {
          requestBody = checkoutSessionBody;
        }
        break;
      }
```
Note: the quote-lock guard (`quote_id` + `expected_amount`) is kept; those fields are NOT forwarded to v1 (v1 doesn't consume them). `return_url` is deliberately NOT forwarded on the v1 reuse branch (forwarding it makes v1 skip reuse of an `awaiting_payment` Stripe surface).

---

## 3. `src/server.js` — Adyen surface fields in the submit_payment response normalizer

In the submit_payment response normalizer, right after `pspNormalized` is computed and **before** the `if (pspNormalized === 'pivota_hosted_checkout')` rejection, add the extraction below. (Requires `paymentObj` to be in scope — it is the existing `const paymentObj = isPlainObject(p.payment) ? p.payment : {}`; include it if not already present.)

```js
        const adyenRaw =
          isPlainObject(p.raw) ? p.raw
          : isPlainObject(paymentObj.raw) ? paymentObj.raw
          : isPlainObject(p.payment_action?.raw) ? p.payment_action.raw
          : isPlainObject(paymentObj.payment_action?.raw) ? paymentObj.payment_action.raw
          : {};
        let adyenAction = null;
        if (isPlainObject(p.action)) adyenAction = p.action;
        else if (isPlainObject(paymentObj.action)) adyenAction = paymentObj.action;
        else if (isPlainObject(p.payment_action?.action)) adyenAction = p.payment_action.action;
        else if (isPlainObject(paymentObj.payment_action?.action)) adyenAction = paymentObj.payment_action.action;
        else if (isPlainObject(p.next_action?.action)) adyenAction = p.next_action.action;
        else if (isPlainObject(adyenRaw.action)) adyenAction = adyenRaw.action;
        const adyenSessionData = firstNonEmptyString(
          p.sessionData, p.session_data, paymentObj.sessionData, paymentObj.session_data,
          p.payment_action?.sessionData, p.payment_action?.session_data, p.payment_action?.client_secret,
          paymentObj.payment_action?.sessionData, paymentObj.payment_action?.session_data, paymentObj.payment_action?.client_secret,
          p.client_secret, paymentObj.client_secret, adyenRaw.sessionData, adyenRaw.session_data,
        );
        const adyenPspReference = firstNonEmptyString(
          p.pspReference, p.psp_reference, paymentObj.pspReference, paymentObj.psp_reference,
          p.payment_action?.pspReference, p.payment_action?.psp_reference,
          paymentObj.payment_action?.pspReference, paymentObj.payment_action?.psp_reference,
          adyenRaw.pspReference, adyenRaw.psp_reference,
        );
        const adyenResultCode = firstNonEmptyString(
          p.resultCode, p.result_code, paymentObj.resultCode, paymentObj.result_code,
          p.payment_action?.resultCode, p.payment_action?.result_code,
          paymentObj.payment_action?.resultCode, paymentObj.payment_action?.result_code,
          adyenRaw.resultCode, adyenRaw.result_code,
        );
        const adyenClientKey = firstNonEmptyString(
          p.clientKey, p.client_key, paymentObj.clientKey, paymentObj.client_key,
          p.payment_action?.clientKey, p.payment_action?.client_key,
          paymentObj.payment_action?.clientKey, paymentObj.payment_action?.client_key,
          adyenRaw.clientKey, adyenRaw.client_key,
        );
```
The `pivota_hosted_checkout` rejection stays exactly as-is (unchanged) immediately after this block.

---

## 4. `src/server.js` — Adyen branch in the `if (!paymentAction) { ... }` derivation

Add this as the **first** branch (before the existing `else if (pspNormalized === 'stripe' && p.client_secret)` branch):

```js
          if (pspNormalized === 'adyen' && (adyenSessionData || adyenPspReference || adyenAction)) {
            paymentAction = {
              type: 'adyen_session',
              client_secret: adyenSessionData || null,
              session_data: adyenSessionData || null,
              client_key: adyenClientKey || null,
              pspReference: adyenPspReference || null,
              action: adyenAction || null,
              resultCode: adyenResultCode || null,
              url: null,
              raw: pruneEmptyFields({
                ...(isPlainObject(adyenRaw) ? adyenRaw : {}),
                ...(adyenPspReference ? { pspReference: adyenPspReference } : {}),
                ...(adyenResultCode ? { resultCode: adyenResultCode } : {}),
                ...(adyenClientKey ? { clientKey: adyenClientKey } : {}),
                ...(adyenAction ? { action: adyenAction } : {}),
              }),
            };
          } else if (/* existing */ pspNormalized === 'stripe' && p.client_secret) {
            // ...unchanged existing stripe / redirect_url / hosted_url branches...
```

---

## 5. Tests

### `tests/integration/checkout_rollout_canary.test.js` — clean, apply as a diff
For each direct-submit `nock(...).post('/agent/v2/payments/checkout-sessions', (body) => {...})` change the path to `'/agent/v1/payments'` and the body matcher from `quote_id/expected_amount/payment_method_hint` to:
```js
        return (
          body &&
          body.order_id === '<ORD_...>' &&
          body.payment_method?.type === 'card' &&
          body.quote_id === undefined &&
          body.expected_amount === undefined
        );
```
(4 occurrences in this file.)

### `tests/integration/submit_payment_contract.test.js`
- Swap each **direct/card** submit `nock` mock from `.post('/agent/v2/payments/checkout-sessions')` → `.post('/agent/v1/payments')` and assert the v1 body (`order_id`, `payment_method.type === 'card'`, `quote_id === undefined`, `expected_amount === undefined`). **Keep** the delegated-handler (Shop Pay / `payment_handler_*`) test on `/agent/v2/payments/checkout-sessions`. **Keep** the `rejects unsupported pivota hosted checkout responses` test (the guard).
- Add the Adyen direct-surface test:
```js
  it('accepts and normalizes an Adyen direct PSP surface with pspReference action data', async () => {
    nock(API_BASE)
      .post('/agent/v1/payments', (body) => {
        return (
          body?.order_id === 'ord_001' &&
          body?.payment_method?.type === 'card' &&
          body?.quote_id === undefined &&
          body?.expected_amount === undefined
        );
      })
      .reply(200, {
        status: 'requires_action',
        payment_id: 'pay_adyen_001',
        psp: 'adyen',
        psp_used: 'adyen',
        pspReference: 'ADYEN_PSP_REF_001',
        resultCode: 'IdentifyShopper',
        action: { type: 'threeDS2', paymentData: 'adyen_payment_data_001' },
      });

    const res = await invokeSubmitPayment();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'requires_action',
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      submit_owner: 'component',
      component_kind: 'adyen_dropin',
      supported_in_shopping_ui: true,
      psp: 'adyen',
      pspReference: 'ADYEN_PSP_REF_001',
      payment_action: {
        type: 'adyen_session',
        pspReference: 'ADYEN_PSP_REF_001',
        resultCode: 'IdentifyShopper',
        action: { type: 'threeDS2', paymentData: 'adyen_payment_data_001' },
      },
    });
  });
```

---

### `tests/integration/checkout_timing_headers.test.js`
In the *"emits retry span for submit_payment temporary unavailability recovery"* test, change **both** submit `nock` mocks from the v2 path to v1 (the `order_id` matcher is unchanged — v1 forwards `order_id`):
```js
// both occurrences (the two retry mocks for ORD_PAY_TIMING):
-      .post('/agent/v2/payments/checkout-sessions', (body) => body && body.order_id === 'ORD_PAY_TIMING')
+      .post('/agent/v1/payments', (body) => body && body.order_id === 'ORD_PAY_TIMING')
```

---

## 6. Verify (after applying to the clean baseline)
```bash
npx jest --watchman=false --runInBand \
  tests/integration/submit_payment_contract.test.js \
  tests/integration/checkout_rollout_canary.test.js \
  tests/integration/checkout_timing_headers.test.js
```
Expected: green (Codex's run on the local tree: 2 suites, 15 tests pass).

## 7. Follow-up + go-live
- `checkout_timing_headers.test.js` (the only other affected test) is now covered in §5 — its two submit mocks swap to `/agent/v1/payments`.
- **Validate the Adyen surface mapping against a real Adyen test response** before trusting it (fields inferred).
- After deploy: re-run the probe (`PROBE_PSP=stripe|adyen PROBE_ALLOW_TEST_PSP=1 ... --create-order --charge`) with `ALLOW_TEST_PSP_PROBE=1` scoped to `merch_efbc46b4619cfbdf` → confirm **B1** (amount in minor units), **B3** (repeat = no double charge), **B4** (webhook → paid). Then disable the flag.
