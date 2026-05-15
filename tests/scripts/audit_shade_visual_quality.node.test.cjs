const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyVisualEvidence,
  collectShadeRowsFromPayload,
  deriveKnownSourceShadeSwatchUrl,
  likelyProductOnlyImageUrl,
  likelyShadeSwatchImageUrl,
} = require('../../scripts/audit-shade-visual-quality.cjs');

test('classifies explicit shade visual fields without accepting product photos', () => {
  assert.equal(likelyShadeSwatchImageUrl('https://example.com/assets/crimson-swatch.png'), true);
  assert.equal(likelyProductOnlyImageUrl('https://example.com/assets/crimson-product-ecomm-silo.jpg'), true);
  assert.equal(
    likelyProductOnlyImageUrl(
      'https://cdn.shopify.com/files/FB_FALL25_T2PRODUCT_ECOMM_BODY-LAVA_HMC_1200X1500_72DPI.jpg',
    ),
    true,
  );
  assert.equal(
    likelyProductOnlyImageUrl(
      'https://cdn.shopify.com/files/FB789050_T2BEAUTY_MODEL_GLOBAL_KILLAWATT_PPAGE_WATTABRAT.jpg',
    ),
    true,
  );

  assert.equal(
    classifyVisualEvidence({ shade_hex: '#bb785f' }, {}, 'W023').visual_status,
    'real_swatch_or_hex',
  );
  assert.equal(
    classifyVisualEvidence(
      { swatch_image_url: 'https://example.com/assets/crimson-swatch.png' },
      {},
      'Crimson',
    ).display_mode,
    'image_swatch',
  );

  const blocked = classifyVisualEvidence(
    { label_image_url: 'https://example.com/assets/crimson-product-ecomm-silo.jpg' },
    {},
    'Crimson',
  );
  assert.equal(blocked.visual_status, 'blocked_product_image_source');
  assert.equal(blocked.display_mode, 'text_chip');

  assert.equal(
    classifyVisualEvidence(
      {
        swatch_image_url:
          'https://cdn.shopify.com/files/FB_FALL25_T2PRODUCT_ECOMM_BODY-LAVA_HMC_1200X1500_72DPI.jpg',
      },
      {},
      'How Many Carats?!',
    ).visual_status,
    'blocked_product_image_source',
  );
});

test('derives only known source-backed RMS shade swatches', () => {
  assert.equal(
    deriveKnownSourceShadeSwatchUrl('W023', {
      brand: { name: 'RMS Beauty' },
      url: 'https://www.rmsbeauty.com/products/revitalize-hydra-concealer',
    }),
    'https://www.rmsbeauty.com/cdn/shop/files/w023_100x.png',
  );
  assert.equal(
    deriveKnownSourceShadeSwatchUrl('Guava', {
      brand: { name: 'Olehenriksen' },
      url: 'https://olehenriksen.com/products/example',
    }),
    '',
  );
});

test('collects variant and product-line shade rows with strict visual classifications', () => {
  const rows = collectShadeRowsFromPayload({
    productId: 'sig_test',
    merchantId: 'external_seed',
    sourceQuery: 'foundation',
    pdpPayload: {
      product: {
        title: 'Strict Shade Product',
        brand: { name: 'Test Beauty' },
        variants: [
          {
            variant_id: 'v1',
            title: 'Crimson',
            options: [{ name: 'Shade', value: 'Crimson' }],
            swatch_image_url: 'https://example.com/assets/crimson-swatch.png',
            image_url: 'https://example.com/assets/crimson-product-ecomm-silo.jpg',
          },
          {
            variant_id: 'v2',
            title: 'Guava',
            options: [{ name: 'Shade', value: 'Guava' }],
            image_url: 'https://example.com/assets/guava-product-ecomm-silo.jpg',
          },
        ],
        product_line_options: [
          {
            option_id: 'line-1',
            axis: 'shade',
            label: 'DN310',
            swatch_color: '#c6beb5',
          },
        ],
      },
    },
  });

  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.shade_name === 'Crimson').visual_status, 'real_swatch_or_hex');
  assert.equal(rows.find((row) => row.shade_name === 'Guava').visual_status, 'blocked_product_image_source');
  assert.equal(rows.find((row) => row.shade_name === 'DN310').display_mode, 'hex_swatch');
});
