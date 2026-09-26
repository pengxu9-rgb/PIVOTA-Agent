'use strict';

// ADR-007 citation-item finalization. finalizeCitableSupplementItem marks a
// built product as a non-buyable citation and strips the raw seed_data /
// external_seed jsonb blobs that buildCanonicalChainMainlineProduct echoes onto
// every item (pure response bloat on a referral-only citation), while KEEPING the
// derived fields extracted from those blobs (ingredient_intel, active_ingredients,
// ingredients_inci, pdp_ingredients_raw, fashion_meta, identity).

const { finalizeCitableSupplementItem } = require('../src/server')._debug;

function sampleBuiltItem() {
  // Shape mirrors buildCanonicalChainMainlineProduct output for an external-seed
  // beauty row: raw passthrough blobs alongside separate derived ingredient keys.
  return {
    id: 'sig_abc',
    product_id: 'sig_abc',
    content_key: 'ck_abc',
    title: 'Jumiso 20% Niacinamide Serum',
    brand: 'Jumiso',
    vendor: 'Jumiso',
    image_url: 'https://img/x.jpg',
    canonical_url: 'https://pivota/x',
    price: 24.0,
    currency: 'USD',
    availability: 'in stock',
    // derived — MUST survive
    ingredients_inci: ['Niacinamide', 'Water'],
    active_ingredients: ['niacinamide'],
    ingredient_intel: { actives: ['niacinamide'], confidence: 0.9 },
    pdp_ingredients_raw: 'Niacinamide, Water',
    ingredient_remediation_v1: { status: 'ok' },
    pdp_field_quality_summary: { ingredients: 'high' },
    fashion_meta: { material: { value: 'n/a' } },
    // raw passthrough — MUST be stripped
    seed_data: { brand: 'Jumiso', snapshot: { title: 'x', price_amount: '24.00', price_currency: 'USD' }, derived: { recall: {} }, big: 'x'.repeat(2000) },
    external_seed: { external_product_id: 'ext_1', snapshot: { price_amount: '24.00', price_currency: 'USD' } },
  };
}

describe('finalizeCitableSupplementItem', () => {
  test('strips raw seed_data / external_seed but keeps derived ingredient + identity fields', () => {
    const out = finalizeCitableSupplementItem(sampleBuiltItem());

    // raw passthrough blobs removed
    expect(out).not.toHaveProperty('seed_data');
    expect(out).not.toHaveProperty('external_seed');

    // citation semantics
    expect(out.buyable).toBe(false);
    expect(out.in_stock).toBe(false);
    expect(out).toHaveProperty('price', 24);
    expect(out).toHaveProperty('currency', 'USD');
    expect(out.catalog_track).toBe('citation');
    expect(out.source).toBe('canonical_citation');
    expect(out.search_recall_source).toBe('canonical_citation');
    expect(out.catalog_source).toBe('canonical_citation');

    // derived ingredient intel is retained (this is the whole point of "strip
    // bloat only" vs dropping product_payload)
    expect(out.ingredients_inci).toEqual(['Niacinamide', 'Water']);
    expect(out.active_ingredients).toEqual(['niacinamide']);
    expect(out.ingredient_intel).toEqual({ actives: ['niacinamide'], confidence: 0.9 });
    expect(out.pdp_ingredients_raw).toBe('Niacinamide, Water');
    expect(out.ingredient_remediation_v1).toEqual({ status: 'ok' });
    expect(out.pdp_field_quality_summary).toEqual({ ingredients: 'high' });
    expect(out.fashion_meta).toEqual({ material: { value: 'n/a' } });

    // identity preserved
    expect(out.content_key).toBe('ck_abc');
    expect(out.title).toBe('Jumiso 20% Niacinamide Serum');
    expect(out.brand).toBe('Jumiso');
    expect(out.image_url).toBe('https://img/x.jpg');
    expect(out.canonical_url).toBe('https://pivota/x');
  });

  test('mutates in place and returns the same object', () => {
    const item = sampleBuiltItem();
    const out = finalizeCitableSupplementItem(item);
    expect(out).toBe(item);
  });

  test('returns null for non-object / null input', () => {
    expect(finalizeCitableSupplementItem(null)).toBeNull();
    expect(finalizeCitableSupplementItem(undefined)).toBeNull();
    expect(finalizeCitableSupplementItem([1, 2])).toBeNull();
  });

  test('is safe when the blobs are already absent and the card has a canonical price', () => {
    const out = finalizeCitableSupplementItem({ content_key: 'ck', title: 't', price: 12, currency: 'USD', ingredient_intel: { a: 1 } });
    expect(out).not.toHaveProperty('seed_data');
    expect(out.ingredient_intel).toEqual({ a: 1 });
    expect(out.buyable).toBe(false);
    expect(out.catalog_track).toBe('citation');
  });
});
