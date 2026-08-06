jest.mock('../../src/db', () => ({
  closePool: jest.fn(),
  query: jest.fn(),
  withClient: jest.fn(),
}));

const { buildPlans } = require('../../scripts/align-external-seed-identity-to-catalog-sig.cjs');

function safeReviewedSingleton(overrides = {}) {
  return {
    product_key: 'prod::external_seed::external_seed::ext_safe',
    source_product_id: 'ext_safe',
    source_listing_ref: 'external_seed:ext_safe',
    title: 'Pressed Powder Highlighter',
    seed_title: 'Pressed Powder Highlighter',
    brand: 'Sigma Beauty',
    canonical_url: 'https://sigmabeauty.com/products/highlighter',
    seed_canonical_url: 'https://sigmabeauty.com/products/highlighter',
    destination_url: 'https://sigmabeauty.com/products/highlighter',
    catalog_sig_id: 'sig_8d8adae5417ce1b3055dee15a62e5a5d',
    catalog_sig_url: 'https://agent.pivota.cc/products/sig_8d8adae5417ce1b3055dee15a62e5a5d',
    content_key: 'ck_safe',
    product_group_id: 'pg_safe',
    is_primary: true,
    identity_sig_id: 'sig_oldidentity000000000000000000',
    product_line_id: 'pl_safe',
    review_family_id: 'rf_safe',
    identity_status: 'review_required',
    live_read_enabled: false,
    review_required: true,
    review_reason_codes: ['multi_variant_exact_item_unresolved', 'insufficient_exact_item_evidence'],
    source_tier: 'brand',
    official_url: 'https://sigmabeauty.com/products/highlighter?variant=123',
    matched_by_rule: 'singleton_source_ref',
    variant_axes: { multi_variant: true },
    seed_data: { snapshot: {} },
    ...overrides,
  };
}

function safeOfficialUrlExactConflict(overrides = {}) {
  return safeReviewedSingleton({
    source_product_id: 'ext_conflict',
    source_listing_ref: 'external_seed:ext_conflict',
    title: 'PixiPerfume Eau de Parfum - PixiFig',
    seed_title: 'PixiPerfume Eau de Parfum - PixiFig',
    brand: 'PIXI BEAUTY',
    canonical_url: 'https://pixibeauty.com/products/pixiperfume-eau-de-parfum-pixifig',
    seed_canonical_url: 'https://pixibeauty.com/products/pixiperfume-eau-de-parfum-pixifig',
    destination_url: 'https://pixibeauty.com/products/pixiperfume-eau-de-parfum-pixifig',
    official_url: 'https://pixibeauty.com/products/pixiperfume-eau-de-parfum-pixifig?variant=456',
    review_reason_codes: ['conflicting_official_url'],
    matched_by_rule: 'manual_reviewed_default_title_axis_cleanup',
    variant_axes: { multi_variant: false },
    seed_data: { snapshot: {} },
    ...overrides,
  });
}

function safeOfficialReviewedSet(overrides = {}) {
  return safeReviewedSingleton({
    source_product_id: 'ext_set',
    source_listing_ref: 'external_seed:ext_set',
    title: 'WH | Perfume Bundle Retail Display',
    seed_title: 'WH | Perfume Bundle Retail Display',
    brand: 'Miss Nella',
    canonical_url: 'https://www.missnella.com/products/perfume-retail-display',
    seed_canonical_url: 'https://www.missnella.com/products/perfume-retail-display',
    destination_url: 'https://www.missnella.com/products/perfume-retail-display',
    official_url: 'https://www.missnella.com/products/perfume-retail-display',
    review_reason_codes: [],
    matched_by_rule: 'official_url_route',
    variant_axes: { pack: 'display', multi_variant: false },
    product_sync_status: 'live',
    price_amount: 119.8,
    availability: 'in_stock',
    seed_data: {
      bundle_component_refs: [
        { external_product_id: 'ext_cool', title: 'Cool like me', review_state: 'reviewed' },
        { external_product_id: 'ext_sweet', title: 'Sweet like me', review_state: 'reviewed' },
      ],
      snapshot: {},
    },
    components: [
      {
        external_product_id: 'ext_cool',
        ref_title: 'Cool like me',
        review_state: 'reviewed',
        seed_title: 'WH | Cool Like Me Roll On Perfume',
        status: 'active',
        canonical_url: 'https://www.missnella.com/products/cool-like-me-roll-on-oil-perfume',
        price_amount: 5.99,
        max_list_price: 5.99,
        availability: 'in_stock',
        sync_status: 'live',
      },
      {
        external_product_id: 'ext_sweet',
        ref_title: 'Sweet like me',
        review_state: 'reviewed',
        seed_title: 'WH | Sweet Like Me Roll On Perfume',
        status: 'active',
        canonical_url: 'https://www.missnella.com/products/sweet-like-me-roll-on-oil-perfume',
        price_amount: 10.3,
        max_list_price: 10.3,
        availability: 'in_stock',
        sync_status: 'live',
      },
    ],
    ...overrides,
  });
}

