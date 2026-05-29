jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    buildQuarantinedReviewSummary,
    buildRowPatch,
    quarantineReviewPaths,
    shouldQuarantineReviewSummary,
    summarizeResults,
  },
} = require('../../scripts/quarantine-synthetic-review-summaries.cjs');

describe('quarantine-synthetic-review-summaries', () => {
  test('quarantines only public synthetic summaries', () => {
    expect(
      shouldQuarantineReviewSummary({
        source: 'pivota_force_fill_v1',
        force_filled: true,
        rating: 4.7,
        review_count: 28,
      }),
    ).toBe(true);
    expect(
      shouldQuarantineReviewSummary({
        source: 'pivota_review_quarantine_v1',
        status: 'quarantined',
        rating: 0,
        review_count: 0,
      }),
    ).toBe(false);
  });

  test('quarantine replacement removes public rating and count while preserving audit summary', () => {
    expect(
      buildQuarantinedReviewSummary(
        {
          source: 'pivota_force_fill_v1',
          status: 'estimated',
          force_filled: true,
          rating: 4.7,
          review_count: 28,
        },
        '2026-05-29T00:00:00.000Z',
      ),
    ).toEqual(
      expect.objectContaining({
        source: 'pivota_review_quarantine_v1',
        status: 'quarantined',
        rating: 0,
        review_count: 0,
        public_visible: false,
        quarantined_at: '2026-05-29T00:00:00.000Z',
        previous_force_filled_estimate: expect.objectContaining({
          rating: 4.7,
          review_count: 28,
          source: 'pivota_force_fill_v1',
        }),
      }),
    );
  });

  test('patches nested seed, catalog, and identity review paths', () => {
    const stale = {
      source: 'pivota_force_fill_v1',
      force_filled: true,
      rating: 4.7,
      review_count: 28,
    };
    const patched = buildRowPatch(
      {
        external_product_id: 'ext_1',
        seed_data: {
          review_summary: stale,
          snapshot: {
            pdp_review_summary: stale,
          },
        },
        catalog_rows: [
          {
            product_key: 'pk_1',
            product_payload: {
              pdp_review_summary: stale,
              seed_data: {
                snapshot: {
                  pdp_review_summary: stale,
                  title: 'Keep me.',
                },
              },
            },
          },
        ],
        identity_rows: [
          {
            source_listing_ref: 'external_seed:ext_1',
            review_summary: stale,
            source_payload: {
              seed_data: {
                review_summary: stale,
              },
            },
          },
        ],
      },
      '2026-05-29T00:00:00.000Z',
    );

    expect(patched.seedPaths).toEqual([
      'external_product_seeds.seed_data.review_summary',
      'external_product_seeds.seed_data.snapshot.pdp_review_summary',
    ]);
    expect(patched.seedData.review_summary.review_count).toBe(0);
    expect(patched.catalogRows[0].patched_paths).toEqual([
      'catalog_products[pk_1].product_payload.pdp_review_summary',
      'catalog_products[pk_1].product_payload.seed_data.snapshot.pdp_review_summary',
    ]);
    expect(patched.catalogRows[0].product_payload.seed_data.snapshot.title).toBe('Keep me.');
    expect(patched.identityRows[0].patched_paths).toEqual([
      'pdp_identity_listing[external_seed:ext_1].review_summary',
      'pdp_identity_listing[external_seed:ext_1].source_payload.seed_data.review_summary',
    ]);
  });

  test('quarantineReviewPaths leaves source-backed summaries untouched', () => {
    const summary = {
      source_origin: 'official_yotpo_reviews_api',
      rating: 4.4,
      review_count: 1318,
    };
    const result = quarantineReviewPaths({ review_summary: summary }, [['review_summary']], '2026-05-29T00:00:00.000Z');
    expect(result.patchedPaths).toEqual([]);
    expect(result.next.review_summary).toEqual(summary);
  });

  test('summarizes quarantine results', () => {
    expect(
      summarizeResults([
        { status: 'dry_run', patched_path_count: 2 },
        { status: 'skipped', patched_path_count: 0 },
      ]),
    ).toEqual(
      expect.objectContaining({
        scanned: 2,
        dry_run: 1,
        skipped: 1,
        patched_paths: 2,
      }),
    );
  });
});
