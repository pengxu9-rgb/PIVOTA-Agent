'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Rehearsal-only quote preparation. The authenticated caller supplies the buyer/session context. */
async function createCheckoutPreview({ merchantId, adapter, ap2Approval, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  if (typeof merchantId !== 'string' || !merchantId.trim() ||
      typeof adapter?.prepare !== 'function' || typeof adapter?.resume !== 'function' ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('Checkout preview requires a configured merchant adapter and a positive quote lifetime');
  }
  const [{ QuoteRegistry }, { InMemoryKvStore }, { PivotaCommerceError }] = await Promise.all([
    import('../../safety-kernel/src/quoteRegistry.js'),
    import('../../safety-kernel/src/stores.js'),
    import('../../safety-kernel/src/errors.js'),
  ]);
  const sessions = new InMemoryKvStore({ now });
  const quotes = new QuoteRegistry({ now, ttlMs });
  const approval = ap2Approval && await configureApproval(ap2Approval, merchantId, now);

  function buyerOf(context) {
    if (typeof context?.user_ref !== 'string' || !context.user_ref.trim() ||
        typeof context?.acp_session_id !== 'string' || !context.acp_session_id.trim()) {
      throw new PivotaCommerceError('USER_AUTH_REQUIRED');
    }
    return { user_ref: context.user_ref, acp_session_id: context.acp_session_id };
  }

  function lockedTotals(quote, item) {
    const totals = {
      subtotal: quote?.subtotalMinor, shipping: quote?.shippingMinor,
      tax: quote?.taxMinor, discount: quote?.discountMinor, total: quote?.totalMinor,
    };
    const amountsValid = Object.values(totals).every((amount) => Number.isSafeInteger(amount) && amount >= 0);
    const beforeDiscount = amountsValid ? totals.subtotal + totals.shipping + totals.tax : NaN;
    if (quote?.sku !== item.sku || quote?.variationId !== item.variationId ||
        quote?.quantity !== item.quantity || quote?.currency !== item.currency ||
        !Number.isSafeInteger(beforeDiscount) || beforeDiscount - totals.discount !== totals.total) {
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'invalid_checkout_preview_quote' });
    }
    return totals;
  }

  function issueQuote(checkoutReference, buyer, item, totals) {
    return quotes.issue({
      ...buyer, merchant_of_record: merchantId, upstream_quote_id: checkoutReference,
      currency: item.currency, locked_totals: totals,
      line_items: [{ sku: item.sku, variant_id: item.variationId, quantity: item.quantity }],
    });
  }

  function summary(reference, state, snapshot) {
    const { subtotal, shipping, tax, discount, total } = snapshot.locked_totals;
    return {
      checkoutReference: reference, quoteReference: snapshot.quote_id, merchantId: snapshot.merchant_of_record,
      expiresAt: new Date(state.expiresAt).toISOString(),
      ...(state.checkoutJwt ? { checkoutJwt: state.checkoutJwt } : {}),
      quote: {
        ...state.item, subtotalMinor: subtotal, shippingMinor: shipping,
        taxMinor: tax, discountMinor: discount, totalMinor: total,
      },
    };
  }

  function quoteState(state, snapshot) {
    return {
      ...state, quoteReference: snapshot.quote_id,
      checkoutJwt: approval?.binding.mintCheckoutJwt({
        checkout_session_id: snapshot.quote_id, expires_at: state.expiresAt,
      }),
    };
  }

  async function prepare(input, context) {
    const buyer = buyerOf(context);
    const { sku, variationId, quantity, currency, shippingAddress, billingAddress } = input ?? {};
    if (typeof sku !== 'string' || !sku.trim() || typeof variationId !== 'string' || !variationId.trim() ||
        !Number.isSafeInteger(quantity) || quantity < 1 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'invalid_checkout_preview_item' });
    }
    const reference = `wpv_${randomUUID()}`;
    const item = { sku, variationId, quantity, currency };
    const { session: merchantSession, quote } = await adapter.prepare({ ...item, shippingAddress, billingAddress });
    const snapshot = await issueQuote(reference, buyer, item, lockedTotals(quote, item));
    const state = quoteState({ ...buyer, item, merchantSession, expiresAt: snapshot.expires_at }, snapshot);
    await sessions.set(reference, state, { ttlMs: Math.max(0, state.expiresAt - now()) });
    return summary(reference, state, snapshot);
  }

  /** Reprice the private cart before verifying any signed approval for this quote revision. */
  async function resume({ checkoutReference, authorization } = {}, context) {
    const buyer = buyerOf(context);
    const state = await sessions.get(checkoutReference);
    if (!state || state.user_ref !== buyer.user_ref || state.acp_session_id !== buyer.acp_session_id) {
      throw new PivotaCommerceError('QUOTE_NOT_FOUND');
    }
    if (now() >= state.expiresAt) throw new PivotaCommerceError('QUOTE_EXPIRED');
    const previous = await quotes.ownedSnapshot(state.quoteReference, buyer);
    if (!previous || previous.upstream_quote_id !== checkoutReference) throw new PivotaCommerceError('QUOTE_NOT_FOUND');
    const { quote } = await adapter.resume({ session: state.merchantSession, item: state.item });
    const totals = lockedTotals(quote, state.item);
    if (now() >= state.expiresAt) throw new PivotaCommerceError('QUOTE_EXPIRED');

    let current = previous;
    let currentState = state;
    let requiresFreshApproval = true;
    if (!isDeepStrictEqual(previous.locked_totals, totals)) {
      current = await issueQuote(checkoutReference, buyer, state.item, totals);
      const remainingMs = state.expiresAt - now();
      if (remainingMs <= 0) throw new PivotaCommerceError('QUOTE_EXPIRED');
      currentState = quoteState(state, current);
      const replaced = await sessions.compareAndSet(checkoutReference, 'quoteReference', previous.quote_id,
        currentState, { ttlMs: remainingMs });
      if (!replaced) throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'checkout_preview_changed_concurrently' });
    } else {
      if (authorization !== undefined) {
        if (!approval) throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'checkout_preview_approval_unavailable' });
        await approval.verify(authorization, {
          user_ref: buyer.user_ref, ctx: buyer, merchant_id: merchantId,
          checkout_session_id: previous.quote_id, currency: previous.currency, amount: totals.total,
        });
        requiresFreshApproval = false;
      }
      if (now() >= state.expiresAt) throw new PivotaCommerceError('QUOTE_EXPIRED');
      if ((await sessions.get(checkoutReference))?.quoteReference !== previous.quote_id) {
        throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'checkout_preview_changed_concurrently' });
      }
    }

    return {
      ...summary(checkoutReference, currentState, current), requiresFreshApproval,
    };
  }

  return { prepare, resume };
}

