// One identity contract for the relationship graph. Every accepting and refusing example runs through
// compareProductIdentity AND through each caller (build prefilter, builder, serving guard, pair policy,
// recall), so a caller can never drift back to its own notion of "same product".
const real = require('./fixtures/relgraph_served_2026_10_08_identity_relation.json');
const { compareProductIdentity, isSameProductOrVariant, compareBrands } = require('../src/auroraBff/relationshipProductIdentity');
const { isSameFamilyVariant } = require('../src/auroraBff/relationshipPairPolicy');
const { getRelationshipEdgeServingSuppressionReasons, validateRelationshipEdge } = require('../src/auroraBff/productRelationshipGraph');
const { __internal: { inferRelationship } } = require('../src/auroraBff/productRelationshipGraphBuilder');
const { __internal: { selectCandidateOpportunities } } = require('../src/auroraBff/productRelationshipGraphSources');
const { classifyEdgeForPrefilter } = require('../scripts/build-product-relationship-graph');

const snapshot = (brand, title, extra = {}) => ({ brand, title, name: title, category: 'beauty', ...extra });
const fromReal = (side) => ({ brand: side.brand, title: side.name, name: side.name, category: side.category });

// [brand, anchor title, candidate title, expected relation]
const BRIEF = [
  // Gaps closed on 2026-10-08: each passed every guard before.
  ['Missha', 'M Perfect Cover BB Cream No.23', 'M Perfect Cover BB Cream No.27', 'same_family_variant'],
  ['Missha', 'M Perfect Cover BB Cream 23 Natural Beige', 'M Perfect Cover BB Cream 27 Honey Beige', 'same_family_variant'],
  ['KISS', 'Full Moon Fantasy Lashes - Style A', 'Full Moon Fantasy Lashes - Style B', 'same_family_variant'],
  ['Laneige', 'Lip Sleeping Mask Berry', 'Lip Sleeping Mask Vanilla', 'same_family_variant'],
  ['Rare Beauty', 'Soft Pinch Liquid Blush in Hope', 'Soft Pinch Liquid Blush in Joy', 'same_family_variant'],
  ['Benefit', 'Boy Brow - Brown', 'Boy Brow - Black', 'same_family_variant'],
  ['The Ordinary', 'Retinol 0.5% in Squalane 30ml', 'Retinol 0.5% in Squalane (30ml) | Sephora', 'same_product'],
  // Already caught; must stay caught.
  ['Dear Barber', 'Fibre 100ml - Barber', 'Fibre 20ml - Barber', 'same_product'],
  ['Dear Barber', 'Shampoo 250ml - Barber', 'Shampoo 1000ml - Barber', 'same_product'],
  ['Missha', 'BB Cream #23', 'BB Cream #27', 'same_family_variant'],
  ['Fenty Beauty', 'Invisimatte Powder', 'Invisimatte Powder Refill', 'same_product'],
  ['Clinique', 'Moisture Surge', 'Moisture Surge Travel Size', 'same_product'],
  // Prior false positives: must remain distinct.
  ['MAKE UP FOR EVER', 'Rouge Artist For Ever Matte', 'Rouge Artist', 'distinct'],
  ['MAKE UP FOR EVER', 'Rouge Artist For Ever Matte', 'Rouge Artist For Ever', 'distinct'],
  ['House', 'Shampoo for Dry Hair', 'Shampoo for Oily Hair', 'distinct'],
  ['House', 'Eau de Parfum for Women', 'Eau de Parfum for Men', 'distinct'],
  ['House', 'Cream for Body', 'Cream for Face', 'distinct'],
  ['Clinique', 'Moisture Surge', 'Moisture Surge Intense', 'distinct'],
  ['Round Lab', 'Birch Moisturizing Sun Stick SPF 50+', 'Birch Moisturizing Sunscreen UVLock SPF 45+', 'distinct'],
  // Strength / name slots are never options.
  ['COSRX', 'Advanced Snail 96 Mucin Power Essence', 'Advanced Snail 92 Mucin Power Essence', 'distinct'],
  ['House', 'Retinol 0.2% in Squalane', 'Retinol 0.5% in Squalane', 'distinct'],
  ['Chanel', 'Perfume No. 5 Eau de Parfum', 'Perfume No. 19 Eau de Parfum', 'distinct'],
  ['House', 'Garden Eau de Parfum No. 5', 'Garden Eau de Parfum No. 19', 'distinct'],
  ['House', 'Skin Relief Toner No.1 Calming Formula', 'Skin Relief Toner No.2 Brightening Formula', 'distinct'],
  ['House', 'Brightening Serum 15 Strong', 'Brightening Serum 10 Gentle', 'distinct'],
  ['House', 'Retinol Serum in Squalane', 'Retinol Serum in Rosehip Oil', 'distinct'],
  ['House', 'Clay Mask Black', 'Clay Mask White', 'distinct'],
  ['House', 'Balm - Rose', 'Balm - Pink', 'distinct'],
  ['House', 'Glow Highlighter - Cream', 'Glow Highlighter - Powder', 'distinct'],
  ['Laneige', 'Lip Sleeping Mask Berry', 'Lip Sleeping Mask Overnight Repair', 'distinct'],
  // Option markers and listing packs.
  ['House', 'Glow Cushion Compact N°21', 'Glow Cushion Compact N°23', 'same_family_variant'],
  ['Laneige', 'Lip Sleeping Mask', 'Lip Sleeping Mask Berry', 'same_family_variant'],
  ['Lav Kids', 'Gentle Care Shampoo 12 fl oz (Case of 12)', 'Gentle Care Shampoo', 'same_product'],
  ['Falscara', 'Volume Wisps - 3-Pack', 'Volume Wisps', 'same_product'],
];
const REAL = real.identity.map((row) => [row.anchor.brand, row.anchor.name, row.candidate.name, row.expected, row]);

