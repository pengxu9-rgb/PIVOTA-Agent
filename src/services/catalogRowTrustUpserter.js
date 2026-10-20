'use strict';

// Layer C1 Phase 2 — catalogRowTrustUpserter (Node)
//
// Thin I/O wrapper around catalogTrustPolicy.deriveTrust. Same JOIN shape as
// scripts/backfill-catalog-row-trust.cjs (the Phase 1 backfill) so the
// steady-state producer output always matches the periodic backfill output.
//
// Usage from producers:
//   const { upsertCatalogRowTrust } = require('./catalogRowTrustUpserter');
//   // fire-and-forget after a catalog write:
//   upsertCatalogRowTrust(pool, productKey).catch(() => {}); // logged inside
//
// All public functions are fire-and-forget: exceptions are logged and
// swallowed so a trust-upsert failure NEVER breaks a producer.
//
// This module exports:
//   upsertCatalogRowTrust(pool, productKey, [now])
//   upsertCatalogRowTrustMany(pool, productKeys, [now])

const { Pool } = require('pg');
const logger = require('../logger');

const {
  CRAWL_FRESH_DEFAULT_DAYS,
  CRAWL_SOURCE_SYSTEM,
  POLICY_VERSION,
  deriveTrust,
  isCrawlFresh,
  isCrawlListing,
} = require('./catalogTrustPolicy');
const {
  pdpRouteResolvableFromRow,
  seedRouteResolvesSql,
} = require('./pdpRenderability');
const { pricedOfferExistsSql, pricedOfferRowConjuncts } = require('./pricedOfferSql');
const { OFFER_UNAVAILABLE_AVAILABILITIES } = require('./offerAvailabilitySql');

// ---------------------------------------------------------------------------
// SQL — kept literal & in sync with scripts/backfill-catalog-row-trust.cjs.
// Any change here must be mirrored in the Python upserter and Node backfill.
// ---------------------------------------------------------------------------

