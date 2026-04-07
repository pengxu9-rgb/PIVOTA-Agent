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
