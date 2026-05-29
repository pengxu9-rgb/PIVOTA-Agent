jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  closePool: jest.fn(async () => {}),
}));

const {
  _internals: {
    collectSourceBackedReviewCandidates,
    normalizeSourceBackedReviewSummary,
    patchSeedDataReviewSummary,
    patchServingPayloadReviewSummary,
    summarizeResults,
  },
} = require('../../scripts/sync-source-backed-review-summaries-to-serving.cjs');

describe('sync-source-backed-review-summaries-to-serving', () => {
  test('prefers official provider summaries with review preview rows', () => {
    const candidates = collectSourceBackedReviewCandidates({
      seed_data: {
        review_summary: {
          source_origin: 'official_json_ld',
          rating: 4.4,
          review_count: 1300,
        },
      },
      catalog_rows: [
        {
          product_key: 'pk_1',
          product_payload: {
            review_summary: {
              source_origin: 'official_yotpo_reviews_api',
              source_kind: 'yotpo_reviews_api',
              rating: 4.397572,
              review_count: 1318,
              preview_items: [{ review_id: 'yotpo_1', rating: 5 }],
            },
          },
        },
      ],
      identity_rows: [],
    });

    expect(candidates[0].path).toBe('catalog_products[pk_1].product_payload.review_summary');
  });

  test('patches seed and serving payload review paths with the same source-backed summary', () => {
    const realSummary = normalizeSourceBackedReviewSummary({
      source_origin: 'official_yotpo_reviews_api',
      source_kind: 'yotpo_reviews_api',
      rating: 4.397572,
      review_count: 1318,
      status: 'ready',
    });
    const staleSummary = {
      source: 'pivota_force_fill_v1',
      force_filled: true,
      rating: 4.7,
      review_count: 28,
    };

    const seedData = patchSeedDataReviewSummary(
      {
        review_summary: staleSummary,
        snapshot: {
          pdp_review_summary: staleSummary,
          description: 'Keep me.',
        },
      },
      realSummary,
    );
    expect(seedData.review_summary).toEqual(realSummary);
    expect(seedData.pdp_review_summary).toEqual(realSummary);
    expect(seedData.snapshot.review_summary).toEqual(realSummary);
    expect(seedData.snapshot.pdp_review_summary).toEqual(realSummary);
    expect(seedData.snapshot.description).toBe('Keep me.');

    const payload = patchServingPayloadReviewSummary(
      {
        pdp_review_summary: staleSummary,
        seed_data: {
          snapshot: {
            pdp_review_summary: staleSummary,
            image_url: 'https://cdn.example.com/p.jpg',
          },
        },
      },
      realSummary,
    );
    expect(payload.review_summary).toEqual(realSummary);
    expect(payload.pdp_review_summary).toEqual(realSummary);
    expect(payload.seed_data.review_summary).toEqual(realSummary);
    expect(payload.seed_data.snapshot.pdp_review_summary).toEqual(realSummary);
    expect(payload.seed_data.snapshot.image_url).toBe('https://cdn.example.com/p.jpg');
  });

  test('normalizes legacy estimate flags off source-backed summaries', () => {
    expect(
      normalizeSourceBackedReviewSummary({
        source_origin: 'official_yotpo_reviews_api',
        rating: 4.4,
        review_count: 1318,
        force_filled: true,
        distribution_estimated: true,
        status: 'estimated',
      }),
    ).toEqual({
      source_origin: 'official_yotpo_reviews_api',
      rating: 4.4,
      review_count: 1318,
      status: 'ready',
    });
  });

  test('summarizes dry-run and apply results', () => {
    expect(
      summarizeResults([
        { status: 'dry_run', stale_synthetic_catalog_payloads: 2, stale_synthetic_identity_payloads: 1 },
        { status: 'skipped', reason: 'missing_source_backed_review_summary' },
      ]),
    ).toEqual(
      expect.objectContaining({
        scanned: 2,
        dry_run: 1,
        skipped: 1,
        missing_source_backed_review_summary: 1,
        catalog_payloads_with_stale_synthetic_before_sync: 2,
        identity_payloads_with_stale_synthetic_before_sync: 1,
      }),
    );
  });
});