const cases = [
  ...BRIEF.map(([brand, a, b, expected]) => ({ name: `${brand} | ${a} || ${b}`, a: snapshot(brand, a), b: snapshot(brand, b), expected })),
  ...REAL.map(([, a, b, expected, row]) => ({ name: `real: ${row.anchor.brand} | ${a} || ${b}`, a: fromReal(row.anchor), b: fromReal(row.candidate), expected })),
];
const IDENTITY_SERVING = { same_product: 'same_product_across_listings_or_sizes', same_family_variant: 'same_family_variant' };
const IDENTITY_BUILDER = { same_product: 'same_product_listing_or_size', same_family_variant: 'same_family_variant' };
const IDENTITY_PREFILTER = { same_product: 'same_product_identity', same_family_variant: 'same_family_variant' };
const pairEdge = (a, b, relation = 'related_product', state = 'ai_approved') => ({
  anchor_type: 'product', anchor_ref: 'product:anchor_1', candidate_product_ref: 'product:candidate_1',
  anchor_snapshot: a, candidate_snapshot: b, relation_type: relation, label_state: state,
});

describe.each(cases)('$name -> $expected', ({ a, b, expected }) => {
  test('compareProductIdentity, both directions', () => {
    expect(compareProductIdentity(a, b).relation).toBe(expected);
    expect(compareProductIdentity(b, a).relation).toBe(expected);
  });
  test('build prefilter', () => {
    const { prefilter_reasons: reasons } = classifyEdgeForPrefilter({ edge: pairEdge(a, b, 'related_product', undefined), defaultLabelState: 'generated' });
    const identityReasons = (reasons || []).filter((reason) => Object.values(IDENTITY_PREFILTER).includes(reason));
    expect(identityReasons).toEqual(IDENTITY_PREFILTER[expected] ? [IDENTITY_PREFILTER[expected]] : []);
  });
  test('builder inferRelationship', () => {
    const inferred = inferRelationship(a, b, { ...b, similarity_score: 0.9, category_use_case_match: 0.9 });
    const reason = inferred.utilityCompatibility?.reason;
    if (IDENTITY_BUILDER[expected]) {
      expect(inferred.relation_type).toBe('rejected');
      expect(reason).toBe(IDENTITY_BUILDER[expected]);
    } else {
      expect(Object.values(IDENTITY_BUILDER)).not.toContain(reason);
    }
  });
  test('serving guard, both recommendation lanes; human decisions preserved', () => {
    for (const relation of ['related_product', 'competitive_alternative']) {
      const reasons = getRelationshipEdgeServingSuppressionReasons(pairEdge(a, b, relation))
        .filter((reason) => /same_product_across_listings_or_sizes|same_family_variant/.test(reason));
      expect(reasons).toEqual(IDENTITY_SERVING[expected] ? [`${relation}_${IDENTITY_SERVING[expected]}`] : []);
      expect(getRelationshipEdgeServingSuppressionReasons(pairEdge(a, b, relation, 'human_approved'))
        .filter((reason) => /same_product|same_family_variant/.test(reason))).toEqual([]);
    }
  });
  test('pair policy and edge validation', () => {
    expect(isSameFamilyVariant(a, b)).toBe(expected === 'same_family_variant');
    const errors = validateRelationshipEdge({ ...pairEdge(a, b, 'competitive_alternative'), review_status: 'pending',
      score_breakdown: { category_use_case_match: 0.9 }, source_refs: [{ type: 'catalog_products' }] }).errors;
    expect(errors.includes('competitive_alternative_same_family_variant')).toBe(Boolean(IDENTITY_SERVING[expected]));
  });
  test('recall never offers the anchor itself or its option', () => {
    const candidate = { ...b, product_ref: 'product:candidate_1', similarity_score: 0.9, category_use_case_match: 0.9 };
    const selected = selectCandidateOpportunities({ ...a, product_ref: 'product:anchor_1' }, [candidate], 4);
    expect(selected.length === 0).toBe(isSameProductOrVariant(a, b));
  });
});

