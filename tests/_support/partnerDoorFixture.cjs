'use strict';

// THE PARTNER-DOOR FIXTURE (PARTNER_DOOR_ONE_PRODUCT_ID): the catalog as the door's lookups see it, shared by
//   tests/partner_door_one_product_id_chain.node.test.cjs       the chained /mcp door test (via its child)
//   tests/integration/partner_door_group_member_signature_postgres.test.js   the lookups on PostgreSQL
//   tests/integration/partner_door_pdp_v2_refusal_shape.test.js              the real get_pdp_v2 refusals
//
//   minted     an external-seed product minted by the enrichment lane: its catalog row's source_product_id is
//              a NAME SLUG, its seed (a `brand:hash` id) is attached to the row by product key, and that seed's
//              listing is approved and live in an identity group;
//   mirror     an external-seed mirror row: its source_product_id IS its seed's id; listed in its own group;
//   connected  a connected merchant's row, listed under the merchant's own platform id;
//   shared     ONE product listed by TWO sellers (a brand's own seed listing and a connected retailer's): the
//              shape a sellable-item group has in production. Each listing is its own catalog row and signature;
//   emitted    a product search serves under its GROUP-SHAPED id (the canonical-entity public emit): the row's own
//              `product_id` is `sig_` + 24 hex and its 32-hex signature rides beside it. Today's path serves that id;
//   fallback   a signature whose catalog row belongs to one seller while get_pdp_v2 answers the group's
//              canonical member, another seller (src/server.js, the canonical-group fallback).
// Plus groups no product answers: one whose only live listing is an unsigned row, one that is not live.
// Every name is a placeholder.
//
// `groupLookup` and `fixtureQuery` answer, in JS, what src/services/partnerDoorOneProductId asks: the group
// lookup (pdpIdentityGraph.resolveLivePdpIdentityGroupForPdp) and its statements. The PostgreSQL test runs the
// real lookup and the real statements over `rows` and requires the same answers, so the door test's stand-ins
// cannot drift from them.

const sig = (c) => `sig_${String(c).repeat(32)}`;
const group = (c) => `sig_${String(c).repeat(24)}`;

const IDS = {
  SIG_MINTED: sig('a'),
  SIG_MIRROR: sig('b'),
  SIG_CONNECTED: sig('c'),
  SIG_SHARED_RETAILER: sig('d'),
  SIG_NOT_SERVABLE: sig('e'),
  SIG_SHARED_BRAND: sig('8'),
  SIG_FALLBACK: sig('5'),
  SIG_EMITTED: sig('3'),
  GROUP_MINTED: group('1'),
  GROUP_MIRROR: group('2'),
  GROUP_CONNECTED: group('3'),
  GROUP_SHARED: group('4'),
  GROUP_NOT_LIVE: group('5'),
  GROUP_UNSIGNED: group('6'),
  GROUP_EMITTED: group('7'),
  GROUP_EMITTED_NO_SIGNATURE_OFFER: group('8'),
  GROUP_UNKNOWN: group('9'),
  SELLER_MINTED: 'merch_obs_brandx',
  SELLER_MIRROR: 'merch_obs_brandy',
  SELLER_SHARED_BRAND: 'merch_obs_brandw',
  SELLER_FALLBACK_ROW: 'merch_obs_brandv',
  SELLER_FALLBACK_CANONICAL: 'merch_obs_brandu',
  SELLER_CONNECTED: 'merch_shop_a',
  SELLER_EMITTED: 'merch_obs_brands',
  SELLER_SHARED_SIBLING: 'merch_obs_brandt',
  SELLER_OTHER_OBSERVED: 'merch_obs_brandz',
  SELLER_OTHER_CONNECTED: 'merch_shop_b',
  SEED_MINTED: 'brand-x:0123456789abcdef',
  SEED_MIRROR: 'ext_00000000000000000000b0b0',
  SEED_SHARED_BRAND: 'ext_00000000000000000000d0d0',
  SEED_FALLBACK: 'ext_00000000000000000000f0f0',
  SEED_EMITTED: 'ext_00000000000000000000e0e0',
  SLUG_MINTED: 'brand-x-calm-serum',
  SOURCE_CONNECTED: '9001',
  SOURCE_SHARED_RETAILER: '9002',
};

