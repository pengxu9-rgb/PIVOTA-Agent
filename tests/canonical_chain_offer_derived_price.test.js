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

describe('the served price states when it was true', () => {
  // We were shipping an unqualified number. Measured on prod 2026-09-16 across the
  // serving-eligible referral lane: 2,273 offers under 7 days old, 8,179 at 7-30
  // days, 7,350 at 30-90, 435 over 90 -- against a catalog audit that found 43% of
  // live PDPs carrying an active markdown at any moment. A cached price stated
  // as-of is a defensible product; an undated one is not.
  //
  // The freshness comes off the SAME offer row as the amount, which is the rule
  // this whole file exists to enforce for the currency.

  test('price_as_of and price_confidence come from the offer row', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: '28.20',
        currency: 'SGD',
        price_updated_at: '2026-09-08 04:25:42.316439+00',
        price_confidence: '0.70',
      }),
    );

    expect(product.price).toBe(28.2);
    expect(product.currency).toBe('SGD');
    expect(product.price_as_of).toBe('2026-09-08T04:25:42.316Z');
    expect(product.price_confidence).toBe(0.7);
  });

  test('a Date instance is accepted, because pg returns one on some paths', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: '10.00',
        currency: 'USD',
        price_updated_at: new Date('2026-01-02T03:04:05.000Z'),
      }),
    );
    expect(product.price_as_of).toBe('2026-01-02T03:04:05.000Z');
  });

  test('NO timestamp means NO price_as_of -- never "now"', () => {
    // The whole value of the field is that a reader can tell a fresh price from a
    // stale one. Defaulting an unknown timestamp to the current time asserts a
    // verification we never performed, and is worse than omitting the field: it
    // would make every unstamped row look like it was checked this second.
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({ merchant_effective_price: '10.00', currency: 'USD' }),
    );

    expect(product.price).toBe(10);
    expect(product).not.toHaveProperty('price_as_of');
  });

  test('an unparseable timestamp is absent, not passed through', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: '10.00',
        currency: 'USD',
        price_updated_at: 'not-a-date',
      }),
    );
    expect(product).not.toHaveProperty('price_as_of');
  });

  test('a null confidence is absent, not coerced to 0', () => {
    // 0 is a real confidence value meaning "we do not believe this price". Emitting
    // it for "we did not record one" would be a different claim entirely.
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: '10.00',
        currency: 'USD',
        price_confidence: null,
      }),
    );
    expect(product).not.toHaveProperty('price_confidence');
  });

  test('a real zero confidence IS emitted', () => {
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: '10.00',
        currency: 'USD',
        price_confidence: '0',
      }),
    );
    expect(product.price_confidence).toBe(0);
  });

  test('CONTROL: an unpriced row carries neither field', () => {
    // Without this, every test above would also pass if the fields were attached
    // unconditionally, outside the priced branch -- dating a price that does not
    // exist.
    const product = buildCanonicalChainMainlineProduct(
      rowWithPayloadPrice({
        merchant_effective_price: null,
        list_price: null,
        currency: null,
        price_updated_at: '2026-09-08T04:25:42.000Z',
        price_confidence: '0.9',
      }),
    );

    expect(product.price).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
    expect(product).not.toHaveProperty('price_as_of');
    expect(product).not.toHaveProperty('price_confidence');
  });

  test('the resolver never invents a timestamp', () => {
    // Source-level, matching this file's existing mutation guards: a Date.now() or
    // new Date() with no argument inside the resolver would defeat every assertion
    // above by making the absent case indistinguishable from the fresh one.
    const source = resolveCanonicalOfferDerivedPrice.toString();
    expect(source).not.toContain('Date.now()');
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).toContain('row.price_updated_at');
    expect(source).toContain('row.price_confidence');
  });
});
