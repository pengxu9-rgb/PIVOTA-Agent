'use strict';

// Legacy seed ids: search serves them, so every door must be able to open them (FIX_PLAN D-06, G-4).
//
// THE COHORT. pivota-backend's enrichment ingest mints a seed's external_product_id as
// `<host-slug>:<16 hex>` (services/catalog_enrichment_agent/ingestion.py `_build_seed_inserts`:
// `f"{merchant_slug}:{seed_id.split(':')[-1]}"`, e.g. `shop-a:0123456789abcdef`). A seed whose catalog
// mirror row was re-keyed (ADR-009) is served under its observed seller (`merch_obs_…`) and a `sig_` id,
// and opens. A seed with no re-keyed mirror is served under the retired shared seller with that raw id.
//
// WHY IT DID NOT OPEN. The commerce get_product is merchant-scoped. For the shared seller and a non-`sig_`
// id, externalSeedLane.isSeedSupplyUnservableUpstream is false, so the kernel sent the read to the
// backend's /agent/shop/v1/invoke get_product_detail, which reads products_cache only and answered
// PRODUCT_NOT_FOUND (NO_MERCHANT_OFFER). The seed row itself is fine: the gateway's seed-DB detail lane
// (server.js fetchExternalSeedProductDetailFromDb, exact match on external_product_id) opens it.
//
// THE FIX IS A ROUTE, NOT A DROP.
//   1. get_product: `routesToLegacySeedLane` says when a read goes to the seed-DB lane first — a legacy id
//      with the shared seller or with no seller at all. The kernel (every executor door: /mcp, /ucp/mcp,
//      /public/mcp, ACP) and the direct invoke door both ask it.
//   2. search: every served legacy row advertises an id that opens.
//      - `rekey` (sync, projectLegacySeedRows): the row carries a `sig_` signature, so it advertises the
//        signature as its product_id (the signature lane opens it, as for every re-keyed row); the legacy
//        id stays in external_product_id;
//      - otherwise the legacy id is kept, because route 1 opens it, and a row with no link gets its
//        destination page as `url`;
//      - `drop` (async, dropUnopenableLegacySeedRows): TRULY CANNOT OPEN = no signature on the row AND the
//        database answers that no ACTIVE seed matches the id on any branch of the seed lane's own match set
//        (signatureSeedNotActive.confirmNoActiveSeedMatches, the twin of the lane's lookup). A probe that
//        cannot be asked (no database, an error, a timeout) keeps the row. Only this case is dropped, and
//        only while SEARCH_DROP_LEGACY_SEED_IDS is on (default on).
//
// Everything else (`ext_…`/`ext:…`, `sig_`, observed sellers, connected merchants) is not touched.

const { isExternalSeedSupplyMerchantId, isObservedSellerMerchantId } = require('./externalSeedLane');

// `<slug>:<16 lowercase hex>`. The slug is `_normalize_token(domain)` with spaces turned to '-', so only
// [a-z0-9] runs joined by single '-'.
const LEGACY_SEED_PRODUCT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{16}$/;

// The fields the eval harness and agents read as a row's link (scripts/agent-readiness-eval/lib/responses.cjs).
const LINK_FIELDS = ['pivota_url', 'pdp_url', 'url', 'canonical_url', 'pivota_canonical_url'];

function text(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function isLegacySeedProductId(productId) {
  const pid = text(productId);
  if (!LEGACY_SEED_PRODUCT_ID_RE.test(pid)) return false;
  // `ext:<…>` is the seed-routed id prefix (pdpRenderability.isSeedRoutedLane), not this cohort.
  return !pid.startsWith('ext:');
}

/** The retired shared seed seller: seed supply that is not a per-brand observed seller. */
function isSharedSeedSeller(merchantId) {
  const mid = text(merchantId);
  return isExternalSeedSupplyMerchantId(mid) && !isObservedSellerMerchantId(mid);
}

/** get_product: does this (merchant, id) pair open on the seed-DB lane? A legacy id, shared or no seller. */
function routesToLegacySeedLane(merchantId, productId) {
  if (!isLegacySeedProductId(productId)) return false;
  const mid = text(merchantId);
  return mid === '' || isSharedSeedSeller(mid);
}

function rowMerchantId(row) {
  return text(row.merchant_id) || text(row.merchantId);
}

function rowProductId(row) {
  return text(row.product_id) || text(row.productId) || text(row.id);
}

function rowSignature(row) {
  return [row.pivota_signature_id, row.signature_id].map(text).find((v) => v.startsWith('sig_')) || '';
}

/** null when the row is not a legacy shared-seller row; else 'rekey' (it carries a signature) or 'probe'. */
function legacyRowDecision(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (!isSharedSeedSeller(rowMerchantId(row)) || !isLegacySeedProductId(rowProductId(row))) return null;
  return rowSignature(row) ? 'rekey' : 'probe';
}

function isLegacySeedIdFilterEnabled(env = process.env) {
  const raw = String(env.SEARCH_DROP_LEGACY_SEED_IDS ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON: a row no lane can open is not a search result
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function rekeyRow(row) {
  const sig = rowSignature(row);
  const out = { ...row, product_id: sig, id: sig };
  if (!text(out.external_product_id)) out.external_product_id = rowProductId(row);
  return out;
}

function linkRow(row) {
  if (LINK_FIELDS.some((f) => text(row[f]))) return row;
  const link = text(row.destination_url) || text(row.external_redirect_url);
  return link ? { ...row, url: link } : row;
}

function productsHolder(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Array.isArray(body.products)) return body;
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data) && Array.isArray(body.data.products)) {
    return body.data;
  }
  return null;
}

