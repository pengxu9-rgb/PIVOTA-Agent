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
  buildSeedCorrectionPlan,
} = require('../../src/services/externalSeedCorrection');

describe('externalSeedCorrection', () => {
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
      ]),
    );
  });
});
