#!/usr/bin/env node
'use strict';

// Deterministic graduation runner for the IPS-stuck identity-approved
// external_seed cohort (1,290 rows per the 2026-05-27 audit at
// /tmp/codex_ips_blocked_identity_audit_result.md).
//
// Root cause: external_seed rows never get a product_quality_snapshot row,
// so services/index_pipeline_state_service.py:_classify_product reads
// content_quality_score = NULL and stamps blocker_code='low_quality' with
// blocker_detail='no quality snapshot found'. Identity is approved, content
// is present, but the cohort is stuck because the quality scorer doesn't
// run on external_seed.
//
// This script computes a deterministic quality snapshot from fields already
// present on the catalog_products + external_product_seeds rows (same
// component shape as wave12_apiceuticals_quality_snapshot_repair.cjs), then
// writes product_quality_snapshot + upserts index_pipeline_state directly.
// No LLM calls, no external content fetches.
//
// Outcomes after write (per row):
//   - score >= 65 + has_image + has_price + desc >= 50 + identity_resolved
//     → serving_eligible=true, pipeline_stage='shadow_indexed', blocker='none'
//   - score >= 65 but missing image/price/desc → pipeline_stage='quality_gated'
//     or stays 'extracted', blocker = next real failure (no_image, no_price,
//     short_description). Correct state instead of stuck state.
//   - score < 65 → still 'low_quality', but now backed by an actual snapshot
//     instead of NULL. The next Python nightly run will see the same score
//     and agree.
//
// Pre-image rollback: every touched (content_key, ips, pqs) tuple is written
// to a per-run JSONL file before the transaction commits. Mirrors WS_A Mode A
// rollback parity (1,170 pre-image snapshots).
//
// Usage:
//   # Dry-run (default), no DB writes:
//   node scripts/graduate_ips_stuck_identity_approved.cjs --out /tmp/run.json
//
//   # Apply (writes product_quality_snapshot + index_pipeline_state):
//   node scripts/graduate_ips_stuck_identity_approved.cjs \
//     --write --confirm APPLY_IPS_STUCK_IDENTITY_GRADUATION_V1 \
//     --pre-image /tmp/pre_image.jsonl --out /tmp/run.json
//
//   # Limit run size for canary:
//   ... --limit 50

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'APPLY_IPS_STUCK_IDENTITY_GRADUATION_V1';
const RULES_VERSION = 'external_seed_deterministic_v1';
const CONSOLIDATION_VERSION = 'ips_stuck_identity_graduation_v1';
const REPAIR_SOURCE = 'graduate_ips_stuck_identity_approved';

const DEFAULT_LIMIT = 0; // 0 = no limit (full cohort)
const CHUNK_SIZE = 50;
const ABORT_CONSECUTIVE_FAILURES = 5;
const ABORT_CUMULATIVE_FAILURE_RATE = 0.10; // 10% after first full chunk

// Quality thresholds — must match Python classifier
// (services/index_pipeline_state_service.py:28-29)
const QUALITY_SCORE_THRESHOLD = 65;
const MIN_DESCRIPTION_LENGTH = 50;

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Field helpers (mirror wave12 idioms)
// ---------------------------------------------------------------------------

