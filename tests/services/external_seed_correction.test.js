jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../src/services/externalSeedImageOverrides', () => ({
  lookupExternalSeedImageOverride: jest.fn(() => ({
    image_url: 'https://cdn.example.com/manual.jpg',
    image_urls: ['https://cdn.example.com/manual.jpg', 'https://cdn.example.com/manual-2.jpg'],
    source: 'test_override',
  })),
}));

jest.mock('../../scripts/backfill-external-product-seeds-catalog', () => ({
  pickSeedTargetUrl: jest.fn((row) => row.canonical_url || row.destination_url || ''),
  normalizeTargetUrlForMarket: jest.fn((url, market) => {
    if (market === 'US') return String(url || '').replace('/de-de/', '/en-us/');
    return String(url || '');
  }),
  recoverTargetUrlFromDiagnostics: jest.fn((row) => row.seed_data?.snapshot?.diagnostics?.requested_url || ''),
  processRow: jest.fn(async (row) => ({ status: 'updated', row: { id: row.id } })),
  fetchRows: jest.fn(),
}));

const {
  SEED_CORRECTION_TYPE,
  applySeedCorrectionAction,
  buildSeedCorrectionPlan,
  runSeedCorrectionCycle,
} = require('../../src/services/externalSeedCorrection');
const { query } = require('../../src/db');
const { processRow } = require('../../scripts/backfill-external-product-seeds-catalog');

