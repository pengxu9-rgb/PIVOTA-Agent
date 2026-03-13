const { auditExternalSeedRow, summarizeAuditResults } = require('../../src/services/externalSeedContentAudit');

describe('externalSeedContentAudit', () => {
  test('flags Patyka-style generic template copy on US seeds', () => {
    const row = {
      id: 'eps_patyka_1',
      domain: 'patyka.com',
      market: 'US',
      canonical_url: 'https://patyka.com/products/creme-lift-eclat-fermete',
      title: 'Crème Lift-Éclat Fermeté',
      seed_data: {
        snapshot: {
          canonical_url: 'https://patyka.com/products/creme-lift-eclat-fermete',
          extracted_at: '2026-03-12T01:00:00.000Z',
          description: 'Experience the ultimate luxury with Crème Lift-Éclat Fermeté.',
          variants: [
            {
              sku: 'PAT-1',
              variant_id: 'PAT-1',
              currency: 'EUR',
              price: '54.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/patyka.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'generic_template_description', severity: 'review' }),
      ]),
    );
  });

  test('flags The Ordinary German description anomaly for US seeds', () => {
    const row = {
      id: 'eps_to_1',
      domain: 'theordinary.com',
      market: 'US',
      canonical_url: 'https://theordinary.com/en-us/100-organic-virgin-chia-seed-face-oil-100395.html',
      title: '100% Organic Virgin Chia Seed Oil',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/100-organic-virgin-chia-seed-face-oil-100395.html',
          description: 'Ein vielseitiges Öl für Haut und Haare.',
          variants: [
            {
              sku: 'TO-1',
              variant_id: 'TO-1',
              currency: 'USD',
              price: '14.90',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/chia.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        anomaly_type: 'non_english_description_for_us_seed',
        severity: 'review',
        evidence: expect.objectContaining({ detected_language: 'de' }),
      }),
    );
  });

  test('does not flag English descriptions as French when only creme terminology appears', () => {
    const row = {
      id: 'eps_fenty_false_positive',
      domain: 'fentybeauty.com',
      market: 'US',
      canonical_url: 'https://fentybeauty.com/products/fenty-parfum-body-creme',
      title: 'Fenty Parfum Body Crème',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/fenty-parfum-body-creme',
          description:
            'Make a lasting impression wherever you go with this rich body crème and travel fragrance set in an unforgettable, warm floral scent.',
          variants: [
            {
              sku: 'FEN-1',
              variant_id: 'FEN-1',
              currency: 'USD',
              price: '48.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/fenty.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'fr_content_in_us_seed' })]),
    );
  });

  test('flags locale drift, currency mismatch, zero image, zero variant, and manual override presence', () => {
    const row = {
      id: 'eps_mixed_1',
      domain: 'example.com',
      market: 'US',
      canonical_url: 'https://example.com/de-de/product-x.html',
      price_currency: 'USD',
      seed_data: {
        snapshot: {
          canonical_url: 'https://example.com/de-de/product-x.html',
          diagnostics: {
            manual_image_override: {
              applied: true,
              source: 'manual_seed_override',
            },
          },
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'locale_market_mismatch', severity: 'blocker' }),
        expect.objectContaining({ anomaly_type: 'zero_images', severity: 'review' }),
        expect.objectContaining({ anomaly_type: 'zero_variants', severity: 'blocker' }),
        expect.objectContaining({ anomaly_type: 'manual_image_override_present', severity: 'review' }),
      ]),
    );
  });

  test('does not flag same-language locale variants like en-eu for US seeds', () => {
    const row = {
      id: 'eps_locale_compatible',
      domain: 'patyka.com',
      market: 'US',
      canonical_url: 'https://patyka.com/en-eu/products/detox-cleansing-foam',
      seed_data: {
        snapshot: {
          canonical_url: 'https://patyka.com/en-eu/products/detox-cleansing-foam',
          description: 'A lightweight cleansing foam that removes impurities and pollution particles.',
          variants: [
            {
              sku: 'PAT-EN-1',
              variant_id: 'PAT-EN-1',
              currency: 'EUR',
              price: '15.90',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/patyka-en.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'locale_market_mismatch' })]),
    );
  });

  test('summarizes findings by severity and anomaly type', () => {
    const results = [
      {
        findings: [
          { anomaly_type: 'generic_template_description', severity: 'review', domain: 'patyka.com' },
          { anomaly_type: 'fr_content_in_us_seed', severity: 'review', domain: 'patyka.com' },
        ],
      },
      {
        findings: [
          { anomaly_type: 'non_english_description_for_us_seed', severity: 'review', domain: 'theordinary.com' },
        ],
      },
    ];

    expect(summarizeAuditResults(results)).toEqual(
      expect.objectContaining({
        scanned: 2,
        flagged_rows: 2,
        findings_total: 3,
        by_severity: expect.objectContaining({ blocker: 0, review: 3, info: 0 }),
        by_anomaly_type: expect.objectContaining({
          generic_template_description: 1,
          fr_content_in_us_seed: 1,
          non_english_description_for_us_seed: 1,
        }),
      }),
    );
  });
});