const PRODUCT_JOIN_SQL = `
  WITH external_seed_one AS (
    SELECT DISTINCT ON (external_product_id)
      id, external_product_id, status, domain, attached_product_key, updated_at, seed_kind
    FROM external_product_seeds
    ORDER BY
      external_product_id,
      (status = 'active') DESC,
      updated_at DESC NULLS LAST,
      created_at DESC NULLS LAST,
      id DESC
  ),
  minted_seed_one AS (
    -- Path-C minted canonicals (catalog_enrichment_agent_v1) attach one seed
    -- PER OFFER to the same product_key, so their seed join must be keyed by
    -- attached_product_key and deduped here or the product join would fan out
    -- per offer. Preference order: a seed that CARRIES an identity listing
    -- outranks a merely-newer sibling — the winner's external_product_id is
    -- the pil join key below, so picking an identity-less sibling would
    -- re-derive IDENTITY_CONFIDENCE_NULL nondeterministically as updated_at
    -- values move.
    SELECT DISTINCT ON (s.attached_product_key)
      s.id, s.external_product_id, s.status, s.domain, s.attached_product_key, s.updated_at, s.seed_kind
    FROM external_product_seeds s
    LEFT JOIN pdp_identity_listing spl
      ON spl.product_id = s.external_product_id
    WHERE s.attached_product_key IS NOT NULL
    ORDER BY
      s.attached_product_key,
      (spl.product_id IS NOT NULL) DESC,
      (s.status = 'active') DESC,
      s.updated_at DESC NULLS LAST,
      s.created_at DESC NULLS LAST,
      s.id DESC
  ),
  merchant_store_one AS (
    SELECT DISTINCT ON (merchant_id, platform)
      merchant_id, platform, domain, status, last_sync
    FROM merchant_stores
    ORDER BY
      merchant_id,
      platform,
      (status = 'active') DESC,
      is_primary DESC NULLS LAST,
      last_sync DESC NULLS LAST,
      created_at DESC NULLS LAST,
      store_id DESC
  ),
  identity_override_one AS (
    SELECT DISTINCT ON (source_listing_ref)
      id, source_listing_ref, action_type, active
    FROM pdp_identity_override
    WHERE active = TRUE
    ORDER BY
      source_listing_ref,
      updated_at DESC NULLS LAST,
      created_at DESC NULLS LAST,
      id DESC
  )
  SELECT
    cp.product_key,
    cp.content_key,
    cp.merchant_id,
    cp.platform,
    cp.source_system,
    cp.source_ref,
    cp.source_product_id,
    cp.source_domain,
    cp.sync_status,
    cp.suppression_reason,
    cp.last_seen_in_sync_at,

    ips.serving_eligible,
    ips.pipeline_stage,
    ips.blocker_code,
    ips.content_quality_score,
    ips.quality_scored_at,
    ips.last_extracted_at,

    pil.source_listing_ref AS pil_source_listing_ref,
    pil.identity_status,
    pil.identity_confidence,
    pil.live_read_enabled,
    pil.review_required,
    pil.sellable_item_group_id,
    pil.product_line_id,
    pil.review_family_id,

    -- c1.v0.5 renderability input. NOT the same question as the eps join
    -- below: eps is restricted to source_system='external_product_seeds_mirror_v1',
    -- while the gateway routes through seeds on TWO keys and this answers for
    -- both. Path-C minted rows join their seed by attached_product_key, exactly
    -- like the minted_seed_one CTE; since P3 (2026-07-25) the gateway resolves
    -- that key too, so they answer TRUE here whenever an acceptable attached
    -- seed exists and their PDPs render. They answered FALSE — and 500ed —
    -- until P3 shipped.
    ` + seedRouteResolvesSql('cp') + ` AS pdp_seed_route_ok,

    -- PER-ROW price input for the OFFER_PRICE_MISSING gate. This is the one
    -- serving signal that CANNOT be taken from the ips join below: that join is
    -- 'ips.content_key = cp.content_key', and index_pipeline_state stores ONE
    -- state per content_key (its primary key, migration 098) chosen from the
    -- best of that key's catalog_products rows. Every product_key mints its own
    -- pivota_signature_id and therefore its own public PDP, so reading price
    -- eligibility off the content-grained row publishes a price-less PDP
    -- whenever a priced SIBLING carries the content_key's state.
    --
    -- That is not hypothetical: it put 4 Tom Ford fragrance PDPs on the public
    -- surface with no price on 2026-07-31, each sharing its content_key with a
    -- priced tomfordbeauty.com row while its own single offer had list_price,
    -- merchant_effective_price and estimated_best_price ALL NULL and no
    -- suppression. index_pipeline_state's has_price was never wrong — it was
    -- answering about a different row.
    ` + pricedOfferExistsSql('cp.product_key') + ` AS row_has_priced_offer,

    -- c1.v0.7 canonical-election input. THE grain bridge, and the reason the
    -- OFFER_PRICE_MISSING gate above is a backstop rather than the fix.
    --
    -- content_canonical_election (mig 181) elects ONE pivota_signature_id per
    -- content_key: the single URL the sitemap advertises and that every sibling
    -- sig's PDP names in <link rel="canonical">. index_pipeline_state answers
    -- for the CONTENT, catalog_row_trust answers for the ROW, and this is the
    -- fact that connects them — without it a non-elected sibling inherits the
    -- content-grained verdict and gets promoted as though it were canonical.
    --
    -- Measured on prod 2026-07-31: 121 of 6,814 trust-public rows are NOT their
    -- content_key's elected canonical, every one on a multi-row content_key.
    -- The 4 Tom Ford rows behind OFFER_PRICE_MISSING were 4 of them.
    --
    -- TRI-STATE and it must stay that way: TRUE/FALSE when an election exists,
    -- NULL when it does not. 32 multi-row content_keys still have no election
    -- and must be left alone, not demoted.
    (
      SELECT (cce.canonical_sig_id = cp.pivota_signature_id)
      FROM content_canonical_election cce
      WHERE cce.content_key = cp.content_key
    ) AS row_is_elected_canonical,

    COALESCE(eps.id, epm.id)                                     AS eps_id,
    COALESCE(eps.status, epm.status)                             AS eps_status,
    COALESCE(eps.domain, epm.domain)                             AS eps_domain,
    COALESCE(eps.attached_product_key, epm.attached_product_key) AS eps_attached_product_key,
    COALESCE(eps.updated_at, epm.updated_at)                     AS eps_last_seen_at,
    COALESCE(eps.seed_kind, epm.seed_kind)                       AS eps_seed_kind,

    ms.merchant_id    AS ms_merchant_id,
    ms.platform       AS ms_platform,
    ms.domain         AS ms_domain,
    ms.status         AS ms_status,
    ms.last_sync      AS ms_last_sync,

    pio.id            AS override_id,
    pio.action_type   AS override_action_type,
    pio.active        AS override_active

  FROM catalog_products cp
  LEFT JOIN index_pipeline_state ips
    ON ips.content_key = cp.content_key
  LEFT JOIN external_seed_one eps
    -- ADR-009: match by source_system, NOT merchant_id='external_seed'. External
    -- seeds now mirror under per-brand observed sellers (merch_obs_…); the legacy
    -- merchant_id conjunct excluded those rows → eps NULL → source lifecycle
    -- 'unknown' → a disabled merch_obs_ seed never propagated its inactive block.
    -- source_system already scopes the join to seed-mirror rows only. Mirrors the
    -- Python twin (services/catalog_row_trust_upserter.py); MUST stay in sync or
    -- this backfill re-derives 'unknown' and overwrites the Python fix.
    ON cp.source_system = 'external_product_seeds_mirror_v1'
   AND eps.external_product_id = cp.source_product_id
  LEFT JOIN minted_seed_one epm
    -- Path-C minted canonicals: seeds attach by attached_product_key (their
    -- source_product_id is a canonical name slug, not a seed id).
    ON cp.source_system = 'catalog_enrichment_agent_v1'
   AND epm.attached_product_key = cp.product_key
  LEFT JOIN pdp_identity_listing pil
    -- Identity rows for external-seed supply are keyed by the SEED id
    -- (pil.product_id = eps.external_product_id). Mirror rows carry that id in
    -- cp.source_product_id; minted rows must route through their attached seed
    -- (epm) or the pil join silently misses and trust re-derives
    -- IDENTITY_CONFIDENCE_NULL forever (the shadow-forever bug on the Jul-16
    -- minted cohort). MUST stay in sync with the Python twin.
    ON pil.merchant_id = cp.merchant_id
   AND pil.product_id = CASE
         WHEN cp.source_system = 'catalog_enrichment_agent_v1'
           THEN epm.external_product_id
         ELSE cp.source_product_id
       END
  LEFT JOIN merchant_store_one ms
    ON ms.merchant_id = cp.merchant_id AND ms.platform = cp.platform
  LEFT JOIN identity_override_one pio
    ON pio.source_listing_ref = pil.source_listing_ref AND pio.active = TRUE
`;

const SELECT_BY_KEY_SQL = PRODUCT_JOIN_SQL + '  WHERE cp.product_key = $1\n';

const SELECT_BY_KEYS_SQL =
  PRODUCT_JOIN_SQL +
  '  WHERE cp.product_key = ANY($1::text[])\n  ORDER BY cp.product_key\n  LIMIT $2\n';