describe('externalSeedCorrection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds deterministic correction plan for locale drift, template copy, and missing images', () => {
    const row = {
      id: 'eps_1',
      market: 'US',
      domain: 'patyka.com',
      canonical_url: 'https://patyka.com/de-de/creme-lift-eclat-fermete',
      title: 'Crème Lift-Éclat Fermeté',
      seed_data: {
        snapshot: {
          canonical_url: 'https://patyka.com/de-de/creme-lift-eclat-fermete',
          description: 'Experience the ultimate luxury with Crème Lift-Éclat Fermeté.',
          diagnostics: {
            requested_url: 'https://patyka.com/en-us/creme-lift-eclat-fermete',
          },
          variants: [
            {
              sku: 'PAT-1',
              variant_id: 'PAT-1',
              currency: 'EUR',
              price: '54.00',
            },
          ],
        },
      },
    };

    const plan = buildSeedCorrectionPlan(row);
    const correctionTypes = plan.actions.map((action) => action.correction_type);

    expect(plan.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'locale_market_mismatch' }),
        expect.objectContaining({ anomaly_type: 'generic_template_description' }),
        expect.objectContaining({ anomaly_type: 'zero_images' }),
      ]),
    );
    expect(correctionTypes).toEqual(
      expect.arrayContaining([
        SEED_CORRECTION_TYPE.normalizeLocaleByMarket,
        SEED_CORRECTION_TYPE.clearGenericTemplateDescription,
        SEED_CORRECTION_TYPE.applyManualImageOverride,
        SEED_CORRECTION_TYPE.rerunCatalogExtraction,
      ]),
    );
  });

  test('reruns extraction when beauty minor-unit pricing is suspected', () => {
    const row = {
      id: 'eps_fenty_minor_unit',
      market: 'US',
      domain: 'fentybeauty.com',
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
            },
          ],
        },
      },
    };

    const plan = buildSeedCorrectionPlan(row);

    expect(plan.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'beauty_minor_unit_price_suspected' }),
      ]),
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correction_type: SEED_CORRECTION_TYPE.rerunCatalogExtraction }),
        expect.objectContaining({ correction_type: SEED_CORRECTION_TYPE.normalizeBeautyMinorUnitPrice }),
      ]),
    );
  });

  test('detects sunscreen SPF minor-unit pricing for correction', () => {
    const row = {
      id: 'eps_olehenriksen_sunscreen_minor_unit',
      market: 'US',
      domain: 'olehenriksen.com',
      canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-31',
      title: 'Banana Bright Mineral Sunscreen SPF 30 - EU',
      price_amount: 2963,
      price_currency: 'USD',
      seed_data: {
        snapshot: {
          canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-31',
          description: 'A mineral SPF 30 sunscreen.',
          variants: [
            {
              sku: '50915',
              variant_id: '42385365991596',
              currency: 'USD',
              price: '2963.00',
            },
          ],
        },
      },
    };

    const plan = buildSeedCorrectionPlan(row);

    expect(plan.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anomaly_type: 'beauty_minor_unit_price_suspected',
          evidence: expect.objectContaining({ suspected_major_unit_amount: 29.63 }),
        }),
      ]),
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correction_type: SEED_CORRECTION_TYPE.normalizeBeautyMinorUnitPrice }),
      ]),
    );
  });

  test('normalizes polluted variant axes without rerunning extraction', async () => {
    const row = {
      id: 'eps_fenty_color_us',
      market: 'US',
      domain: 'fentybeauty.com',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-refill',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill',
      seed_data: {
        category: 'Skincare',
        variants: [
          {
            variant_id: 'v1',
            title: 'US',
            option_name: 'Color',
            option_value: 'US',
            image_url: 'https://example.com/refill-us.jpg',
          },
        ],
        snapshot: {
          variants: [
            {
              variant_id: 'v1',
              title: 'US',
              option_name: 'Color',
              option_value: 'US',
              image_url: 'https://example.com/refill-us.jpg',
            },
          ],
        },
      },
    };

    const plan = buildSeedCorrectionPlan(row);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract,
        }),
      ]),
    );

    const result = await applySeedCorrectionAction(
      row,
      { correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract },
      { dryRun: true },
    );

    expect(processRow).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.row.seed_data.snapshot.variants[0]).toEqual(
      expect.objectContaining({
        title: 'Default',
        options: [],
        source_quality_status: 'blocked',
      }),
    );
    expect(result.row.seed_data.snapshot.variants[0].option_name).toBeUndefined();
    expect(result.row.seed_data.snapshot.variants[0].option_value).toBeUndefined();
    expect(result.row.seed_data.variants[0]).toEqual(
      expect.objectContaining({
        title: 'Default',
        options: [],
        source_quality_status: 'blocked',
      }),
    );
    expect(result.row.seed_data.variants[0].option_name).toBeUndefined();
    expect(result.row.seed_data.variants[0].option_value).toBeUndefined();
  });

  test('dry-run rerun extraction previews the refreshed price without persisting', async () => {
    const row = {
      id: 'eps_fenty_minor_unit',
      market: 'US',
      domain: 'fentybeauty.com',
      canonical_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
      destination_url: 'https://fentybeauty.com/products/deep-moisture-repair-the-maintenance-crew-full-size-bundle',
      title: 'Deep Moisture Repair The Maintenance Crew Full-Size Bundle',
      price_amount: 12100,
      price_currency: 'USD',
      availability: 'in_stock',
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
            },
          ],
        },
      },
    };

    processRow.mockResolvedValueOnce({
      status: 'dry_run',
      row,
      payload: {
        nextRow: {
          title: row.title,
          canonical_url: row.canonical_url,
          destination_url: row.destination_url,
          image_url: '',
          price_amount: 113,
          price_currency: 'USD',
          availability: 'in_stock',
          seed_data: {
            snapshot: {
              canonical_url: row.canonical_url,
              description:
                'Unlock endless styles with The Maintenance Crew. Essentials repair and nourish hair, now with our deep conditioner for extra hydration.',
              variants: [
                {
                  sku: 'KFH10000005',
                  variant_id: 'KFH10000005',
                  currency: 'USD',
                  price: '113.00',
                },
              ],
            },
          },
        },
      },
    });

    const result = await applySeedCorrectionAction(
      row,
      { correction_type: SEED_CORRECTION_TYPE.rerunCatalogExtraction },
      { dryRun: true, baseUrl: 'https://catalog.example.com' },
    );

    expect(processRow).toHaveBeenCalledWith(
      row,
      expect.objectContaining({
        baseUrl: 'https://catalog.example.com',
        dryRun: true,
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.row.price_amount).toBe(113);
    expect(result.row.seed_data.snapshot.variants[0].price).toBe('113.00');
  });

  test('can restrict correction cycle to variant contract cleanup only', async () => {
    const row = {
      id: 'eps_variant_only',
      market: 'US',
      domain: 'fentybeauty.com',
      canonical_url: 'https://fentybeauty.com/products/hydra-vizor-refill',
      title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill',
      seed_data: {
        category: 'Skincare',
        snapshot: {
          variants: [
            {
              variant_id: 'v1',
              title: 'US',
              option_name: 'Color',
              option_value: 'US',
              image_url: 'https://example.com/refill-us.jpg',
            },
          ],
        },
      },
    };

    const result = await runSeedCorrectionCycle(row, {
      dryRun: true,
      correctionTypes: [SEED_CORRECTION_TYPE.normalizeVariantDisplayContract],
    });

    expect(processRow).not.toHaveBeenCalled();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual(
      expect.objectContaining({
        correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract,
        dry_run: true,
      }),
    );
    expect(result.row.seed_data.snapshot.variants[0].option_name).toBeUndefined();
  });

  test('flags generic variant axis names for contract normalization', () => {
    const row = {
      id: 'eps_generic_variant_axis',
      market: 'US',
      domain: 'www.guerlain.com',
      canonical_url: 'https://www.guerlain.com/products/kisskiss-bee-glow',
      title: 'KISSKISS BEE GLOW honey tint balm',
      seed_data: {
        snapshot: {
          variants: [
            {
              variant_id: 'v1',
              option_name: 'Variant',
              option_value: '458 POP ROSE GLOW',
              image_url: 'https://example.com/pop-rose.jpg',
            },
          ],
        },
      },
    };

    expect(buildSeedCorrectionPlan(row).actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract,
        }),
      ]),
    );
  });

  test('normalizes polluted image gallery contracts without rerunning extraction', async () => {
    const productImage =
      'https://cdn.shopify.com/s/files/1/0662/4598/4498/files/KJC_WLM_23_5ml_Stylized.jpg?v=1712005037';
    const row = {
      id: 'eps_kylie_gallery_pollution',
      market: 'US',
      domain: 'kyliecosmetics.com',
      canonical_url: 'https://kyliecosmetics.com/products/mini-wisp-lash-kylie-jenner-mascara',
      title: 'Mini Wisp Lash Mascara',
      image_url: productImage,
      seed_data: {
        image_urls: [
          productImage,
          'https://kyliecosmetics.com/%22%22',
          'https://kyliecosmetics.com/cdn/shop/files/v1_cosmetics_lips_nav_5e2c0efa.jpg?v=1740598507',
        ],
        snapshot: {
          image_urls: [
            productImage,
            'https://kyliecosmetics.com/%22%22',
            'https://kyliecosmetics.com/cdn/shop/files/v1_cosmetics_lips_nav_5e2c0efa.jpg?v=1740598507',
          ],
        },
      },
    };

    const plan = buildSeedCorrectionPlan(row);
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correction_type: SEED_CORRECTION_TYPE.normalizeImageGalleryContract,
        }),
      ]),
    );

    const result = await applySeedCorrectionAction(
      row,
      { correction_type: SEED_CORRECTION_TYPE.normalizeImageGalleryContract },
      { dryRun: true },
    );

    expect(processRow).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
    expect(result.row.image_url).toBe(productImage);
    expect(result.row.seed_data.image_urls).toEqual([productImage]);
    expect(result.row.seed_data.snapshot.image_urls).toEqual([productImage]);
    expect(result.row.seed_data.snapshot.image_gallery_contract_v1).toEqual(
      expect.objectContaining({
        contract_version: 'external_seed.image_gallery_contract.v1',
        review_state: 'assistant_reviewed',
        image_count: 1,
      }),
    );
  });

  test('prefers clean primary variant images when top-level strict gallery cleanup is ambiguous', async () => {
    const variantPrimary =
      'https://cdn.shopify.com/s/files/1/0662/4598/4498/files/KJC_WLM_23_5ml_Stylized.jpg?v=1712005037';
    const variantSecondary =
      'https://kyliecosmetics.com/cdn/shop/files/KJC_WLM_23_5ml_Stylized.jpg?crop=center&v=1712005037';
    const unrelatedTopLevel =
      'https://kyliecosmetics.com/cdn/shop/files/KJC_HOLIDAY_24_Mini_Lip_Kit_Kylie_02_CP_354_Hero_WS.jpg?v=1727108210';
    const row = {
      id: 'eps_kylie_ambiguous_gallery_pollution',
      market: 'US',
      domain: 'kyliecosmetics.com',
      canonical_url: 'https://kyliecosmetics.com/products/mini-wisp-lash-kylie-jenner-mascara',
      title: 'Mini Wisp Lash Mascara',
      seed_data: {
        image_urls: [
          variantPrimary,
          'https://kyliecosmetics.com/%22%22',
          unrelatedTopLevel,
        ],
        snapshot: {
          image_urls: [
            variantPrimary,
            'https://kyliecosmetics.com/%22%22',
            unrelatedTopLevel,
          ],
          variants: [
            {
              variant_id: '45167939322098',
              option_name: 'Size',
              option_value: '5 mL',
              image_url: variantPrimary,
              image_urls: [variantPrimary, variantSecondary],
            },
          ],
        },
      },
    };

    const result = await applySeedCorrectionAction(
      row,
      { correction_type: SEED_CORRECTION_TYPE.normalizeImageGalleryContract },
      { dryRun: true },
    );

    expect(result.changed).toBe(true);
    expect(result.row.seed_data.image_urls).toEqual([variantPrimary, variantSecondary]);
    expect(result.row.seed_data.snapshot.image_urls).toEqual([variantPrimary, variantSecondary]);
  });

  test('strips NUL bytes before persisting corrected seed JSON', async () => {
    query.mockResolvedValue({ rows: [] });
    const row = {
      id: 'eps_nul_variant',
      market: 'US',
      domain: 'example.com',
      canonical_url: 'https://example.com/products/a',
      title: 'NUL test',
      seed_data: {
        snapshot: {
          variants: [
            {
              variant_id: 'v1',
              option_name: 'Title',
              option_value: 'Default Title',
              description: 'before\u0000after',
            },
          ],
        },
      },
    };

    await applySeedCorrectionAction(
      row,
      { correction_type: SEED_CORRECTION_TYPE.normalizeVariantDisplayContract },
      { skipIngredientEnrichment: true },
    );

    const updateCall = query.mock.calls.find((call) => String(call[0]).includes('UPDATE external_product_seeds'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][8]).not.toContain('\u0000');
    expect(updateCall[1][8]).not.toContain('\\u0000');
  });

  test('runSeedCorrectionCycle clears beauty minor-unit blocker after dry-run preview', async () => {
    const row = {
      id: 'eps_cocokind_minor_unit',
      market: 'US',
      domain: 'www.cocokind.com',
      canonical_url: 'https://www.cocokind.com/products/ceramide-barrier-serum',
      destination_url: 'https://www.cocokind.com/products/ceramide-barrier-serum',
      title: 'Ceramide Barrier Serum',
      price_amount: 2200,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          canonical_url: 'https://www.cocokind.com/products/ceramide-barrier-serum',
          description: 'A skin barrier serum for daily moisture support.',
          variants: [
            {
              sku: 'CK-2200',
              variant_id: 'CK-2200',
              currency: 'USD',
              price: '22.00',
            },
          ],
        },
      },
    };

    processRow.mockResolvedValueOnce({
      status: 'dry_run',
      row,
      payload: {
        nextRow: {
          title: row.title,
          canonical_url: row.canonical_url,
          destination_url: row.destination_url,
          image_url: '',
          price_amount: 22,
          price_currency: 'USD',
          availability: 'in_stock',
          seed_data: {
            snapshot: {
              canonical_url: row.canonical_url,
              description: 'A skin barrier serum for daily moisture support.',
              variants: [
                {
                  sku: 'CK-2200',
                  variant_id: 'CK-2200',
                  currency: 'USD',
                  price: '22.00',
                },
              ],
            },
          },
        },
      },
    });

    const result = await runSeedCorrectionCycle(row, {
      dryRun: true,
      baseUrl: 'https://catalog.example.com',
    });

    expect(result.initialAudit.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anomaly_type: 'beauty_minor_unit_price_suspected' }),
      ]),
    );
    expect(result.finalAudit.findings).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ anomaly_type: 'beauty_minor_unit_price_suspected' }),
      ]),
    );
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correction_type: SEED_CORRECTION_TYPE.rerunCatalogExtraction,
          dry_run: true,
        }),
      ]),
    );
  });

  test('runSeedCorrectionCycle normalizes cents-style pricing when rerun extraction still returns minor units', async () => {
    const row = {
      id: 'eps_nuxe_minor_unit',
      market: 'US',
      domain: 'us.nuxe.com',
      canonical_url: 'https://us.nuxe.com/products/reve-de-miel-duo-cleansing-gel-body-cream',
      destination_url: 'https://us.nuxe.com/products/reve-de-miel-duo-cleansing-gel-body-cream',
      title: 'Reve De Miel Duo Cleansing Gel + Body Cream',
      price_amount: 5000,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        snapshot: {
          canonical_url: 'https://us.nuxe.com/products/reve-de-miel-duo-cleansing-gel-body-cream',
          description: 'A body care duo bundle.',
          variants: [
            {
              sku: 'NUXE-DUO',
              variant_id: 'NUXE-DUO',
              currency: 'USD',
              price: '5000',
            },
          ],
        },
      },
    };

    processRow.mockResolvedValueOnce({
      status: 'dry_run',
      row,
      payload: {
        nextRow: {
          title: row.title,
          canonical_url: row.canonical_url,
          destination_url: row.destination_url,
          image_url: '',
          price_amount: 5000,
          price_currency: 'USD',
          availability: 'in_stock',
          seed_data: {
            snapshot: {
              canonical_url: row.canonical_url,
              description: 'A body care duo bundle.',
              variants: [
                {
                  sku: 'NUXE-DUO',
                  variant_id: 'NUXE-DUO',
                  currency: 'USD',
                  price: '5000',
                },
              ],
            },
          },
        },
      },
    });

    const result = await runSeedCorrectionCycle(row, {
      dryRun: true,
      baseUrl: 'https://catalog.example.com',
    });

    expect(result.finalAudit.findings).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ anomaly_type: 'beauty_minor_unit_price_suspected' }),
      ]),
    );
    expect(result.row.price_amount).toBe(50);
    expect(result.row.seed_data.snapshot.variants[0].price).toBe('50.00');
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          correction_type: SEED_CORRECTION_TYPE.normalizeBeautyMinorUnitPrice,
          dry_run: true,
        }),
      ]),
    );
  });
});
