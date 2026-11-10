'use strict';

// THE PARTNER-DOOR FIXTURE (PARTNER_DOOR_ONE_PRODUCT_ID): three products as the catalog holds them, shared by
//   tests/partner_door_one_product_id_chain.node.test.cjs       the chained /mcp door test (via its child)
//   tests/integration/partner_door_group_member_signature_postgres.test.js   the resolver SQL on PostgreSQL
//   tests/integration/partner_door_pdp_v2_refusal_shape.test.js              the real get_pdp_v2 refusals
//
//   minted     an external-seed product minted by the enrichment lane: its catalog row's source_product_id is
//              a NAME SLUG, its seed (a `brand:hash` id) is attached to the row by product key, and that seed's
//              listing is approved and live in an identity group;
//   mirror     an external-seed mirror row: its source_product_id IS its seed's id; listed in its own group;
//   connected  a connected merchant's row, listed under the merchant's own id.
// Plus two groups no product answers: one whose live listings sit under two different catalog rows, one with
// no live listing. Every name is a placeholder.
//
// `lookups` answers, in JS, the two questions src/services/partnerDoorOneProductId asks the database. The
// PostgreSQL test runs the real statements over `rows` and requires the same answers, so the door test's
// stand-in cannot drift from the SQL.

const sig = (c) => `sig_${String(c).repeat(32)}`;
const group = (c) => `sig_${String(c).repeat(24)}`;

const IDS = {
  SIG_MINTED: sig('a'),
  SIG_MIRROR: sig('b'),
  SIG_CONNECTED: sig('c'),
  SIG_SECOND_OF_SEVERAL: sig('d'),
  SIG_NOT_SERVABLE: sig('e'),
  GROUP_MINTED: group('1'),
  GROUP_MIRROR: group('2'),
  GROUP_CONNECTED: group('3'),
  GROUP_SEVERAL: group('4'),
  GROUP_NOT_LIVE: group('5'),
  GROUP_UNKNOWN: group('9'),
  SELLER_MINTED: 'merch_obs_brandx',
  SELLER_MIRROR: 'merch_obs_brandy',
  SELLER_CONNECTED: 'merch_shop_a',
  SELLER_OTHER_OBSERVED: 'merch_obs_brandz',
  SELLER_OTHER_CONNECTED: 'merch_shop_b',
  SEED_MINTED: 'brand-x:0123456789abcdef',
  SEED_MIRROR: 'ext_00000000000000000000b0b0',
  SLUG_MINTED: 'brand-x-calm-serum',
};

const rows = {
  catalog_merchants: [
    { merchant_id: IDS.SELLER_MINTED, status: 'observed' },
    { merchant_id: IDS.SELLER_MIRROR, status: 'observed' },
    { merchant_id: IDS.SELLER_CONNECTED, status: 'active' },
  ],
  catalog_products: [
    { product_key: 'ext:brand-x-calm-serum::00000001', merchant_id: IDS.SELLER_MINTED, platform: 'external_seed',
      source_system: 'catalog_enrichment_agent_v1', source_product_id: IDS.SLUG_MINTED, pivota_signature_id: IDS.SIG_MINTED },
    { product_key: 'prod::external_seed::mirror-1', merchant_id: IDS.SELLER_MIRROR, platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1', source_product_id: IDS.SEED_MIRROR, pivota_signature_id: IDS.SIG_MIRROR },
    { product_key: 'prod::shop-a::9001', merchant_id: IDS.SELLER_CONNECTED, platform: 'storefront',
      source_system: 'storefront_sync_v1', source_product_id: '9001', pivota_signature_id: IDS.SIG_CONNECTED },
    { product_key: 'prod::shop-a::9002', merchant_id: IDS.SELLER_CONNECTED, platform: 'storefront',
      source_system: 'storefront_sync_v1', source_product_id: '9002', pivota_signature_id: IDS.SIG_SECOND_OF_SEVERAL },
    // No signature: a listed row that names no product id.
    { product_key: 'prod::shop-a::9003', merchant_id: IDS.SELLER_CONNECTED, platform: 'storefront',
      source_system: 'storefront_sync_v1', source_product_id: '9003', pivota_signature_id: null },
  ],
  external_product_seeds: [
    { external_product_id: IDS.SEED_MINTED, attached_product_key: 'ext:brand-x-calm-serum::00000001', status: 'active' },
    { external_product_id: IDS.SEED_MIRROR, attached_product_key: null, status: 'active' },
  ],
  pdp_identity_listing: [
    { merchant_id: IDS.SELLER_MINTED, product_id: IDS.SEED_MINTED, sellable_item_group_id: IDS.GROUP_MINTED, live: true },
    { merchant_id: IDS.SELLER_MIRROR, product_id: IDS.SEED_MIRROR, sellable_item_group_id: IDS.GROUP_MIRROR, live: true },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: '9001', sellable_item_group_id: IDS.GROUP_CONNECTED, live: true },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: '9001', sellable_item_group_id: IDS.GROUP_SEVERAL, live: true, listing: 'b' },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: '9002', sellable_item_group_id: IDS.GROUP_SEVERAL, live: true },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: '9003', sellable_item_group_id: IDS.GROUP_SEVERAL, live: true },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: '9002', sellable_item_group_id: IDS.GROUP_NOT_LIVE, live: false },
  ],
};

// group id -> the distinct catalog signatures its LIVE listings sit under (sorted).
function groupSignatures(groupId) {
  const out = new Set();
  for (const listing of rows.pdp_identity_listing) {
    if (listing.sellable_item_group_id !== groupId || !listing.live) continue;
    for (const cp of rows.catalog_products) {
      if (!cp.pivota_signature_id) continue;
      const direct = cp.merchant_id === listing.merchant_id && cp.source_product_id === listing.product_id;
      const attached = cp.source_system === 'catalog_enrichment_agent_v1' && rows.external_product_seeds
        .some((s) => s.external_product_id === listing.product_id && s.attached_product_key === cp.product_key);
      if (direct || attached) out.add(cp.pivota_signature_id);
    }
  }
  return [...out].sort();
}

// signature -> the sellers whose catalog rows carry it (sorted).
function signatureSellers(signature) {
  return [...new Set(rows.catalog_products.filter((cp) => cp.pivota_signature_id === signature).map((cp) => cp.merchant_id))].sort();
}

// The database stand-in the door test installs (partnerDoorOneProductId.usePartnerDoorQueryForTest): it answers
// the module's two statements, told apart by their leading tag comment, and nothing else.
async function fixtureQuery(sql, params) {
  const text = String(sql || '');
  if (text.includes('/* partner_door_group_member_signature */')) {
    return { rows: groupSignatures(params[0]).map((s) => ({ pivota_signature_id: s })) };
  }
  if (text.includes('/* partner_door_signature_sellers */')) {
    return { rows: signatureSellers(params[0]).map((m) => ({ merchant_id: m })) };
  }
  throw new Error('partner door fixture: unexpected statement');
}

module.exports = { IDS, rows, groupSignatures, signatureSellers, fixtureQuery };
