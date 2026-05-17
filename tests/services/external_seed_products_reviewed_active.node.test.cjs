'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');

test('buildExternalSeedProduct lets reviewed active ingredients override explanatory active raw lines', () => {
  const product = buildExternalSeedProduct({
    id: 'eps_detox',
    external_product_id: 'ext_detox',
    domain: 'olehenriksen.com',
    market: 'US',
    title: 'Detox Drops 2% Salicylic Acid Toner',
    canonical_url: 'https://olehenriksen.com/products/detox-drops-2-salicylic-acid-toner-4oz',
    price_amount: 34,
    price_currency: 'USD',
    availability: 'in_stock',
    seed_data: {
      brand: 'OleHenriksen',
      pdp_active_ingredients_raw:
        'SALICYLIC ACID (BHA)\nOTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE',
      active_ingredients: ['Salicylic acid'],
      reviewed_active_ingredients_v1: {
        contract_version: 'external_seed.reviewed_active_ingredients.v1',
        status: 'approved',
      },
      pdp_field_quality_summary: {
        active_ingredients_raw: {
          source_quality_status: 'high',
          source_origin: 'shopify_json',
        },
      },
      snapshot: {
        pdp_active_ingredients_raw:
          'SALICYLIC ACID (BHA)\nOTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE',
        active_ingredients: ['Salicylic acid'],
        reviewed_active_ingredients_v1: {
          contract_version: 'external_seed.reviewed_active_ingredients.v1',
          status: 'approved',
        },
      },
    },
  });

  assert.deepEqual(product.active_ingredients, ['Salicylic acid']);
  assert.equal(product.active_ingredients.includes('OTC-LEVEL, EXFOLIATES SKIN, TARGETS + TREATS ACNE'), false);
  assert.match(product.pdp_active_ingredients_raw, /SALICYLIC ACID/);
});
