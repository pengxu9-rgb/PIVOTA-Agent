// Independent counterexamples for the contextual intent fix. No alternate
// query or title-based bypass: exercise the real contract and final ranker.
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const d = require('../src/server')._debug;

const hair = (overrides = {}) => ({
  product_id: 'sig_eyurs_hair_powder',
  title: "A'PIEU Oily Hair Dry Powder (5g)",
  brand: "A'PIEU",
  description: 'Absorbs excess oil and refreshes the scalp, leaving hair feeling fresh and lightweight.',
  category_path: ['beauty', 'haircare', 'treatment'],
  catalog_category_path: 'beauty/haircare/treatment',
  source: 'canonical_chain',
  price: 6, currency: 'USD', availability: 'in_stock',
  image_url: 'https://cdn.example.test/hair-powder.jpg',
  ...overrides,
});

function score(product, query) {
  const contract = buildSearchQualityContract({ rawQuery: query });
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return d.scoreBeautyExternalSeedProduct({ product, queryText: query,
    intent: d.inferBeautyMainlineIntent(query), normalizedQuery: normalized,
    queryTokens: normalized.split(/\s+/), searchQualityContract: contract });
}

test.each([
  "A'PIEU Oily Hair Dry Powder",
  'oily hair powder',
  'oil-control scalp powder',
  'sebum control for scalp',
  'shine control hair powder',
  'shampoo for oily hair',
])('hair/scalp oil concern is not facial-acne intent: %s', query => {
  expect(d.beautyQueryHasAcneOilControlIntent(query)).toBe(false);
});

test.each([
  'oily skin powder',
  'oil control face powder',
  'acne care for oily scalp',
  'hair powder for acne-prone skin',
  'oily hair and oily skin',
  'blemishes and scalp sebum',
  'breakout-prone skin and hair oil',
  'clogged pores and oily hair',
  'oil control for T-zone and oily hair',
  'oily complexion and hair',
  'visible pores and oily hair',
  'sebum control',
  'oily',
])('explicit facial/acne or unscoped oil concern retains its gate: %s', query => {
  expect(d.beautyQueryHasAcneOilControlIntent(query)).toBe(true);
});

test('the observed exact natural title survives its ordinary primary ranker', () => {
  expect(score(hair(), "A'PIEU Oily Hair Dry Powder").relevant).toBe(true);
});

test.each([
  ['wrong brand despite identical title', { brand: 'Fenty Beauty' }],
  ['face powder', { title: "A'PIEU Oily Skin Face Powder", category_path: ['beauty', 'makeup', 'face', 'powder'],
                    catalog_category_path: 'beauty/makeup/face/powder' }],
  ['hair oil', { title: "A'PIEU Oily Hair Dry Oil", category_path: ['beauty', 'haircare', 'hair_oil'] }],
  ['hair mask', { title: "A'PIEU Oily Hair Dry Mask", category_path: ['beauty', 'haircare', 'mask'] }],
  ['cross-sell title only in description', { title: "A'PIEU Volumizing Hair Mask",
    description: "Pair with A'PIEU Oily Hair Dry Powder", category_path: ['beauty', 'haircare', 'mask'] }],
])('context correction does not accept %s', (label, changes) => {
  expect(score(hair(changes), "A'PIEU Oily Hair Dry Powder").relevant).toBe(false);
});

test.each(["A'PIEU face powder", "A'PIEU setting powder", "A'PIEU lipstick", "A'PIEU lip oil"])(
  'a hair product still fails a different explicit product form: %s', query => {
    expect(score(hair(), query).relevant).toBe(false);
  },
);

test('facial acne query still rejects the observed hair product without acne evidence', () => {
  expect(score(hair(), "A'PIEU oily skin acne care").relevant).toBe(false);
});

test('title relevance does not exempt the matched product from unavailable/price gates', () => {
  const product = hair();
  expect(score(product, "A'PIEU Oily Hair Dry Powder").relevant).toBe(true);
  const unavailable = { products: [{ ...product, serving_eligible: false }], total: 1 };
  d.enforceFindProductsMultiAvailabilityContract(unavailable);
  expect(unavailable.products).toEqual([]);
  const unpriced = { products: [{ ...product, price: null }], total: 1 };
  d.enforceFindProductsMultiPriceContract(unpriced);
  expect(unpriced.products).toEqual([]);
});
