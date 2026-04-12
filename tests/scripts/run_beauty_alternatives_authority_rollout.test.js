const {
  parseBrandSpecs,
  collectAppliedSeedIds,
  summarizeSeedScopedAuditResults,
} = require('../../scripts/run_beauty_alternatives_authority_rollout.cjs');

describe('run_beauty_alternatives_authority_rollout', () => {
  test('parseBrandSpecs accepts preferred titles and fallback domains', () => {
    expect(
      parseBrandSpecs([
        'La Roche-Posay|https://www.laroche-posay.us/pdp|Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen|https://www.ulta.com/p/lrp-aox;https://www.walmart.com/ip/lrp-aox',
      ]),
    ).toEqual([
      {
        brand: 'La Roche-Posay',
        domain: 'https://www.laroche-posay.us/pdp',
        preferredTitles: ['Anthelios AOX Antioxidant Serum with SPF 50 Sunscreen'],
        fallbackDomains: [
          'https://www.ulta.com/p/lrp-aox',
          'https://www.walmart.com/ip/lrp-aox',
        ],
        key: 'la-roche-posay',
      },
    ]);
  });

  test('collectAppliedSeedIds keeps only inserted or existing rows', () => {
    expect(
      collectAppliedSeedIds({
        apply_result: {
          items: [
            { seed_id: 'eps_a', status: 'inserted' },
            { seed_id: 'eps_b', status: 'skipped_existing' },
            { seed_id: 'eps_c', status: 'invalid' },
            { seed_id: 'eps_a', status: 'inserted' },
          ],
        },
      }),
    ).toEqual(['eps_a', 'eps_b']);
  });

  test('summarizes content and live-pdp seed-scoped audit batches', () => {
    expect(
      summarizeSeedScopedAuditResults([
        {
          seed_id: 'eps_lrp',
          result: {
            summary: {
              findings_total: 2,
            },
          },
        },
        {
          seed_id: 'eps_ntg',
          result: [
            {
              seed_id: 'eps_ntg',
              failure_reasons: ['missing_similar_results', 'live_pdp_price_mismatch'],
            },
          ],
        },
      ]),
    ).toEqual({
      scanned_seed_count: 2,
      failed_seed_count: 2,
      finding_total: 2,
      failure_reason_counts: {
        missing_similar_results: 1,
        live_pdp_price_mismatch: 1,
      },
    });
  });
});
