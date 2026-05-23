const {
  BLOCKER_VERSION,
  HOLD_VERSION,
  buildContracts,
  patchSeedData,
} = require('../../scripts/mark-external-seed-non-merch-terminal-hold.cjs');

describe('mark-external-seed-non-merch-terminal-hold', () => {
  test('patches seed and snapshot commerce fields without deleting content assets', () => {
    const contracts = buildContracts({
      reason: 'non_merchandise_promo_or_gift_card',
      evidence: 'Title identifies a gift card or surprise gift promotion.',
      sourceUrl: 'https://sigmabeauty.com/products/sigma-beauty-e-gift-card',
      generatedAt: '2026-05-23T00:00:00.000Z',
    });
    const patched = patchSeedData(
      {
        title: 'Sigma Beauty E-Gift Card',
        description: 'Choose an electronic gift card for later redemption.',
        price: 50,
        currency: 'USD',
        image_urls: ['https://cdn.example.com/gift-card.jpg'],
        variants: [
          {
            title: '$50',
            price: 50,
            currency: 'USD',
            in_stock: true,
            available: true,
            inventory_quantity: 3,
          },
        ],
        snapshot: {
          title: 'Sigma Beauty E-Gift Card',
          price_amount: 50,
          price_currency: 'USD',
          offers: [
            {
              price: 50,
              priceCurrency: 'USD',
              in_stock: true,
              available: true,
              inventory_quantity: 2,
            },
          ],
        },
      },
      contracts,
    );

    expect(patched.title).toBe('Sigma Beauty E-Gift Card');
    expect(patched.description).toBe('Choose an electronic gift card for later redemption.');
    expect(patched.image_urls).toEqual(['https://cdn.example.com/gift-card.jpg']);
    expect(patched.product_kind).toBe('non_merch');
    expect(patched.product_family).toBe('non_merch');
    expect(patched.external_seed_product_family).toBe('non_merch');
    expect(patched.transaction_ready).toBe(false);
    expect(patched.availability).toBe('out_of_stock');
    expect(patched.in_stock).toBe(false);
    expect(patched.price).toBeUndefined();
    expect(patched.currency).toBeUndefined();
    expect(patched.variants[0]).toEqual(
      expect.objectContaining({
        product_kind: 'non_merch',
        product_family: 'non_merch',
        transaction_ready: false,
        availability: 'out_of_stock',
        in_stock: false,
        available: false,
        inventory_quantity: 0,
      }),
    );
    expect(patched.variants[0].price).toBeUndefined();
    expect(patched.variants[0].currency).toBeUndefined();

    expect(patched.snapshot.product_family).toBe('non_merch');
    expect(patched.snapshot.price_amount).toBeUndefined();
    expect(patched.snapshot.price_currency).toBeUndefined();
    expect(patched.snapshot.offers[0].price).toBeUndefined();
    expect(patched.snapshot.offers[0].priceCurrency).toBeUndefined();
    expect(patched.snapshot.offers[0].available).toBe(false);
    expect(patched.snapshot.offers[0].inventory_quantity).toBe(0);
    expect(patched.non_merch_terminal_hold_v1.contract_version).toBe(HOLD_VERSION);
    expect(patched.transaction_readiness_blocker_v1.contract_version).toBe(BLOCKER_VERSION);
    expect(patched.snapshot.non_merch_terminal_hold_v1.status).toBe('non_merch_terminal_hold');
    expect(patched.snapshot.transaction_readiness_blocker_v1.transaction_ready).toBe(false);
  });

  test('builds reviewed non-merch hold and transaction blocker contracts', () => {
    const contracts = buildContracts({
      reason: 'surprise_gift_not_merchandisable_product',
      evidence: 'Listing is a surprise gift promotion, not a standalone PDP.',
      sourceUrl: '',
      generatedAt: '2026-05-23T00:00:00.000Z',
    });

    expect(contracts.hold).toEqual(
      expect.objectContaining({
        contract_version: HOLD_VERSION,
        status: 'non_merch_terminal_hold',
        reason: 'surprise_gift_not_merchandisable_product',
        transaction_ready: false,
        review_state: 'reviewed',
      }),
    );
    expect(contracts.blocker).toEqual(
      expect.objectContaining({
        contract_version: BLOCKER_VERSION,
        status: 'non_merch_terminal_hold',
        transaction_ready: false,
      }),
    );
  });
});
