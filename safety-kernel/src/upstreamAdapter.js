// Upstream normalization adapter — maps the REAL Pivota backend response shapes into the shapes the
// Safety Kernel expects. WHY THIS EXISTS: the kernel was built against an idealized contract
// (`locked_totals` with numbers, `merchant_of_record`, top-level `order_id`), but the real backend
// returns `pricing` with decimal STRINGS, no `merchant_of_record`, and a nested `order.order_id`.
// Without this adapter the kernel rejects every real `preview_quote` with MERCHANT_UNAVAILABLE.
//
// Wire it in by wrapping the raw invoke client:
//   const upstream = wrapUpstream(rawInvoke);   // rawInvoke(op, payload, headers) -> real response
//   const kernel = new SafetyKernel({ upstream, ... });
//
// SCOPE: preview_quote, create_order, AND submit_payment are normalized here. The submit_payment
// re-model (async checkout-session / client-confirmation + webhook completion) is implemented in the
// kernel (payment state machine + onPaymentWebhook) — see docs/agent-checkout/payment-flow-remodel.md.

import { PivotaCommerceError } from './errors.js';
import { parseDecimalToMinor } from './money.js';

/**
 * Parse a MAJOR-unit money value from the backend (`preview_quote.pricing` is major-unit decimal STRINGS
 * like "95.00") into an INTEGER number of MINOR units for `currency`. This is the conversion point that
 * makes minor-unit integers the kernel's single canonical money representation (see money.js) — no float
 * drift, and zero-/three-decimal currencies (JPY, BHD) are correct.
 *
 * UNIT CONTRACT (confirmed by the prod wire-format probe, 2026-06-02): BOTH `preview_quote.pricing.total`
 * AND `create_order.order.amounts.total` are MAJOR-unit decimal STRINGS ("28.24"). The adapter parses both
 * to MINOR via this function so the kernel cross-checks them like-for-like (fail-closed on mismatch). The
 * `submit_payment` wire, by contrast, expects MINOR units (the gateway sends e.g. 2900 to
 * /agent/v2/payments/checkout-sessions) — the kernel forwards the stored minor amount as-is, no re-convert.
 */
export function parseMoney(v, currency) {
  return parseDecimalToMinor(v, currency);
}

/** Real preview_quote → kernel-expected (locked_totals as MINOR-unit integers + merchant_of_record). */
export function normalizePreviewQuote(raw, requestPayload) {
  const pricing = raw?.pricing || {};
  // Canonicalize to UPPERCASE so currency comparisons (cross-check + submit echo) are case-insensitive.
  const currency = typeof raw?.currency === 'string' ? raw.currency.toUpperCase() : raw?.currency;
  // The backend does NOT return merchant_of_record; source it from the request's merchant_id (the
  // merchant the quote is for). True legal MoR may differ — confirm with the backend if needed.
  const merchant_of_record = requestPayload?.quote?.merchant_id ?? raw?.merchant_of_record;
  return {
    ...raw,
    currency,
    merchant_of_record,
    locked_totals: {
      subtotal: parseMoney(pricing.subtotal, currency),
      tax: parseMoney(pricing.tax, currency),
      shipping: parseMoney(pricing.shipping_fee ?? pricing.shipping, currency), // real uses `shipping_fee`
      total: parseMoney(pricing.total, currency),
    },
    line_items: raw?.line_items,
    // Carry an opaque ACP state forward; the real backend uses engine/engine_ref as its session refs.
    acp_state: raw?.acp_state ?? { engine: raw?.engine, engine_ref: raw?.engine_ref, quote_id: raw?.quote_id },
  };
}

/**
 * Real create_order → kernel-expected (lift nested order.order_id to top-level). Also surfaces the
 * backend's OWN order amount as `backend_amount_minor` (parsed from a MAJOR-unit decimal string → minor,
 * the confirmed live contract) so the kernel can CROSS-CHECK it against the quote snapshot and fail closed
 * on a units/currency mismatch. The kernel still charges the quote snapshot (INV-5) — detector, not a
 * charge source.
 */
