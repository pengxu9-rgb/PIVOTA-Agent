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

describe('the served price states when it was read', () => {
  // `price_checked_at` is the backend's "we read this price" stamp, carried off the SAME offer row as
  // the amount (the rule this file enforces for the currency). NOT updated_at: prod 2026-09-28, 85% of
  // served offers share their updated_at minute with 100+ rows from bulk writes, and 22,530 were
  // re-read after their last stamp. See isServedPriceAsOfEnabled in canonicalCatalogSearch.js.
  const FLAG = 'CANONICAL_CATALOG_SERVED_PRICE_AS_OF';
  let savedFlag;
  beforeEach(() => {
    savedFlag = process.env[FLAG];
    process.env[FLAG] = 'on';
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  const priced = (overrides) => buildCanonicalChainMainlineProduct(
    rowWithPayloadPrice({ merchant_effective_price: '28.20', currency: 'SGD', ...overrides }),
  );

  test('price_as_of comes from the offer row, as pg returns it', () => {
    // timestamptz arrives as a Date.
    const product = priced({ price_checked_at: new Date('2026-09-08T04:25:42.316Z') });
    expect(product.price).toBe(28.2);
    expect(product.currency).toBe('SGD');
    expect(product.price_as_of).toBe('2026-09-08T04:25:42.316Z');
  });

  test.each([['0.70'], ['0'], ['1.00'], [0.9]])('the row\'s price_confidence (%p) is never published', (value) => {
    // A per-writer constant, not a reading of the row: 0.70 on all 47,005 enrichment-agent offers.
    // On a card it would read as "how likely this price is right" and rank sellers by ingest lane.
    const product = priced({ price_checked_at: new Date('2026-09-08T04:25:42.316Z'), price_confidence: value });
    expect(product.price_as_of).toBe('2026-09-08T04:25:42.316Z');
    expect(product).not.toHaveProperty('price_confidence');
  });

  test('updated_at is never read as the as-of', () => {
    // The row-write stamp is the tempting wrong answer: it is on every row and it is always recent
    // after a backfill.
    const product = priced({ updated_at: '2026-09-28 06:07:00', offer_updated_at: new Date(), price_updated_at: new Date() });
    expect(product).not.toHaveProperty('price_as_of');
  });

  test('NO stamp means NO price_as_of, never "now"', () => {
    const product = priced({ price_checked_at: null });
    expect(product.price).toBe(28.2);
    expect(product).not.toHaveProperty('price_as_of');
  });

  test('CONTROL: an unpriced row carries neither field', () => {
    // Without this, the tests above would also pass with the fields attached outside the priced
    // branch, dating a price that does not exist.
    const product = buildCanonicalChainMainlineProduct(rowWithPayloadPrice({
      merchant_effective_price: null, list_price: null, currency: null,
      price_checked_at: new Date('2026-09-08T04:25:42.000Z'),
    }));
    expect(product.price).toBeUndefined();
    expect(product.price_absent_reason).toBe(CANONICAL_NO_OFFER_DERIVED_PRICE_REASON);
    expect(product).not.toHaveProperty('price_as_of');
  });

  test('flag OFF publishes no as-of, even from a row that carries one', () => {
    process.env[FLAG] = 'off';
    const product = priced({ price_checked_at: new Date('2026-09-08T04:25:42.316Z') });
    expect(product.price).toBe(28.2);
    expect(product).not.toHaveProperty('price_as_of');
  });

  test.each([
    ['a bare number', 0],
    ['a negative number', -1],
    ['a year only', '2026'],
    ['a us locale date', '9/8/2026'],
    ['a date with no time', '2026-09-08'],
    // A zone-less time would be parsed as LOCAL time. price_checked_at is timestamptz; a string
    // without a zone did not come from it.
    ['a time with no zone', '2026-09-08 04:25:42.316439'],
    ['junk', 'not-a-date'],
    ['an invalid Date', new Date('nope')],
    ['a boolean', true],
    ['an object', {}],
    // Stringifies to a valid timestamp, so the guard has to reject by type.
    ['an array wrapping a valid timestamp', ['2026-09-08T04:25:42.316Z']],
  ])('%s yields NO price_as_of', (_label, value) => {
    const product = priced({ price_checked_at: value });
    expect(product.price).toBe(28.2);
    expect(product).not.toHaveProperty('price_as_of');
  });

  test.each([
    ['a Date', new Date('2026-09-08T04:25:42.316Z')],
    ['the postgres +00 rendering', '2026-09-08 04:25:42.316439+00'],
    ['a +08 offset', '2026-09-08 12:25:42.316+08'],
    ['a full ISO instant', '2026-09-08T04:25:42.316Z'],
  ])('%s is accepted', (_label, value) => {
    expect(priced({ price_checked_at: value }).price_as_of).toBe('2026-09-08T04:25:42.316Z');
  });

  test('the resolver reads the stamp column and never invents a time', () => {
    const source = resolveCanonicalOfferDerivedPrice.toString();
    expect(source).toContain('row.price_checked_at');
    expect(source).not.toContain('price_confidence');
    expect(source).not.toContain('updated_at');
    expect(source).not.toContain('Date.now()');
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});

describe('the freshness field survives the transport projection', () => {
  const { projectSearchTransportProduct } = server._debug;

  test('price_as_of is not stripped; price_confidence is', () => {
    // An explicit allowlist at every find_products_multi exit: a field missing from it is simply
    // absent, which looks exactly like a product that never had one. The live merchant lane's own
    // price_as_of (its fetch time) passes through here too.
    const projected = projectSearchTransportProduct({
      product_id: 'sig_x', title: 'x', price: 28.2, currency: 'SGD',
      price_as_of: '2026-09-08T04:25:42.316Z', price_confidence: 0.7,
    });
    expect(projected.price).toBe(28.2);
    expect(projected.price_as_of).toBe('2026-09-08T04:25:42.316Z');
    expect(projected).not.toHaveProperty('price_confidence');
  });

  test('CONTROL: the projection is still an allowlist', () => {
    const projected = projectSearchTransportProduct({
      product_id: 'sig_x', title: 'x', _internal_debug_blob: { secret: true }, price_checked_at: 'raw',
    });
    expect(projected.product_id).toBe('sig_x');
    expect(projected).not.toHaveProperty('_internal_debug_blob');
    expect(projected).not.toHaveProperty('price_checked_at');
  });
});
