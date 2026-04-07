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

  test('does not flag English-dominant PDP copy for sparse ingredient language markers', () => {
    const row = {
      id: 'eps_fenty_sparse_markers',
      domain: 'fentybeauty.com',
      market: 'US',
      canonical_url: 'https://fentybeauty.com/products/cherry-dub-blah-2-bright-5-aha-face-mask',
      title: 'Cherry Dub Blah 2 Bright 5% AHA Face Mask',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/cherry-dub-blah-2-bright-5-aha-face-mask',
          description:
            'DETAILS STRAIGHT UP: Go from blah to bright in minutes for the instant pick-me-up your skin craves. THE LOWDOWN: Unique jelly texture gently exfoliates and smooths skin texture for makeup application. WHAT ELSE: Vegan and cruelty-free formula. Peau, crème, piel and haut appear only in ingredient or locale fragments.',
          variants: [
            {
              sku: 'FEN-AHA-1',
              variant_id: 'FEN-AHA-1',
              currency: 'USD',
              price: '39.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/fenty-mask.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'fr_content_in_us_seed' }),
        expect.objectContaining({ anomaly_type: 'es_content_in_us_seed' }),
        expect.objectContaining({ anomaly_type: 'non_english_description_for_us_seed' }),
      ]),
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

  test('flags implausible cents-style beauty pricing for rerun', () => {
    const row = {
      id: 'eps_fenty_minor_unit',
      domain: 'fentybeauty.com',
      market: 'US',
      canonical_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
      title: 'Deep Moisture Repair The Maintenance Crew Full-Size Bundle',
      price_amount: 12100,
      price_currency: 'USD',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
          description:
            'Unlock endless styles with The Maintenance Crew. Essentials repair and nourish hair, now with our deep conditioner for extra hydration.',
          variants: [
            {
              sku: 'KFH10000005',
              variant_id: 'KFH10000005',
              currency: 'USD',
              price: '12100.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/fenty-hair.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomaly_type: 'beauty_minor_unit_price_suspected',
          severity: 'blocker',
          evidence: expect.objectContaining({
            row_price_amount: 12100,
            suspected_major_unit_amount: 121,
          }),
        }),
      ]),
    );
  });

  test('flags synthetic summary description pollution', () => {
    const row = {
      id: 'eps_rare_summary',
      domain: 'rarebeauty.com',
      market: 'US',
      canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
      seed_data: {
        seed_description_origin: 'synthetic_summary',
        snapshot: {
          canonical_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          description: 'OFFICIAL: Lightweight tint. /// SOCIAL HIGHLIGHTS: Viral SPF with dewy finish.',
          variants: [
            {
              sku: 'RARE-SPF-1',
              variant_id: 'RARE-SPF-1',
              currency: 'USD',
              price: '32.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/rare.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomaly_type: 'seed_description_pollution',
          severity: 'review',
          evidence: expect.objectContaining({ seed_description_origin: 'synthetic_summary' }),
        }),
      ]),
    );
  });

  test('does not flag intentional gift card shared SKU variants', () => {
    const row = {
      id: 'eps_gift_card_shared_sku',
      domain: 'theordinary.com',
      market: 'US',
      canonical_url: 'https://theordinary.com/en-us/gift-card-100570.html',
      title: 'Digital Gift Card',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/gift-card-100570.html',
          description: 'A digital gift card for use on future purchases.',
          variants: [
            {
              sku: 'GIFT-CARD',
              variant_id: 'GIFT-25',
              currency: 'USD',
              price: '25.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/gift-card.jpg',
            },
            {
              sku: 'GIFT-CARD',
              variant_id: 'GIFT-50',
              currency: 'USD',
              price: '50.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/gift-card.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'gift_card_duplicate_sku' })]),
    );
  });

  test('still flags shared SKU variants for normal sellable products', () => {
    const row = {
      id: 'eps_duplicate_sku_product',
      domain: 'examplebeauty.com',
      market: 'US',
      canonical_url: 'https://examplebeauty.com/products/glow-serum',
      title: 'Glow Serum',
      seed_data: {
        snapshot: {
          canonical_url: 'https://examplebeauty.com/products/glow-serum',
          description: 'A brightening serum for daily skin care.',
          variants: [
            {
              sku: 'GLOW-SERUM',
              variant_id: 'GLOW-30',
              currency: 'USD',
              price: '30.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/glow-serum.jpg',
            },
            {
              sku: 'GLOW-SERUM',
              variant_id: 'GLOW-50',
              currency: 'USD',
              price: '50.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/glow-serum.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomaly_type: 'gift_card_duplicate_sku',
          severity: 'info',
        }),
      ]),
    );
  });

  test('does not flag product PDP gift card paths as non-product fallback pages', () => {
    const row = {
      id: 'eps_fenty_egift_card',
      domain: 'fentybeauty.com',
      market: 'US',
      canonical_url: 'https://fentybeauty.com/products/egift-cards',
      title: 'Fenty Beauty E-Gift Cards',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/egift-cards',
          description:
            'Details Fenty Beauty E-Gift Cards can be ordered online and sent to a recipient of your choice. Fenty Beauty reserves the right to change these terms and conditions from time to time in its discretion.',
          variants: [
            {
              sku: 'FEN-GIFT-25',
              variant_id: 'FEN-GIFT-25',
              currency: 'USD',
              price: '25.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/fenty-gift-card.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'non_product_fallback_page' })]),
    );
  });

  test('does not flag product PDP donation bundles for footer-style support copy', () => {
    const row = {
      id: 'eps_fenty_clf_bundle',
      domain: 'fentybeauty.com',
      market: 'US',
      canonical_url: 'https://fentybeauty.com/products/clf-bundle',
      title: 'CLF Bundle',
      seed_data: {
        snapshot: {
          canonical_url: 'https://fentybeauty.com/products/clf-bundle',
          description:
            'DETAILS GIVE BACK WITH FENTY FAVES. 35% of every purchase is donated to the Clara Lionel Foundation. For questions, including the amount donated to CLF for this quarterly period, contact customer service@fentybeauty.com. Fenty Beauty reserves the right to change these terms and conditions from time to time.',
          variants: [
            {
              sku: 'FEN-CLF-1',
              variant_id: 'FEN-CLF-1',
              currency: 'USD',
              price: '67.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/fenty-clf-bundle.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ anomaly_type: 'non_product_fallback_page' })]),
    );
  });

  test('still flags non-product support paths outside product PDP routes', () => {
    const row = {
      id: 'eps_non_product_support_path',
      domain: 'examplebeauty.com',
      market: 'US',
      canonical_url: 'https://examplebeauty.com/contact-us',
      title: 'Contact Us',
      seed_data: {
        snapshot: {
          canonical_url: 'https://examplebeauty.com/contact-us',
          description: 'Contact us for order support and customer service questions.',
          variants: [
            {
              sku: 'SUPPORT-1',
              variant_id: 'SUPPORT-1',
              currency: 'USD',
              price: '0.00',
              stock: 'In Stock',
              image_url: 'https://cdn.example.com/support-page.jpg',
            },
          ],
        },
      },
    };

    const result = auditExternalSeedRow(row);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomaly_type: 'non_product_fallback_page',
          severity: 'blocker',
        }),
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
