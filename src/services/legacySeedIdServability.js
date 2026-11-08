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
//
// REVIEW GD-2: the drop asks the database ONCE per page (signatureSeedNotActive.confirmNoActiveSeedMatchesBatch),
// under one TOTAL deadline that fails open (the page is sent as it would be with no check), and remembers each
// answer for a few seconds (createLegacySeedProbeCache), so a slow or hung database adds at most the deadline.
//
// REVIEW GD-3: the route opens a legacy id only through `legacySeedDetailGate`, the gates a normal seed detail
// read is held to: no seed from a quarantined source, no seed attached to a catalog product (that product is
// served under its own id), and only a seed priced in the buyer's currency (the buyer's declared market; silence
// is the served default). A pair the gate refuses keeps the route it had before.

const { isExternalSeedSupplyMerchantId, isObservedSellerMerchantId } = require('./externalSeedLane');
const { resolveServingCurrency } = require('./buyerMarket');
const { filterProductsToServingCurrency } = require('./servingCurrencyGuard');
const { seedCurrencySql } = require('./seedSearchOfferScope');
const { buildQuarantineAntiJoinSql } = require('./sourceQuarantine');

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
  const none = { body, rekeyedCount: 0, linkedCount: 0, dedupedCount: 0, probeIds: [] };
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
  // GD-4: a re-keyed row can now carry the same id as a row already on the page (a shared-seller legacy row
  // with sig X next to the observed seller's own row for sig X). One id is one result: the first one stays.
  // Only ids a re-key produced are judged, so a page with no re-key, or its other rows, is not touched.
  const rekeyedIds = new Set();
  holder.products.forEach((row) => {
    if (legacyRowDecision(row) === 'rekey') rekeyedIds.add(rowSignature(row));
  });
  const seen = new Set();
  let dedupedCount = 0;
  const unique = products.filter((row) => {
    const pid = row && typeof row === 'object' ? rowProductId(row) : '';
    if (!pid || !rekeyedIds.has(pid)) return true;
    if (seen.has(pid)) {
      dedupedCount += 1;
      return false;
    }
    seen.add(pid);
    return true;
  });
  const extra = dedupedCount && typeof holder.total === 'number'
    ? { total: Math.max(unique.length, holder.total - dedupedCount) }
    : {};
  return { body: withProducts(body, holder, unique, extra), rekeyedCount, linkedCount, dedupedCount, probeIds };
}

// GD-2: the whole drop's budget. Short, because the answer only removes rows; past it the page is sent as it
// would be with no check. SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS, clamped to [20, 2000].
const DEFAULT_PROBE_DEADLINE_MS = 250;
// GD-2: how long one id's answer is remembered. SEARCH_LEGACY_SEED_PROBE_CACHE_TTL_MS, clamped to [0, 300000]; 0
// turns the cache off.
const DEFAULT_PROBE_CACHE_TTL_MS = 30000;
const PROBE_CACHE_MAX_ENTRIES = 5000;

