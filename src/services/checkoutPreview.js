'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Rehearsal-only quote preparation. The authenticated caller supplies the buyer/session context. */
async function createCheckoutPreview({ merchantId, adapter, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
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
      quote: {
        ...state.item, subtotalMinor: subtotal, shippingMinor: shipping,
        taxMinor: tax, discountMinor: discount, totalMinor: total,
      },
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
    const state = { ...buyer, item, merchantSession, expiresAt: snapshot.expires_at, quoteReference: snapshot.quote_id };
    await sessions.set(reference, state, { ttlMs: Math.max(0, state.expiresAt - now()) });
    return summary(reference, state, snapshot);
  }

  /** approvedQuoteReference is the quote shown during approval. This method checks price freshness only. */
  async function resume({ checkoutReference, approvedQuoteReference } = {}, context) {
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
    if (!isDeepStrictEqual(previous.locked_totals, totals)) {
      current = await issueQuote(checkoutReference, buyer, state.item, totals);
      const remainingMs = state.expiresAt - now();
      if (remainingMs <= 0) throw new PivotaCommerceError('QUOTE_EXPIRED');
      const replaced = await sessions.compareAndSet(checkoutReference, 'quoteReference', previous.quote_id,
        { ...state, quoteReference: current.quote_id }, { ttlMs: remainingMs });
      if (!replaced) throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'checkout_preview_changed_concurrently' });
    } else if ((await sessions.get(checkoutReference))?.quoteReference !== previous.quote_id) {
      throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'checkout_preview_changed_concurrently' });
    }

    return {
      ...summary(checkoutReference, state, current),
      requiresFreshApproval: approvedQuoteReference !== current.quote_id,
    };
  }

  return { prepare, resume };
}

module.exports = { createCheckoutPreview };