describe('align-external-seed-identity-to-catalog-sig reviewed singleton guard', () => {
  test('keeps review-required rows blocked by default', () => {
    const [plan] = buildPlans([safeReviewedSingleton()]);

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toEqual(['identity_review_required']);
  });

  test('allows a reviewed brand product-line singleton when all guards pass', () => {
    const [plan] = buildPlans([safeReviewedSingleton()], {
      allowReviewedProductLineSingletons: true,
    });

    expect(plan.action).toBe('align_ready');
    expect(plan.needs_update).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.reviewed_product_line_singleton.eligible).toBe(true);
  });

  test('blocks source identity drift where official URL no longer matches canonical', () => {
    const [plan] = buildPlans(
      [
        safeReviewedSingleton({
          official_url: 'https://sigmabeauty.com/products/the-little-mermaid-highlighter',
        }),
      ],
      { allowReviewedProductLineSingletons: true },
    );

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toContain('reviewed_product_line_singleton_official_url_mismatch');
  });

  test('blocks terminal-hold rows even when product-line singleton evidence matches', () => {
    const [plan] = buildPlans(
      [
        safeReviewedSingleton({
          seed_data: {
            snapshot: {
              transaction_readiness_blocker_v1: {
                status: 'terminal_hold',
              },
            },
          },
        }),
      ],
      { allowReviewedProductLineSingletons: true },
    );

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toContain('reviewed_product_line_singleton_terminal_hold_present');
  });

  test('allows exact official-url conflict cleanup behind an explicit flag', () => {
    const [plan] = buildPlans([safeOfficialUrlExactConflict()], {
      allowOfficialUrlExactConflictCleanup: true,
    });

    expect(plan.action).toBe('align_ready');
    expect(plan.needs_update).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.reviewed_official_url_exact_conflict_cleanup.eligible).toBe(true);
  });

  test('keeps exact official-url conflict cleanup blocked by default', () => {
    const [plan] = buildPlans([safeOfficialUrlExactConflict()]);

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toEqual(['identity_review_required']);
  });

  test('blocks exact official-url conflict cleanup when extra review reasons are present', () => {
    const [plan] = buildPlans(
      [
        safeOfficialUrlExactConflict({
          review_reason_codes: ['conflicting_official_url', 'ambiguous_variant_axis'],
        }),
      ],
      { allowOfficialUrlExactConflictCleanup: true },
    );

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toContain(
      'reviewed_official_url_exact_conflict_cleanup_unsupported_review_reason_codes',
    );
  });

  test('blocks exact official-url conflict cleanup when the official URL drifts', () => {
    const [plan] = buildPlans(
      [
        safeOfficialUrlExactConflict({
          official_url: 'https://pixibeauty.com/products/pixiperfume-eau-de-parfum-pixirose',
        }),
      ],
      { allowOfficialUrlExactConflictCleanup: true },
    );

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toContain('reviewed_official_url_exact_conflict_cleanup_official_url_mismatch');
  });

  test('allows an official reviewed set when component refs are reviewed and price-sane', () => {
    const [plan] = buildPlans([safeOfficialReviewedSet()], {
      allowOfficialReviewedSetComponentRefs: true,
    });

    expect(plan.action).toBe('align_ready');
    expect(plan.needs_update).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.official_reviewed_set_component_ref.eligible).toBe(true);
  });

  test('blocks official reviewed set alignment when a component price is an outlier', () => {
    const [plan] = buildPlans(
      [
        safeOfficialReviewedSet({
          price_amount: 5.95,
          components: [
            {
              external_product_id: 'ext_lip',
              ref_title: 'Lip Gloss',
              review_state: 'reviewed',
              seed_title: 'WH | Pink Secret Lip Gloss',
              status: 'active',
              canonical_url: 'https://www.missnella.com/products/pink-secret-lip-gloss-pack-of-6',
              price_amount: 3.3,
              max_list_price: 3.3,
              availability: 'in_stock',
              sync_status: 'live',
            },
            {
              external_product_id: 'ext_nail',
              ref_title: 'Nail Polish',
              review_state: 'reviewed',
              seed_title: 'WH | Sparkles Nail Polish and Accessories Bundle',
              status: 'active',
              canonical_url: 'https://www.missnella.com/products/christmas-sparkles-nail-polish-and-accessories-bundle',
              price_amount: 155,
              max_list_price: 155,
              availability: 'in_stock',
              sync_status: 'live',
            },
          ],
        }),
      ],
      { allowOfficialReviewedSetComponentRefs: true },
    );

    expect(plan.action).toBe('hold');
    expect(plan.blockers).toContain('official_reviewed_set_component_ref_component_price_outlier');
    expect(plan.blockers).toContain('official_reviewed_set_component_ref_component_total_price_outlier');
  });
});
