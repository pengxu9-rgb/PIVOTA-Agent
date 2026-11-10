'use strict';

// PARTNER DOOR, ONE PRODUCT ID (flag PARTNER_DOOR_ONE_PRODUCT_ID, default off; off = nothing here runs).
//
// THE FLAG ACTS ON THE `/mcp` DOOR ONLY. Nothing in this file is called from the kernel hop, the canonical
// executor or get_pdp_v2: its one caller is the `/mcp` door's view of the tool surface
// (mcp-server/src/partnerDoorOneProductId.js), so `/ucp/mcp`, `/public/mcp` and the invoke route answer the same
// with the flag on as with it off.
//
// Two different ids start with `sig_`:
//   - the catalog signature, `sig_` + 32 hex: the `product_id` search_catalog advertises;
//   - the identity-graph group id, `sig_` + 24 hex (pdpIdentityGraph stableHash('sig', ...)): the value of
//     `product_group_id` / `sellable_item_group_id` on a row.
// A partner that passed the second one to get_product was answered NO_MERCHANT_OFFER for a minted row: the alias
// lane hands the serving gate a ref with no signature and no content key, which a minted row never matches.
//
// So a group id is answered as the catalog signature of the member get_pdp_v2's own group lookup elects
// (pdpIdentityGraph.resolveLivePdpIdentityGroupForPdp: same listings, same active-seed filter, same canonical
// pick), and the read then takes the signature lane. The one thing added here is the step that lookup does not
// do: a listing ref -> the catalog row it is, by the join the signature resolver runs the other way round
// (src/server.js resolveCatalogProductRefFromPivotaSignature): the row's own (merchant_id, source_product_id),
// or, for a minted row whose source_product_id is a name slug, the seed attached to the row by product key.

const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');
const {
  isExternalSeedSupplyMerchantId,
  isObservedSellerMerchantId,
  isSeedSupplyUnservableUpstream,
} = require('./externalSeedLane');

const FLAG_NAME = 'PARTNER_DOOR_ONE_PRODUCT_ID';

function partnerDoorOneProductIdEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[FLAG_NAME]) || '').trim());
}

const IDENTITY_GROUP_ID_RE = /^sig_[0-9a-f]{24}$/i;
const CATALOG_SIGNATURE_RE = /^sig_[0-9a-f]{32}$/i;
const REASON_RE = /^[a-z0-9_]{1,64}$/;

const asString = (value) => (typeof value === 'string' ? value.trim() : '');
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIdentityGroupIdShape = (value) => IDENTITY_GROUP_ID_RE.test(asString(value));
const isCatalogSignatureShape = (value) => CATALOG_SIGNATURE_RE.test(asString(value));

// EVERY STATEMENT THIS MODULE SENDS IS BOUNDED. They sit in front of a partner's read, and the pool's own
// defaults (tens of seconds) would let a slow database hold that read. Past the budget the lookup is
// "unavailable": retriable for a group id, and no opinion for a seller list.
const DEFAULT_LOOKUP_BUDGET_MS = 1500;
function lookupBudgetMs(env = process.env) {
  const configured = Number(env && env.PARTNER_DOOR_LOOKUP_BUDGET_MS);
  return Number.isFinite(configured) && configured >= 50 && configured <= 10000 ? Math.floor(configured) : DEFAULT_LOOKUP_BUDGET_MS;
}
function budgetedQuery(sql, params) {
  const db = require('../db');
  return db.queryWithBudget(sql, params, { timeoutMs: lookupBudgetMs() });
}

// Test stand-ins (the door tests run without a database). Never set outside a test.
let queryForTest = null;
let groupLookupForTest = null;
function usePartnerDoorQueryForTest(queryFn) {
  queryForTest = typeof queryFn === 'function' ? queryFn : null;
}
function usePartnerDoorGroupLookupForTest(lookupFn) {
  groupLookupForTest = typeof lookupFn === 'function' ? lookupFn : null;
}
function pickQuery(queryFn) {
  if (queryForTest) return queryForTest;
  if (!process.env.DATABASE_URL) return null;
  return typeof queryFn === 'function' ? queryFn : budgetedQuery;
}
function pickGroupLookup() {
  if (groupLookupForTest) return groupLookupForTest;
  return require('./pdpIdentityGraph').resolveLivePdpIdentityGroupForPdp;
}

// The catalog row a listing ref is, for an ordered list of refs: the first ref (in the order given) that has a
// signed, active catalog row answers. Within one ref the row keyed on the listing's own ids comes before a
// minted row reached through its attached seed.
const LISTING_REF_SIGNATURE_SQL = `
  /* partner_door_listing_ref_signature */
  WITH refs AS (
    SELECT r.merchant_id, r.product_id, r.ord
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r(merchant_id, product_id, ord)
  )
  SELECT picked.pivota_signature_id
  FROM (
    SELECT cp.pivota_signature_id, r.ord, 0 AS lane, cp.product_key
    FROM refs r
    JOIN catalog_products cp
      ON cp.merchant_id = r.merchant_id
     AND cp.source_product_id = r.product_id
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
    UNION ALL
    SELECT cp.pivota_signature_id, r.ord, 1 AS lane, cp.product_key
    FROM refs r
    JOIN external_product_seeds eps ON eps.external_product_id = r.product_id
    JOIN catalog_products cp
      ON cp.product_key = eps.attached_product_key
     AND cp.source_system = 'catalog_enrichment_agent_v1'
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
  ) picked
  WHERE picked.pivota_signature_id ~ '^sig_[0-9a-f]{32}$'
  ORDER BY picked.ord ASC, picked.lane ASC, picked.product_key ASC
  LIMIT 1
`;

