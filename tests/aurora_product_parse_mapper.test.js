const { mapAuroraProductParse } = require('../src/auroraBff/auroraStructuredMapper');

describe('Aurora structured mapper: product parse', () => {
  test('falls back to URL heuristics when upstream parse has no anchor product', () => {
    const upstream = {
      schema_version: 'aurora.structured.v1',
      parse: {
        normalized_query: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
        parse_confidence: 0,
      },
      kb_requirements_check: {
        missing_fields: ['ingredients', 'social_signals'],
      },
    };

    const out = mapAuroraProductParse(upstream);
    expect(out.product).toBeTruthy();
    expect(out.product.brand).toBe('The Ordinary');
    expect(out.product.name).toBe('Multi Peptide Copper Peptides 1 Serum');
    expect(out.product.display_name).toBe('The Ordinary Multi Peptide Copper Peptides 1 Serum');
    expect(out.confidence).toBeCloseTo(0.25);
    expect(out.missing_info).toEqual(expect.arrayContaining(['ingredients', 'social_signals', 'heuristic_url_parse']));
  });

  test('maps alternate parse product fields and parse-level missing_info', () => {
    const upstream = {
      schema_version: 'aurora.structured.v1',
      parse: {
        product_entity: {
          brand: 'MockBrand',
          name: 'Mock Product',
        },
        confidence: 0.61,
        missing_info: ['price_unknown'],
      },
    };

    const out = mapAuroraProductParse(upstream);
    expect(out.product).toMatchObject({
      brand: 'MockBrand',
      name: 'Mock Product',
      display_name: 'MockBrand Mock Product',
    });
    expect(out.confidence).toBeCloseTo(0.61);
    expect(out.missing_info).toEqual(expect.arrayContaining(['price_unknown']));
  });
});
