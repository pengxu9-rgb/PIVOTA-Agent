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

const logger = require('../logger');

const { POLICY_VERSION, deriveTrust } = require('./catalogTrustPolicy');

// ---------------------------------------------------------------------------
// SQL — kept literal & in sync with scripts/backfill-catalog-row-trust.cjs.
// Any change here must be mirrored in the Python upserter and Node backfill.
// ---------------------------------------------------------------------------

const PRODUCT_JOIN_SQL = `
  WITH external_seed_one AS (
    SELECT DISTINCT ON (external_product_id)
      id, external_product_id, status, domain, attached_product_key, updated_at
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
      s.id, s.external_product_id, s.status, s.domain, s.attached_product_key, s.updated_at
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

    COALESCE(eps.id, epm.id)                                     AS eps_id,
    COALESCE(eps.status, epm.status)                             AS eps_status,
    COALESCE(eps.domain, epm.domain)                             AS eps_domain,
    COALESCE(eps.attached_product_key, epm.attached_product_key) AS eps_attached_product_key,
    COALESCE(eps.updated_at, epm.updated_at)                     AS eps_last_seen_at,

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
    const inputs = rowToPolicyInputs(row, activeQuarantines, now || new Date());
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
    let wrote = 0;
    for (const row of joinedRes.rows) {
      try {
        const inputs = rowToPolicyInputs(row, activeQuarantines, clock);
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

function rowToPolicyInputs(row, activeQuarantines, now) {
  return {
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
    },
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
  upsertCatalogRowTrust,
  upsertCatalogRowTrustMany,
  upsertCatalogRowTrustForSourceListingRefs,
};
