'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeRow,
  collectIngredientApplicability,
  collectIngredientComponentRefs,
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

test('component-linked sets are not audited as missing source-backed ingredients', () => {
  const audited = analyzeRow(
    row({
      title: 'Perfect Hanbang Palette',
      category_path: 'beauty/skincare/serum',
      seed_data: {
        product_family: 'set_or_collection',
        variants: [{ title: '4 serums', options: [{ name: 'Pack', value: '4 serums', axis_kind: 'pack' }] }],
        image_urls: ['https://cdn.shopify.com/s/files/1/set.jpg'],
        bundle_component_refs: [
          {
            external_product_id: 'ext_glow_serum',
            title: 'Glow Serum',
            review_state: 'reviewed',
            inheritance_scope: ['ingredients_inci', 'how_to_use'],
          },
        ],
        ingredient_intel: {
          source_review_queue: {
            status: 'component_refs_linked',
          },
        },
        ingredient_remediation_v1: {
          action: 'component_refs_linked',
        },
        snapshot: {},
      },
    }),
  );

  assert.equal(audited.module_status.ingredient_component_refs_status, 'component_refs_linked');
  assert.equal(audited.module_status.ingredient_component_refs_count, 1);
  assert.equal(
    audited.issues.some((issue) => issue.reason_code === 'ingredients_missing_source_backed_inci'),
    false,
  );
});

test('collectIngredientComponentRefs requires reviewed linked marker', () => {
  assert.equal(
    collectIngredientComponentRefs(
      {
        bundle_component_refs: [{ external_product_id: 'ext_component', title: 'Component' }],
        snapshot: {},
      },
      {},
      {},
    ),
    null,
  );

  const linked = collectIngredientComponentRefs(
    {
      bundle_component_refs: [{ external_product_id: 'ext_component', title: 'Component' }],
      ingredient_remediation_v1: { action: 'component_refs_linked' },
      snapshot: {},
    },
    {},
    {},
  );
  assert.equal(linked.status, 'component_refs_linked');
  assert.equal(linked.count, 1);
});

test('many source-backed shade variant images do not trigger gallery excessive by themselves', () => {
  const shadeVariants = Array.from({ length: 18 }, (_, index) => ({
    label: `Shade ${index + 1}`,
    image_url: `https://cdn.shopify.com/s/files/1/shade-${index + 1}.jpg`,
  }));
  const audited = analyzeRow(
    row({
      title: 'Daily Tinted Fluid Sunscreen',
      category_path: 'beauty/makeup/face/tinted-sunscreen',
      seed_data: {
        variants: shadeVariants,
        image_urls: [
          'https://cdn.shopify.com/s/files/1/product-1.jpg',
          'https://cdn.shopify.com/s/files/1/product-2.jpg',
        ],
        pdp_ingredients_raw: 'Water, Zinc Oxide, Glycerin, Iron Oxides, Tocopherol',
        how_to_use: 'Shake well before use and apply evenly as the final daytime skincare step.',
        snapshot: {},
      },
    }),
  );

  assert.equal(audited.module_status.root_image_count, 2);
  assert.equal(audited.module_status.variant_image_count, 18);
  assert.equal(
    audited.issues.some((issue) => issue.reason_code === 'gallery_excessive_image_count'),
    false,
  );
});

test('excessive root gallery remains actionable even when variant images are separate', () => {
  const audited = analyzeRow(
    row({
      title: 'Glow Serum',
      category_path: 'beauty/skincare/treat/serum',
      seed_data: {
        variants: [{ label: '30 mL', image_url: 'https://cdn.shopify.com/s/files/1/variant.jpg' }],
        image_urls: Array.from({ length: 17 }, (_, index) => `https://cdn.shopify.com/s/files/1/root-${index + 1}.jpg`),
        pdp_ingredients_raw: 'Water, Glycerin, Propolis Extract, Niacinamide, Sodium Hyaluronate',
        how_to_use: 'Apply two to three drops after toner and before moisturizer.',
        snapshot: {},
      },
    }),
  );

  const issue = audited.issues.find((item) => item.reason_code === 'gallery_excessive_image_count');
  assert.ok(issue);
  assert.equal(issue.evidence.count, 17);
  assert.equal(issue.evidence.variant_image_count, 1);
});

test('source-backed shade makeup root gallery over generic threshold is not excessive without suspicious roots', () => {
  const audited = analyzeRow(
    row({
      title: 'Airy Bloom Mesh Blush',
      category_path: 'beauty/makeup/face/blush',
      seed_data: {
        variants: [{ label: 'Rose Pink', image_url: 'https://cdn.shopify.com/s/files/1/rose-pink.jpg' }],
        image_urls: Array.from({ length: 20 }, (_, index) => `https://cdn.shopify.com/s/files/1/blush-shade-${index + 1}.jpg`),
        pdp_ingredients_raw: 'Water, Dimethicone, Mica, Titanium Dioxide, Iron Oxides',
        how_to_use: 'Tap onto cheeks and blend outward with fingertips or a brush.',
        snapshot: {},
      },
    }),
  );

  assert.equal(audited.module_status.root_image_count, 20);
  assert.equal(
    audited.issues.some((issue) => issue.reason_code === 'gallery_excessive_image_count'),
    false,
  );
});

test('shade makeup root gallery with global banner assets remains actionable', () => {
  const audited = analyzeRow(
    row({
      title: 'Airy Bloom Mesh Blush',
      category_path: 'beauty/makeup/face/blush',
      seed_data: {
        variants: [{ label: 'Rose Pink', image_url: 'https://cdn.shopify.com/s/files/1/rose-pink.jpg' }],
        image_urls: [
          ...Array.from({ length: 20 }, (_, index) => `https://cdn.shopify.com/s/files/1/blush-shade-${index + 1}.jpg`),
          'https://tirtir.global/cdn/shop/files/black.png?v=1',
        ],
        pdp_ingredients_raw: 'Water, Dimethicone, Mica, Titanium Dioxide, Iron Oxides',
        how_to_use: 'Tap onto cheeks and blend outward with fingertips or a brush.',
        snapshot: {},
      },
    }),
  );

  const issue = audited.issues.find((item) => item.reason_code === 'gallery_excessive_image_count');
  assert.ok(issue);
  assert.equal(issue.evidence.suspicious_root_count, 1);
});
