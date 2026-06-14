const {
  hydrateProductWithReviewedIngredientAuthority,
  _internals,
} = require('../../src/services/pdpReviewedIngredientAuthority');

// get_pdp_v2 must surface the graded, claim-safe CLAIMS (evidence_profile) the
// supplier-evidence intake writes to beauty_product_profiles — selected by
// content_key with brand-official precedence (mirrors the backend assembler).
describe('pdp evidence_profile (graded claims) attach', () => {
  beforeEach(() => {
    _internals.resetTableAvailabilityCacheForTest();
  });

  function evidenceQueryFn(evidenceRow) {
    return jest.fn(async (sql, params) => {
      if (/to_regclass/i.test(sql)) return { rows: [{ table_name: params[0] }] };
      if (/FROM public\.beauty_sku_ingredients/i.test(sql)) return { rows: [] };
      if (/FROM pci_kb\.sku_ingredients/i.test(sql)) return { rows: [] };
      if (/FROM public\.beauty_product_profiles/i.test(sql)) {
        // resolved by content_key, brand-official precedence ordering present
        expect(params).toEqual(['ck-1']);
        expect(sql).toContain("(bpp.merchant_id = 'external_seed') DESC");
        expect(sql).toContain('JOIN public.catalog_products cp');
        return { rows: evidenceRow ? [evidenceRow] : [] };
      }
      return { rows: [] };
    });
  }

  test('attaches evidence_profile + required_disclaimers resolved by content_key', async () => {
    const queryFn = evidenceQueryFn({
      evidence_profile: {
        claims: [{
          claim_text: 'Helps brighten and even the look of skin tone',
          source_type: 'ingredient_mechanism',
          substantiation_status: 'substantiated',
        }],
        review_state: 'observed',
      },
      required_disclaimers: [{ text: 'This statement has not been evaluated by the FDA.' }],
    });

    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product: { content_key: 'ck-1', title: 'Good Night Collagen', product_id: 'p1' },
      canonicalProductRef: { content_key: 'ck-1' },
      queryFn,
    });

    expect(hydrated.evidence_profile.claims[0].claim_text).toContain('brighten');
    expect(hydrated.evidence_profile.claims[0].substantiation_status).toBe('substantiated');
    expect(hydrated.required_disclaimers).toEqual([
      { text: 'This statement has not been evaluated by the FDA.' },
    ]);
  });

  test('no-ops when the cluster has no authored evidence (PDP unbroken)', async () => {
    const queryFn = evidenceQueryFn(null);
    const product = { content_key: 'ck-1', title: 'X', product_id: 'p1' };
    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product,
      canonicalProductRef: { content_key: 'ck-1' },
      queryFn,
    });
    expect(hydrated.evidence_profile).toBeUndefined();
  });

  test('does not overwrite claims the product already carries', async () => {
    const queryFn = evidenceQueryFn({
      evidence_profile: { claims: [{ claim_text: 'NEW' }], review_state: 'observed' },
    });
    const existing = { claims: [{ claim_text: 'EXISTING' }], review_state: 'reviewed' };
    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product: { content_key: 'ck-1', title: 'X', evidence_profile: existing },
      canonicalProductRef: { content_key: 'ck-1' },
      queryFn,
    });
    expect(hydrated.evidence_profile.claims[0].claim_text).toBe('EXISTING');
  });

  test('no content_key → no evidence query, returns product unchanged', async () => {
    const queryFn = jest.fn(async () => ({ rows: [] }));
    const hydrated = await hydrateProductWithReviewedIngredientAuthority({
      product: { title: 'X', product_id: 'p1' },
      canonicalProductRef: {},
      queryFn,
    });
    expect(hydrated.evidence_profile).toBeUndefined();
    // the beauty_product_profiles table-availability check should be skipped
    const calledSql = queryFn.mock.calls.map((c) => c[0]).join(' ');
    expect(calledSql).not.toContain('FROM public.beauty_product_profiles');
  });
});