const QUARANTINE_SQL = `
  SELECT quarantine_id, match_type, match_value, state, expires_at
  FROM catalog_source_quarantine
  WHERE state = 'active'
    AND (expires_at IS NULL OR expires_at > now())
`;

const UPSERT_SQL = `
  INSERT INTO catalog_row_trust (
    subject_type, subject_key,
    product_key, source_listing_ref, content_key, source_id, source_domain,
    source_lifecycle_state, source_last_checked_at,
    identity_status, identity_confidence,
    matched_product_key, matched_content_key, matched_sellable_item_group_id,
    freshness_state, last_verified_at, verification_source,
    serving_decision, serving_reason_codes,
    manual_override_id, policy_version, updated_at
  ) VALUES (
    $1, $2,
    $3, $4, $5, $6, $7,
    $8, $9,
    $10, $11,
    $12, $13, $14,
    $15, $16, $17,
    $18, $19,
    $20, $21, now()
  )
  ON CONFLICT (subject_type, subject_key) DO UPDATE SET
    product_key = EXCLUDED.product_key,
    source_listing_ref = EXCLUDED.source_listing_ref,
    content_key = EXCLUDED.content_key,
    source_id = EXCLUDED.source_id,
    source_domain = EXCLUDED.source_domain,
    source_lifecycle_state = EXCLUDED.source_lifecycle_state,
    source_last_checked_at = EXCLUDED.source_last_checked_at,
    identity_status = EXCLUDED.identity_status,
    identity_confidence = EXCLUDED.identity_confidence,
    matched_product_key = EXCLUDED.matched_product_key,
    matched_content_key = EXCLUDED.matched_content_key,
    matched_sellable_item_group_id = EXCLUDED.matched_sellable_item_group_id,
    freshness_state = EXCLUDED.freshness_state,
    last_verified_at = EXCLUDED.last_verified_at,
    verification_source = EXCLUDED.verification_source,
    serving_decision = EXCLUDED.serving_decision,
    serving_reason_codes = EXCLUDED.serving_reason_codes,
    manual_override_id = EXCLUDED.manual_override_id,
    policy_version = EXCLUDED.policy_version,
    updated_at = now()
  WHERE catalog_row_trust.policy_version <> EXCLUDED.policy_version
     OR catalog_row_trust.serving_decision <> EXCLUDED.serving_decision
     OR catalog_row_trust.serving_reason_codes <> EXCLUDED.serving_reason_codes
     OR catalog_row_trust.source_lifecycle_state <> EXCLUDED.source_lifecycle_state
     OR catalog_row_trust.identity_status <> EXCLUDED.identity_status
`;

// ---------------------------------------------------------------------------
// CRAWL_FRESH input (2026-10-20) — default OFF
// ---------------------------------------------------------------------------
//
// Twin of pivota-backend services/catalog_row_trust_upserter.py (the
// CRAWL_FRESH block there).
//
// THE SWITCH LIVES HERE, NOT IN THE POLICY. catalog_row_trust is shared state
// written by this service (on identity events) and by the pivota-backend twin
// (its cron and hooks), so whatever decides a row must be computed identically
// on both sides. The policy stays a pure function of its inputs; this upserter
// decides whether to SUPPLY the `crawl_fresh` input at all.
//
//   * OFF (default): no extra query runs and the input key is never set, so the
//     inputs object, every decision, every reason code and POLICY_VERSION are
//     byte-identical to main.
//   * ON: drain-lane crawl rows (catalogTrustPolicy.isCrawlListing: retailer
//     listings and brand-official / curated `ext:` canonicals) get
//     `crawl_fresh` = true/false from the newest price read below.
//
// 🚨 SET IT ON BOTH SERVICES OR NEITHER, and set the SAME N. With it on one side
// only, that side writes the fresh listings 'public' and the other re-derives
// them 'shadow' on its next recompute: rows FLAP on the live serving surface.
// The rule CATALOG_TRUST_RENDERABLE_GATE documents, unchanged.
//
// A FAILED READ FAILS CLOSED, PER BATCH, as in the backend (round 3): the
// freshness statement and the column probe run isolated (isolatedQuery: a
// SAVEPOINT on a client in a transaction), and a failed freshness read leaves
// the input unset for that batch, which then writes the flag-off verdicts. It
// never throws into the caller's transaction (the retire-demo scripts pass a
// client inside BEGIN).
//
// NO DECAY RECHECK HERE. The backend's trust cron re-derives, every tick, the
// CRAWL_FRESH rows whose read may age out (and, switched off, every CRAWL_FRESH
// row), with CATALOG_TRUST_CRAWL_FRESH_RECHECK_LIMIT bounding it. That is a
// backend-cron-only job and env var; this repo only recomputes on identity
// events, and does so with exactly the input rule below.
//
// Not a separate SELECT column in the product join, deliberately: with the
// switch off the join text stays byte-identical to main, a database whose
// catalog_offers lacks price_checked_at is never sent a statement naming it,
// and the lookup runs only for the drain-lane rows of a batch.
const CRAWL_FRESH_ENV = 'CATALOG_TRUST_CRAWL_FRESH_ENABLED';
const CRAWL_FRESH_DAYS_ENV = 'CATALOG_TRUST_CRAWL_FRESH_DAYS';

const CRAWL_FRESH_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Default OFF. The same truthy spelling as the policy's other switches. */
function crawlFreshEnabled() {
  return CRAWL_FRESH_TRUTHY.has(String(process.env[CRAWL_FRESH_ENV] ?? '').trim().toLowerCase());
}