function clampedIntEnv(raw, fallback, min, max) {
  const text = String(raw ?? '').trim();
  if (text === '') return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function legacySeedProbeDeadlineMs(env = process.env) {
  return clampedIntEnv(env.SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS, DEFAULT_PROBE_DEADLINE_MS, 20, 2000);
}

function legacySeedProbeCacheTtlMs(env = process.env) {
  return clampedIntEnv(env.SEARCH_LEGACY_SEED_PROBE_CACHE_TTL_MS, DEFAULT_PROBE_CACHE_TTL_MS, 0, 300000);
}

/** A small per-process TTL cache of the database's answers: id -> true (no active seed) | false (one is active). */
function createLegacySeedProbeCache({ maxEntries = PROBE_CACHE_MAX_ENTRIES, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(id) {
      const hit = entries.get(id);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      return hit.value;
    },
    set(id, value, ttlMs) {
      if (!(ttlMs > 0) || typeof value !== 'boolean') return;
      entries.delete(id);
      entries.set(id, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

const PROCESS_PROBE_CACHE = createLegacySeedProbeCache();

function withDeadline(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('legacy seed probe deadline exceeded')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// The per-id form (`noActiveSeed(id)`) as a batch, for a caller that has no batch statement: each id that
// throws is simply unanswered, so only its row is kept.
function batchFromPerId(noActiveSeed) {
  return async (ids) => {
    const out = new Map();
    await Promise.all(ids.map(async (id) => {
      try {
        const answer = await noActiveSeed(id);
        if (typeof answer === 'boolean') out.set(id, answer);
      } catch (_) {
        // could not ask about this id: it stays unanswered
      }
    }));
    return out;
  };
}

/**
 * ASYNC half: drop the legacy rows that TRULY cannot open (header).
 *
 * `noActiveSeeds(ids)` asks about the whole page at once and resolves a Map id -> true (no active seed
 * matches) | false; an id missing from it is unknown, and a throw means it could not ask. Only a literal
 * `true` drops a row. (`noActiveSeed(id)`, the per-id form, is still accepted.)
 *
 * GD-2: ONE call per page, under ONE total deadline (`deadlineMs`); past it, or on any failure, every
 * unanswered row is kept, so the page is exactly the fail-open page. Answers are remembered for `cacheTtlMs`.
 * @returns {Promise<{ body: any, droppedIds: string[], failedOpenCount: number, cachedCount: number }>}
 */
async function dropUnopenableLegacySeedRows(
  body,
  {
    noActiveSeeds,
    noActiveSeed,
    env = process.env,
    deadlineMs = legacySeedProbeDeadlineMs(env),
    cache = PROCESS_PROBE_CACHE,
    cacheTtlMs = legacySeedProbeCacheTtlMs(env),
  } = {},
) {
  const holder = productsHolder(body);
  const none = { body, droppedIds: [], failedOpenCount: 0, cachedCount: 0 };
  const ask = typeof noActiveSeeds === 'function'
    ? noActiveSeeds
    : typeof noActiveSeed === 'function' ? batchFromPerId(noActiveSeed) : null;
  if (!holder || !isLegacySeedIdFilterEnabled(env) || !ask) return none;
  const candidates = [];
  holder.products.forEach((row, index) => {
    if (legacyRowDecision(row) === 'probe') candidates.push({ index, pid: rowProductId(row) });
  });
  if (!candidates.length) return none;

  const answers = new Map();
  let cachedCount = 0;
  const useCache = Boolean(cache) && cacheTtlMs > 0;
  if (useCache) {
    for (const { pid } of candidates) {
      const hit = cache.get(pid);
      if (typeof hit === 'boolean' && !answers.has(pid)) {
        answers.set(pid, hit);
        cachedCount += 1;
      }
    }
  }
  const toAsk = Array.from(new Set(candidates.map((c) => c.pid).filter((pid) => !answers.has(pid))));
  if (toAsk.length) {
    try {
      const fresh = await withDeadline(ask(toAsk), deadlineMs);
      if (fresh instanceof Map) {
        for (const pid of toAsk) {
          const value = fresh.get(pid);
          if (typeof value !== 'boolean') continue;
          answers.set(pid, value);
          if (useCache) cache.set(pid, value, cacheTtlMs);
        }
      }
    } catch (_) {
      // could not ask (no database, an error, the deadline): every unanswered row is kept
    }
  }

  let failedOpenCount = 0;
  const dead = new Set();
  for (const { index, pid } of candidates) {
    const value = answers.get(pid);
    if (value === true) dead.add(index);
    else if (value !== false) failedOpenCount += 1;
  }
  if (!dead.size) return { body, droppedIds: [], failedOpenCount, cachedCount };
  const droppedIds = [];
  const products = holder.products.filter((row, index) => {
    if (!dead.has(index)) return true;
    droppedIds.push(rowProductId(row));
    return false;
  });
  const extra = typeof holder.total === 'number'
    ? { total: Math.max(products.length, holder.total - droppedIds.length) }
    : {};
  return { body: withProducts(body, holder, products, extra), droppedIds, failedOpenCount, cachedCount };
}

// ---- GD-3: the gates a re-routed legacy detail read is held to -------------------------------------------

// The seed-DB detail statement's match clause for a legacy id (server.js fetchExternalSeedProductDetailFromDb,
// `legacySeedGate`). $1 = the legacy id, $2 = the buyer's serving currency. A seed is opened only when:
//   - it is the id's own row (exact external_product_id; a legacy id is minted there and nowhere else);
//   - it is not attached to a catalog product (a normal read serves that product under its own id, and the
//     backend REST seed lookup refuses an attached seed the same way);
//   - its currency is the buyer's: column and page read agree (seedSearchOfferScope.seedCurrencySql), so an SG
//     buyer is never handed a USD seed, whichever partition it is filed under;
//   - its source is not quarantined. external_product_seeds carries only a domain, so only `domain`
//     quarantines can match a seed row (the backend's seed seam passes NULL for the other three for the same
//     reason); the domain expression is table-qualified, as the backend's is.
const SEED_TABLE = 'external_product_seeds';
const LEGACY_SEED_DETAIL_MATCH_CLAUSE = [
  'external_product_id = $1',
  'AND attached_product_key IS NULL',
  `AND ${seedCurrencySql(SEED_TABLE)} = $2`,
  buildQuarantineAntiJoinSql({
    domainExpr: `${SEED_TABLE}.domain`,
    merchantExpr: 'NULL',
    platformExpr: 'NULL',
    sourceSystemExpr: 'NULL',
    sourceRefExpr: 'NULL',
  }),
].join('\n      ');

/**
 * What a re-routed legacy read may serve for this buyer: null when the buyer's market has no single serving
 * currency (several markets, an unkeyable value), and then the pair is NOT re-routed. Silence is the served
 * default, the same rule every search door applies (buyerMarket.resolveServingCurrency).
 */
function legacySeedDetailGate(requestedMarket, env = process.env) {
  const servingCurrency = resolveServingCurrency(requestedMarket, env);
  return servingCurrency ? { servingCurrency, matchClause: LEGACY_SEED_DETAIL_MATCH_CLAUSE } : null;
}

/**
 * The built detail, checked again with the door's own currency test (servingCurrencyGuard): every currency it
 * states is the buyer's, and a price that states none is refused. A detail that quotes no price is kept: it has
 * nothing to be in the wrong currency, and the statement already required the seed's currency to be the buyer's.
 */
function isLegacySeedDetailServable(product, gate) {
  if (!gate || !gate.servingCurrency || !product || typeof product !== 'object') return false;
  return filterProductsToServingCurrency([product], gate.servingCurrency).length === 1;
}

const SEARCH_OPS = new Set(['find_products_multi', 'find_products']);

/** The search ops whose responses this projection applies to (invoke egress and the commerce kernel). */
function isLegacySeedProjectedOp(op) {
  return SEARCH_OPS.has(text(op).toLowerCase());
}

module.exports = {
  LEGACY_SEED_DETAIL_MATCH_CLAUSE,
  LEGACY_SEED_PRODUCT_ID_RE,
  createLegacySeedProbeCache,
  dropUnopenableLegacySeedRows,
  isLegacySeedDetailServable,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  isLegacySeedProjectedOp,
  isSharedSeedSeller,
  legacyRowDecision,
  legacySeedDetailGate,
  legacySeedProbeCacheTtlMs,
  legacySeedProbeDeadlineMs,
  projectLegacySeedRows,
  routesToLegacySeedLane,
  __internal: { PROCESS_PROBE_CACHE },
};
