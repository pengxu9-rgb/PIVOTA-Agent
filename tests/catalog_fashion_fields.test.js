// Tests for services/catalogFashionFields — the read-through layer
// that makes catalog_products the single source of truth for derived
// fashion fields on PDP renders.

const path = require('path');

// Mock the DB query helper before requiring the module under test.
let _mockRows = [];
let _mockQueryError = null;
let _mockQueryCalls = [];
jest.mock('../src/db', () => ({
  query: async (sql, params) => {
    _mockQueryCalls.push({ sql, params });
    if (_mockQueryError) throw _mockQueryError;
    return { rows: _mockRows };
  },
}));

const {
  readFashionFieldsByProductRef,
  enrichProductWithCatalogFashionFields,
  __test: { _invalidateCache },
} = require(path.join('..', 'src', 'services', 'catalogFashionFields'));

beforeEach(() => {
  _mockRows = [];
  _mockQueryError = null;
  _mockQueryCalls = [];
  _invalidateCache();
});

describe('readFashionFieldsByProductRef', () => {
  test('returns null when merchantId or sourceProductId is missing', async () => {
    expect(await readFashionFieldsByProductRef({})).toBeNull();
    expect(await readFashionFieldsByProductRef({ merchantId: 'm' })).toBeNull();
    expect(await readFashionFieldsByProductRef({ sourceProductId: 'p' })).toBeNull();
    expect(_mockQueryCalls).toEqual([]); // never hits DB
  });

  test('builds provenance-tagged shape from a populated row', async () => {
    _mockRows = [{
      material: '100% organic cotton',
      material_source: 'merchant_payload',
      material_confidence: 1.0,
      care: 'Machine wash cold',
      care_source: 'llm_extraction_v1',
      care_confidence: 0.85,
      size_guide: { columns: ['Size', 'Bust'], rows: [] },
      size_guide_source: 'manual_review',
      size_guide_confidence: 1.0,
    }];
    const result = await readFashionFieldsByProductRef({
      merchantId: 'm1', sourceProductId: 'p1',
    });
    expect(result).toEqual({
      material: { value: '100% organic cotton', source: 'merchant_payload', confidence: 1.0 },
      care: { value: 'Machine wash cold', source: 'llm_extraction_v1', confidence: 0.85 },
      size_fit_chart: { columns: ['Size', 'Bust'], rows: [] },
    });
  });

  test('skips fields with null values', async () => {
    _mockRows = [{
      material: 'cotton', material_source: 'merchant_payload', material_confidence: 1.0,
      care: null, care_source: null, care_confidence: null,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    const result = await readFashionFieldsByProductRef({
      merchantId: 'm1', sourceProductId: 'p1',
    });
    expect(result).toEqual({
      material: { value: 'cotton', source: 'merchant_payload', confidence: 1.0 },
    });
  });

  test('returns null when row has no populated fashion data', async () => {
    _mockRows = [{
      material: null, material_source: null, material_confidence: null,
      care: null, care_source: null, care_confidence: null,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    expect(await readFashionFieldsByProductRef({
      merchantId: 'm1', sourceProductId: 'p1',
    })).toBeNull();
  });

  test('returns null when query throws (does not 500 the gateway)', async () => {
    _mockQueryError = new Error('DB unavailable');
    expect(await readFashionFieldsByProductRef({
      merchantId: 'm1', sourceProductId: 'p1',
    })).toBeNull();
  });

  test('parses size_guide string into object envelope', async () => {
    _mockRows = [{
      material: null, material_source: null, material_confidence: null,
      care: null, care_source: null, care_confidence: null,
      size_guide: '{"raw": "See chart below"}',
      size_guide_source: 'regex_extraction_v1', size_guide_confidence: 0.7,
    }];
    const result = await readFashionFieldsByProductRef({
      merchantId: 'm1', sourceProductId: 'p1',
    });
    expect(result?.size_fit_chart).toEqual({ raw: 'See chart below' });
  });

  test('caches result for 5 min — second read does not hit DB', async () => {
    _mockRows = [{
      material: 'silk', material_source: 'merchant_payload', material_confidence: 1.0,
      care: null, care_source: null, care_confidence: null,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    await readFashionFieldsByProductRef({ merchantId: 'm1', sourceProductId: 'p1' });
    expect(_mockQueryCalls).toHaveLength(1);
    await readFashionFieldsByProductRef({ merchantId: 'm1', sourceProductId: 'p1' });
    expect(_mockQueryCalls).toHaveLength(1); // cached
    // Different product key bypasses cache:
    _mockRows = [];
    await readFashionFieldsByProductRef({ merchantId: 'm1', sourceProductId: 'p2' });
    expect(_mockQueryCalls).toHaveLength(2);
  });

  test('bypassCache=true forces a re-read', async () => {
    _mockRows = [{ material: 'silk', material_source: 'merchant_payload', material_confidence: 1.0,
                   care: null, care_source: null, care_confidence: null,
                   size_guide: null, size_guide_source: null, size_guide_confidence: null }];
    await readFashionFieldsByProductRef({ merchantId: 'm1', sourceProductId: 'p1' });
    await readFashionFieldsByProductRef({ merchantId: 'm1', sourceProductId: 'p1', bypassCache: true });
    expect(_mockQueryCalls).toHaveLength(2);
  });
});


describe('enrichProductWithCatalogFashionFields', () => {
  test('merges catalog fields into a product with no existing fashion_meta', async () => {
    _mockRows = [{
      material: 'wool', material_source: 'llm_extraction_v1', material_confidence: 0.9,
      care: null, care_source: null, care_confidence: null,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    const product = { product_id: 'sig_x', merchant_id: 'm', source_product_id: 'p' };
    await enrichProductWithCatalogFashionFields(product, { merchantId: 'm', sourceProductId: 'p' });
    expect(product.fashion_meta).toEqual({
      material: { value: 'wool', source: 'llm_extraction_v1', confidence: 0.9 },
    });
  });

  test('upstream fashion_meta fields win over catalog values', async () => {
    _mockRows = [{
      material: 'CATALOG_WINS', material_source: 'llm_extraction_v1', material_confidence: 0.9,
      care: 'CATALOG_CARE', care_source: 'llm_extraction_v1', care_confidence: 0.8,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    const product = {
      product_id: 'sig_x', merchant_id: 'm', source_product_id: 'p',
      fashion_meta: { material: 'UPSTREAM' }, // legacy flat string — should win
    };
    await enrichProductWithCatalogFashionFields(product, { merchantId: 'm', sourceProductId: 'p' });
    expect(product.fashion_meta.material).toBe('UPSTREAM');
    // care wasn't on upstream, so catalog fills it in
    expect(product.fashion_meta.care).toEqual({
      value: 'CATALOG_CARE', source: 'llm_extraction_v1', confidence: 0.8,
    });
  });

  test('no-op when catalog has nothing', async () => {
    _mockRows = [{
      material: null, material_source: null, material_confidence: null,
      care: null, care_source: null, care_confidence: null,
      size_guide: null, size_guide_source: null, size_guide_confidence: null,
    }];
    const product = { product_id: 'sig_x', fashion_meta: { material: 'silk' } };
    const before = JSON.parse(JSON.stringify(product));
    await enrichProductWithCatalogFashionFields(product, { merchantId: 'm', sourceProductId: 'p' });
    expect(product).toEqual(before);
  });

  test('no-op when no sourceProductId (sig-only product without source ref)', async () => {
    const product = { product_id: 'sig_x' };
    await enrichProductWithCatalogFashionFields(product, { merchantId: 'm', sourceProductId: null });
    expect(_mockQueryCalls).toEqual([]);
    expect(product.fashion_meta).toBeUndefined();
  });
});