// The decimal spellings Python's float() accepts (digits, one point, an
// exponent, `_` between digits). Number() alone would also take hex / octal /
// binary literals ('0x10' -> 16) that the twin rejects, and reject the `_`
// spellings the twin takes; this keeps the two answering alike. inf / nan
// spellings are rejected on both sides (Python parses them, then the positivity
// and finiteness test sends them to the default, as here).
const PY_FLOAT_DECIMAL = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;

// Python's float() also reads any Unicode decimal digit (General_Category Nd:
// fullwidth '３', Arabic-Indic '٣', mathematical '𝟓', ...) as its ASCII value.
// Unicode guarantees every Nd digit sits in a contiguous run of whole 0..9
// blocks, so a digit's value is its offset from the start of its run, mod 10.
const UNICODE_DECIMAL_DIGIT = /\p{Nd}/u;
function asciiDigits(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 || !UNICODE_DECIMAL_DIGIT.test(ch)) {
      out += ch;
      continue;
    }
    let start = cp;
    while (start > 0 && UNICODE_DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
    out += String((cp - start) % 10);
  }
  return out;
}

/**
 * N for "crawl-fresh", in days. Unset, unparseable, non-finite or not positive
 * -> the default (7). Fractions are allowed (0.5 = 12 hours).
 */
function crawlFreshDays() {
  const raw = process.env[CRAWL_FRESH_DAYS_ENV];
  if (raw == null || !String(raw).trim()) return CRAWL_FRESH_DEFAULT_DAYS;
  const text = asciiDigits(String(raw).trim());
  const days = PY_FLOAT_DECIMAL.test(text) ? Number(text.replace(/_/g, '')) : Number.NaN;
  if (!(days > 0 && days !== Number.POSITIVE_INFINITY)) {
    logger.warn({
      event: 'catalog_row_trust_invalid_crawl_fresh_days',
      env: CRAWL_FRESH_DAYS_ENV,
      raw,
      using: CRAWL_FRESH_DEFAULT_DAYS,
    });
    return CRAWL_FRESH_DEFAULT_DAYS;
  }
  return days;
}

// THE LIVE-OFFER TEST (round 4): the payload link, else source_ref, trimmed,
// starting http:// or https:// -- spelled exactly as the backend's offer reader
// tests `servable` (round 3 also required no whitespace, so an offer the reader
// serves could sit outside the class). A destination no reader serves (ftp:, a
// bare path) is not live and neither dates nor blocks a row.
// Byte-identical to the backend's CRAWL_OFFER_LINK_SQL.
const CRAWL_OFFER_LINK_SQL =
  "btrim(coalesce(co.offer_payload->>'destination_url', co.source_ref)," +
  " E' \\t\\n\\r\\f\\v') ~ '^https?://'";
// An affiliate-feed offer's link is a network tracking URL, not the listing, and
// the drain never read its price from the storefront: never a valid read.
// Byte-identical to the backend's CRAWL_OFFER_NOT_AFFILIATE_SQL.
const CRAWL_OFFER_NOT_AFFILIATE_SQL =
  "coalesce(co.offer_payload->>'validated_at', '') NOT LIKE 'affiliate_feed:%'";

// ---- round 4 (2026-10-20): EVERY live offer, fail closed ------------------------
//
// Twin of the backend's round-4 block. Trust stays per PRODUCT, and the readers
// serve every live offer of a product to somebody (a caller that declares no
// market is shown them all), so the row may go public only when NO offer any
// reader can show carries a price we cannot vouch for. The input is the row's
// price-read date: the OLDEST valid read across EVERY live offer, NULL as soon
// as one of them has none.
//
// THE CLASS (crawlOfferClassConjuncts) -- every LIVE offer on the row:
// unsuppressed and priced (pricedOfferSql), linking to an http(s) destination
// (CRAWL_OFFER_LINK_SQL). Nothing else: any source_system, any market, any
// currency, affiliate offers included.
//
// A VALID READ of one class offer (CRAWL_OFFER_VALID_READ_SQL), ALL of: written
// by the drain (source_system catalog_enrichment_agent_v1); in a SERVED market
// priced in that market's currency; not an affiliate-feed offer; price_checked_at
// not after the bound now (a future stamp is stale, per offer); the market was
// DECLARED by the writer (offer_payload.declared_market = catalog_offers.market,
// since the column is NOT NULL DEFAULT 'US'); not an employee price edit. So ONE
// live offer that fails any of these makes the row NOT fresh: fail closed.
//
// THE ROW IS CRAWL-FRESH when it has at least one class offer, EVERY class offer
// has a valid read, at least one class offer is not explicitly out of stock, and
// the oldest of those reads is within N days of the SAME now the statement was
// bound with. "Every" covers each live variant offer AND `<pk>::canonical`, and
// an out-of-stock offer needs its valid read like any other.
//
// THE SERVED (market, currency) PAIRS ARE A CONSTANT HERE, NOT servedMarkets().
// The backend renders them at import from its market registry (status 'served')
// x region_pricing, and commits them as config/crawl_fresh_served_markets.json for
// this twin to pin; this repo's servedMarkets() is a per-deployment env list
// (CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET) and would make the two statements
// differ by environment. tests/catalog_trust_crawl_fresh.node.test.cjs fails when
// this list differs from tests/fixtures/crawl_fresh_served_markets.backend.json, a
// verbatim copy of that backend file: the twins must move together.
const CRAWL_FRESH_SERVED_MARKET_CURRENCY_PAIRS = Object.freeze([
  Object.freeze(['SG', 'SGD']),
  Object.freeze(['US', 'USD']),
]);