export function normalizeCreateOrder(raw) {
  const order = raw?.order || {};
  // LIVE-CONTRACT FIX (2026-06-09): the kernel's create_order upstream is the shop gateway
  // (`POST /agent/shop/v1/invoke`), which PROXIES create_order to `/agent/v1/orders/create`. That v1
  // response is FLAT — there is NO `order` wrapper and NO `amounts` object. It carries the order total at
  // the TOP LEVEL as MAJOR-unit values: `total` (decimal STRING "1.69", always present) + `total_amount`
  // (float, same value) + best-effort `pricing.total` (quote-snapshot echo, present only on the quote-first
  // path). The earlier `order.amounts.total` contract (allegedly confirmed 2026-06-02) does NOT match this
  // wire — it was the idealized / v2-REST shape, never what the live gateway returns. Reading only the
  // nested paths made `backend_amount_present` FALSE on every real order → with `requireBackendAmount` on in
  // prod, the kernel fail-closed with `backend_amount_missing` → PRICE_CHANGED on EVERY create_order (gating
  // both create_payment_link and complete_checkout_session). Fix: also read the real flat paths, parsing
  // them as MAJOR units → minor exactly like the quote, so the cross-check compares like-for-like.
  //
  // Candidate ORDER matters: `find(!== undefined)` picks the FIRST PROVIDED value (even if null) so a
  // present-but-null primary fails closed rather than silently falling through to a valid fallback. Prefer
  // the order's OWN total (`order.amounts?.total` for any future v2 shape, then the flat `total`/
  // `total_amount`) over `pricing.total` — the latter only echoes the quote, which would make the
  // cross-check tautological.
  const amountCandidates = [
    order.amounts?.total,   // idealized / future v2-nested shape (absent on the live v1 wire)
    raw?.total,             // v1 create: MAJOR-unit decimal STRING, authoritative + always present
    raw?.total_amount,      // v1 create: same value as a float (fallback)
    order.amount,           // legacy nested
    raw?.amount,            // legacy flat
    raw?.pricing?.total,    // last resort: quote-snapshot echo (quote-first only)
  ];
  const backend_amount_present = amountCandidates.some((a) => a !== undefined);
  // Codex: select the FIRST PROVIDED candidate (even if null) — do NOT `??`-fall-through a present-but-null
  // primary to a valid fallback, or a `{ amounts: { total: null }, total: "28.24" }` would slip past the
  // present-but-unparseable fail-closed path.
  const rawAmount = amountCandidates.find((a) => a !== undefined);
  // Round-2 P2: canonicalize currency to UPPERCASE — Stripe's API commonly returns lowercase ("usd"),
  // and ISO codes are case-insensitive; a raw compare would falsely reject "usd" vs "USD". The live v1
  // create response carries currency at the TOP LEVEL (`raw.currency`); keep the nested reads for compat.
  const rawCurrency = order.amounts?.currency ?? order.currency ?? raw?.currency
    ?? raw?.charge_currency ?? raw?.presentment_currency;
  const backend_currency = typeof rawCurrency === 'string' ? rawCurrency.toUpperCase() : rawCurrency;
  // Parse the backend total as a MAJOR-unit amount → minor (the confirmed live contract), the same way
  // the quote's pricing.total is parsed. A non-numeric value yields undefined → fail closed.
  const backend_amount_minor = parseMoney(rawAmount, backend_currency);
  return {
    ...raw,
    order_id: order.order_id ?? raw?.order_id,
    backend_amount_present,
    backend_amount_minor,
    backend_currency,
    acp_state: raw?.acp_state ?? raw?.tracking ?? {},
  };
}

/**
 * Real submit_payment → kernel-expected. The real backend is a checkout-session / client-confirmation
 * model: `payment_action.{type,url,client_secret}`, `payment_intent_id`/`checkout_session_id`,
 * `confirmation_owner`, `requires_client_confirmation`. The kernel's payment state machine + webhook
 * path (kernel.onPaymentWebhook) handle the async completion — see payment-flow-remodel.md.
 */
export function normalizeSubmitPayment(raw) {
  const pa = raw?.payment_action || {};
  const checkoutSession =
    raw?.checkout_session && typeof raw.checkout_session === 'object' && !Array.isArray(raw.checkout_session)
      ? raw.checkout_session
      : null;
  const checkoutSessionId =
    checkoutSession?.checkout_session_id ?? checkoutSession?.id ?? checkoutSession?.checkout_token;
  const checkoutRedirectUrl =
    checkoutSession?.hosted_url ?? checkoutSession?.checkout_url ?? checkoutSession?.url;
  return {
    ...raw,
    payment_status: raw?.payment_status ?? (checkoutSession ? 'requires_action' : raw?.status),
    payment_id: raw?.payment_id ?? raw?.payment_intent_id ?? raw?.checkout_session_id ?? checkoutSessionId,
    // A redirect comes back under payment_action; surface it as the flat redirect_url the kernel returns.
    redirect_url: raw?.redirect_url ?? (pa.type === 'redirect_url' ? pa.url : undefined) ?? checkoutRedirectUrl,
    // client_secret is for client-side confirmation; pass through but it is SENSITIVE (never log).
    client_secret: raw?.client_secret ?? pa.client_secret,
    confirmation_owner: raw?.confirmation_owner ?? (checkoutSession ? 'client' : undefined),
    requires_client_confirmation: raw?.requires_client_confirmation ?? (checkoutSession ? true : undefined),
  };
}

/**
 * Normalize a raw backend response for a given operation into the kernel-expected shape.
 * Unhandled ops (incl. submit_payment, reads) pass through unchanged.
 */
export function normalizeUpstream(operation, raw, requestPayload) {
  switch (operation) {
    case 'preview_quote': return normalizePreviewQuote(raw, requestPayload);
    case 'create_order': return normalizeCreateOrder(raw);
    case 'submit_payment': return normalizeSubmitPayment(raw);
    default: return raw; // reads: pass through
  }
}

/**
 * Wrap a raw upstream invoke so the kernel receives normalized responses.
 * @param {(op:string, payload:object, headers?:object) => Promise<any>} rawUpstream
 */
export function wrapUpstream(rawUpstream) {
  if (typeof rawUpstream !== 'function') throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_upstream' });
  return async (operation, payload, headers) => {
    const raw = await rawUpstream(operation, payload, headers);
    return normalizeUpstream(operation, raw, payload);
  };
}
