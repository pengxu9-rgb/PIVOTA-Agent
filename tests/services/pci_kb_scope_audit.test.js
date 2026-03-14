const { classifyKbRows, extractSeedIdFromSkuKey, toCsv } = require('../../scripts/audit-pci-kb-scope');

describe('pci kb scope audit', () => {
  test('extracts seed id from sku keys', () => {
    expect(extractSeedIdFromSkuKey('extseed:eps_123:sku_1')).toBe('eps_123');
    expect(extractSeedIdFromSkuKey('')).toBe('');
    expect(extractSeedIdFromSkuKey('not-a-seed')).toBe('');
  });

  test('classifies kb rows into allow, review, block, and missing seed buckets', () => {
    const kbRows = [
      {
        sku_key: 'extseed:eps_serum:41609',
        brand: 'Ole Henriksen',
        product_name: 'Banana Bright Vitamin C Serum - 30ml',
      },
      {
        sku_key: 'extseed:eps_blush:PIXI-CASSIS',
        brand: 'Pixi Beauty',
        product_name: 'On-the-Glow Blush - Cassis',
      },
      {
        sku_key: 'extseed:eps_missing:ghost',
        brand: 'Ghost',
        product_name: 'Ghost Product',
      },
      {
        sku_key: 'extseed:eps_unmatched:custom',
        brand: 'Custom',
        product_name: 'Custom Product',
      },
    ];

    const seedRows = [
      {
        id: 'eps_serum',
        market: 'US',
        canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
        title: 'Banana Bright Vitamin C Serum',
        seed_data: {
          brand: 'Ole Henriksen',
          snapshot: {
            category: 'Skincare',
            canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
            title: 'Banana Bright Vitamin C Serum',
            variants: [
              {
                sku: '41609',
                variant_id: '41609',
                option_value: '30ml',
                url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
              },
            ],
          },
        },
      },
      {
        id: 'eps_blush',
        market: 'US',
        canonical_url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
        title: 'On-the-Glow Blush',
        seed_data: {
          brand: 'Pixi Beauty',
          snapshot: {
            canonical_url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
            title: 'On-the-Glow Blush',
            variants: [
              {
                sku: 'PIXI-CASSIS',
                variant_id: 'PIXI-CASSIS',
                option_value: 'Cassis',
                url: 'https://www.pixibeauty.com/products/on-the-glow-blush',
              },
            ],
          },
        },
      },
      {
        id: 'eps_unmatched',
        market: 'US',
        canonical_url: 'https://example.com/products/custom-product',
        title: 'Custom Product',
        seed_data: {
          brand: 'Custom',
          snapshot: {
            canonical_url: 'https://example.com/products/custom-product',
            title: 'Custom Product',
            variants: [],
          },
        },
      },
    ];

    const result = classifyKbRows(kbRows, seedRows);
    expect(result.counts).toEqual({
      allow: 1,
      review: 1,
      block: 1,
      missing_seed: 1,
    });
    expect(result.scopedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku_key: 'extseed:eps_serum:41609',
          scope_decision: 'allow',
        }),
        expect.objectContaining({
          sku_key: 'extseed:eps_blush:PIXI-CASSIS',
          scope_decision: 'block',
          scope_reason: 'non_skincare_product_class',
        }),
        expect.objectContaining({
          sku_key: 'extseed:eps_unmatched:custom',
          scope_decision: 'review',
          scope_reason: 'missing_explicit_skincare_signals',
        }),
        expect.objectContaining({
          sku_key: 'extseed:eps_missing:ghost',
          scope_decision: 'missing_seed',
        }),
      ]),
    );
  });

  test('renders csv rows with stable headers', () => {
    const csv = toCsv([
      {
        sku_key: 'extseed:eps_serum:41609',
        external_seed_id: 'eps_serum',
        brand: 'Ole Henriksen',
        product_name: 'Banana Bright Vitamin C Serum - 30ml',
        scope_decision: 'allow',
        scope_reason: 'skincare_signals_present',
        candidate_found: true,
        source_ref: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum?variant=41609',
        canonical_url: 'https://olehenriksen.com/products/banana-bright-vitamin-c-serum',
        market: 'US',
      },
    ]);
    expect(csv).toContain('sku_key,external_seed_id,brand,product_name,scope_decision');
    expect(csv).toContain('extseed:eps_serum:41609');
  });
});