describe('structured keys come first; a different key never proves distinct', () => {
  const a = snapshot('House', 'Hydrating Cream');
  const other = snapshot('House', 'Completely Different Serum');
  test.each([
    ['pivota_signature_id', { pivota_signature_id: 'sig_abcdef123' }, 'equal_listing_id'],
    ['content_key', { content_key: 'ck_0123456789' }, 'equal_content_key'],
    ['canonical entity', { canonical_entity_id: 'ent_42abc' }, 'equal_canonical_entity'],
    ['product group', { product_group_id: 'pg_42abc' }, 'equal_canonical_entity'],
    ['gtin', { gtin: '00012345678905' }, 'equal_gtin'],
    ['canonical url', { url: 'https://www.example.com/products/cream/?utm=x' }, 'equal_canonical_url'],
  ])('equal %s => same_product', (_label, key, reason) => {
    const other2 = { ...other, ...key, ...(key.url ? { url: 'https://example.com/products/cream' } : {}) };
    expect(compareProductIdentity({ ...a, ...key }, other2)).toEqual({ relation: 'same_product', basis: 'structured', reasons: [reason] });
  });
  test('equal refs => same_product', () => {
    expect(compareProductIdentity(a, other, { anchorRef: 'product:ext_9f8e7d', candidateRef: 'product:ext_9f8e7d' }).relation).toBe('same_product');
    expect(compareProductIdentity(a, other, { anchorRef: 'product:ext_9f8e7d', candidateRef: 'external:ext_9f8e7d' }).relation).toBe('same_product');
    expect(compareProductIdentity(a, other, { anchorRef: 'product:ext_9f8e7d', candidateRef: 'product:ext_000000' }).relation).toBe('distinct');
  });
  test('one PDP URL with two selected variants => same_family_variant', () => {
    expect(compareProductIdentity({ ...a, url: 'https://shop.example/products/tint?variant=1' }, { ...other, url: 'https://shop.example/products/tint?variant=2' }))
      .toMatchObject({ relation: 'same_family_variant', basis: 'structured' });
  });
  test('differing signatures / content keys do not make shades distinct', () => {
    const x = snapshot('Missha', 'BB Cream #23', { pivota_signature_id: 'sig_aaaaaa1', content_key: 'ck_aaaaaaa' });
    const y = snapshot('Missha', 'BB Cream #27', { pivota_signature_id: 'sig_bbbbbb2', content_key: 'ck_bbbbbbb' });
    expect(compareProductIdentity(x, y).relation).toBe('same_family_variant');
  });
  test('a key shared by two different brands is not identity evidence', () => {
    expect(compareProductIdentity(snapshot('Luxury', 'Barrier Cream', { product_id: 'shared-id-123' }), snapshot('Value', 'Barrier Cream', { product_id: 'shared-id-123' })))
      .toMatchObject({ relation: 'distinct', reasons: ['different_brand', 'structured_key_brand_conflict'] });
  });
});

