const {
  buildSeedStats,
  buildExtractorStats,
  getSeedUnderfillFlags,
  classifyCatalogRecovery,
  buildClassification,
  buildCandidateRowsSql,
  summarizeResults,
} = require('../../scripts/audit-external-seed-pdp-underfill-against-catalog');

describe('audit-external-seed-pdp-underfill-against-catalog', () => {
  test('classifies stale seeds when catalog extraction has richer PDP signals', () => {
    const seedStats = buildSeedStats({
      image_url: 'https://cdn.example.com/thumb.jpg',
      seed_data: {
        pdp_description_raw: 'Short description.',
        snapshot: {
          image_urls: ['https://cdn.example.com/thumb.jpg'],
        },
      },
    });
    const extractorStats = buildExtractorStats({
      image_urls: [
        'https://cdn.example.com/thumb.jpg',
        'https://cdn.example.com/detail-1.jpg',
        'https://cdn.example.com/detail-2.jpg',
      ],
      description_raw:
        'This is a longer product story with enough product-specific PDP content to carry overview, benefits, shade, SPF, and finish details for the canonical product page.',
      details_sections: [{ heading: 'Benefits', content: 'Lightweight tint.' }],
      how_to_use_raw: 'Shake well before use.',
      faq_items: [{ question: 'Is it matte?', answer: 'Natural finish.' }],
    });

    const underfillFlags = getSeedUnderfillFlags(seedStats);
    const recoveryFlags = classifyCatalogRecovery(seedStats, extractorStats);

    expect(underfillFlags).toEqual([
      'image_underfilled',
      'short_description',
      'no_details_sections',
      'no_how_to_use',
      'no_faq_items',
    ]);
    expect(recoveryFlags).toEqual([
      'image_gallery_recoverable',
      'details_sections_recoverable',
      'how_to_use_recoverable',
      'faq_recoverable',
    ]);
    expect(buildClassification({ seedUnderfillFlags: underfillFlags, recoveryFlags })).toBe(
      'stale_seed_backfill_recoverable',
    );
  });

  test('uses extractor issue classification when underfilled seeds cannot be recovered', () => {
    const seedUnderfillFlags = ['short_description', 'no_details_sections'];
    expect(
      buildClassification({
        seedUnderfillFlags,
        recoveryFlags: [],
        extractorError: null,
      }),
    ).toBe('extractor_underfilled_or_source_missing');
  });

  test('builds a product-PDP scoped SQL query without selecting non-existent description columns', () => {
    const { sql, params } = buildCandidateRowsSql({
      market: 'US',
      domain: 'beautyofjoseon.com',
      limit: 10,
      offset: 0,
      imageUnderfillMax: 1,
      shortDescriptionChars: 220,
    });

    expect(sql).toContain('FROM external_product_seeds');
    expect(sql).toContain('target_url ~*');
    expect(sql).not.toMatch(/\bdescription\b\s*,/);
    expect(params).toContain('US');
    expect(params).toContain('beautyofjoseon.com');
  });

  test('summarizes recoverable rows for batch backfill input', () => {
    const summary = summarizeResults([
      {
        classification: 'stale_seed_backfill_recoverable',
        domain: 'beautyofjoseon.com',
        external_product_id: 'ext_1',
        seed_underfill_flags: ['image_underfilled'],
        recovery_flags: ['image_gallery_recoverable'],
      },
      {
        classification: 'stale_seed_backfill_recoverable',
        domain: 'beautyofjoseon.com',
        external_product_id: 'ext_1',
        seed_underfill_flags: ['short_description'],
        recovery_flags: ['description_recoverable'],
      },
    ]);

    expect(summary.recoverable_external_product_ids).toEqual(['ext_1']);
    expect(summary.top_recoverable_domains).toEqual([{ domain: 'beautyofjoseon.com', count: 2 }]);
    expect(summary.by_recovery_flag).toEqual({
      image_gallery_recoverable: 1,
      description_recoverable: 1,
    });
  });
});
