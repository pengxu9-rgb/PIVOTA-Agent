// A shared category is a shelf, not evidence that two products are alike.
//
// 2026-09-25 JP/AU dry run (gateway e5028c4d6): all 2,464 product edges scored exactly 1.0 with
// category_use_case_match 1.0. Equal one-word categories ("sunscreen", "mask", "general") overlap
// 1.0, retailer rows repeat the category as their only tag, and both terms fed a max(). Every
// cheaper same-shelf product from another brand became a "dupe" (a sunscreen gel "duped" by eye
// patches; a hair serum by a flyaway stick). Each rule below is paired with a case it must still
// accept.
const { buildProductRelationshipGraphDryRun } = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  normalizeProductCandidateSnapshot,
  __internal: { scoreCandidateForAnchor },
} = require('../src/auroraBff/productRelationshipGraphSources');

const NOW = '2026-09-25T00:00:00.000Z';

function product(overrides = {}) {
  return normalizeProductCandidateSnapshot(overrides, { sourceType: 'catalog_products' });
}

function score(anchor, candidate, options) {
  return scoreCandidateForAnchor(product(anchor), product(candidate), options);
}

describe('relationship graph scoring: category agreement is capped evidence', () => {
  test('two products sharing only a one-word category do not score as near-identical', () => {
    const out = score(
      { product_ref: 'product:sig_a', brand: 'X', name: 'Alpha Beta', category: 'mask', price: 20 },
      { product_ref: 'product:sig_b', brand: 'Y', name: 'Gamma Delta', category: 'mask', price: 10 },
    );

    expect(out.category_use_case_match).toBe(0.72);
    expect(out.score_total).toBeLessThan(0.82);
  });

  test('a catch-all category shared by both sides is no category evidence at all', () => {
    const out = score(
      { product_ref: 'product:sig_c', brand: 'Milbon', name: 'Plarmia Hair Serum Treatment', category: 'general', tags: ['general'] },
      { product_ref: 'product:sig_d', brand: '&honey', name: 'Matomake Stick Flyaway', category: 'general', tags: ['general'] },
    );

    expect(out.category_use_case_match).toBeLessThan(0.55);
    expect(out.score_total).toBeLessThan(0.55);
  });

  test('tags that only repeat the category do not come back as ingredient/product evidence', () => {
    const out = score(
      { product_ref: 'product:sig_e', brand: 'Skin Aqua', name: 'Super Moisture Gel', category: 'sunscreen', tags: ['sunscreen'] },
      { product_ref: 'product:sig_f', brand: 'PIXI', name: 'FortifEYE Eye Patches', category: 'Sunscreen', tags: ['Sunscreen'] },
    );

    expect(out.ingredient_functional_similarity).toBeLessThan(0.82);
    expect(out.score_total).toBeLessThan(0.82);
  });

  test('accepts: descriptive tags beyond the category still count as shared evidence', () => {
    const out = score(
      { product_ref: 'product:sig_g', brand: 'X', name: 'Calm Cream', category: 'moisturizer', tags: ['moisturizer', 'fragrance-free', 'ceramide'] },
      { product_ref: 'product:sig_h', brand: 'Y', name: 'Rescue Lotion', category: 'moisturizer', tags: ['moisturizer', 'fragrance-free', 'ceramide'] },
    );

    expect(out.ingredient_functional_similarity).toBe(1);
  });

  test('accepts: curated dupe evidence still lifts category agreement past the shelf cap', () => {
    const out = score(
      { product_ref: 'product:sig_i', brand: 'X', name: 'Alpha Beta', category: 'mask' },
      { product_ref: 'product:sig_j', brand: 'Y', name: 'Gamma Delta', category: 'mask' },
      { legacyMatch: true },
    );

    expect(out.category_use_case_match).toBeCloseTo(0.84, 4);
  });
});

describe('relationship graph builder: a dupe needs product evidence beyond the shelf', () => {
  const anchor = {
    product_id: 'sig_anchor',
    brand: 'Skin Aqua',
    name: 'Skin Aqua UV Super Moisture Essence Sunscreen SPF50+ PA++++ 2.8oz',
    category: 'sunscreen',
    price: 14,
  };
  function candidate(overrides = {}) {
    return {
      brand: 'Other',
      category: 'sunscreen',
      price: 9,
      category_use_case_match: 1,
      ingredient_functional_similarity: 1,
      similarity_score: 1,
      source_refs: [{ type: 'external_product_seed', authoritative: true }],
      price_observed_at: NOW,
      ...overrides,
    };
  }
  function relations(candidates) {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [anchor],
      candidatesByAnchor: { 'product:sig_anchor': candidates },
      now: new Date(NOW),
      reviewStatus: 'pending',
      limit: 200,
      needs: [],
    });
    return Object.fromEntries(out.edges.map((edge) => [edge.candidate_product_ref, edge.relation_type]));
  }

  test('a cheaper same-category product whose name shares nothing with the anchor is not a dupe', () => {
    const got = relations([
      candidate({ product_id: 'sig_patches', brand: 'PIXI BEAUTY', name: 'FortifEYE Single-Use Eye Patches' }),
    ]);

    expect(got['product:sig_patches']).not.toBe('dupe');
  });

  test('brand, body-area, generic and size words shared by both names are not product evidence', () => {
    const got = relations([
      candidate({ product_id: 'sig_sizes', brand: 'Aqua Labs', name: 'Aqua Labs Face Care Mist 2.8oz' }),
    ]);

    expect(got['product:sig_sizes']).not.toBe('dupe');
  });

  test('accepts: a cheaper product named for the same job and form is still a dupe', () => {
    const got = relations([
      candidate({ product_id: 'sig_biore', brand: 'Bioré', name: 'Bioré UV Aqua Rich Watery Essence Sunscreen SPF50+ PA++++' }),
    ]);

    expect(got['product:sig_biore']).toBe('dupe');
  });

  test('accepts: curated dupe evidence stands without shared name words', () => {
    const got = relations([
      candidate({
        product_id: 'sig_curated',
        brand: 'Curated',
        name: 'Daily Shield Fluid',
        source_refs: [{ type: 'aurora_dupe_kb', authoritative: true }],
      }),
    ]);

    expect(got['product:sig_curated']).toBe('dupe');
  });
});
