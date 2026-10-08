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
  ['Lav Kids', 'Facial Foaming Cleanser Value Pack', 'WH | Facial Foaming Cleanser', 'same_product'],
  // A one-word base does not name a product, and a numbered slot inside a name is not an option.
  ['House', 'Tint - Rose', 'Tint - Pink', 'distinct'],
  ['House', 'Velvet Lip Tint No.1 Matte Formula', 'Velvet Lip Tint No.2 Glossy Formula', 'distinct'],
  // Review 2026-10-09 P2-b: a formula, audience or set tail vetoes the description-tail rule.
  ['House', 'Daily Moisturizer', 'Daily Moisturizer - SPF 30', 'distinct'],
  ['House', 'Daily Moisturizer', 'Daily Moisturizer, SPF 30', 'distinct'],
  ['House', 'Volume Mascara', 'Volume Mascara - Waterproof', 'distinct'],
  ['YSL', 'Libre Eau de Parfum', 'Libre Eau de Parfum - Intense', 'distinct'],
  ['Clinique', 'Moisture Surge Hydrator', 'Moisture Surge Hydrator for Men', 'distinct'],
  ['House', 'Mineral Sunscreen', 'Mineral Sunscreen for Kids', 'distinct'],
  ['Neutrogena', 'Hydro Boost Water Gel', 'Hydro Boost Water Gel - Fragrance Free', 'distinct'],
  ['House', 'Barrier Repair Cream', 'Barrier Repair Cream - Starter Set', 'distinct'],
  ['House', 'Barrier Repair Cream', 'Barrier Repair Cream - Kit', 'distinct'],
  // Review 2026-10-09 P2-c: shade words, No. markers and codes only name options in shade-bearing jobs.
  ['House', 'Hydrating Sheet Mask - Honey', 'Hydrating Sheet Mask - Rose', 'distinct'],
  ['Olaplex', 'Hair Perfector No.3', 'Hair Perfector No.4', 'distinct'],
  ['House', 'Collagen Sheet Mask PK100', 'Collagen Sheet Mask PK200', 'distinct'],
];
const REAL = real.identity.map((row) => [row.anchor.brand, row.anchor.name, row.candidate.name, row.expected, row]);

