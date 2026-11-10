'use strict';

// PARTNER DOOR, ONE PRODUCT ID (flag PARTNER_DOOR_ONE_PRODUCT_ID, default off; off = nothing here runs).
//
// Two different ids start with `sig_`:
//   - the catalog signature, `sig_` + 32 hex: the `product_id` search_catalog advertises;
//   - the identity-graph group id, `sig_` + 24 hex (pdpIdentityGraph stableHash('sig', ...)): the value of
//     `product_group_id` / `sellable_item_group_id` on a row.
// A partner that passed the second one to get_product was answered NO_MERCHANT_OFFER (the alias lane hands the
// serving gate a ref with no signature and no content key, which a minted row never matches). This module is
// the door-side answer: a group id is resolved to the ONE catalog signature its live members sit under, and the
// read re-enters the signature lane with it; a group that names several products, or none, is refused by name.
//
// The lookup is the join the signature resolver already runs the other way round (src/server.js
// resolveCatalogProductRefFromPivotaSignature, its seed LATERAL): a listing meets its catalog row either on the
// row's own (merchant_id, source_product_id), or, for a minted row whose source_product_id is a name slug,
// through the seed attached to the row by product key.

const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');
const { EXTERNAL_SEED_MERCHANT_ID, isExternalSeedSupplyMerchantId } = require('./externalSeedLane');

const FLAG_NAME = 'PARTNER_DOOR_ONE_PRODUCT_ID';

function partnerDoorOneProductIdEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[FLAG_NAME]) || '').trim());
}

const IDENTITY_GROUP_ID_RE = /^sig_[0-9a-f]{24}$/i;
const CATALOG_SIGNATURE_RE = /^sig_[0-9a-f]{32}$/i;
const REASON_RE = /^[a-z0-9_]{1,64}$/;

const asString = (value) => (typeof value === 'string' ? value.trim() : '');
const isIdentityGroupIdShape = (value) => IDENTITY_GROUP_ID_RE.test(asString(value));
const isCatalogSignatureShape = (value) => CATALOG_SIGNATURE_RE.test(asString(value));

// A test's stand-in for the database (the door tests run without one). Never set outside a test.
let queryForTest = null;
function usePartnerDoorQueryForTest(queryFn) {
  queryForTest = typeof queryFn === 'function' ? queryFn : null;
}
function pickQuery(queryFn) {
  if (queryForTest) return queryForTest;
  return process.env.DATABASE_URL && typeof queryFn === 'function' ? queryFn : null;
}

const GROUP_MEMBER_SIGNATURE_SQL = `
  /* partner_door_group_member_signature */
  WITH members AS (
    SELECT pil.merchant_id, pil.product_id
    FROM pdp_identity_listing pil
    WHERE pil.sellable_item_group_id = $1
      AND pil.identity_status = 'approved'
      AND pil.live_read_enabled = true
      AND pil.review_required = false
    LIMIT 200
  )
  SELECT DISTINCT picked.pivota_signature_id
  FROM (
    SELECT cp.pivota_signature_id
    FROM members m
    JOIN catalog_products cp
      ON cp.merchant_id = m.merchant_id
     AND cp.source_product_id = m.product_id
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
    UNION ALL
    SELECT cp.pivota_signature_id
    FROM members m
    JOIN external_product_seeds eps ON eps.external_product_id = m.product_id
    JOIN catalog_products cp
      ON cp.product_key = eps.attached_product_key
     AND cp.source_system = 'catalog_enrichment_agent_v1'
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
  ) picked
  WHERE picked.pivota_signature_id ~ '^sig_[0-9a-f]{32}$'
  LIMIT 3
`;

/**
 * An identity group id -> the catalog signature of the product its live members are.
 * @returns {Promise<{status:'resolved', productId:string}|{status:'several', count:number}|{status:'none'}|{status:'no_database'}|{status:'unavailable'}>}
 *   `no_database`: this process has no database, so no group id can ever resolve here (not a transient state).
 *   `unavailable`: the database was asked and did not answer. Never throws.
 */
async function resolveGroupIdToProductId({ groupId, queryFn } = {}) {
  const id = asString(groupId).toLowerCase();
  if (!isIdentityGroupIdShape(id)) return { status: 'none' };
  const run = pickQuery(queryFn);
  if (!run) return { status: 'no_database' };
  let rows;
  try {
    const res = await run(GROUP_MEMBER_SIGNATURE_SQL, [id]);
    rows = Array.isArray(res && res.rows) ? res.rows : [];
  } catch (_) {
    return { status: 'unavailable' };
  }
  const signatures = Array.from(
    new Set(rows.map((row) => asString(row && row.pivota_signature_id).toLowerCase()).filter(isCatalogSignatureShape)),
  );
  if (signatures.length === 1) return { status: 'resolved', productId: signatures[0] };
  if (signatures.length > 1) return { status: 'several', count: signatures.length };
  return { status: 'none' };
}

const SIGNATURE_SELLERS_SQL = `
  /* partner_door_signature_sellers */
  SELECT DISTINCT cp.merchant_id
  FROM catalog_products cp
  WHERE cp.pivota_signature_id = $1
  LIMIT 20
`;

