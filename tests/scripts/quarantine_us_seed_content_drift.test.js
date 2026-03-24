const {
  DEFAULT_ANOMALIES,
  pickMatchingFindings,
  buildQuarantinePayload,
  summarize,
} = require('../../scripts/quarantine_us_seed_content_drift.cjs');

describe('quarantine_us_seed_content_drift', () => {
  test('defaults target language and locale drift findings', () => {
    expect(DEFAULT_ANOMALIES).toEqual([
      'locale_market_mismatch',
      'non_english_description_for_us_seed',
      'fr_content_in_us_seed',
      'es_content_in_us_seed',
    ]);
  });

  test('pickMatchingFindings filters by anomaly type', () => {
    const findings = [
      { anomaly_type: 'fr_content_in_us_seed' },
      { anomaly_type: 'generic_template_description' },
    ];
    expect(pickMatchingFindings(findings, DEFAULT_ANOMALIES)).toEqual([{ anomaly_type: 'fr_content_in_us_seed' }]);
  });

  test('buildQuarantinePayload and summarize capture matched rows', () => {
    const findings = [
      {
        anomaly_type: 'es_content_in_us_seed',
        severity: 'review',
        evidence: { detected_language: 'es' },
        recommended_action: 'refresh',
        last_extracted_at: '2026-03-24T00:00:00.000Z',
      },
    ];
    const payload = buildQuarantinePayload(
      { canonical_url: 'https://patyka.com/en-us/products/example' },
      findings,
    );
    expect(payload.reason).toBe('content_market_drift');
    expect(payload.anomaly_types).toEqual(['es_content_in_us_seed']);

    const summary = summarize(
      [
        {
          domain: 'patyka.com',
          matching_findings: findings,
          apply_status: 'quarantined',
        },
        {
          domain: 'olehenriksen.com',
          matching_findings: [],
          apply_status: 'skipped',
        },
      ],
      { dryRun: false },
    );

    expect(summary.quarantined).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.by_anomaly_type.es_content_in_us_seed).toBe(1);
  });
});
