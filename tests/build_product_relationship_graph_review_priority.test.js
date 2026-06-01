const { orderEdgesByReviewPriority } = require('../scripts/build-product-relationship-graph');
const { normalizeKey } = require('../src/auroraBff/productBeautyAttributes');

function edge(id, { score = 0.95, aBrand, cBrand } = {}) {
  return {
    id,
    anchor_ref: `product:${id}A`,
    candidate_product_ref: `product:${id}C`,
    relation_type: 'competitive_alternative',
    score_total: score,
    anchor_snapshot: aBrand ? { brand: aBrand } : {},
    candidate_snapshot: cBrand ? { brand: cBrand } : {},
  };
}

function attrMap(entries) {
  const m = new Map();
  for (const [ref, attrs] of entries) m.set(normalizeKey(ref), attrs);
  return m;
}

describe('orderEdgesByReviewPriority', () => {
  // A clearly-good pair: same area, overlapping category, same brand.
  const good = edge('good', { aBrand: 'Glow', cBrand: 'Glow' });
  // A clearly-bad pair: cross area, disjoint category, cross brand.
  const bad = edge('bad', { aBrand: 'Glow', cBrand: 'Lume' });
  const attrs = attrMap([
    [good.anchor_ref, { target_area: 'face', category_leaf: 'vitamin_c_serum', product_form: 'serum' }],
    [good.candidate_product_ref, { target_area: 'face', category_leaf: 'brightening_serum', product_form: 'serum' }],
    [bad.anchor_ref, { target_area: 'face', category_leaf: 'lipstick', product_form: 'lipstick' }],
    [bad.candidate_product_ref, { target_area: 'lips', category_leaf: 'mascara', product_form: 'mascara' }],
  ]);

  test('sorts the higher-predicted-approval edge first and attaches review_priority', () => {
    const out = orderEdgesByReviewPriority([bad, good], attrs);
    expect(out.map((e) => e.id)).toEqual(['good', 'bad']);
    expect(out[0].review_priority).toBeGreaterThan(out[1].review_priority);
    expect(out[0].review_priority).toBeGreaterThanOrEqual(0);
    expect(out[0].review_priority).toBeLessThanOrEqual(1);
  });

  test('preserves all edges and does not mutate the input array', () => {
    const input = [bad, good];
    const out = orderEdgesByReviewPriority(input, attrs);
    expect(out).toHaveLength(2);
    expect(input.map((e) => e.id)).toEqual(['bad', 'good']); // input untouched
  });

  test('is a stable no-op ordering when no attrs are available (neutral features)', () => {
    const e1 = edge('e1');
    const e2 = edge('e2');
    const out = orderEdgesByReviewPriority([e1, e2], new Map());
    // equal (neutral) priority → stable original order
    expect(out.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  test('handles empty input', () => {
    expect(orderEdgesByReviewPriority([], attrs)).toEqual([]);
  });
});