const CRAWL_OFFER_SERVED_MARKET_SQL =
  "(upper(btrim(coalesce(co.market, ''))), upper(btrim(coalesce(co.currency, ''))))" +
  ' IN (' +
  [...CRAWL_FRESH_SERVED_MARKET_CURRENCY_PAIRS]
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([m, c]) => `('${m}', '${c}')`)
    .join(', ') +
  ')';

// The unavailable vocabulary is offerAvailabilitySql's, itself pinned to the
// backend's offer_buyability.OFFER_UNAVAILABLE_AVAILABILITIES. Sorted, as the
// backend renders it. NOTE the one-argument btrim (spaces only), the backend's
// spelling here -- not offerAvailabilitySql's JS-trim character set.
// KNOWN GAP, kept byte-identical to the backend (unchanged through its round 4):
// a tab/newline-padded value ('\tsoldout') and spaced spellings ('out of stock')
// are not caught. It gates only "at least one class offer is in stock", never
// freshness: an out-of-stock offer needs its valid read like any other.
const CRAWL_OFFER_IN_STOCK_SQL =
  "lower(btrim(coalesce(co.availability, '')))" +
  ' NOT IN (' +
  [...OFFER_UNAVAILABLE_AVAILABILITIES].sort().map((a) => `'${a}'`).join(', ') +
  ')';

// The key the backend's attached-listing lane writes (its PRICE_READ_SOURCE_KEY)
// and the one source that is not a crawl.
const CRAWL_PRICE_READ_SOURCE_KEY = 'price_read_source';
const CRAWL_OFFER_NOT_EMPLOYEE_EDIT_SQL =
  `coalesce(co.offer_payload->>'${CRAWL_PRICE_READ_SOURCE_KEY}', '') <> 'employee_edit'`;
// The key the backend's retailer-ingest drain stamps when its job carried an
// explicit market (retailer_ingest.pipeline.stamp_declared_market).
const CRAWL_DECLARED_MARKET_KEY = 'declared_market';
const CRAWL_OFFER_DECLARED_MARKET_SQL =
  `upper(btrim(coalesce(co.offer_payload->>'${CRAWL_DECLARED_MARKET_KEY}', '')))` +
  " = upper(btrim(coalesce(co.market, '')))";
const CRAWL_OFFER_DRAIN_SOURCE_SQL = `co.source_system = '${CRAWL_SOURCE_SYSTEM}'`;
// `$2` is the batch's `now` (the backend's `:now`).
const CRAWL_OFFER_VALID_READ_SQL =
  `CASE WHEN ${CRAWL_OFFER_DRAIN_SOURCE_SQL}` +
  ` AND ${CRAWL_OFFER_SERVED_MARKET_SQL}` +
  ` AND ${CRAWL_OFFER_NOT_AFFILIATE_SQL}` +
  ' AND co.price_checked_at <= CAST($2 AS timestamptz)' +
  ` AND ${CRAWL_OFFER_DECLARED_MARKET_SQL}` +
  ` AND ${CRAWL_OFFER_NOT_EMPLOYEE_EDIT_SQL}` +
  ' THEN co.price_checked_at END';

/** The class for one row: every live offer. `productKeyExpr` is SQL, never a value. */
function crawlOfferClassConjuncts(productKeyExpr) {
  return [
    `co.product_key = ${productKeyExpr}`,
    ...pricedOfferRowConjuncts('co'),
    CRAWL_OFFER_LINK_SQL,
  ];
}

/**
 * The row's price-read date as the body of a LATERAL: the oldest valid read
 * across every class offer, or NULL. Binds `$2` (now). Twin of
 * crawl_row_price_read_lateral_sql (the backend also builds its recheck from
 * it; this repo has no recheck, see the note above CRAWL_FRESH_ENV).
 */
function crawlRowPriceReadLateralSql(productKeyExpr, indent = '   ') {
  const where = crawlOfferClassConjuncts(productKeyExpr).join(`\n${indent}   AND `);
  return (
    `${indent}SELECT CASE WHEN count(*) > 0\n` +
    `${indent}             AND bool_and((${CRAWL_OFFER_VALID_READ_SQL}) IS NOT NULL)\n` +
    `${indent}             AND bool_or(${CRAWL_OFFER_IN_STOCK_SQL})\n` +
    `${indent}            THEN min(${CRAWL_OFFER_VALID_READ_SQL}) END AS row_price_read_at\n` +
    `${indent}  FROM catalog_offers co\n` +
    `${indent} WHERE ${where}\n`
  );
}

// One indexed probe per key, as a LATERAL over the key list.
//
// ONE CLOCK: `$2` is the batch's `now`, bound from JS, and the age is judged in
// JS (catalogTrustPolicy.isCrawlFresh) against that same value.
//
// BYTE-IDENTICAL to the backend's CRAWL_ROW_PRICE_READ_SQL except for the bind
// tokens: the backend binds SQLAlchemy's `:product_keys` and `:now`, node-pg
// binds them positionally as `$1` and `$2`.
// tests/fixtures/crawl_fresh_trust_backend_sql.json holds the backend constant
// verbatim; the suite pins this string to it with exactly those substitutions.
const CRAWL_ROW_PRICE_READ_SQL =
  'SELECT k.product_key, r.row_price_read_at\n' +
  '  FROM unnest(CAST($1 AS text[])) AS k(product_key)\n' +
  ' CROSS JOIN LATERAL (\n' +
  crawlRowPriceReadLateralSql('k.product_key') +
  ' ) r\n' +
  ' WHERE r.row_price_read_at IS NOT NULL\n';

