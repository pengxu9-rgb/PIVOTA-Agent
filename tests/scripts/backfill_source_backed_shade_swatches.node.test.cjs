const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applySwatchPatch,
  applyVisualPatch,
  findSourceBackedSwatchUrl,
  findSourceBackedShadeHex,
  isTrustedSourceBackedShadeTextureUrl,
  normalizeHexColor,
  urlMatchesShade,
} = require('../../scripts/backfill-source-backed-shade-swatches.cjs');

test('accepts source-backed per-shade texture smears', () => {
  const url =
    'https://cdn.shopify.com/s/files/1/0341/3458/9485/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01_1200X1500_72DPI.png?v=1690914315';

  assert.equal(urlMatchesShade(url, '1'), true);
  assert.equal(isTrustedSourceBackedShadeTextureUrl(url, '1'), true);
});

test('rejects product, model, and group swatch assets as shade chip backfill', () => {
  assert.equal(
    isTrustedSourceBackedShadeTextureUrl(
      'https://cdn.shopify.com/files/FB_F23_T2PRODUCT_CONCRETE_EAZEDROPSTICK_SHADE_01_1200x1500.jpg',
      '1',
    ),
    false,
  );
  assert.equal(
    isTrustedSourceBackedShadeTextureUrl(
      'https://cdn.shopify.com/files/FB845752GLOBAL_GB-OG_GIMME-SPACE_PPAGEASSETS_1200x1500_Model_Smear_YUKI.jpg',
      'Gimme Space',
    ),
    false,
  );
  assert.equal(
    isTrustedSourceBackedShadeTextureUrl(
      'https://kyliecosmetics.com/cdn/shop/products/KJC_LL_21_Arm_Swatch_WS_ShadeNames.jpg',
      'coconut',
    ),
    false,
  );
  assert.equal(
    isTrustedSourceBackedShadeTextureUrl(
      'https://cdn.shopify.com/files/FB816865GLOBAL_GLOSSBOMBOIL_INFOGRAPHICS_1200x1500_2Model_Smear_FENTYGLOW_2.jpg',
      'fenty glow',
    ),
    false,
  );
  assert.equal(
    isTrustedSourceBackedShadeTextureUrl(
      'https://cdn.shopify.com/files/FS689758_GLOBAL_FALL_24_INFOGRAPHICS_2000x2000_FENTY_TREATZ_Product_w_Smear_BLACK_CHERRY.jpg',
      'black cherry',
    ),
    false,
  );
});

test('finds a source-backed swatch only from matching seed image URLs', () => {
  const seedData = {
    image_urls: [
      'https://cdn.shopify.com/files/FB_F23_T2PRODUCT_CONCRETE_EAZEDROPSTICK_SHADE_01_1200x1500.jpg',
      'https://cdn.shopify.com/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01_1200X1500_72DPI.png',
    ],
    snapshot: {
      variants: [
        {
          title: '1',
          options: [{ name: 'Shade', value: '1' }],
        },
      ],
    },
  };

  assert.equal(
    findSourceBackedSwatchUrl(seedData, ['1']),
    'https://cdn.shopify.com/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01_1200X1500_72DPI.png',
  );
});

test('patches top-level and matching single-variant swatch fields without replacing product images', () => {
  const seedData = {
    image_url: 'https://cdn.shopify.com/files/product.jpg',
    image_urls: ['https://cdn.shopify.com/files/product.jpg'],
    variants: [
      {
        variant_id: 'v1',
        title: '1',
        options: [{ name: 'Shade', value: '1' }],
        image_url: 'https://cdn.shopify.com/files/product.jpg',
      },
    ],
    snapshot: {
      image_url: 'https://cdn.shopify.com/files/product.jpg',
      variants: [
        {
          variant_id: 'v1',
          title: '1',
          options: [{ name: 'Shade', value: '1' }],
          image_url: 'https://cdn.shopify.com/files/product.jpg',
        },
      ],
    },
  };

  const swatchUrl = 'https://cdn.shopify.com/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01.png';
  const patched = applySwatchPatch(seedData, swatchUrl, ['1'], '2026-05-16T00:00:00.000Z');

  assert.equal(patched.image_url, 'https://cdn.shopify.com/files/product.jpg');
  assert.equal(patched.swatch_image_url, swatchUrl);
  assert.equal(patched.variants[0].image_url, 'https://cdn.shopify.com/files/product.jpg');
  assert.equal(patched.variants[0].swatch_image_url, swatchUrl);
  assert.equal(patched.snapshot.variants[0].label_image_url, swatchUrl);
  assert.equal(patched.snapshot.diagnostics.shade_swatch_backfill.applied, true);
});

test('accepts only explicit source-backed hex values and patches matching variants', () => {
  assert.equal(normalizeHexColor('#D9C4AD'), '#d9c4ad');
  assert.equal(normalizeHexColor('warm nude'), '');

  const seedData = {
    variants: [
      {
        variant_id: 'v1',
        title: 'DN350',
        options: [{ name: 'Shade', value: 'DN350' }],
        swatch: { hex: '#D9C4AD' },
      },
      {
        variant_id: 'v2',
        title: 'DN360',
        options: [{ name: 'Shade', value: 'DN360' }],
      },
    ],
    snapshot: {
      variants: [
        {
          variant_id: 'v1',
          title: 'DN350',
          options: [{ name: 'Shade', value: 'DN350' }],
          shade_hex: '#D9C4AD',
        },
      ],
    },
  };

  const shadeHex = findSourceBackedShadeHex(seedData, ['DN350']);
  const patched = applyVisualPatch(seedData, { shadeHex }, ['DN350'], '2026-05-16T00:00:00.000Z');

  assert.equal(shadeHex, '#d9c4ad');
  assert.equal(patched.swatch_color, '#d9c4ad');
  assert.equal(patched.variants[0].swatch.hex, '#d9c4ad');
  assert.equal(patched.variants[1].swatch_color, undefined);
  assert.equal(patched.snapshot.diagnostics.shade_swatch_backfill.evidence_kind, 'source_backed_explicit_hex');
});
