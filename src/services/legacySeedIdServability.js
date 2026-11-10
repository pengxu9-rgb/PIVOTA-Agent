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
//        database answers that no seed passes the route's own gate for ANY buyer (confirmNoOpenableLegacySeeds,
//        built from the same clause as the route, below). A probe that cannot be asked (no database, an error,
//        a timeout, the failure backoff) keeps the row. Only this case is dropped, and only while
//        SEARCH_DROP_LEGACY_SEED_IDS is on (default on).
//
// Everything else (`ext_…`/`ext:…`, `sig_`, observed sellers, connected merchants) is not touched.
//
// REVIEW GD-2: the drop asks the database ONCE per page (confirmNoOpenableLegacySeeds), under one TOTAL deadline
// that fails open (the page is sent as it would be with no check), remembers each answer for a few seconds
// (createLegacySeedProbeCache), and after a failed ask does not ask again for a few seconds
// (createLegacySeedProbeBackoff), so a slow or hung database adds at most the deadline, and an incident does
// not leave one more orphaned statement per search page.
//
// REVIEW P2-N1 (second delta): the drop and the route are ONE rule. The drop keeps a row exactly when the route
// can open it for some buyer: both statements are built from the same clause parts (LEGACY_SEED_GATE_PARTS),
// the route binding the buyer's currency and the drop accepting any currency a market is served in.
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
const { BUYER_REGION_CURRENCY } = require('../auroraBff/buyerRegion');
const { isGateEnabled: isPurchasabilityGateEnabled } = require('./merchantPurchasabilityClient');

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
  // with sig X next to the observed seller's own row for sig X). One id is one result. The row that was NOT
  // re-keyed is preferred (P3-g: the observed seller's own row is the listing; the re-keyed one is the shared
  // seller's copy of it), and it takes the place of the first occurrence, so the product keeps its rank. With
  // only re-keyed copies, the first stays. Only ids a re-key produced are judged, so a page with no re-key, or
  // its other rows, is not touched.
  const rekeyedIds = new Set();
  const rekeyedIndexes = new Set();
  holder.products.forEach((row, index) => {
    if (legacyRowDecision(row) === 'rekey') {
      rekeyedIds.add(rowSignature(row));
      rekeyedIndexes.add(index);
    }
  });
  const preferred = new Map();
  products.forEach((row, index) => {
    const pid = row && typeof row === 'object' ? rowProductId(row) : '';
    if (!pid || !rekeyedIds.has(pid)) return;
    const current = preferred.get(pid);
    if (!current || (current.rekeyed && !rekeyedIndexes.has(index))) {
      preferred.set(pid, { row, rekeyed: rekeyedIndexes.has(index) });
    }
  });
  const seen = new Set();
  let dedupedCount = 0;
  const unique = [];
  products.forEach((row) => {
    const pid = row && typeof row === 'object' ? rowProductId(row) : '';
    if (!pid || !rekeyedIds.has(pid)) {
      unique.push(row);
      return;
    }
    if (seen.has(pid)) {
      dedupedCount += 1;
      return;
    }
    seen.add(pid);
    unique.push(preferred.get(pid).row);
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
// P3-b: after a failed ask (the deadline, an error), how long the drop does not ask at all and keeps every
// unanswered row. A timed-out statement keeps running server-side until statement_timeout; without this, each
// search page during a database incident would leave one more of them. SEARCH_LEGACY_SEED_PROBE_FAILURE_BACKOFF_MS,
// clamped to [0, 60000]; 0 turns it off.
const DEFAULT_PROBE_FAILURE_BACKOFF_MS = 5000;
// P3-f: the budget of the re-routed detail statement (the route's own read). Past it the pair keeps the route it
// had before. LEGACY_SEED_DETAIL_DB_BUDGET_MS, clamped to [50, 5000].
const DEFAULT_DETAIL_DB_BUDGET_MS = 800;

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

function legacySeedProbeFailureBackoffMs(env = process.env) {
  return clampedIntEnv(env.SEARCH_LEGACY_SEED_PROBE_FAILURE_BACKOFF_MS, DEFAULT_PROBE_FAILURE_BACKOFF_MS, 0, 60000);
}

function legacySeedDetailDbBudgetMs(env = process.env) {
  return clampedIntEnv(env.LEGACY_SEED_DETAIL_DB_BUDGET_MS, DEFAULT_DETAIL_DB_BUDGET_MS, 50, 5000);
}

/** P3-b: per process, "a recent ask failed: do not ask again until then". */
function createLegacySeedProbeBackoff({ now = () => Date.now() } = {}) {
  let until = 0;
  return {
    active() {
      return now() < until;
    },
    trip(ms) {
      if (ms > 0) until = Math.max(until, now() + ms);
    },
    clear() {
      until = 0;
    },
  };
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
const PROCESS_PROBE_BACKOFF = createLegacySeedProbeBackoff();

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
 * P3-b: a failed ask trips `backoff` for `backoffMs`; while it is active nothing is asked (cached answers still
 * apply) and the unanswered rows are kept.
 * @returns {Promise<{ body: any, droppedIds: string[], failedOpenCount: number, cachedCount: number,
 *   backedOff: boolean }>}
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
    backoff = PROCESS_PROBE_BACKOFF,
    backoffMs = legacySeedProbeFailureBackoffMs(env),
  } = {},
) {
  const holder = productsHolder(body);
  const none = { body, droppedIds: [], failedOpenCount: 0, cachedCount: 0, backedOff: false };
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
  const backedOff = toAsk.length > 0 && Boolean(backoff) && backoff.active();
  if (toAsk.length && !backedOff) {
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
      // could not ask (no database, an error, the deadline): every unanswered row is kept, and the next pages
      // do not ask for a while (P3-b)
      if (backoff) backoff.trip(backoffMs);
    }
  }

  let failedOpenCount = 0;
  const dead = new Set();
  for (const { index, pid } of candidates) {
    const value = answers.get(pid);
    if (value === true) dead.add(index);
    else if (value !== false) failedOpenCount += 1;
  }
  if (!dead.size) return { body, droppedIds: [], failedOpenCount, cachedCount, backedOff };
  const droppedIds = [];
  const products = holder.products.filter((row, index) => {
    if (!dead.has(index)) return true;
    droppedIds.push(rowProductId(row));
    return false;
  });
  const extra = typeof holder.total === 'number'
    ? { total: Math.max(products.length, holder.total - droppedIds.length) }
    : {};
  return { body: withProducts(body, holder, products, extra), droppedIds, failedOpenCount, cachedCount, backedOff };
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
//
// P2-N1: the search drop is built from the SAME parts (`openableClause`), with the currency term widened from "the
// buyer's" to "a currency some market is served in" (BUYER_REGION_CURRENCY, the map resolveServingCurrency reads),
// because the drop answers for every buyer at once. So "the drop keeps it" is exactly "the route opens it for
// some buyer", and a quarantined, attached, seed_data-only, seed-id-only, inactive or currency-less seed leaves
// search instead of being served as a link that 404s.
const SEED_TABLE = 'external_product_seeds';
const SEED_CURRENCY_SQL = seedCurrencySql(SEED_TABLE);
const SERVED_SEED_CURRENCIES = Object.freeze(
  Array.from(new Set(Object.values(BUYER_REGION_CURRENCY).map((c) => String(c).trim().toUpperCase())))
    .filter((c) => /^[A-Z]{3}$/.test(c))
    .sort(),
);
function legacySeedGateClause(idExpr, currencyTerm) {
  return [
    `external_product_id = ${idExpr}`,
    'AND attached_product_key IS NULL',
    `AND ${SEED_CURRENCY_SQL} ${currencyTerm}`,
    buildQuarantineAntiJoinSql({
      domainExpr: `${SEED_TABLE}.domain`,
      merchantExpr: 'NULL',
      platformExpr: 'NULL',
      sourceSystemExpr: 'NULL',
      sourceRefExpr: 'NULL',
    }),
  ].join('\n      ');
}
const LEGACY_SEED_DETAIL_MATCH_CLAUSE = legacySeedGateClause('$1', '= $2');
const LEGACY_SEED_SERVED_CURRENCY_TERM = `IN (${SERVED_SEED_CURRENCIES.map((c) => `'${c}'`).join(', ')})`;
const LEGACY_SEED_OPENABLE_CLAUSE = legacySeedGateClause('req.id', LEGACY_SEED_SERVED_CURRENCY_TERM);

// The drop's statement: one row per requested id, `openable` = the route opens it for some buyer.
const LEGACY_SEED_OPENABLE_BATCH_SQL = `
  SELECT
    req.id AS product_id,
    EXISTS (SELECT 1 FROM ${SEED_TABLE} WHERE status = 'active' AND ${LEGACY_SEED_OPENABLE_CLAUSE}) AS openable
  FROM unnest($1::text[]) AS req(id)
`;

/**
 * The drop's question for a page of ids, in ONE statement: Map id -> true when NO seed passes the route's gate
 * for any buyer (no lane can open it), false when one does. An id the statement did not answer is absent
 * (unknown: the row is kept). Throws on a failed query or a malformed answer.
 */
async function confirmNoOpenableLegacySeeds(productIds, { queryFn }) {
  const ids = Array.from(new Set((Array.isArray(productIds) ? productIds : []).map((v) => text(v)).filter(Boolean)));
  if (!ids.length) return new Map();
  if (typeof queryFn !== 'function') throw new Error('no database is configured');
  const res = await queryFn(LEGACY_SEED_OPENABLE_BATCH_SQL, [ids]);
  if (!res || !Array.isArray(res.rows)) throw new Error('legacy seed openable batch returned no rows');
  const requested = new Set(ids);
  const out = new Map();
  for (const row of res.rows) {
    if (!row || typeof row !== 'object') throw new Error('legacy seed openable batch returned a malformed row');
    const id = typeof row.product_id === 'string' ? row.product_id : '';
    if (!requested.has(id)) throw new Error('legacy seed openable batch answered an id it was not asked');
    if (typeof row.openable !== 'boolean') throw new Error('legacy seed openable column is not boolean');
    out.set(id, row.openable === false);
  }
  return out;
}

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

function hostOf(url) {
  try {
    return new URL(text(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/**
 * P3-e: the merchant-purchasability gate, as a re-routed detail meets it. Off (MERCHANT_PURCHASABILITY_GATE_ENABLED,
 * the default) nothing is asked and the product is returned AS IS. Armed, the seed's merchant (its destination
 * page's host) is asked about for `market` through the SAME seam every offer path uses
 * (offersPriority.resolveOfferPurchasabilityDecisions, rail human, fail open); when it declines, the product goes
 * through the same decline (enrichOfferCommerceMetadata: every checkout URL on the merchant's host and every
 * "buyable here" claim removed, `purchase_route` the referral one) and keeps its browse link.
 * `deps` is injectable for a test; the defaults are the real seam.
 */
async function applyLegacySeedPurchasabilityGate(product, { market, env = process.env, deps = {} } = {}) {
  if (!product || typeof product !== 'object' || !isPurchasabilityGateEnabled(env)) return product;
  const offersPriority = deps.offersPriority || require('../offers/offersPriority');
  const domain = hostOf(product.destination_url) || hostOf(product.url) || hostOf(product.source_url);
  if (!domain) return product;
  const asked = { execution_spec: { merchant_domain: domain } };
  const key = offersPriority.readOfferMerchantDomain(asked);
  let declined = null;
  try {
    declined = await offersPriority.resolveOfferPurchasabilityDecisions([asked], {
      market,
      env,
      ...(typeof deps.shouldOfferPurchase === 'function' ? { shouldOfferPurchase: deps.shouldOfferPurchase } : {}),
    });
  } catch (_) {
    return product; // the seam does not throw; if it ever does, the previous behaviour
  }
  if (!(declined instanceof Set) || !key || !declined.has(key)) return product;
  const gated = offersPriority.enrichOfferCommerceMetadata({ ...product, execution_spec: asked.execution_spec }, {
    declinedDomains: declined,
  });
  const { execution_spec: _spec, ...out } = gated;
  return { ...out, merchant_purchasability: { offer: false, market: market || null } };
}

const SEARCH_OPS = new Set(['find_products_multi', 'find_products']);

/** The search ops whose responses this projection applies to (invoke egress and the commerce kernel). */
function isLegacySeedProjectedOp(op) {
  return SEARCH_OPS.has(text(op).toLowerCase());
}

module.exports = {
  LEGACY_SEED_DETAIL_MATCH_CLAUSE,
  LEGACY_SEED_OPENABLE_BATCH_SQL,
  LEGACY_SEED_OPENABLE_CLAUSE,
  LEGACY_SEED_PRODUCT_ID_RE,
  SERVED_SEED_CURRENCIES,
  applyLegacySeedPurchasabilityGate,
  confirmNoOpenableLegacySeeds,
  createLegacySeedProbeBackoff,
  createLegacySeedProbeCache,
  dropUnopenableLegacySeedRows,
  isLegacySeedDetailServable,
  isLegacySeedIdFilterEnabled,
  isLegacySeedProductId,
  isLegacySeedProjectedOp,
  isSharedSeedSeller,
  legacyRowDecision,
  legacySeedDetailDbBudgetMs,
  legacySeedDetailGate,
  legacySeedProbeCacheTtlMs,
  legacySeedProbeDeadlineMs,
  legacySeedProbeFailureBackoffMs,
  projectLegacySeedRows,
  routesToLegacySeedLane,
  __internal: { PROCESS_PROBE_BACKOFF, PROCESS_PROBE_CACHE },
};
