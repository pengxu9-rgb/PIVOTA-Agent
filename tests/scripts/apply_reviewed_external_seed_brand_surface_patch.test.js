const {
  PATCH_VERSION,
  buildMarker,
  patchSeedData,
  validatePlan,
  _internals,
} = require('../../scripts/apply-reviewed-external-seed-brand-surface-patch.cjs');

describe('apply-reviewed-external-seed-brand-surface-patch', () => {
  const entry = {
    external_product_id: 'ext_real',
    market: 'US',
    brand: 'Tom Ford Beauty',
    reason: 'reviewed_official_domain_brand_surface_repair',
    evidence: 'Official Tom Ford Beauty PDP URL and product page identify this as a Tom Ford Beauty item.',
    source_url: 'https://www.tomfordbeauty.com/products/figue-erotique-eau-de-parfum',
    reviewed_by: 'codex_review',
  };

  test('adds reviewed brand marker without deleting commerce or content fields', () => {
    const marker = buildMarker(entry, '2026-05-23T00:00:00.000Z');
    const patched = patchSeedData(
      {
        price_amount: 255,
        price_currency: 'USD',
        availability: 'in_stock',
        description: 'A real official source-backed fragrance description.',
        snapshot: {
          price_amount: 255,
          price_currency: 'USD',
          availability: 'in_stock',
          description: 'A real official source-backed fragrance description.',
        },
      },
      entry,
      '2026-05-23T00:00:00.000Z',
    );

    expect(marker.contract_version).toBe(PATCH_VERSION);
    expect(patched.brand).toBe('Tom Ford Beauty');
    expect(patched.snapshot.brand).toBe('Tom Ford Beauty');
    expect(patched.reviewed_brand_surface_patch_v1).toEqual(
      expect.objectContaining({
        contract_version: PATCH_VERSION,
        patched_fields: ['brand'],
        review_state: 'assistant_reviewed',
      }),
    );
    expect(patched.snapshot.reviewed_brand_surface_patch_v1).toEqual(
      patched.reviewed_brand_surface_patch_v1,
    );
    expect(patched.price_amount).toBe(255);
    expect(patched.price_currency).toBe('USD');
    expect(patched.availability).toBe('in_stock');
    expect(patched.description).toBe('A real official source-backed fragrance description.');
    expect(patched.snapshot.price_amount).toBe(255);
    expect(patched.snapshot.price_currency).toBe('USD');
    expect(patched.snapshot.availability).toBe('in_stock');
    expect(patched.snapshot.description).toBe('A real official source-backed fragrance description.');
  });

  test('blocks overwriting a conflicting existing brand', () => {
    const blockers = validatePlan(
      {
        status: 'active',
        market: 'US',
        canonical_url: 'https://www.tomfordbeauty.com/products/figue-erotique-eau-de-parfum',
        seed_data: {
          brand: 'Different Brand',
          snapshot: {},
        },
        product_payload: {},
      },
      entry,
    );

    expect(blockers).toContain('brand_conflict_Different Brand');
  });

  test('requires source URL host to match the seed host', () => {
    const blockers = validatePlan(
      {
        status: 'active',
        market: 'US',
        canonical_url: 'https://www.tomfordbeauty.com/products/figue-erotique-eau-de-parfum',
        seed_data: {
          snapshot: {},
        },
        product_payload: {},
      },
      {
        ...entry,
        source_url: 'https://example.com/products/figue-erotique-eau-de-parfum',
      },
    );

    expect(blockers).toContain('source_url_host_mismatch');
  });

  test('catalog patch carries brand but no commerce fallback values', () => {
    const patch = _internals.buildCatalogPatch(entry, '2026-05-23T00:00:00.000Z');

    expect(patch.brand).toBe('Tom Ford Beauty');
    expect(patch.brand_name).toBe('Tom Ford Beauty');
    expect(patch.reviewed_brand_surface_patch_v1.contract_version).toBe(PATCH_VERSION);
    expect(patch).not.toHaveProperty('price_amount');
    expect(patch).not.toHaveProperty('availability');
  });
});
