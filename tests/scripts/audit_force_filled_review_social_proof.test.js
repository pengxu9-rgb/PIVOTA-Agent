jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    classifyAuditedRow,
    isSourceBackedReviewSummary,
    isSyntheticReviewSummary,
    summarizeRows,
  },
} = require('../../scripts/audit-force-filled-review-social-proof.cjs');

describe('audit-force-filled-review-social-proof', () => {
  test('detects force-filled review summaries as public synthetic social proof', () => {
    expect(
      isSyntheticReviewSummary({
        source: 'pivota_force_fill_v1',
        status: 'estimated',
        force_filled: true,
        rating: 4.7,
        review_count: 28,
      }),
    ).toBe(true);
  });

  test('treats official merchant provider summaries as source-backed', () => {
    expect(
      isSourceBackedReviewSummary({
        source_origin: 'official_yotpo_reviews_api',
        source_kind: 'yotpo_reviews_api',
        rating: 4.397572,
        review_count: 1318,
        preview_items: [{ review_id: 'yotpo_1', rating: 5 }],
      }),
    ).toBe(true);
  });

  test('classifies nested stale catalog and identity fallback paths for repair', () => {
    const result = classifyAuditedRow({
      id: 'seed_1',
      external_product_id: 'ext_1',
      market: 'US',
      domain: 'fentybeauty.com',
      title: 'Gloss Bomb Heat',
      canonical_url: 'https://fentybeauty.com/products/gloss-bomb-heat',
      seed_data: {
        review_summary: {
          source_origin: 'official_yotpo_reviews_api',
          source_kind: 'yotpo_reviews_api',
          rating: 4.4,
          review_count: 1318,
        },
        snapshot: {},
      },
      catalog_rows: [
        {
          product_key: 'pk_1',
          pivota_signature_id: 'sig_123',
          product_payload: {
            seed_data: {
              pdp_review_summary: {
                source: 'pivota_force_fill_v1',
                force_filled: true,
                rating: 4.7,
                review_count: 28,
              },
            },
          },
        },
      ],
      identity_rows: [
        {
          source_listing_ref: 'external_seed:ext_1',
          review_summary: {
            source_origin: 'official_yotpo_reviews_api',
            source_kind: 'yotpo_reviews_api',
            rating: 4.4,
            review_count: 1318,
          },
          source_payload: {
            seed_data: {
              snapshot: {
                pdp_review_summary: {
                  status: 'estimated',
                  rating: 4.7,
                  review_count: 28,
                },
              },
            },
          },
        },
      ],
    });

    expect(result.has_synthetic_public_social_proof).toBe(true);
    expect(result.has_source_backed_review_summary).toBe(true);
    expect(result.recommended_action).toBe('sync_existing_source_backed_review_summary_to_serving_paths');
    expect(result.synthetic_public_paths.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        'catalog_products[pk_1].product_payload.seed_data.pdp_review_summary',
        'pdp_identity_listing[external_seed:ext_1].source_payload.seed_data.snapshot.pdp_review_summary',
      ]),
    );
    expect(result.pivota_signature_ids).toEqual(['sig_123']);
  });

  test('summarizes backfill candidates separately from existing source-backed syncs', () => {
    const rows = [
      {
        domain: 'brand-a.com',
        has_synthetic_public_social_proof: true,
        has_source_backed_review_summary: false,
        recommended_action: 'run_official_html_review_summary_backfill_dry_run',
        synthetic_public_paths: [{ path: 'external_product_seeds.seed_data.review_summary' }],
      },
      {
        domain: 'brand-b.com',
        has_synthetic_public_social_proof: true,
        has_source_backed_review_summary: true,
        recommended_action: 'sync_existing_source_backed_review_summary_to_serving_paths',
        synthetic_public_paths: [{ path: 'catalog_products[pk].product_payload.seed_data.pdp_review_summary' }],
      },
    ];

    expect(summarizeRows(rows)).toEqual(
      expect.objectContaining({
        scanned: 2,
        with_synthetic_public_social_proof: 2,
        backfill_dry_run_candidates: 1,
        sync_existing_source_backed_candidates: 1,
      }),
    );
  });
});