describe('rules that only fire with their evidence', () => {
  test('one title with two structured shades is a variant', () => {
    expect(compareProductIdentity(snapshot('House', 'Hydrating Tint', { variant_title: 'Shade: Fair' }), snapshot('House', 'Hydrating Tint', { variant_title: 'Shade: Deep' })))
      .toMatchObject({ relation: 'same_family_variant', reasons: ['listing_title_equal', 'structured_variant_differs'] });
    expect(compareProductIdentity(snapshot('House', 'Hydrating Tint', { variant_title: 'Shade: Fair' }), snapshot('House', 'Hydrating Tint', { variant_title: 'Shade: Fair' })).relation)
      .toBe('same_product');
  });
  test('a different product job (here from the category) is never a shade of the other', () => {
    expect(compareProductIdentity(snapshot('House', 'Velvet Stick - Rose', { category: 'blush' }), snapshot('House', 'Velvet Stick - Pink', { category: 'highlighter' })))
      .toMatchObject({ relation: 'distinct', reasons: ['different_product_role'] });
  });
  test('labelled options cannot make a variant when the product job is unknown', () => {
    expect(compareProductIdentity(snapshot('House', 'Mystery Thing, Rose Gold', { variant_title: 'Shade: Rose Gold' }),
      snapshot('House', 'Mystery Thing, Black Onyx', { variant_title: 'Shade: Black Onyx' })).relation).toBe('distinct');
  });
  test('identical short refs are one listing', () => {
    expect(compareProductIdentity(snapshot('House', 'Cream'), snapshot('House', 'Serum'), { anchorRef: 'product:a', candidateRef: 'product:a' }))
      .toMatchObject({ relation: 'same_product', reasons: ['equal_product_ref'] });
  });
});

describe('brand is normalised once, names with names and ids with ids', () => {
  test('brand spelling variants are one brand', () => {
    expect(compareBrands({ brand: 'First Aid Beauty' }, { brand: 'Firstaid Beauty' })).toBe('same');
    expect(compareBrands({ brand: 'Stila' }, { brand: 'Stila Cosmetics' })).toBe('same');
    expect(compareBrands({ brand: 'O HUI' }, { brand: 'O HUI (오휘)' })).toBe('same');
    expect(compareBrands({ brand: 'Stila' }, { brand: 'Fenty Beauty' })).toBe('different');
  });
  test('a brand_id on one side does not hide a name on either side', () => {
    // brand_id-first extraction compared 'brand_77' with 'missha' and silently skipped the check.
    const a = { brand_id: 'brand_77', brand: 'Missha', title: 'BB Cream 30ml' };
    const b = { brand: 'missha', title: 'BB Cream 50ml' };
    expect(compareProductIdentity(a, b).relation).toBe('same_product');
    expect(getRelationshipEdgeServingSuppressionReasons(pairEdge(a, b))).toContain('related_product_same_product_across_listings_or_sizes');
  });
  test('an id on one side and only a name on the other is unresolved, not distinct', () => {
    expect(compareProductIdentity({ brand_id: 'b1', title: 'X Cream' }, { brand: 'B1', title: 'X Cream' }).relation).toBe('unknown');
    expect(compareProductIdentity({ brand_id: 'b1', title: 'X Cream 30ml' }, { brand_id: 'b1', title: 'X Cream 50ml' }).relation).toBe('same_product');
  });
  test('missing brand or title is unknown', () => {
    expect(compareProductIdentity({ title: 'Barrier Cream' }, snapshot('House', 'Barrier Cream')).relation).toBe('unknown');
    expect(compareProductIdentity(snapshot('House', ''), snapshot('House', 'Barrier Cream')).relation).toBe('unknown');
  });
});
