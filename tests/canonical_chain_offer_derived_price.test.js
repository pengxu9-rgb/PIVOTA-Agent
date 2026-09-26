'use strict';

// The canonical-chain served price has NO fallback chain, by design.
//
// buildCanonicalChainMainlineProduct used to resolve the price amount and the
// price currency through two INDEPENDENT chains — the amount walked
// merchant_effective_price -> estimated_best_price -> list_price -> the seed
// payload, while the currency walked its own chain ending in the literal 'USD'.
// Nothing tied the two together, so an amount lifted from the payload could be
// shipped under a currency lifted from somewhere else. Measured on prod
// 2026-08-05: one live product carried a EUR payload amount labelled USD.
//
// The fix is not a consistency guard in front of the chains, it is the deletion
// of the chains: amount and currency come from ONE catalog_offers row or the
// product ships no price at all and is dropped by the serving gate. A
// fallback-derived price is an invisible wrong answer that makes a broken
// primary route look healthy; an absent one is a countable failure.
//
// These tests are written to FAIL if any fallback tier is reinstated — see the
// mutation-guard block at the bottom, which reads the resolver's own source.

jest.mock('../src/db', () => ({ query: jest.fn() }));

const server = require('../src/server');
const {
  buildCanonicalChainMainlineProduct,
  resolveCanonicalOfferDerivedPrice,
  CANONICAL_NO_OFFER_DERIVED_PRICE_REASON,
  getSearchProductServingEligibility,
} = server._debug;

/** A canonical-chain row whose payload carries a DIFFERENT price/currency than the offer row. */
function rowWithPayloadPrice(offerOverrides = {}, payloadPrice = { price_amount: '2.00', price_currency: 'EUR' }) {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: 'ext_price_probe',
    product_key: 'prod::external_seed::external_seed::ext_price_probe',
    pivota_signature_id: 'sig_price_probe',
    product_title: 'Price Probe Serum',
    product_payload: JSON.stringify({
      seed_data: JSON.stringify({
        title: 'Price Probe Serum',
        ...payloadPrice,
      }),
      external_seed: JSON.stringify({
        external_product_id: 'ext_price_probe',
        ...payloadPrice,
      }),
    }),
    ...offerOverrides,
  };
}

describe('canonical chain price is offer-derived or absent', () => {
  test('amount and currency both come from the SAME offer row', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: '31.50', currency: 'GBP' }),
    );

    expect(product.price).toBe(31.5);
    // GBP from the offer row — NOT EUR from the payload, and NOT a hardcoded USD.
    expect(product.currency).toBe('GBP');
    expect(product.price_absent_reason).toBeUndefined();
  });

  test('list_price is used when merchant_effective_price is null, with that row currency', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: null, list_price: '18.00', currency: 'JPY' }),
    );

    expect(product.price).toBe(18);
    expect(product.currency).toBe('JPY');
  });

  test('a payload price is NEVER substituted when the offer row has none', () => {
    // The exact live prod shape: offer row present, both price columns null,
    // payload carries a EUR amount. Old code shipped 2 labelled USD.
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: null, list_price: null, currency: 'USD' }),
    );

    expect(product.price).toBeUndefined();
    expect(product.currency).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });

  test('no offer row at all yields no price and no currency', () => {
    const product = buildCanonicalChainMainlineProduct(rowWithPayloadPrice({}));

    expect(product.price).toBeUndefined();
    expect(product.currency).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });

  test('currency is never defaulted: a priced offer row with no currency yields no price', () => {
    // An amount without a currency is not price-quotable. The old chain
    // answered 'USD' here from a literal; there is no literal any more.
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: '42.00', currency: null }),
    );

    expect(product.price).toBeUndefined();
    expect(product.currency).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });

  test('estimated_best_price is NOT a price source (pricedOfferSql excludes our own guess)', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: null,
        list_price: null,
        estimated_best_price: '99.00',
        currency: 'USD',
      }),
    );

    expect(product.price).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });

  test('a zero-price offer is not buyable and yields no price', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: '0', currency: 'USD' }),
    );

    expect(product.price).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });
});