// The group's listing refs in the order get_pdp_v2 would try them: the canonical member it elects, the member
// it sells from, then the rest of the group as the lookup ordered it.
function orderedGroupRefs(group) {
  const out = [];
  const seen = new Set();
  const push = (ref) => {
    if (!isObj(ref)) return;
    const merchantId = asString(ref.merchant_id);
    const productId = asString(ref.product_id);
    if (!merchantId || !productId) return;
    const key = `${merchantId}\u0000${productId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ merchant_id: merchantId, product_id: productId, pivota_signature_id: asString(ref.pivota_signature_id).toLowerCase() });
  };
  if (isObj(group)) {
    push(group.canonical_product_ref);
    push(group.selected_commerce_ref);
    for (const member of Array.isArray(group.group_members) ? group.group_members : []) push(member);
  }
  return out.slice(0, 50);
}

/**
 * An identity group id -> the catalog signature of the member get_pdp_v2's group lookup elects.
 * @returns {Promise<{status:'resolved', productId:string}|{status:'none'}|{status:'no_database'}|{status:'unavailable'}>}
 *   `none`: the lookup found no live member, or no member that is a signed, active catalog row.
 *   `no_database`: this process has no database, so no group id can ever resolve here (not a transient state).
 *   `unavailable`: the database was asked and did not answer in time. Never throws.
 */
async function resolveGroupIdToProductId({ groupId, queryFn } = {}) {
  const id = asString(groupId).toLowerCase();
  if (!isIdentityGroupIdShape(id)) return { status: 'none' };
  const run = pickQuery(queryFn);
  if (!run) return { status: 'no_database' };
  // The group lookup answers null for "no such group" and also when it swallowed a statement that failed, so
  // every statement it sends is watched: nothing found after a failure is "unavailable", not "none".
  let statementFailed = false;
  const watched = async (sql, params) => {
    try {
      return await run(sql, params);
    } catch (err) {
      statementFailed = true;
      throw err;
    }
  };
  try {
    const group = await pickGroupLookup()({ productGroupId: id, queryFn: watched });
    const refs = orderedGroupRefs(group);
    if (!refs.length) return { status: statementFailed ? 'unavailable' : 'none' };
    // The lookup's catalog-group fallback already names its member's signature.
    if (isCatalogSignatureShape(refs[0].pivota_signature_id)) return { status: 'resolved', productId: refs[0].pivota_signature_id };
    const res = await run(LISTING_REF_SIGNATURE_SQL, [refs.map((r) => r.merchant_id), refs.map((r) => r.product_id)]);
    const row = Array.isArray(res && res.rows) ? res.rows[0] : null;
    const signature = asString(row && row.pivota_signature_id).toLowerCase();
    return isCatalogSignatureShape(signature) ? { status: 'resolved', productId: signature } : { status: 'none' };
  } catch (_) {
    return { status: 'unavailable' };
  }
}

const SIGNATURE_SELLERS_SQL = `
  /* partner_door_signature_sellers */
  SELECT DISTINCT cp.merchant_id
  FROM catalog_products cp
  WHERE cp.pivota_signature_id = $1
  LIMIT 20
`;

/**
 * The sellers whose catalog rows carry this signature. null = could not ask (no database, an error, past the
 * budget, not a signature).
 */
async function listSignatureSellerIds({ productId, queryFn } = {}) {
  const id = asString(productId).toLowerCase();
  if (!isCatalogSignatureShape(id)) return null;
  const run = pickQuery(queryFn);
  if (!run) return null;
  try {
    const res = await run(SIGNATURE_SELLERS_SQL, [id]);
    const rows = Array.isArray(res && res.rows) ? res.rows : [];
    return Array.from(new Set(rows.map((row) => asString(row && row.merchant_id)).filter(Boolean)));
  } catch (_) {
    return null;
  }
}

// The seller an answered product IS: its own `merchant_id`, and nothing else. The sellers a product merely LISTS
// (group members, other listings, offers, the refs it resolved through) are other sellers' products: accepting
// one would serve seller A's row to a caller that named seller B.
function sellersNamedByProduct(product) {
  const names = new Set();
  const id = isObj(product) ? asString(product.merchant_id) : '';
  if (id) names.add(id);
  return names;
}

/**
 * Does the seller a caller named belong to this product? `sellers` is the answered product's own seller, or the
 * sellers of the signature's own catalog rows.
 *   - any seller in the list is accepted;
 *   - for seed supply, the shared seed seller name and a per-brand observed seller stand for each other, in
 *     both directions (a seed row's signature was minted under the shared name and re-keyed to the observed
 *     seller, and get_pdp_v2 can answer either);
 *   - nothing to compare (no seller named, or the product names none) is not a mismatch.
 */
function sellerAmong(requestedMerchantId, sellers) {
  const requested = asString(requestedMerchantId);
  const known = Array.from(sellers || []).map(asString).filter(Boolean);
  if (!requested || known.length === 0) return true;
  if (known.includes(requested)) return true;
  if (!isExternalSeedSupplyMerchantId(requested)) return false;
  return known.some(
    (seller) => isExternalSeedSupplyMerchantId(seller) && (isSharedSeedSellerName(requested) || isSharedSeedSellerName(seller)),
  );
}

// The shared seed seller NAME, as request vocabulary: seed supply that is not a per-brand observed seller. Asked
// of the lane's own predicates (services/externalSeedLane), so the seller-shape knowledge stays in its one
// watched place and this file compares against no seller literal.
function isSharedSeedSellerName(merchantId) {
  return isExternalSeedSupplyMerchantId(merchantId) && !isObservedSellerMerchantId(merchantId);
}

/** The seller check against the answered product alone (no database). */
function sellerMatchesProduct(requestedMerchantId, product) {
  return sellerAmong(requestedMerchantId, sellersNamedByProduct(product));
}

/**
 * ONE FACT PER CODE, for a get_product the kernel refused. The kernel's mapping folds the whole not-found family
 * of the single-product read into NO_MERCHANT_OFFER (audit rows E1-E3). On the `/mcp` door, flag on, that error
 * is re-read from the detail it already carries (`upstream_detail` is the upstream's own body):
 *   - this gateway's detail lane answered for an id it had RESOLVED to a catalog identity: the product exists
 *     and a gate or its content route withholds it       -> PRODUCT_NOT_SERVABLE, with the gate's reason
 *   - the detail lane answered for an id no lane resolved -> UNKNOWN_PRODUCT_ID
 *   - the per-merchant backend said not found: that merchant has no such product -> UNKNOWN_PRODUCT_ID
 * null = not that error: it is rethrown untouched (MERCHANT_UNAVAILABLE and every other code included).
 * The lane is the one the kernel hop took for these arguments (src/server.js `case 'get_product_detail'`).
 */
function remapReadFailure({ code, detail, merchantId, productId } = {}) {
  if (code !== 'NO_MERCHANT_OFFER' || !isObj(detail) || detail.operation !== 'get_product_detail') return null;
  const pdpLane = !asString(merchantId) || isSeedSupplyUnservableUpstream(merchantId, productId);
  const body = isObj(detail.upstream_detail) ? detail.upstream_detail : null;
  const identity = body && isObj(body.metadata) && isObj(body.metadata.identity_resolution) ? body.metadata.identity_resolution : null;
  const source = asString(identity && identity.resolution_source);
  const resolved = Boolean(identity) && (identity.canonicalization_applied === true || (source !== '' && source !== 'requested_route'));
  if (pdpLane && resolved) {
    const reason = asString(body && isObj(body.details) ? body.details.reason : '');
    return { code: 'PRODUCT_NOT_SERVABLE', reason: REASON_RE.test(reason) ? reason : 'product_detail_not_found' };
  }
  return { code: 'UNKNOWN_PRODUCT_ID', reason: 'product_id_not_found' };
}

const GROUP_ID_REFUSAL_REASONS = Object.freeze({
  none: 'group_has_no_servable_product',
  no_database: 'group_id_not_resolvable',
});

/**
 * The (code, detail) a group id that did not resolve is refused with. Only a lookup that FAILED is retriable;
 * every other outcome is the terminal "this is a group id" refusal.
 */
function groupIdFailure(resolved, operation) {
  if (resolved && resolved.status === 'unavailable') {
    return ['MERCHANT_UNAVAILABLE', { reason: 'group_id_lookup_unavailable', operation }];
  }
  return [
    'PRODUCT_GROUP_ID_NOT_PRODUCT_ID',
    { reason: GROUP_ID_REFUSAL_REASONS[resolved && resolved.status] || GROUP_ID_REFUSAL_REASONS.none, operation },
  ];
}

module.exports = {
  FLAG_NAME,
  LISTING_REF_SIGNATURE_SQL,
  SIGNATURE_SELLERS_SQL,
  DEFAULT_LOOKUP_BUDGET_MS,
  lookupBudgetMs,
  partnerDoorOneProductIdEnabled,
  isIdentityGroupIdShape,
  isCatalogSignatureShape,
  orderedGroupRefs,
  resolveGroupIdToProductId,
  listSignatureSellerIds,
  sellersNamedByProduct,
  sellerAmong,
  sellerMatchesProduct,
  remapReadFailure,
  groupIdFailure,
  usePartnerDoorQueryForTest,
  usePartnerDoorGroupLookupForTest,
};