function text(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function priceAmount(row) {
  const fromOffer = Number(row.offer_price_amount);
  if (Number.isFinite(fromOffer) && fromOffer > 0) return fromOffer;
  const fromSeed = Number(row.seed_price_amount);
  if (Number.isFinite(fromSeed) && fromSeed > 0) return fromSeed;
  return null;
}

function imageCount(row) {
  const payload = asObject(row.product_payload);
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const urls = [
    row.catalog_image_url,
    row.seed_image_url,
    ...asArray(payload.image_urls),
    ...asArray(payload.images),
    ...asArray(seedData.image_urls),
    ...asArray(snapshot.image_urls),
  ].map(text).filter(Boolean);
  return new Set(urls).size;
}

// Deterministic scoring — same shape as wave12 to keep this defensible.
// 7 components averaged; summary/attributes are placeholders (0) by design
// so the cohort can't accidentally graduate past gates that require those.
function qualityForRow(row) {
  const title = firstString(row.catalog_title, row.seed_title);
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const brand = firstString(
    row.catalog_brand,
    seedData.brand,
    snapshot.brand,
  );
  const description = firstString(
    row.catalog_description,
    seedData.description,
    seedData.pdp_description_raw,
    snapshot.description,
  );
  const category = firstString(
    row.catalog_product_type,
    seedData.category,
    seedData.product_type,
    snapshot.category,
  );
  const images = imageCount(row);
  const price = priceAmount(row);

  const components = [
    { name: 'title', score: title ? 100 : 0 },
    {
      name: 'description',
      score: description.length >= 140 ? 100 : description.length >= 60 ? 70 : 0,
    },
    { name: 'summary', score: 0 },
    { name: 'attributes', score: 0 },
    { name: 'images', score: images > 0 ? 100 : 0 },
    {
      name: 'brand_category',
      score: brand && category ? 100 : brand || category ? 50 : 0,
    },
    { name: 'price', score: price != null ? 100 : 0 },
  ];
  const score = Number(
    (components.reduce((sum, c) => sum + c.score, 0) / components.length).toFixed(1),
  );
  const problems = [];
  if (!title) problems.push({ field: 'title', code: 'missing_title' });
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    problems.push({
      field: 'description',
      code: description.length === 0 ? 'missing_description' : 'short_description',
      length: description.length,
    });
  }
  if (!brand) problems.push({ field: 'brand', code: 'missing_brand' });
  if (!category) problems.push({ field: 'category', code: 'missing_category' });
  if (!images) problems.push({ field: 'image_list', code: 'missing_images' });
  if (price == null) problems.push({ field: 'price', code: 'invalid_price' });

  return {
    content_quality_score: score,
    model_readiness_score: 0,
    conversion_potential_score: null,
    rules_version: RULES_VERSION,
    model_version: 'none',
    has_image: images > 0,
    has_price: price != null,
    description_length: description.length,
    details: {
      content_quality_score: score,
      model_readiness_score: 0,
      conversion_potential_score: null,
      problems,
      components,
      repair_source: REPAIR_SOURCE,
      source_backed_fields: {
        title: Boolean(title),
        description_length: description.length,
        image_count: images,
        price_amount: price,
        brand: Boolean(brand),
        category: Boolean(category),
      },
    },
  };
}

