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

// Parity with the backend's normalize_availability. This fixture is a byte-identical copy of the
// backend's tests/fixtures/availability_spellings_parity.json; both change together.
const { normalizeAvailability } = require('../../src/services/availabilityVocabulary');
const PARITY = require('../fixtures/availability_spellings_parity.json').cases;
const STATE_FOR = { in_stock: 'available', out_of_stock: 'out_of_stock' };

describe('availability vocabulary matches the backend (shared fixture)', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  test('fixture is non-trivial', () => {
    expect(PARITY.length).toBeGreaterThan(100);
  });

  test.each(PARITY.map((c) => [c.input, c.expected]))('normaliser: %j -> %j', (input, expected) => {
    expect(normalizeAvailability(input)).toBe(expected);
  });

  test.each(PARITY.filter((c) => typeof c.input === 'string').map((c) => [c.input, c.expected]))(
    'flag on serving state: availability %j',
    (input, expected) => {
      process.env[FLAG] = 'true';
      const state = buildCatalogServingDoc({ ...base, availability: input }).availability_state;
      // Exact 'preorder'/'backorder' keep their own pre-existing serving states (never 'available').
      const ownState = ['preorder', 'backorder'].includes(input.trim().toLowerCase());
      expect(state).toBe(expected === null ? (ownState ? input.trim().toLowerCase() : 'unknown') : STATE_FOR[expected]);
    },
  );

  test.each([[true, 'available'], [false, 'out_of_stock'], [null, 'unknown']])(
    'flag on serving state: in_stock %j alone',
    (inStock, state) => {
      process.env[FLAG] = 'true';
      const input = inStock === null ? { ...base } : { ...base, in_stock: inStock };
      expect(buildCatalogServingDoc(input).availability_state).toBe(state);
    },
  );

  test('JSON-LD shapes: {@id} and lists, a disagreeing list is unknown', () => {
    expect(normalizeAvailability({ '@id': 'https://schema.org/SoldOut' })).toBe('out_of_stock');
    expect(normalizeAvailability(['https://schema.org/InStock'])).toBe('in_stock');
    expect(normalizeAvailability(['OutOfStock', 'InStock'])).toBe(null);
    process.env[FLAG] = 'true';
    expect(buildCatalogServingDoc({ ...base, availability: { '@id': 'http://schema.org/OutOfStock' } })
      .availability_state).toBe('out_of_stock');
  });
});

describe('schema.org OutOfStock IRI is out of stock with the flag on', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  test.each([
    'https://schema.org/OutOfStock',
    'http://schema.org/OutOfStock',
    'https://www.schema.org/OutOfStock',
    'http://www.schema.org/OutOfStock',
  ])('%s', (iri) => {
    process.env[FLAG] = 'true';
    expect(buildCatalogServingDoc({ ...base, availability: iri }).availability_state).toBe('out_of_stock');
    expect(buildCatalogServingDoc({ ...base, availability_state: iri }).availability_state).toBe('out_of_stock');
  });
});

describe('a boolean in_stock decides over stated stock text', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  // The offer's own boolean wins (live-verified sold-out with stale in-stock text stays out of
  // stock). Text is read only when there is no boolean.
  const BOOLEAN_CASES = [
    // [input, flag off, flag on]
    [{ in_stock: false, availability: 'in stock' }, 'out_of_stock', 'out_of_stock'],
    [{ in_stock: false, availability: 'https://schema.org/InStock' }, 'out_of_stock', 'out_of_stock'],
    [{ in_stock: true, availability: 'discontinued' }, 'available', 'available'],
    [{ in_stock: true, availability: 'https://schema.org/SoldOut' }, 'available', 'available'],
    [{ in_stock: true, availability: 'in stock' }, 'available', 'available'],
    [{ in_stock: false, availability: 'sold out' }, 'out_of_stock', 'out_of_stock'],
    [{ in_stock: false, availability: 'preorder' }, 'out_of_stock', 'out_of_stock'],
    [{ in_stock: true, availability: 'preorder' }, 'preorder', 'preorder'],
    [{ in_stock: true, availability: 'backorder' }, 'backorder', 'backorder'],
    [{ in_stock: true, availability: 'check_at_store' }, 'available', 'available'],
    [{ in_stock: true }, 'available', 'available'],
    [{ in_stock: false }, 'out_of_stock', 'out_of_stock'],
    // no boolean: the shared vocabulary reads the text
    [{ availability: 'discontinued' }, 'available', 'out_of_stock'],
    [{ availability: 'Temporarily out of stock' }, 'available', 'out_of_stock'],
    [{ availability: 'limited stock' }, 'available', 'available'],
    [{ availability: 'n/a' }, 'available', 'unknown'],
  ];

  test.each(BOOLEAN_CASES)('flag off unchanged for %j', (input, off) => {
    delete process.env[FLAG];
    expect(buildCatalogServingDoc({ ...base, ...input }).availability_state).toBe(off);
  });

  test.each(BOOLEAN_CASES)('flag on for %j', (input, _off, on) => {
    process.env[FLAG] = 'true';
    expect(buildCatalogServingDoc({ ...base, ...input }).availability_state).toBe(on);
  });
});

// Inputs where JS and Python string handling differ. Expected values are what the backend's
// normalize_availability returned (pivota-backend venv, 2026-11-20). Kept out of the shared
// fixture so that file stays byte-identical with the backend copy.
describe('exotic inputs match the backend normaliser', () => {
  test.each([
    // nested JSON-LD: the backend reads str() (repr) of the inner container
    [{ availability: { availability: 'InStock' } }, null],
    [{ availability: { '@id': 'https://schema.org/OutOfStock' } }, 'out_of_stock'],
    [{ availability: { availability: 'SoldOut' } }, 'out_of_stock'],
    [{ availability: ['OutOfStock', 'InStock'] }, null],
    [{ value: [true] }, null],
    [{ availability: { k: '\u001fsold out' } }, 'out_of_stock'],
    // U+FEFF is not stripped by Python, so the IRI does not unwrap
    ['\ufeffhttps://schema.org/InStock', null],
    ['\ufeffInStock', 'in_stock'],
    // U+001F / U+0085 / U+3000 ARE stripped by Python, so the IRI unwraps
    ['\u001fhttps://schema.org/InStock', 'in_stock'],
    ['\u0085https://schema.org/InStock', 'in_stock'],
    ['\u3000https://schema.org/InStock', 'in_stock'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeAvailability(input)).toBe(expected);
  });
});

describe('flag parse', () => {
  const saved = process.env[FLAG];
  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  test.each(['1', 'yes', 'on', 'True1', ''])('%j stays off', (value) => {
    process.env[FLAG] = value;
    expect(buildCatalogServingDoc({ ...base, availability: 'unknown' }).availability_state).toBe('available');
  });

  test.each(['true', ' TRUE ', 'True'])('%j turns it on', (value) => {
    process.env[FLAG] = value;
    expect(buildCatalogServingDoc({ ...base, availability: 'unknown' }).availability_state).toBe('unknown');
  });
});
