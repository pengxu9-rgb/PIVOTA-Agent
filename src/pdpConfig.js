// TWO AXES THAT HAPPEN TO SHARE A STRING, and must not be spelled with one constant.
//
// EXTERNAL_SEED_MERCHANT_ID is the sentinel SELLER: "the world has one shared seller". ADR-009
// is retiring it (tests/scripts/external_seed_merchant_literal_ratchet.test.js is the shrink-only
// ratchet), because rows migrate to their observed sellers and every comparison against it then
// goes silently blind. Measured 2026-09-10: catalog_products and catalog_offers contain ZERO rows
// carrying it — all 13,896 external-seed products already have a real merch_* seller.
//
// EXTERNAL_SEED_PLATFORM is the LANE, and it survives that re-key. It is the value the data
// actually uses: platform=external_seed on 13,896 of 15,516 catalog_products rows, and on 90/90
// rows served by the live agent door.
//
// They are the same string TODAY, which is exactly why the confusion is invisible and why it
// needs two names: server.js:6353 filters `cp.platform` using the MERCHANT constant, so it reads
// as a lane query and is really a seller query that works by string coincidence. Retire the
// sentinel and that WHERE clause silently matches nothing — a dead lane, no error.
const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const EXTERNAL_SEED_PLATFORM = 'external_seed';

const STANDARD_PDP_INITIAL_INCLUDE = Object.freeze([
  'offers',
  'variant_selector',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
  'product_overview',
  'supplemental_details',
  'reviews_preview',
]);

function buildPdpCorePrewarmRequestBody(target, metadataSource = 'pdp_core_prewarm') {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: String(target?.merchant_id || '').trim(),
        product_id: String(target?.product_id || '').trim(),
      },
      include: [...STANDARD_PDP_INITIAL_INCLUDE],
      options: {
        debug: false,
      },
    },
    metadata: {
      source: metadataSource,
    },
  };
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  EXTERNAL_SEED_PLATFORM,
  STANDARD_PDP_INITIAL_INCLUDE,
  buildPdpCorePrewarmRequestBody,
};