// Review 2026-10-09 P1-a / P1-c: real prod keys. content_key and GTIN are shared by different products in
// prod, so they may confirm a title match but never create one; listing refs / ids / signatures and an
// identical URL are the same listing whatever the brand spelling.
const KEYED = [
  { name: 'real ck_9aa75773 Birch Juice toner vs cream', expected: 'distinct',
    a: { brand: 'Round Lab', title: '[ROUND LAB] Birch Juice Moisturizing Toner 300ml', content_key: 'ck_9aa75773611a00a1eced5d0b1cce295a' },
    b: { brand: 'Round Lab', title: '[ROUND LAB] Birch Juice Moisturizing Cream 80ml', content_key: 'ck_9aa75773611a00a1eced5d0b1cce295a' } },
  { name: 'real ck_03c8b782 O HUI serum vs cream', expected: 'distinct',
    a: { brand: 'O HUI', title: 'O HUI Miracle Toning Glow Serum 20mL', content_key: 'ck_03c8b782b45b435bdb158d9c50f1dcbb' },
    b: { brand: 'O HUI', title: 'O HUI Miracle Toning Glow Cream 60mL', content_key: 'ck_03c8b782b45b435bdb158d9c50f1dcbb' } },
  { name: 'real ck_67e7694a two A\'PIEU cleansers', expected: 'distinct',
    a: { brand: "A'PIEU", title: "A'pieu Deep Clean Foam Cleanser - Pore 130ml X 3ea", content_key: 'ck_67e7694a364d4cd0d2b05eab80f64fa2' },
    b: { brand: "A'PIEU", title: "A'pieu Pore King Minji Trouble Cleansing Foam 200ml", content_key: 'ck_67e7694a364d4cd0d2b05eab80f64fa2' } },
  { name: 'two different sets sharing GTIN 08801051438130', expected: 'distinct',
    a: { brand: 'O HUI', title: 'Miracle Moisture Pink Barrier Ampoule 777 Set', gtin: '08801051438130' },
    b: { brand: 'O HUI', title: 'Age Recovery Collagen Special Set', gtin: '08801051438130' } },
  { name: 'real ck_9de1dc93 confirms two listings of one cream', expected: 'same_product',
    a: { brand: 'Anua', title: '[ANUA] Heartleaf 70% Intense Calming Cream 50ml', content_key: 'ck_9de1dc9381ac584375f83e34b0113688' },
    b: { brand: 'Anua', title: 'Anua Heartleaf 70% Intense Calming Cream (50ml)', content_key: 'ck_9de1dc9381ac584375f83e34b0113688' } },
  { name: 'shared signature, brand spelled differently', expected: 'same_product', crossBrand: true,
    a: { brand: 'Laneige', title: 'Lip Sleeping Mask', pivota_signature_id: 'sig_111111aa' },
    b: { brand: 'LANEIGE US', title: 'Lip Sleeping Mask Berry', pivota_signature_id: 'sig_111111aa' } },
  { name: 'identical URL, V1 / Good Molecules', expected: 'same_product', crossBrand: true,
    a: { brand: 'Good Molecules', title: 'Niacinamide Serum', url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml' },
    b: { brand: 'V1', title: 'Niacinamide Serum', url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml' } },
];

const cases = [
  ...KEYED.map(({ name, expected, crossBrand, a, b }) => ({ name, expected, crossBrand, a: { ...a, name: a.title, category: 'beauty' }, b: { ...b, name: b.title, category: 'beauty' } })),
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

describe.each(cases)('$name -> $expected', ({ a, b, expected, crossBrand }) => {
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
    // Edge validation checks this only for a same-brand alternative; a cross-brand pair is refused elsewhere.
    expect(errors.includes('competitive_alternative_same_family_variant')).toBe(Boolean(IDENTITY_SERVING[expected]) && !crossBrand);
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
    ['canonical entity', { canonical_entity_id: 'ent_42abc' }, 'equal_canonical_entity'],
    ['product group', { product_group_id: 'pg_42abc' }, 'equal_canonical_entity'],
    ['canonical url', { url: 'https://www.example.com/products/cream/?utm=x' }, 'equal_canonical_url'],
  ])('equal %s => same_product', (_label, key, reason) => {
    const other2 = { ...other, ...key, ...(key.url ? { url: 'https://example.com/products/cream' } : {}) };
    expect(compareProductIdentity({ ...a, ...key }, other2)).toEqual({ relation: 'same_product', basis: 'structured', reasons: [reason] });
  });
  test('content_key and GTIN confirm a title match but never create one', () => {
    for (const key of [{ content_key: 'ck_0123456789' }, { gtin: '00012345678905' }]) {
      expect(compareProductIdentity({ ...a, ...key }, { ...other, ...key })).toMatchObject({ relation: 'distinct', reasons: ['different_product_role'] });
      expect(compareProductIdentity({ ...a, ...key, title: 'Hydrating Cream 50ml' }, { ...a, ...key }))
        .toMatchObject({ relation: 'same_product', basis: 'title', reasons: ['listing_title_equal', key.gtin ? 'gtin_agrees' : 'content_key_agrees'] });
    }
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
  test('a canonical entity or normalised URL shared by two different brands is not identity evidence', () => {
    expect(compareProductIdentity(snapshot('Luxury', 'Barrier Cream', { canonical_entity_id: 'ent_shared1' }), snapshot('Value', 'Barrier Cream', { canonical_entity_id: 'ent_shared1' })))
      .toMatchObject({ relation: 'distinct', reasons: ['different_brand', 'structured_key_brand_conflict'] });
    expect(compareProductIdentity(snapshot('Luxury', 'Barrier Cream', { url: 'https://shop.example/products/cream?utm=a' }), snapshot('Value', 'Barrier Cream', { url: 'https://shop.example/products/cream' })).relation)
      .toBe('distinct');
  });
  test('equal refs, listing ids and signatures win over a differently spelled brand (build prefilter)', () => {
    const edgeOf = (a, b, ar, cr) => ({ relation_type: 'related_product', anchor_ref: ar, candidate_product_ref: cr, anchor_snapshot: a, candidate_snapshot: b });
    const run = (edge) => classifyEdgeForPrefilter({ edge, defaultLabelState: 'generated' }).prefilter_reasons;
    expect(run(edgeOf({ brand: 'Fenty Beauty', title: 'Gloss Bomb' }, { brand: 'FENTY BEAUTY by Rihanna', title: 'Gloss Bomb Universal Lip Luminizer' }, 'product:sig_abc123', 'product:sig_abc123')))
      .toEqual(['same_product_identity']);
    expect(run(edgeOf({ brand: 'Laneige', title: 'Lip Sleeping Mask', pivota_signature_id: 'sig_111111' }, { brand: 'LANEIGE US', title: 'Lip Sleeping Mask Berry', pivota_signature_id: 'sig_111111' }, 'product:a1', 'product:c1')))
      .toEqual(['same_product_identity']);
    expect(run(edgeOf({ brand: 'Good Molecules', title: 'Niacinamide Serum', url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml' },
      { brand: 'V1', title: 'Niacinamide Serum', url: 'https://v1.goodmolecules.com/products/niacinamide-serum?Size=30ml' }, 'product:a1', 'product:c1'))).toEqual(['same_product_identity']);
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
