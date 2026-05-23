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
});
