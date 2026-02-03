const { mapAuroraAlternativesToDupeCompare } = require('../src/auroraBff/auroraStructuredMapper');

describe('Aurora structured mapper: dupe compare', () => {
  test('Uses originalAnchorFallback when upstream parse lacks anchor_product', () => {
    const upstream = {
      schema_version: 'aurora.structured.v1',
      parse: { normalized_query: 'MockBrand Mock Parsed Product' },
      alternatives: [],
    };

    const originalFallback = { brand: 'MockBrand', name: 'Mock Parsed Product', sku_id: 'mock_sku_1' };
    const dupe = { brand: 'MockDupeBrand', name: 'Mock Dupe Product', sku_id: 'mock_dupe_1' };

    const out = mapAuroraAlternativesToDupeCompare(upstream, dupe, { originalAnchorFallback: originalFallback });

    expect(out).toHaveProperty('original');
    expect(out.original).toMatchObject({ brand: 'MockBrand', name: 'Mock Parsed Product' });
    expect(out).toHaveProperty('dupe');
    expect(out.dupe).toMatchObject({ brand: 'MockDupeBrand', name: 'Mock Dupe Product' });
  });
});

