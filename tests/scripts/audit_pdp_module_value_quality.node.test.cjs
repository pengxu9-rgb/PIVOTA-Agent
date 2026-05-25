'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeRow,
  collectIngredientApplicability,
} = require('../../scripts/audit-pdp-module-value-quality.cjs');

function row(overrides = {}) {
  return {
    product_key: 'prod::external_seed::external_seed::ext_tool',
    pivota_signature_id: 'sig_tool',
    external_product_id: 'ext_tool',
    title: 'Porcelain Gwalsa (Gua Sha)',
    brand: 'Beauty of Joseon',
    domain: 'beautyofjoseon.com',
    market: 'US',
    category_path: 'beauty/skincare/tools/gua-sha',
    canonical_url: 'https://beautyofjoseon.com/products/porcelain-gwalsa-guasha',
    seed_data: {
      variants: [{ title: 'One piece', option1: 'One piece' }],
      image_urls: ['https://cdn.shopify.com/s/files/1/tool.jpg'],
      how_to_use: 'Clean with soap and warm water after use, then air dry.',
      snapshot: {},
    },
    product_payload: {},
    review_count: 0,
    review_possible_key_count: 0,
    qna_count: 0,
    ...overrides,
  };
}

test('reviewed not-applicable INCI is not audited as missing source-backed ingredients', () => {
  const audited = analyzeRow(
    row({
      seed_data: {
        variants: [{ title: 'One piece', option1: 'One piece' }],
        image_urls: ['https://cdn.shopify.com/s/files/1/tool.jpg'],
        how_to_use: 'Clean with soap and warm water after use, then air dry.',
        ingredient_intel: {
          not_applicable: true,
          inci_applicability: {
            status: 'not_applicable',
            reason: 'product_family_accessory',
          },
        },
        ingredient_remediation_v1: {
          action: 'mark_inci_not_applicable',
          source_quality_status: 'reviewed_not_applicable',
        },
        snapshot: {},
      },
    }),
  );

  assert.equal(audited.module_status.ingredient_applicability_status, 'reviewed_not_applicable');
  assert.equal(
    audited.issues.some((issue) => issue.reason_code === 'ingredients_missing_source_backed_inci'),
    false,
  );
});

test('missing INCI still remains actionable for formula-like products', () => {
  const audited = analyzeRow(
    row({
      title: 'Glow Serum',
      category_path: 'beauty/skincare/treat/serum',
      seed_data: {
        variants: [{ title: '30 mL', option1: '30 mL' }],
        image_urls: ['https://cdn.shopify.com/s/files/1/serum.jpg'],
        how_to_use: 'Apply two to three drops after toner.',
        snapshot: {},
      },
    }),
  );

  assert.equal(
    audited.issues.some((issue) => issue.reason_code === 'ingredients_missing_source_backed_inci'),
    true,
  );
});

test('collectIngredientApplicability reads reviewed_not_applicable quality summary', () => {
  const applicability = collectIngredientApplicability(
    {
      pdp_field_quality_summary: {
        ingredients_inci: {
          source_quality_status: 'reviewed_not_applicable',
          reason_codes: ['product_family_accessory'],
        },
      },
    },
    {},
    {},
  );

  assert.equal(applicability.status, 'reviewed_not_applicable');
  assert.equal(applicability.evidence[0].source, 'pdp_field_quality_summary');
});