/**
 * The sellers whose catalog rows carry this signature. null = could not ask (no database, an error, not a
 * signature): the caller then keeps the route it had.
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

/**
 * Does the seller a caller named belong to a product whose own seller is `productMerchantId`?
 * Both ids the door itself hands out are accepted: the row's seller, and the shared seed seller name for a
 * seed-supply row (the literal a seed row's signature was minted under, which get_product has always taken).
 */
function sellerMatchesProduct(requestedMerchantId, productMerchantId) {
  const requested = asString(requestedMerchantId);
  const actual = asString(productMerchantId);
  if (!requested || !actual) return true;
  if (requested === actual) return true;
  return requested === EXTERNAL_SEED_MERCHANT_ID && isExternalSeedSupplyMerchantId(actual);
}

/**
 * What a failed single-product read says, for mapUpstreamErrorToKernelCode's `partnerDoorRead` and the error's
 * `detail.reason`. `extracted` is extractUpstreamErrorCode's answer; `pdpV2Detail` says the read went to this
 * gateway's own detail lane.
 */
function describePartnerDoorReadFailure({ extracted, pdpV2Detail } = {}) {
  const data = extracted && extracted.data && typeof extracted.data === 'object' ? extracted.data : null;
  const identity = data && data.metadata && typeof data.metadata === 'object' && data.metadata.identity_resolution
    && typeof data.metadata.identity_resolution === 'object' ? data.metadata.identity_resolution : null;
  const source = asString(identity && identity.resolution_source);
  const resolved = Boolean(identity) && (identity.canonicalization_applied === true || (source !== '' && source !== 'requested_route'));
  // FastAPI's bare `{"detail": "PRODUCT_NOT_FOUND"}`: a statement about the product with no code field.
  const statedNotFound = Boolean(data) && data.detail === 'PRODUCT_NOT_FOUND';
  const rawReason = asString(data && data.details && typeof data.details === 'object' ? data.details.reason : '');
  return {
    partnerDoorRead: { lane: pdpV2Detail ? 'pdp_v2' : 'backend', statedNotFound, resolved },
    reason: REASON_RE.test(rawReason) ? rawReason : null,
  };
}

/** The `detail.reason` a mapped read failure carries: the gate's own reason when it named one. */
function partnerDoorReadFailureReason(kernelCode, reason) {
  if (kernelCode === 'PRODUCT_NOT_SERVABLE') return reason || 'product_detail_not_found';
  if (kernelCode === 'UNKNOWN_PRODUCT_ID') return reason || 'product_id_not_found';
  return null;
}

/**
 * get_offers behind the partner door. Off, `getOffers` is returned as is. On:
 *   - a `product_id` that is a group id is resolved like get_product's (same resolver), or refused by name;
 *   - an empty answer always says why (`metadata.reason`);
 *   - the answer's metadata carries no `sig_`-shaped group id.
 * `fail(code, detail)` throws the door's error class (it lives in an ES module the caller already loads).
 */
function makePartnerDoorGetOffers({ getOffers, queryFn, fail, enabled = partnerDoorOneProductIdEnabled } = {}) {
  return async function partnerDoorGetOffers(params = {}, ctx) {
    if (!enabled()) return getOffers(params, ctx);
    const wrapped = params && typeof params === 'object' && params.payload && typeof params.payload === 'object';
    const p = wrapped ? params.payload : params || {};
    let next = params;
    if (asString(p.product_group_id)) {
      await fail('PRODUCT_GROUP_ID_NOT_PRODUCT_ID', { reason: 'product_group_id_argument', operation: 'get_offers' });
    }
    if (isIdentityGroupIdShape(p.product_id)) {
      const resolved = await resolveGroupIdToProductId({ groupId: p.product_id, queryFn });
      if (resolved.status !== 'resolved') await fail(...groupIdFailure(resolved, 'get_offers'));
      const payload = { ...p, product_id: resolved.productId };
      next = wrapped ? { ...params, payload } : payload;
    }
    const answer = await getOffers(next, ctx);
    if (!answer || typeof answer !== 'object') return answer;
    const metadata = answer.metadata && typeof answer.metadata === 'object' ? { ...answer.metadata } : {};
    if (/^sig_/i.test(asString(metadata.product_group_id))) metadata.product_group_id = null;
    const empty = !answer.best_offer && (!Array.isArray(answer.signals) || answer.signals.length === 0);
    if (empty && !asString(metadata.reason)) metadata.reason = 'no_offer_for_product';
    return { ...answer, metadata };
  };
}

const GROUP_ID_REFUSAL_REASONS = Object.freeze({
  several: 'group_has_several_products',
  none: 'group_has_no_servable_product',
  no_database: 'group_id_not_resolvable',
});

/**
 * The (code, detail) a group id that did not resolve to one product is refused with. Only a lookup that FAILED
 * is retriable; every other outcome is the terminal "this is a group id" refusal.
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
  GROUP_MEMBER_SIGNATURE_SQL,
  SIGNATURE_SELLERS_SQL,
  partnerDoorOneProductIdEnabled,
  isIdentityGroupIdShape,
  isCatalogSignatureShape,
  resolveGroupIdToProductId,
  listSignatureSellerIds,
  sellerMatchesProduct,
  describePartnerDoorReadFailure,
  partnerDoorReadFailureReason,
  makePartnerDoorGetOffers,
  groupIdFailure,
  usePartnerDoorQueryForTest,
};
