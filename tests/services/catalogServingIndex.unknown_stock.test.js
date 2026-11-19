const { buildCatalogServingDoc } = require('../../src/services/catalogServingIndex');

const FLAG = 'OFFERS_UNKNOWN_STOCK_STAYS_UNKNOWN_ENABLED';
const base = { product_id: 'p1', merchant_id: 'm1', title: 'Tinted Balm', market: 'US' };
const CASES = [
  // [input, flag off, flag on]
  [{ availability: 'in_stock' }, 'available', 'available'],
  [{ in_stock: true }, 'available', 'available'],
  [{ availability: 'https://schema.org/InStock' }, 'available', 'available'],
  [{ availability: 'out_of_stock' }, 'out_of_stock', 'out_of_stock'],
  [{ in_stock: false }, 'out_of_stock', 'out_of_stock'],
  [{ availability: 'sold out' }, 'available', 'out_of_stock'],
  [{ availability: 'preorder' }, 'preorder', 'preorder'],
  [{ availability: 'unknown' }, 'available', 'unknown'],
  [{ availability: 'check_at_store' }, 'available', 'unknown'],
  [{}, 'available', 'unknown'],
];

describe('catalog serving index: unknown stock stays unknown (flag)', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  test.each(CASES)('flag off keeps today\'s state for %j', (input, off) => {
    delete process.env[FLAG];
    expect(buildCatalogServingDoc({ ...base, ...input }).availability_state).toBe(off);
  });

  test.each(CASES)('flag on never calls unknown available for %j', (input, _off, on) => {
    process.env[FLAG] = 'true';
    expect(buildCatalogServingDoc({ ...base, ...input }).availability_state).toBe(on);
  });

  test('only the exact value true turns it on', () => {
    for (const value of ['1', 'yes', 'on', 'TRUE ']) {
      process.env[FLAG] = value;
      const state = buildCatalogServingDoc({ ...base, availability: 'unknown' }).availability_state;
      expect(state).toBe(value.trim().toLowerCase() === 'true' ? 'unknown' : 'available');
    }
  });
});