const product = (product_key, merchant_id, platform, source_system, source_product_id, pivota_signature_id) =>
  ({ product_key, merchant_id, platform, source_system, source_product_id, pivota_signature_id });
const listing = (merchant_id, product_id, sellable_item_group_id, source_kind, source_tier, over = {}) =>
  ({ merchant_id, product_id, sellable_item_group_id, source_kind, source_tier, live: true, confidence: 0.9, ...over });

const rows = {
  catalog_merchants: [
    { merchant_id: IDS.SELLER_MINTED, status: 'observed' },
    { merchant_id: IDS.SELLER_MIRROR, status: 'observed' },
    { merchant_id: IDS.SELLER_SHARED_BRAND, status: 'observed' },
    { merchant_id: IDS.SELLER_FALLBACK_ROW, status: 'observed' },
    { merchant_id: IDS.SELLER_EMITTED, status: 'observed' },
    { merchant_id: IDS.SELLER_CONNECTED, status: 'active' },
  ],
  catalog_products: [
    product('ext:brand-x-calm-serum::00000001', IDS.SELLER_MINTED, 'external_seed', 'catalog_enrichment_agent_v1', IDS.SLUG_MINTED, IDS.SIG_MINTED),
    product('prod::external_seed::mirror-1', IDS.SELLER_MIRROR, 'external_seed', 'external_product_seeds_mirror_v1', IDS.SEED_MIRROR, IDS.SIG_MIRROR),
    product('prod::external_seed::mirror-2', IDS.SELLER_SHARED_BRAND, 'external_seed', 'external_product_seeds_mirror_v1', IDS.SEED_SHARED_BRAND, IDS.SIG_SHARED_BRAND),
    product('prod::external_seed::mirror-3', IDS.SELLER_FALLBACK_ROW, 'external_seed', 'external_product_seeds_mirror_v1', IDS.SEED_FALLBACK, IDS.SIG_FALLBACK),
    product('prod::external_seed::mirror-4', IDS.SELLER_EMITTED, 'external_seed', 'external_product_seeds_mirror_v1', IDS.SEED_EMITTED, IDS.SIG_EMITTED),
    product('prod::shop-a::9001', IDS.SELLER_CONNECTED, 'storefront', 'storefront_sync_v1', IDS.SOURCE_CONNECTED, IDS.SIG_CONNECTED),
    product('prod::shop-a::9002', IDS.SELLER_CONNECTED, 'storefront', 'storefront_sync_v1', IDS.SOURCE_SHARED_RETAILER, IDS.SIG_SHARED_RETAILER),
    // No signature: a listed row that names no product id.
    product('prod::shop-a::9003', IDS.SELLER_CONNECTED, 'storefront', 'storefront_sync_v1', '9003', null),
  ],
  external_product_seeds: [
    { external_product_id: IDS.SEED_MINTED, attached_product_key: 'ext:brand-x-calm-serum::00000001', status: 'active' },
    { external_product_id: IDS.SEED_MIRROR, attached_product_key: null, status: 'active' },
    { external_product_id: IDS.SEED_SHARED_BRAND, attached_product_key: null, status: 'active' },
    { external_product_id: IDS.SEED_FALLBACK, attached_product_key: null, status: 'active' },
    { external_product_id: IDS.SEED_EMITTED, attached_product_key: null, status: 'active' },
  ],
  pdp_identity_listing: [
    listing(IDS.SELLER_MINTED, IDS.SEED_MINTED, IDS.GROUP_MINTED, 'external_seed', 'brand'),
    listing(IDS.SELLER_MIRROR, IDS.SEED_MIRROR, IDS.GROUP_MIRROR, 'external_seed', 'brand'),
    listing(IDS.SELLER_CONNECTED, IDS.SOURCE_CONNECTED, IDS.GROUP_CONNECTED, 'internal', 'retailer'),
    // One product, two sellers. The retailer's listing is the more confident one and is inserted first: the
    // group's canonical member is still the brand's.
    listing(IDS.SELLER_CONNECTED, IDS.SOURCE_SHARED_RETAILER, IDS.GROUP_SHARED, 'internal', 'retailer', { confidence: 0.99 }),
    listing(IDS.SELLER_SHARED_BRAND, IDS.SEED_SHARED_BRAND, IDS.GROUP_SHARED, 'external_seed', 'brand', { confidence: 0.8 }),
    listing(IDS.SELLER_EMITTED, IDS.SEED_EMITTED, IDS.GROUP_EMITTED, 'external_seed', 'brand'),
    listing(IDS.SELLER_CONNECTED, '9003', IDS.GROUP_UNSIGNED, 'internal', 'retailer'),
    listing(IDS.SELLER_CONNECTED, '9004', IDS.GROUP_NOT_LIVE, 'internal', 'retailer', { live: false }),
  ],
};

