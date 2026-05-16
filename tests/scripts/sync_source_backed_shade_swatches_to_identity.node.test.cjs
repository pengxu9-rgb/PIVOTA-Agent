const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseVisualEntries,
  patchIdentityPayloadVisuals,
} = require('../../scripts/sync-source-backed-shade-swatches-to-identity.cjs');

test('parses only reviewed source-backed shade visuals from candidate rows', () => {
  const visuals = parseVisualEntries({
    visuals_by_shade: JSON.stringify([
      {
        shade_key: '1',
        shade_name: '1',
        swatch_image_url:
          'https://cdn.shopify.com/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01_1200X1500_72DPI.png',
      },
      {
        shade_key: 'fenty glow',
        shade_name: 'Fenty Glow',
        swatch_image_url:
          'https://cdn.shopify.com/files/FB816865GLOBAL_GLOSSBOMBOIL_INFOGRAPHICS_1200x1500_2Model_Smear_FENTYGLOW_2.jpg',
      },
    ]),
  });

  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].shade_key, '1');
});

test('patches identity payload visual fields without rewriting content fields', () => {
  const payload = {
    title: 'Eaze Drop Blur + Smooth Tint Stick — 1',
    pdp_ingredients_raw: 'existing ingredients',
    pdp_how_to_use_raw: 'existing directions',
    variants: [
      {
        variant_id: 'v1',
        title: '1',
        options: [{ name: 'Color', value: '1' }],
        image_url: 'https://cdn.shopify.com/files/concrete-shade-01.jpg',
      },
    ],
  };
  const patched = patchIdentityPayloadVisuals(
    payload,
    [
      {
        shade_key: '1',
        shade_name: '1',
        swatch_image_url:
          'https://cdn.shopify.com/files/FB_FALL23_T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01_1200X1500_72DPI.png',
        shade_hex: '',
      },
    ],
    '2026-05-16T00:00:00.000Z',
  );

  assert.equal(patched.pdp_ingredients_raw, 'existing ingredients');
  assert.equal(patched.pdp_how_to_use_raw, 'existing directions');
  assert.equal(patched.image_url, undefined);
  assert.equal(patched.swatch_image_url.includes('T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01'), true);
  assert.equal(patched.variants[0].image_url, 'https://cdn.shopify.com/files/concrete-shade-01.jpg');
  assert.equal(patched.variants[0].swatch_image_url.includes('T2PRODUCT_SMEAR_EAZEDROP_STICK_SHADE_01'), true);
  assert.equal(patched.diagnostics.shade_swatch_identity_sync.visual_count, 1);
});

test('patches multi-shade identity variants per shade without setting one top-level visual', () => {
  const payload = {
    variants: [
      { variant_id: 'banana', title: 'Banana', options: [{ name: 'Shade', value: 'Banana' }] },
      { variant_id: 'guava', title: 'Guava', options: [{ name: 'Shade', value: 'Guava' }] },
    ],
  };
  const patched = patchIdentityPayloadVisuals(
    payload,
    [
      {
        shade_key: 'banana',
        shade_name: 'Banana',
        swatch_image_url: 'https://cdn.shopify.com/files/OH_CC_STICKS_Smear_Banana_1500x1500.jpg',
        shade_hex: '',
      },
      {
        shade_key: 'guava',
        shade_name: 'Guava',
        swatch_image_url: 'https://cdn.shopify.com/files/OH_CC_STICKS_Smear_Guava_1500x1500.jpg',
        shade_hex: '',
      },
    ],
    '2026-05-16T00:00:00.000Z',
  );

  assert.equal(patched.swatch_image_url, undefined);
  assert.equal(patched.variants[0].swatch_image_url.includes('Banana'), true);
  assert.equal(patched.variants[1].swatch_image_url.includes('Guava'), true);
});