describe('resolveCanonicalOfferDerivedPrice unit contract', () => {
  test('reads ONLY the offer-row columns', () => {
    expect(resolveCanonicalOfferDerivedPrice({ merchant_effective_price: '5', currency: 'CAD' }))
      .toEqual({ priced: true, amount: 5, currency: 'CAD' });
    expect(resolveCanonicalOfferDerivedPrice({ list_price: '7', currency: 'AUD' }))
      .toEqual({ priced: true, amount: 7, currency: 'AUD' });
  });

  test('merchant_effective_price wins over list_price on the same row', () => {
    const r = resolveCanonicalOfferDerivedPrice({
      merchant_effective_price: '5',
      list_price: '9',
      currency: 'USD',
    });
    expect(r).toEqual({ priced: true, amount: 5, currency: 'USD' });
  });

  test('unusable rows report the reason code', () => {
    for (const row of [{}, null, { currency: 'USD' }, { merchant_effective_price: '5' }]) {
      expect(resolveCanonicalOfferDerivedPrice(row)).toEqual({
        priced: false,
        reason: CANONICAL_NO_OFFER_DERIVED_PRICE_REASON,
      });
    }
  });
});

describe('the residue is countable', () => {
  test('a price-less canonical product is serving-INELIGIBLE and reports the specific reason', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: null, currency: 'USD' }),
    );
    const verdict = getSearchProductServingEligibility(product, { requireBeauty: false });

    expect(verdict.eligible).toBe(false);
    // Generic bucket AND the narrower, sortable reason.
    expect(verdict.reasons).toContain('missing_price');
    expect(verdict.reasons).toContain(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });

  test('a properly priced canonical product reports neither price reason', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: '31.50', currency: 'GBP' }),
    );
    const verdict = getSearchProductServingEligibility(product, { requireBeauty: false });

    expect(verdict.reasons).not.toContain('missing_price');
    expect(verdict.reasons).not.toContain(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
  });
});

// MUTATION GUARD.
//
// The behavioral tests above pin the OUTPUT, but a reinstated fallback can hide
// behind inputs a test does not happen to supply — the old currency chain read
// six payload keys, and a test that never sets `snapshot.price_currency` would
// stay green while that tier came back. These assertions read the resolver's
// own source so that re-adding ANY tier, or the hardcoded default, fails here.
describe('mutation guard: the fallback chain must not come back', () => {
  const source = resolveCanonicalOfferDerivedPrice.toString();

  test('no hardcoded currency literal anywhere in the resolver', () => {
    // The whole defect class in one assertion: no currency may be invented.
    expect(source).not.toMatch(/['"`](?:USD|EUR|GBP|JPY|CAD|AUD|INR|ZAR|CNY|KRW)['"`]/i);
  });

  test('the resolver reads no payload/seed/snapshot source', () => {
    for (const forbidden of [
      'payload',
      'seed_data',
      'seedData',
      'snapshot',
      'external_seed',
      'externalSeed',
      'price_amount',
      'price_currency',
      'estimated_best_price',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test('the resolver reads exactly the three offer-row columns', () => {
    expect(source).toContain('row.currency');
    expect(source).toContain('row.merchant_effective_price');
    expect(source).toContain('row.list_price');
  });

  test('the mapper resolves price through the resolver and nowhere else', () => {
    const mapper = buildCanonicalChainMainlineProduct.toString();
    // Exactly one price resolution call, and no direct re-derivation.
    expect(mapper).toContain('resolveCanonicalOfferDerivedPrice(row)');
    expect(mapper).not.toContain('snapshot.price_amount');
    expect(mapper).not.toContain('externalSeed.price_currency');
    expect(mapper).not.toContain('seedData.price_amount');
  });
});
