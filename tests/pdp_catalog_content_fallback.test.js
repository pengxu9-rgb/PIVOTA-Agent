// Canonical PDPs for the enrichment lane showed only an overview: the content the catalog already
// holds was never read (measured on prod 2026-10-05 across 12 brands). These pin the two reads.
jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadDebug() {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', DATABASE_URL: 'postgres://test' };
  return require('../src/server')._debug;
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const SIG = 'sig_a84005aa3df3224c3d986428734eb770';
const BRAND_COPY = 'A rich, nourishing cream with bee pollen extract that restores moisture and visibly firms tired skin.';

describe('catalog description fallback for seed-routed listings', () => {
  test('uses the backfilled catalog copy when the seed gave none', () => {
    const { applyCatalogIdentityToPdpProduct } = loadDebug();
    const product = applyCatalogIdentityToPdpProduct({ product_id: 'missha:abc', title: 'Bee Pollen Renew' },
      { pivota_signature_id: SIG, catalog_description: BRAND_COPY });
    expect(product.description).toBe(BRAND_COPY);
  });

  test('uses it over a shorter seed description', () => {
    const { applyCatalogIdentityToPdpProduct } = loadDebug();
    const product = applyCatalogIdentityToPdpProduct({ product_id: 'missha:abc', description: 'Moisturizer' },
      { pivota_signature_id: SIG, catalog_description: BRAND_COPY });
    expect(product.description).toBe(BRAND_COPY);
  });

  test('never replaces a longer seed description', () => {
    const { applyCatalogIdentityToPdpProduct } = loadDebug();
    const longer = `${BRAND_COPY} Apply morning and night after toner, massaging gently until absorbed.`;
    const product = applyCatalogIdentityToPdpProduct({ product_id: 'missha:abc', description: longer },
      { pivota_signature_id: SIG, catalog_description: BRAND_COPY });
    expect(product.description).toBe(longer);
  });

  test.each([
    ['the ingest product-type summary', 'Toner'],
    ['copy under the backfill floor', 'Hydrating cream for dry skin.'],
  ])('ignores %s', (_label, catalogDescription) => {
    const { applyCatalogIdentityToPdpProduct } = loadDebug();
    const product = applyCatalogIdentityToPdpProduct({ product_id: 'missha:abc' },
      { pivota_signature_id: SIG, catalog_description: catalogDescription, product_type: 'Toner' });
    expect(product.description).toBeUndefined();
  });
});

describe('collected INCI is looked up under the catalog product key', () => {
  test('the canonical listing product_key and its canonical SKU are lookup keys', () => {
    const { _internals } = require('../src/services/pdpReviewedIngredientAuthority');
    const { keys } = _internals.buildReviewedIngredientKeyCandidates(
      { product_id: 'missha:abc' },
      { product_key: 'ext:missha::h1', merchant_id: 'merch_obs_x', product_id: 'missha:abc' },
    );
    expect(keys).toEqual(expect.arrayContaining(['ext:missha::h1', 'ext:missha::h1::canonical', 'missha:abc']));
  });

  test('a ref without a product_key keeps the previous keys', () => {
    const { _internals } = require('../src/services/pdpReviewedIngredientAuthority');
    const { keys } = _internals.buildReviewedIngredientKeyCandidates({ product_id: 'p1' }, { merchant_id: 'm1', product_id: 'p1' });
    expect(keys).toEqual(['p1', 'product:p1', 'm1:p1', 'm1::p1', 'merchant:m1:product:p1']);
  });
});