// Classify the post-snapshot IPS state — must agree with the Python
// classifier (services/index_pipeline_state_service.py:_classify_product)
// so the next nightly run is a no-op.
function classifyPostGraduation(quality, row) {
  const sourceDocumentPresent =
    Boolean(firstString(row.seed_title, row.catalog_title));
  const identityResolved = row.identity_resolved === true;

  // First-failing-check-wins order (matches Python L240-293):
  // not_live → non_core → no_seed → no_extraction → low_quality →
  //   no_image → no_price → short_description → entity_unresolved → ...
  // We pre-filter on sync_status='live' + identity_status='approved' so
  // not_live / no_seed / non_core / entity_unresolved should not fire here.
  let blockerCode = 'none';
  let blockerDetail = null;
  if (!sourceDocumentPresent) {
    blockerCode = 'no_extraction';
    blockerDetail = 'source row present but title missing';
  } else if (quality.content_quality_score < QUALITY_SCORE_THRESHOLD) {
    blockerCode = 'low_quality';
    blockerDetail =
      `content_quality_score=${quality.content_quality_score} < ${QUALITY_SCORE_THRESHOLD}`;
  } else if (!quality.has_image) {
    blockerCode = 'no_image';
    blockerDetail = 'no image_url after deterministic scoring';
  } else if (!quality.has_price) {
    blockerCode = 'no_price';
    blockerDetail = 'no catalog_offers row with list_price > 0';
  } else if (quality.description_length < MIN_DESCRIPTION_LENGTH) {
    blockerCode = 'short_description';
    blockerDetail =
      `description length ${quality.description_length} < ${MIN_DESCRIPTION_LENGTH}`;
  } else if (!identityResolved) {
    blockerCode = 'entity_unresolved';
    blockerDetail = 'identity not resolved at graduation time';
  }

  const servingEligible =
    blockerCode === 'none' &&
    quality.content_quality_score >= QUALITY_SCORE_THRESHOLD &&
    quality.has_image &&
    quality.has_price &&
    quality.description_length >= MIN_DESCRIPTION_LENGTH &&
    identityResolved;

  // Stage assignment (matches Python L310-338):
  let pipelineStage;
  if (servingEligible) {
    pipelineStage = 'shadow_indexed';
  } else if (
    sourceDocumentPresent &&
    quality.content_quality_score >= QUALITY_SCORE_THRESHOLD &&
    quality.has_image &&
    quality.has_price &&
    quality.description_length >= MIN_DESCRIPTION_LENGTH
  ) {
    pipelineStage = 'quality_gated';
  } else if (sourceDocumentPresent) {
    pipelineStage = 'extracted';
  } else {
    pipelineStage = 'discovered';
  }

  return { pipelineStage, blockerCode, blockerDetail, servingEligible };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Cohort filter matches the 2026-05-27 audit (/tmp/codex_ips_blocked_identity_audit_result.md):
//   - merchant_id='external_seed', platform='external_seed'
//   - ips.pipeline_stage='extracted', ips.blocker_code='low_quality',
//     ips.last_extracted_at IS NULL
//   - identity approved + live_read_enabled + not review_required
//   - (defensive) cp.sync_status='live' so the Python classifier wouldn't
//     reclassify to 'not_live' before our quality check fires
//
// Bound params: $1 = RULES_VERSION (for already_graduated probe).
//               $2 = LIMIT (only appended when caller passes a positive limit).
const FETCH_COHORT_SQL_BASE = `
  SELECT
    cp.merchant_id,
    cp.platform,
    cp.source_product_id,
    cp.content_key,
    cp.product_key,
    cp.pivota_signature_id,
    cp.title          AS catalog_title,
    cp.brand          AS catalog_brand,
    cp.product_type   AS catalog_product_type,
    cp.description    AS catalog_description,
    cp.image_url      AS catalog_image_url,
    cp.product_payload,
    cp.sync_status,
    eps.id            AS seed_id,
    eps.title         AS seed_title,
    eps.image_url     AS seed_image_url,
    eps.price_amount  AS seed_price_amount,
    eps.seed_data,
    (
      SELECT MAX(co.list_price)
      FROM catalog_offers co
      WHERE co.product_key = cp.product_key
        AND co.suppressed_at IS NULL
        AND co.list_price > 0
    )                  AS offer_price_amount,
    EXISTS (
      SELECT 1 FROM pdp_identity_listing pil
      WHERE pil.merchant_id = cp.merchant_id
        AND pil.product_id = cp.source_product_id
        AND pil.identity_status = 'approved'
        AND pil.live_read_enabled = true
        AND pil.review_required = false
    )                  AS identity_resolved,
    -- Full pre-image snapshots for rollback completeness:
    row_to_json(ips.*) AS pre_ips_row,
    (
      SELECT json_agg(row_to_json(pqs.*) ORDER BY pqs.snapshot_date DESC)
      FROM product_quality_snapshot pqs
      WHERE pqs.merchant_id = cp.merchant_id
        AND pqs.platform = cp.platform
        AND pqs.platform_product_id = cp.source_product_id
    )                  AS pre_pqs_rows,
    EXISTS (
      SELECT 1 FROM product_quality_snapshot pqs2
      WHERE pqs2.merchant_id = cp.merchant_id
        AND pqs2.platform = cp.platform
        AND pqs2.platform_product_id = cp.source_product_id
        AND pqs2.rules_version = $1
    )                  AS already_graduated
  FROM index_pipeline_state ips
  JOIN catalog_products cp ON cp.content_key = ips.content_key
  LEFT JOIN external_product_seeds eps
    ON eps.external_product_id = cp.source_product_id
   AND eps.status = 'active'
  WHERE cp.merchant_id = 'external_seed'
    AND cp.platform = 'external_seed'
    AND cp.sync_status = 'live'
    AND ips.pipeline_stage = 'extracted'
    AND ips.blocker_code = 'low_quality'
    AND ips.last_extracted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM pdp_identity_listing pil2
      WHERE pil2.merchant_id = cp.merchant_id
        AND pil2.product_id = cp.source_product_id
        AND pil2.identity_status = 'approved'
        AND pil2.live_read_enabled = true
        AND pil2.review_required = false
    )
  ORDER BY cp.content_key
`;

function buildFetchCohortSQL(limit) {
  if (limit && limit > 0) {
    return `${FETCH_COHORT_SQL_BASE}\n  LIMIT $2`;
  }
  return FETCH_COHORT_SQL_BASE;
}

const INSERT_PQS_SQL = `
  INSERT INTO product_quality_snapshot (
    merchant_id,
    platform,
    platform_product_id,
    geo_code,
    product_id,
    content_quality_score,
    model_readiness_score,
    conversion_potential_score,
    rules_version,
    model_version,
    details,
    snapshot_date,
    created_at
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::json,now(),now())
`;

const UPSERT_IPS_SQL = `
  INSERT INTO index_pipeline_state (
    content_key,
    pivota_signature_id,
    merchant_id,
    pipeline_stage,
    blocker_code,
    blocker_detail,
    serving_eligible,
    content_quality_score,
    quality_rules_version,
    quality_scored_at,
    seed_audit_status,
    identity_resolved,
    product_group_id,
    has_image,
    has_price,
    description_length,
    consolidation_version,
    last_consolidated_at,
    created_at
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$13,$14,$15,$16,now(),now())
  ON CONFLICT (content_key) DO UPDATE SET
    pivota_signature_id        = EXCLUDED.pivota_signature_id,
    merchant_id                = EXCLUDED.merchant_id,
    pipeline_stage             = EXCLUDED.pipeline_stage,
    blocker_code               = EXCLUDED.blocker_code,
    blocker_detail             = EXCLUDED.blocker_detail,
    serving_eligible           = EXCLUDED.serving_eligible,
    content_quality_score      = EXCLUDED.content_quality_score,
    quality_rules_version      = EXCLUDED.quality_rules_version,
    quality_scored_at          = now(),
    seed_audit_status          = EXCLUDED.seed_audit_status,
    identity_resolved          = EXCLUDED.identity_resolved,
    product_group_id           = EXCLUDED.product_group_id,
    has_image                  = EXCLUDED.has_image,
    has_price                  = EXCLUDED.has_price,
    description_length         = EXCLUDED.description_length,
    consolidation_version      = EXCLUDED.consolidation_version,
    last_consolidated_at       = now()
`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function fetchCohort(client, limit) {
  const sql = buildFetchCohortSQL(limit);
  const params = limit && limit > 0 ? [RULES_VERSION, limit] : [RULES_VERSION];
  const result = await client.query(sql, params);
  return result.rows || [];
}

function planForRow(row) {
  const quality = qualityForRow(row);
  const verdict = classifyPostGraduation(quality, row);
  return {
    content_key: row.content_key,
    pivota_signature_id: row.pivota_signature_id,
    merchant_id: row.merchant_id,
    platform: row.platform,
    source_product_id: row.source_product_id,
    product_key: row.product_key,
    title: text(row.catalog_title || row.seed_title),
    identity_resolved: row.identity_resolved === true,
    already_graduated: row.already_graduated === true,
    quality: {
      content_quality_score: quality.content_quality_score,
      rules_version: quality.rules_version,
      has_image: quality.has_image,
      has_price: quality.has_price,
      description_length: quality.description_length,
      problems: quality.details.problems,
    },
    verdict,
    pre_image: {
      ips_row: row.pre_ips_row,
      pqs_rows: row.pre_pqs_rows || [],
    },
  };
}

async function writeOneRow(client, row, plan) {
  const { quality, verdict } = plan;
  await client.query(INSERT_PQS_SQL, [
    row.merchant_id,
    row.platform,
    row.source_product_id,
    'default',
    `${row.merchant_id}|${row.platform}|${row.source_product_id}`,
    plan.quality.content_quality_score,
    0,
    null,
    RULES_VERSION,
    'none',
    JSON.stringify({
      content_quality_score: plan.quality.content_quality_score,
      model_readiness_score: 0,
      conversion_potential_score: null,
      problems: plan.quality.problems,
      repair_source: REPAIR_SOURCE,
    }),
  ]);
  await client.query(UPSERT_IPS_SQL, [
    row.content_key,
    row.pivota_signature_id,
    row.merchant_id,
    verdict.pipelineStage,
    verdict.blockerCode,
    verdict.blockerDetail,
    verdict.servingEligible,
    plan.quality.content_quality_score,
    RULES_VERSION,
    'passed',
    plan.identity_resolved,
    row.pivota_signature_id,
    plan.quality.has_image,
    plan.quality.has_price,
    plan.quality.description_length,
    CONSOLIDATION_VERSION,
  ]);
}

async function applyChunk(client, runId, plans, rowsByKey, preImageStream) {
  await client.query('BEGIN');
  const applied = [];
  try {
    for (const plan of plans) {
      if (plan.already_graduated) {
        applied.push({ ...plan, outcome: 'skipped_already_graduated' });
        continue;
      }
      const row = rowsByKey.get(plan.content_key);
      if (preImageStream) {
        preImageStream.write(
          `${JSON.stringify({
            run_id: runId,
            content_key: plan.content_key,
            merchant_id: plan.merchant_id,
            platform: plan.platform,
            source_product_id: plan.source_product_id,
            captured_at: new Date().toISOString(),
            pre_image: plan.pre_image,
          })}\n`,
        );
      }
      await writeOneRow(client, row, plan);
      applied.push({ ...plan, outcome: 'applied' });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return applied;
}

function summarize(results) {
  const summary = {
    total: results.length,
    applied: 0,
    skipped_already_graduated: 0,
    would_be_serving_eligible: 0,
    by_post_blocker: {},
    by_post_stage: {},
    score_distribution: { lt_65: 0, ge_65: 0 },
  };
  for (const result of results) {
    const outcome = result.outcome || 'planned';
    if (outcome === 'applied') summary.applied += 1;
    if (outcome === 'skipped_already_graduated') {
      summary.skipped_already_graduated += 1;
    }
    if (result.verdict.servingEligible) summary.would_be_serving_eligible += 1;
    const bc = result.verdict.blockerCode || 'none';
    summary.by_post_blocker[bc] = (summary.by_post_blocker[bc] || 0) + 1;
    const ps = result.verdict.pipelineStage || 'unknown';
    summary.by_post_stage[ps] = (summary.by_post_stage[ps] || 0) + 1;
    if (result.quality.content_quality_score >= QUALITY_SCORE_THRESHOLD) {
      summary.score_distribution.ge_65 += 1;
    } else {
      summary.score_distribution.lt_65 += 1;
    }
  }
  return summary;
}

async function main() {
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  const limit = Number(argValue('limit', String(DEFAULT_LIMIT))) || 0;
  const out = argValue('out');
  const preImagePath = argValue('pre-image');
  const runId = `${REPAIR_SOURCE}_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required');
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  const preImageStream =
    write && preImagePath
      ? fs.createWriteStream(preImagePath, { flags: 'a' })
      : null;

  const results = [];
  let consecutiveFailures = 0;
  let totalErrors = 0;
  let aborted = false;
  let abortReason = null;

  try {
    const cohort = await fetchCohort(client, limit);
    const rowsByKey = new Map();
    for (const row of cohort) rowsByKey.set(row.content_key, row);
    const plans = cohort.map(planForRow);

    if (!write) {
      for (const plan of plans) results.push({ ...plan, outcome: 'planned' });
    } else {
      for (let i = 0; i < plans.length; i += CHUNK_SIZE) {
        const chunk = plans.slice(i, i + CHUNK_SIZE);
        try {
          const applied = await applyChunk(
            client,
            runId,
            chunk,
            rowsByKey,
            preImageStream,
          );
          results.push(...applied);
          consecutiveFailures = 0;
        } catch (error) {
          totalErrors += chunk.length;
          consecutiveFailures += 1;
          for (const plan of chunk) {
            results.push({
              ...plan,
              outcome: 'error',
              error: error?.message || String(error),
            });
          }
          if (consecutiveFailures >= ABORT_CONSECUTIVE_FAILURES) {
            aborted = true;
            abortReason = `${consecutiveFailures} consecutive chunk failures`;
            break;
          }
        }
        // Cumulative failure-rate gate kicks in once we have ≥1 chunk worth
        // of attempts to amortize startup noise.
        if (
          results.length >= CHUNK_SIZE &&
          totalErrors / results.length >= ABORT_CUMULATIVE_FAILURE_RATE
        ) {
          aborted = true;
          abortReason = `cumulative failure rate ${(
            (totalErrors / results.length) *
            100
          ).toFixed(1)}% exceeded ${(ABORT_CUMULATIVE_FAILURE_RATE * 100).toFixed(0)}%`;
          break;
        }
      }
    }

    const summary = summarize(results);
    const report = {
      run_id: runId,
      generated_at: new Date().toISOString(),
      dry_run: !write,
      aborted,
      abort_reason: abortReason,
      rules_version: RULES_VERSION,
      consolidation_version: CONSOLIDATION_VERSION,
      cohort_filter: {
        merchant_id: 'external_seed',
        platform: 'external_seed',
        sync_status: 'live',
        ips_pipeline_stage: 'extracted',
        ips_blocker_code: 'low_quality',
        ips_last_extracted_at: 'IS NULL',
        identity_status: 'approved',
        live_read_enabled: true,
        review_required: false,
        limit: limit || null,
      },
      summary,
      pre_image_file: preImageStream ? preImagePath : null,
      results,
    };
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(
      `${JSON.stringify(
        { run_id: runId, dry_run: !write, aborted, summary },
        null,
        2,
      )}\n`,
    );
    if (aborted) process.exitCode = 2;
  } finally {
    if (preImageStream) preImageStream.end();
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