// Does THIS database's catalog_offers carry price_checked_at? Byte-identical to
// the backend's external_offer_dual_write.PRICE_CHECK_COLUMN_SQL, the probe its
// upserter asks before naming the column.
const PRICE_CHECK_COLUMN_SQL = `
SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = to_regclass('catalog_offers')
    AND attname = 'price_checked_at'
    AND attnum > 0
    AND NOT attisdropped
) AS present
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recompute and UPSERT the trust row for one product_key.
 *
 * Fire-and-forget: returns a Promise that resolves to `true` on success or
 * `false` on error (error is logged, never re-thrown). Callers that don't
 * await won't break; callers that do get the success flag.
 *
 * @param {import('pg').Pool} pool
 * @param {string} productKey
 * @param {Date} [now]
 * @returns {Promise<boolean>}
 */
async function upsertCatalogRowTrust(pool, productKey, now) {
  if (!productKey || typeof productKey !== 'string') return false;
  try {
    const [joinedRes, quarantinesRes] = await Promise.all([
      pool.query(SELECT_BY_KEY_SQL, [productKey]),
      pool.query(QUARANTINE_SQL),
    ]);
    const row = joinedRes.rows[0];
    if (!row) {
      logger.debug({ event: 'catalog_row_trust_skip', reason: 'not_found', productKey });
      return false;
    }
    const activeQuarantines = quarantinesRes.rows;
    const clock = now || new Date();
    const crawlFresh = await crawlFreshByKey(pool, [row], clock);
    const inputs = rowToPolicyInputs(row, activeQuarantines, clock, { crawlFresh });
    const trust = deriveTrust(inputs);
    await pool.query(UPSERT_SQL, trustToParams(trust));
    return true;
  } catch (err) {
    logger.error({ event: 'catalog_row_trust_upsert_failed', productKey, err: err.message });
    return false;
  }
}

/**
 * Recompute and UPSERT trust rows for a batch of product_keys.
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} productKeys
 * @param {Date} [now]
 * @param {number} [limit]
 * @returns {Promise<number>} count of rows written
 */
async function upsertCatalogRowTrustMany(pool, productKeys, now, limit = 5000) {
  const keys = (productKeys || []).filter((k) => k && typeof k === 'string');
  if (!keys.length) return 0;
  try {
    const [joinedRes, quarantinesRes] = await Promise.all([
      pool.query(SELECT_BY_KEYS_SQL, [keys, Math.max(1, Number(limit) || 5000)]),
      pool.query(QUARANTINE_SQL),
    ]);
    const activeQuarantines = quarantinesRes.rows;
    const clock = now || new Date();
    const crawlFresh = await crawlFreshByKey(pool, joinedRes.rows, clock);
    let wrote = 0;
    for (const row of joinedRes.rows) {
      try {
        const inputs = rowToPolicyInputs(row, activeQuarantines, clock, { crawlFresh });
        const trust = deriveTrust(inputs);
        await pool.query(UPSERT_SQL, trustToParams(trust));
        wrote += 1;
      } catch (rowErr) {
        logger.error({
          event: 'catalog_row_trust_upsert_failed',
          productKey: row.product_key,
          err: rowErr.message,
        });
      }
    }
    return wrote;
  } catch (err) {
    logger.error({
      event: 'catalog_row_trust_bulk_upsert_failed',
      keys: keys.length,
      err: err.message,
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// `crawlFresh` is crawlFreshByKey's answer for the batch. null (the switch off,
// or no price_checked_at column) and a key absent from it both leave
// `crawl_fresh` UNSET, so the object is exactly what main built.
function rowToPolicyInputs(row, activeQuarantines, now, { crawlFresh = null } = {}) {
  const inputs = {
    subject_type: 'product',
    subject_key: row.product_key,
    product: {
      product_key: row.product_key,
      content_key: row.content_key,
      merchant_id: row.merchant_id,
      platform: row.platform,
      source_system: row.source_system,
      source_ref: row.source_ref,
      source_product_id: row.source_product_id,
      source_domain: row.source_domain,
      sync_status: row.sync_status,
      suppression_reason: row.suppression_reason,
      last_seen_in_sync_at: row.last_seen_in_sync_at,
      // seed_kind='cross' (retailer-sourced observed seller) must NOT get the
      // observed-seller public-passthrough exemption; 'self'/null keeps it.
      seed_kind: row.eps_seed_kind,
    },
    // c1.v0.5. The lane test is pure row data; only the seed EXISTS needs SQL
    // (pdp_seed_route_ok above). Tri-state: a row assembled without that column
    // yields null and leaves the decision exactly as c1.v0.4.
    pdp_route_resolvable: pdpRouteResolvableFromRow(row),
    identity: row.identity_status != null ? {
      source_listing_ref: row.pil_source_listing_ref,
      identity_status: row.identity_status,
      identity_confidence: row.identity_confidence,
      live_read_enabled: row.live_read_enabled,
      review_required: row.review_required,
      sellable_item_group_id: row.sellable_item_group_id,
      product_line_id: row.product_line_id,
      review_family_id: row.review_family_id,
    } : null,
    // Tri-state, same contract as pdp_route_resolvable above: true = this
    // product_key has its own unsuppressed priced offer, false = it does not,
    // null = the caller did not compute it and the gate stays silent. The JOIN
    // always computes it (EXISTS is never NULL), so null here means a
    // hand-built test input or an older caller.
    row_has_priced_offer:
      row.row_has_priced_offer == null ? null : Boolean(row.row_has_priced_offer),
    // Tri-state, same contract. true = this row IS its content_key's elected
    // canonical, false = a sibling holds the canonical URL, null = no election
    // exists and the gate stays silent. Unlike the two above, null is a NORMAL
    // production value here — the election table does not cover every
    // content_key — not just a hand-built-test artifact.
    row_is_elected_canonical:
      row.row_is_elected_canonical == null ? null : Boolean(row.row_is_elected_canonical),
    ips: row.serving_eligible != null ? {
      serving_eligible: row.serving_eligible,
      pipeline_stage: row.pipeline_stage,
      blocker_code: row.blocker_code,
      content_quality_score: row.content_quality_score,
      quality_scored_at: row.quality_scored_at,
      last_extracted_at: row.last_extracted_at,
    } : null,
    external_seed: row.eps_id != null ? {
      id: row.eps_id,
      status: row.eps_status,
      domain: row.eps_domain,
      attached_product_key: row.eps_attached_product_key,
      last_seen_at: row.eps_last_seen_at,
    } : null,
    merchant_store: row.ms_merchant_id ? {
      merchant_id: row.ms_merchant_id,
      platform: row.ms_platform,
      domain: row.ms_domain,
      status: row.ms_status,
      last_sync: row.ms_last_sync,
    } : null,
    override: row.override_id ? {
      id: row.override_id,
      action_type: row.override_action_type,
      active: row.override_active,
    } : null,
    active_quarantines: activeQuarantines,
    now,
  };
  if (crawlFresh != null && Object.prototype.hasOwnProperty.call(crawlFresh, row.product_key)) {
    inputs.crawl_fresh = Boolean(crawlFresh[row.product_key]);
  }
  return inputs;
}

/**
 * `{ [product_key]: crawl-fresh? }` for the drain-lane crawl rows among `rows`,
 * or null when the input must not be supplied at all.
 *
 * null (-> every row byte-identical to main) when the switch is off, and when
 * this database's catalog_offers has no price_checked_at yet (asked first, so
 * no statement naming a missing column is ever sent -- on Postgres a failed
 * statement would abort the caller's transaction). Rows that are not drain-lane
 * crawl rows never appear in the map. A listing with no qualifying offer maps
 * to false: never read = not fresh = today's gates. A failure of the freshness
 * statement itself propagates to the caller's log-and-swallow, as in the twin.
 */
async function crawlFreshByKey(pool, rows, now) {
  if (!crawlFreshEnabled()) return null;
  const keys = Array.from(
    new Set(
      (rows || [])
        .filter((r) => isCrawlListing({ product_key: r?.product_key, source_system: r?.source_system }))
        .map((r) => String(r.product_key)),
    ),
  ).sort();
  if (!keys.length) return {};
  if (!(await priceCheckColumnPresent(pool))) return null;
  const clock = now instanceof Date ? now : new Date();
  const maxAgeDays = crawlFreshDays();
  let res;
  try {
    res = await isolatedQuery(pool, CRAWL_ROW_PRICE_READ_SQL, [keys, clock]);
  } catch (err) {
    // FAIL CLOSED, PER BATCH (as the backend): the input stays unset for every
    // key of this batch, so each row gets the flag-off verdict and the batch is
    // still written.
    logger.error({
      event: 'catalog_row_trust_crawl_fresh_read_failed',
      keys: keys.length,
      err: err && err.message,
    });
    return null;
  }
  const reads = new Map(
    ((res && res.rows) || []).map((r) => [String(r.product_key), r.row_price_read_at]),
  );
  const out = {};
  for (const pk of keys) {
    out[pk] = isCrawlFresh(reads.get(pk), { now: clock, maxAgeDays });
  }
  return out;
}

const CRAWL_FRESH_SAVEPOINT = 'catalog_row_trust_crawl_fresh';

/**
 * Run one of the CRAWL_FRESH reads so that its failure can never abort the
 * CALLER'S transaction. Callers hand this module a pg Pool (each query its own
 * autocommit statement: a failure is already isolated) or a single client that
 * may be inside BEGIN (the retire-demo scripts do). On a client, the read runs
 * under a SAVEPOINT and a failure rolls back to it, leaving the caller's
 * transaction usable. A client NOT in a transaction refuses SAVEPOINT with
 * 25P01 (no_active_sql_transaction), which changes nothing; the read then runs
 * plainly, isolated by autocommit. Errors from the read itself still throw, to
 * the caller in this module that decides what a failure means.
 */
async function isolatedQuery(pool, sql, params) {
  if (pool instanceof Pool) return pool.query(sql, params);
  try {
    await pool.query(`SAVEPOINT ${CRAWL_FRESH_SAVEPOINT}`);
  } catch (err) {
    if (err && err.code === '25P01') return pool.query(sql, params);
    throw err;
  }
  try {
    const res = await pool.query(sql, params);
    await pool.query(`RELEASE SAVEPOINT ${CRAWL_FRESH_SAVEPOINT}`);
    return res;
  } catch (err) {
    await pool.query(`ROLLBACK TO SAVEPOINT ${CRAWL_FRESH_SAVEPOINT}`).catch(() => {});
    await pool.query(`RELEASE SAVEPOINT ${CRAWL_FRESH_SAVEPOINT}`).catch(() => {});
    throw err;
  }
}

/**
 * The effective switch and N, logged once by each entry point that can write
 * catalog_row_trust (the gateway at boot, the identity jobs at start), so a
 * flip can be verified from logs on every writer. Returns what it logged.
 * `stream` (e.g. process.stderr) writes one JSON line there instead of pino.
 *
 * Same event name and fields as the backend's log_crawl_fresh_config line
 * (`catalog_row_trust_crawl_fresh_config component=... enabled=... days=...
 * served_market_currency=SG:SGD,US:USD`), minus `recheck_limit`: the decay
 * recheck is backend-only. `raw_enabled` / `raw_days` are extra.
 */
function logCrawlFreshConfig(component, { stream = null } = {}) {
  const config = {
    event: 'catalog_row_trust_crawl_fresh_config',
    component: String(component || 'unknown'),
    enabled: crawlFreshEnabled(),
    days: crawlFreshDays(),
    served_market_currency: CRAWL_FRESH_SERVED_MARKET_CURRENCY_PAIRS.map(([m, c]) => `${m}:${c}`).join(','),
    raw_enabled: process.env[CRAWL_FRESH_ENV] ?? null,
    raw_days: process.env[CRAWL_FRESH_DAYS_ENV] ?? null,
  };
  if (stream && typeof stream.write === 'function') {
    // Scripts whose stdout is a JSON report pass process.stderr, so the line
    // never lands inside that report.
    stream.write(`${JSON.stringify(config)}\n`);
  } else {
    // warn, not info: a deployment running LOG_LEVEL=warn must still show it.
    logger.warn(config);
  }
  return config;
}

/**
 * Does THIS database's catalog_offers carry price_checked_at? Asked of the
 * caller's own pool/client. Never throws: a failed read is "absent". Not
 * cached: one catalog lookup per batch, and only while the switch is on.
 */
async function priceCheckColumnPresent(pool) {
  try {
    const res = await isolatedQuery(pool, PRICE_CHECK_COLUMN_SQL);
    const row = res && res.rows ? res.rows[0] : null;
    return Boolean(row != null && row.present);
  } catch (_err) {
    return false;
  }
}

function trustToParams(trust) {
  return [
    trust.subject_type,
    trust.subject_key,
    trust.product_key,
    trust.source_listing_ref,
    trust.content_key,
    trust.source_id,
    trust.source_domain,
    trust.source_lifecycle_state,
    trust.source_last_checked_at,
    trust.identity_status,
    trust.identity_confidence,
    trust.matched_product_key,
    trust.matched_content_key,
    trust.matched_sellable_item_group_id,
    trust.freshness_state,
    trust.last_verified_at,
    trust.verification_source,
    trust.serving_decision,
    trust.serving_reason_codes,
    trust.manual_override_id,
    trust.policy_version,
  ];
}

/**
 * Recompute trust for catalog row(s) linked to a pdp_identity_listing
 * source_listing_ref (format: 'merchantId:productId').
 *
 * Used by pdpIdentityGraph after identity mutations (override writes,
 * live_read promotions) where only source_listing_ref is available.
 *
 * @param {import('pg').Pool} pool
 * @param {string[]} sourceListingRefs
 * @param {Date} [now]
 * @returns {Promise<number>} count of trust rows written
 */
async function upsertCatalogRowTrustForSourceListingRefs(pool, sourceListingRefs, now) {
  const refs = (sourceListingRefs || []).filter((r) => r && typeof r === 'string');
  if (!refs.length) return 0;
  try {
    // Resolve refs to catalog product_keys.
    // source_listing_ref = 'merchantId:productId'; product_id in
    // pdp_identity_listing maps to source_product_id in catalog_products for
    // mirror-lane rows. Path-C minted canonicals carry a name slug there, so
    // their refs resolve through the attached seed instead — without the
    // second arm the post-promotion trust refresh resolved 0 keys for minted
    // rows and their serving_decision stayed stale until the 6h cron.
    const resolveRes = await pool.query(
      `
        SELECT DISTINCT cp.product_key
        FROM catalog_products cp
        JOIN pdp_identity_listing pil
          ON pil.merchant_id = cp.merchant_id
         AND pil.product_id = cp.source_product_id
        WHERE pil.source_listing_ref = ANY($1::text[])
        UNION
        SELECT DISTINCT cp.product_key
        FROM pdp_identity_listing pil
        JOIN external_product_seeds eps
          ON eps.external_product_id = pil.product_id
        JOIN catalog_products cp
          ON cp.product_key = eps.attached_product_key
         AND cp.source_system = 'catalog_enrichment_agent_v1'
         AND cp.merchant_id = pil.merchant_id
        WHERE pil.source_listing_ref = ANY($1::text[])
        LIMIT 5000
      `,
      [refs],
    );
    const productKeys = (resolveRes.rows || []).map((r) => r.product_key).filter(Boolean);
    if (!productKeys.length) return 0;
    return upsertCatalogRowTrustMany(pool, productKeys, now);
  } catch (err) {
    logger.error({
      event: 'catalog_row_trust_identity_refresh_failed',
      refs: refs.length,
      err: err.message,
    });
    return 0;
  }
}

module.exports = {
  POLICY_VERSION,
  // Exported for tests: the compiled join must keep carrying the c1.v0.5
  // seed-route EXISTS. Swapping it for TRUE was an invisible mutation.
  PRODUCT_JOIN_SQL,
  CRAWL_FRESH_ENV,
  CRAWL_FRESH_DAYS_ENV,
  CRAWL_ROW_PRICE_READ_SQL,
  CRAWL_OFFER_IN_STOCK_SQL,
  CRAWL_OFFER_SERVED_MARKET_SQL,
  CRAWL_FRESH_SERVED_MARKET_CURRENCY_PAIRS,
  CRAWL_OFFER_VALID_READ_SQL,
  CRAWL_PRICE_READ_SOURCE_KEY,
  PRICE_CHECK_COLUMN_SQL,
  crawlFreshByKey,
  crawlOfferClassConjuncts,
  crawlRowPriceReadLateralSql,
  isolatedQuery,
  logCrawlFreshConfig,
  crawlFreshDays,
  crawlFreshEnabled,
  rowToPolicyInputs,
  upsertCatalogRowTrust,
  upsertCatalogRowTrustMany,
  upsertCatalogRowTrustForSourceListingRefs,
};
