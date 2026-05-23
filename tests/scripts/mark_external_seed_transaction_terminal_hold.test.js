const {
  BLOCKER_VERSION,
  SOURCE_IDENTITY_DRIFT_VERSION,
  buildContracts,
  patchSeedData,
} = require('../../scripts/mark-external-seed-transaction-terminal-hold.cjs');

describe('mark-external-seed-transaction-terminal-hold', () => {
  test('patches source identity drift holds without changing product family or content', () => {
    const contracts = buildContracts({
      reason: 'official_source_identity_drift',
      evidence: 'Official extractor now returns Mystery Bundle for the old Makeup & Brush Bundle URL.',
      sourceUrl: 'https://sigmabeauty.com/products/makeup-brush-bundle-118-value',
      observedTitle: 'Mystery Bundle ($100+ Value)',
      generatedAt: '2026-05-23T00:00:00.000Z',
    });
    const patched = patchSeedData(
      {
        title: 'Makeup & Brush Bundle ($118 Value)',
        description: 'Original reviewed bundle description.',
        product_family: 'set_or_collection',
        price: 118,
        currency: 'USD',
        image_urls: ['https://cdn.example.com/makeup-brush-bundle.jpg'],
        variants: [
          {
            title: 'Default Title',
            price: 118,
            currency: 'USD',
            in_stock: true,
            available: true,
            inventory_quantity: 5,
          },
        ],
        snapshot: {
          title: 'Makeup & Brush Bundle ($118 Value)',
          product_family: 'set_or_collection',
          price_amount: 118,
          price_currency: 'USD',
          offers: [
            {
              price: 118,
              priceCurrency: 'USD',
              in_stock: true,
              available: true,
            },
          ],
        },
      },
      contracts,
    );

    expect(patched.title).toBe('Makeup & Brush Bundle ($118 Value)');
    expect(patched.description).toBe('Original reviewed bundle description.');
    expect(patched.image_urls).toEqual(['https://cdn.example.com/makeup-brush-bundle.jpg']);
    expect(patched.product_family).toBe('set_or_collection');
    expect(patched.snapshot.product_family).toBe('set_or_collection');
    expect(patched.price).toBeUndefined();
    expect(patched.currency).toBeUndefined();
    expect(patched.transaction_ready).toBe(false);
    expect(patched.availability).toBe('out_of_stock');
    expect(patched.variants[0].price).toBeUndefined();
    expect(patched.variants[0].currency).toBeUndefined();
    expect(patched.variants[0].available).toBe(false);
    expect(patched.variants[0].inventory_quantity).toBe(0);
    expect(patched.snapshot.price_amount).toBeUndefined();
    expect(patched.snapshot.price_currency).toBeUndefined();
    expect(patched.snapshot.offers[0].price).toBeUndefined();
    expect(patched.snapshot.offers[0].priceCurrency).toBeUndefined();
    expect(patched.source_identity_drift_v1.contract_version).toBe(SOURCE_IDENTITY_DRIFT_VERSION);
    expect(patched.source_identity_drift_v1.observed_title).toBe('Mystery Bundle ($100+ Value)');
    expect(patched.transaction_readiness_blocker_v1.contract_version).toBe(BLOCKER_VERSION);
    expect(patched.transaction_readiness_blocker_v1.status).toBe('terminal_hold');
    expect(patched.transaction_readiness_blocker_v1.terminal_hold_kind).toBe('source_identity_drift');
    expect(patched.snapshot.transaction_readiness_blocker_v1.transaction_ready).toBe(false);
  });

  test('builds reviewed terminal hold contracts for source identity drift', () => {
    const contracts = buildContracts({
      reason: 'official_source_identity_drift',
      evidence: 'A direct official-source dry-run returned a different product title.',
      sourceUrl: '',
      observedTitle: 'Mystery Bundle ($100+ Value)',
      generatedAt: '2026-05-23T00:00:00.000Z',
    });

    expect(contracts.drift).toEqual(
      expect.objectContaining({
        contract_version: SOURCE_IDENTITY_DRIFT_VERSION,
        status: 'source_identity_drift',
        reason: 'official_source_identity_drift',
        observed_title: 'Mystery Bundle ($100+ Value)',
        transaction_ready: false,
        review_state: 'reviewed',
      }),
    );
    expect(contracts.blocker).toEqual(
      expect.objectContaining({
        contract_version: BLOCKER_VERSION,
        status: 'terminal_hold',
        terminal_hold_kind: 'source_identity_drift',
        transaction_ready: false,
        review_state: 'reviewed',
      }),
    );
  });
});