async function configureApproval({ bindingSecret, issuers }, merchantId, now) {
  const [{ Ap2CheckoutBindingService }, { createAp2MandateVerifier },
    { createPaymentAuthorizationVerifier }, { PivotaCommerceError }] = await Promise.all([
    import('../../safety-kernel/src/protocol/ap2CheckoutBinding.js'),
    import('../../safety-kernel/src/protocol/protocolPaymentVerifiers.js'),
    import('../../safety-kernel/src/protocol/paymentAuthorizationVerifier.js'),
    import('../../safety-kernel/src/errors.js'),
  ]);
  const binding = new Ap2CheckoutBindingService({ secret: bindingSecret, now });
  const verifyMandate = createAp2MandateVerifier({
    issuers, expectedVct: 'urn:ap2:checkout-mandate',
    verifyCheckoutHash: binding.createCheckoutHashVerifier(), clockToleranceSeconds: 0,
  });
  const verify = createPaymentAuthorizationVerifier({
    merchantId, now, clockToleranceMs: 0,
    methods: { ap2_mandate: async (authorization) => {
      const claims = await verifyMandate(authorization);
      if (!claims.user_ref) throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'approval_buyer_missing' });
      return claims;
    } },
  });
  return { binding, verify };
}

module.exports = { createCheckoutPreview };