function withProducts(body, holder, products, extra = {}) {
  const nextHolder = { ...holder, products, ...extra };
  return holder === body ? nextHolder : { ...body, data: nextHolder };
}

/**
 * SYNC half: legacy shared-seller rows advertise an id that opens (a carried signature), and a kept legacy
 * row with no link gets its destination page. Drops nothing. Returns the SAME body when nothing changes;
 * never mutates its input. `probeIds` are the rows dropUnopenableLegacySeedRows will ask about.
 */
function projectLegacySeedRows(body) {
  const holder = productsHolder(body);
  const none = { body, rekeyedCount: 0, linkedCount: 0, probeIds: [] };
  if (!holder) return none;
  let rekeyedCount = 0;
  let linkedCount = 0;
  const probeIds = [];
  const products = holder.products.map((row) => {
    const decision = legacyRowDecision(row);
    if (decision === 'rekey') {
      rekeyedCount += 1;
      return rekeyRow(row);
    }
    if (decision === 'probe') {
      probeIds.push(rowProductId(row));
      const out = linkRow(row);
      if (out !== row) linkedCount += 1;
      return out;
    }
    return row;
  });
  if (!rekeyedCount && !linkedCount) return { ...none, probeIds };
  return { body: withProducts(body, holder, products), rekeyedCount, linkedCount, probeIds };
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('legacy seed probe timed out')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * ASYNC half: drop the legacy rows that TRULY cannot open (header). `noActiveSeed(id)` resolves true only
 * when the database says no active seed matches; it throws when it cannot ask, and the row is kept.
 * @returns {Promise<{ body: any, droppedIds: string[], failedOpenCount: number }>}
 */
async function dropUnopenableLegacySeedRows(
  body,
  { noActiveSeed, env = process.env, concurrency = 4, timeoutMs = 1500 } = {},
) {
  const holder = productsHolder(body);
  const none = { body, droppedIds: [], failedOpenCount: 0 };
  if (!holder || !isLegacySeedIdFilterEnabled(env) || typeof noActiveSeed !== 'function') return none;
  const candidates = [];
  holder.products.forEach((row, index) => {
    if (legacyRowDecision(row) === 'probe') candidates.push({ index, pid: rowProductId(row) });
  });
  if (!candidates.length) return none;
  const dead = new Set();
  let failedOpenCount = 0;
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < candidates.length; i = cursor++) {
      try {
        if ((await withTimeout(noActiveSeed(candidates[i].pid), timeoutMs)) === true) dead.add(candidates[i].index);
      } catch (_) {
        failedOpenCount += 1; // could not ask: keep the row
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  if (!dead.size) return { body, droppedIds: [], failedOpenCount };
  const droppedIds = [];
  const products = holder.products.filter((row, index) => {
    if (!dead.has(index)) return true;
    droppedIds.push(rowProductId(row));
    return false;
  });
  const extra = typeof holder.total === 'number'
    ? { total: Math.max(products.length, holder.total - droppedIds.length) }
    : {};
  return { body: withProducts(body, holder, products, extra), droppedIds, failedOpenCount };
}

const SEARCH_OPS = new Set(['find_products_multi', 'find_products']);

/** The search ops whose responses this projection applies to (invoke egress and the commerce kernel). */
function isLegacySeedProjectedOp(op) {
  return SEARCH_OPS.has(text(op).toLowerCase());
}

module.exports = {
  LEGACY_SEED_PRODUCT_ID_RE,
  dropUnopenableLegacySeedRows,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  isLegacySeedProjectedOp,
  isSharedSeedSeller,
  legacyRowDecision,
  projectLegacySeedRows,
  routesToLegacySeedLane,
};