// What each group id resolves to (null: nothing servable). Literal on purpose: the PostgreSQL test holds the
// real lookup to this table, and the JS stand-ins below to it too.
const GROUP_PRODUCT = {
  [IDS.GROUP_MINTED]: IDS.SIG_MINTED,
  [IDS.GROUP_MIRROR]: IDS.SIG_MIRROR,
  [IDS.GROUP_CONNECTED]: IDS.SIG_CONNECTED,
  [IDS.GROUP_SHARED]: IDS.SIG_SHARED_BRAND,
  [IDS.GROUP_EMITTED]: IDS.SIG_EMITTED,
  [IDS.GROUP_EMITTED_NO_SIGNATURE_OFFER]: null,
  [IDS.GROUP_UNSIGNED]: null,
  [IDS.GROUP_NOT_LIVE]: null,
  [IDS.GROUP_UNKNOWN]: null,
};

// The group lookup's answer, as far as the door reads it: the canonical member (brand tier first, then
// confidence) and the members in that order.
async function groupLookup({ productGroupId }) {
  const members = rows.pdp_identity_listing
    .filter((l) => l.sellable_item_group_id === productGroupId && l.live)
    .sort((a, b) => (a.source_tier === 'brand' ? 0 : 1) - (b.source_tier === 'brand' ? 0 : 1) || b.confidence - a.confidence)
    .map((l) => ({ merchant_id: l.merchant_id, product_id: l.product_id }));
  if (!members.length) return null;
  return { product_group_id: productGroupId, canonical_product_ref: members[0], selected_commerce_ref: members[0], group_members: members };
}

// One listing ref -> its catalog signature: the row keyed on the ref's own ids, else a minted row reached
// through its attached seed.
function refSignature(merchantId, productId) {
  const signed = rows.catalog_products.filter((cp) => cp.pivota_signature_id);
  const direct = signed.find((cp) => cp.merchant_id === merchantId && cp.source_product_id === productId);
  if (direct) return direct.pivota_signature_id;
  const attached = signed.find((cp) => cp.source_system === 'catalog_enrichment_agent_v1' && rows.external_product_seeds
    .some((s) => s.external_product_id === productId && s.attached_product_key === cp.product_key));
  return attached ? attached.pivota_signature_id : null;
}

// signature -> the sellers whose catalog rows carry it (sorted).
function signatureSellers(signature) {
  return [...new Set(rows.catalog_products.filter((cp) => cp.pivota_signature_id === signature).map((cp) => cp.merchant_id))].sort();
}

// The database stand-in the door test installs. It answers the door's two statements (told apart by their tag
// comment) and the kernel hop's signature -> platform id translation for a connected merchant
// (catalogEntityResolution.resolveMerchantScopedSourceProductId), and nothing else.
async function fixtureQuery(sql, params) {
  const text = String(sql || '');
  if (text.includes('/* partner_door_listing_ref_signature */')) {
    for (let i = 0; i < params[0].length; i += 1) {
      const signature = refSignature(params[0][i], params[1][i]);
      if (signature) return { rows: [{ pivota_signature_id: signature }] };
    }
    return { rows: [] };
  }
  if (text.includes('/* partner_door_signature_sellers */')) {
    return { rows: signatureSellers(params[0]).map((m) => ({ merchant_id: m })) };
  }
  if (/cp\.pivota_signature_id = \$1\s+AND cp\.merchant_id = \$2/.test(text) && text.includes('SELECT DISTINCT cp.source_product_id')) {
    return {
      rows: rows.catalog_products
        .filter((cp) => cp.pivota_signature_id === params[0] && cp.merchant_id === params[1])
        .map((cp) => ({ source_product_id: cp.source_product_id })),
    };
  }
  throw new Error('partner door fixture: unexpected statement');
}

module.exports = { IDS, rows, GROUP_PRODUCT, groupLookup, refSignature, signatureSellers, fixtureQuery };
