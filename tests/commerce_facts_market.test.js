'use strict';

// ADR-026 P0: commerce facts never relabel an unknown market as US, and the seed gate checks every
// market's currency, not only US's. normalizeMarketId('GB') used to return 'US', so a GB seed's facts
// were served as market US and its GBP price was judged against USD.

const {
  MARKET_CURRENCY_TARGET,
  MARKET_COUNTRY,
  buildCommerceFactsFromSeedRow,
  readCommerceFactsV1,
  attachCommerceFactsToSeedRow,
  validateCommerceFactsGateForSeedRow,
} = require('../src/commerce/commerceFacts');
const { BUYER_REGION_CURRENCY } = require('../src/auroraBff/buyerRegion');

const seed = (over = {}) => ({
  market: 'US', price_amount: 20, price_currency: 'USD', availability: 'in_stock', image_url: 'https://cdn/x.jpg',
  destination_url: 'https://store.example/products/x', seed_data: {}, ...over,
});

test('the currency map covers every region the gateway knows, plus the legacy EU-DE and CN ids', () => {
  for (const [region, currency] of Object.entries(BUYER_REGION_CURRENCY)) {
    expect(MARKET_CURRENCY_TARGET[region]).toBe(currency);
    expect(MARKET_COUNTRY[region]).toBe(region);
  }
  expect(MARKET_CURRENCY_TARGET['EU-DE']).toBe('EUR');
  expect(MARKET_COUNTRY['EU-DE']).toBe('DE');
  expect(MARKET_CURRENCY_TARGET.CN).toBe('CNY');
});

test('a GB seed priced in GBP is a GB fact with a GBP target and an ok market switch, not US/USD/mismatch', () => {
  const facts = buildCommerceFactsFromSeedRow(seed({ market: 'GB', price_currency: 'GBP' }));
  expect(facts.market_id).toBe('GB');
  expect(facts.country).toBe('GB');
  expect(facts.currency_target).toBe('GBP');
  const row = attachCommerceFactsToSeedRow(seed({ market: 'GB', price_currency: 'GBP' }));
  expect(readCommerceFactsV1(row).market_id).toBe('GB');
  expect(validateCommerceFactsGateForSeedRow(row).status).toBe('pass');
});

test('an unknown market is null with no target: unknown switch, held by the gate, never US', () => {
  const row = attachCommerceFactsToSeedRow(seed({ market: 'ZZ', price_currency: 'USD' }));
  const facts = readCommerceFactsV1(row);
  expect(facts.market_id).toBeNull();
  expect(facts.currency_target).toBeNull();
  expect(facts.country).toBeNull();
  const gate = validateCommerceFactsGateForSeedRow(row);
  expect(gate.market_id).toBeNull();
  expect(gate.expected_currency).toBeNull();
  expect(gate.status).toBe('hold');
  expect(gate.problems).toContain('unknown_market');
});

test('a row that names no market is still a US row (the seed partition default)', () => {
  const facts = buildCommerceFactsFromSeedRow(seed({ market: undefined }));
  expect(facts.market_id).toBe('US');
  expect(facts.currency_target).toBe('USD');
});

test('the gate checks every market currency: an SG row priced in USD is held, an SG row in SGD passes', () => {
  const sgUsd = attachCommerceFactsToSeedRow(seed({ market: 'SG', price_currency: 'USD' }));
  const held = validateCommerceFactsGateForSeedRow(sgUsd);
  expect(held.status).toBe('hold');
  expect(held.problems).toEqual(expect.arrayContaining(['market_currency_mismatch']));
  const sgSgd = attachCommerceFactsToSeedRow(seed({ market: 'SG', price_currency: 'SGD' }));
  expect(validateCommerceFactsGateForSeedRow(sgSgd).status).toBe('pass');
});

test('US behaviour is unchanged: a US row in USD passes, a US row in SGD is held as before', () => {
  expect(validateCommerceFactsGateForSeedRow(attachCommerceFactsToSeedRow(seed())).status).toBe('pass');
  const usSgd = validateCommerceFactsGateForSeedRow(attachCommerceFactsToSeedRow(seed({ price_currency: 'SGD' })));
  expect(usSgd.problems).toEqual(expect.arrayContaining(['market_currency_mismatch']));
});
