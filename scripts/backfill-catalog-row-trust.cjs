#!/usr/bin/env node

// Backfill catalog_row_trust from current production tables.
//
// Phase 1 (this script): one-shot idempotent backfill.
// Runs the same catalogTrustPolicy that producers will dual-write through
// in Phase 2, so the backfill output matches steady-state output.
//
// Usage:
//   node scripts/backfill-catalog-row-trust.cjs --dry-run
//   node scripts/backfill-catalog-row-trust.cjs --limit 1000
//   node scripts/backfill-catalog-row-trust.cjs --subject product --limit 5000
//
// Required env: DATABASE_URL.

const { Pool } = require('pg');
const {
  POLICY_VERSION,
  deriveTrust,
} = require('../src/services/catalogTrustPolicy');

const BATCH_SIZE = 500;

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function loadActiveQuarantines(pool) {
  const { rows } = await pool.query(`
    SELECT quarantine_id, match_type, match_value, state, expires_at
    FROM catalog_source_quarantine
    WHERE state = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  `);
  return rows;
}

// One JOIN per subject row. The shape mirrors catalogTrustPolicy.deriveTrust
// input order. We pull catalog_products as the driver and outer-join the
// other tables.
//
// Join keys (verified against db/migrations/036_pdp_identity_graph.sql and
// db/migrations/058_catalog_core.sql + 077/083/084/133/134/135):
//   index_pipeline_state    ↔ catalog_products via content_key
//   pdp_identity_listing    ↔ catalog_products via (merchant_id, source_product_id)
//   external_product_seeds  ↔ external_seed catalog rows via
//                              (cp.source_system='external_product_seeds_mirror_v1' AND
//                               cp.source_product_id = eps.external_product_id)
//                              ADR-009: keyed on source_system, NOT merchant_id —
//                              seeds mirror under per-brand observed sellers (merch_obs_…)
//   merchant_stores         ↔ catalog_products via (merchant_id, platform)
//   pdp_identity_override   ↔ pdp_identity_listing via source_listing_ref
const PRODUCT_DRIVER_SQL = `
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

    eps.id            AS eps_id,
    eps.status        AS eps_status,
    eps.domain        AS eps_domain,
    eps.attached_product_key AS eps_attached_product_key,
    eps.updated_at    AS eps_last_seen_at,

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
  LEFT JOIN pdp_identity_listing pil
    ON pil.merchant_id = cp.merchant_id
   AND pil.product_id = cp.source_product_id
  LEFT JOIN external_seed_one eps
    -- ADR-009: match by source_system, NOT merchant_id='external_seed' (seeds
    -- mirror under per-brand merch_obs_ observed sellers). Kept in sync with
    -- src/services/catalogRowTrustUpserter.js + the Python twin.
    ON cp.source_system = 'external_product_seeds_mirror_v1'
   AND eps.external_product_id = cp.source_product_id
  LEFT JOIN merchant_store_one ms
    ON ms.merchant_id = cp.merchant_id AND ms.platform = cp.platform
  LEFT JOIN identity_override_one pio
    ON pio.source_listing_ref = pil.source_listing_ref AND pio.active = TRUE
  WHERE ($1::text IS NULL OR cp.product_key > $1)
  ORDER BY cp.product_key
  LIMIT $2
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
    identity: row.identity_status ? {
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

function trustRowToParams(trust) {
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

async function main() {
  const totalLimit = Math.max(1, Number(argValue('limit') || 0)) || Infinity;
  const dryRun = hasFlag('dry-run');
  const subjectFilter = argValue('subject') || 'product';

  if (subjectFilter !== 'product') {
    throw new Error('phase 1 backfill only supports --subject product');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL required');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const now = new Date();

  const tally = {
    scanned: 0, wrote: 0, public: 0, shadow: 0, blocked: 0,
    by_reason: Object.create(null),
  };

  const activeQuarantines = await loadActiveQuarantines(pool);

  let cursor = null;
  while (tally.scanned < totalLimit) {
    const batchSize = Math.min(BATCH_SIZE, totalLimit - tally.scanned);
    const { rows } = await pool.query(PRODUCT_DRIVER_SQL, [cursor, batchSize]);
    if (rows.length === 0) break;

    for (const row of rows) {
      tally.scanned += 1;
      const trust = deriveTrust(rowToPolicyInputs(row, activeQuarantines, now));
      tally[trust.serving_decision] += 1;
      for (const r of trust.serving_reason_codes) {
        tally.by_reason[r] = (tally.by_reason[r] || 0) + 1;
      }
      if (!dryRun) {
        await pool.query(UPSERT_SQL, trustRowToParams(trust));
        tally.wrote += 1;
      }
    }
    cursor = rows[rows.length - 1].product_key;
    if (rows.length < batchSize) break;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    policy_version: POLICY_VERSION,
    dry_run: dryRun,
    tally,
  }, null, 2) + '\n');

  await pool.end();
}

main().catch((err) => {
  process.stderr.write(`backfill-catalog-row-trust failed: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
