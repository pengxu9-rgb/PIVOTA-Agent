#!/usr/bin/env node
'use strict';

// Sibling-loss correction for graduate_ips_stuck_identity_approved.cjs.
//
// Problem (observed 2026-05-28):
//   - Graduation cohort had 1,294 (content_key, source_product_id) pairs
//   - 1,258 distinct content_keys; 36 content_keys had multiple sibling
//     source_product_id rows in catalog_products
//   - Graduation INSERTed PQS per source_product_id but UPSERTed IPS per
//     content_key. Last-write-wins on IPS; for 26 multi-sibling content_keys
//     the later-ordered sibling had a lower score, so IPS landed at
//     low_quality even though a graduate-eligible sibling existed at our
//     rules_version.
//
// This script finds those 26 (or however many) stuck content_keys and
// re-UPSERTs IPS using the best-scoring sibling's PQS row as the source of
// truth. Pre-image JSONL captured for rollback (separate file from the
// graduation's pre-image, since this script captures the POST-graduation
// state before correction).
//
// Idempotent: filter requires `ips.serving_eligible = false` AND `max PQS
// score >= 65`. After successful run, matching rows have
// `serving_eligible = true`, so a re-run is a no-op.
//
// Usage:
//   # Dry-run (default):
//   node scripts/fix_sibling_loss_post_graduation.cjs \
//     --out /tmp/sibling_loss_dry_run.json
//
//   # Apply:
//   node scripts/fix_sibling_loss_post_graduation.cjs \
//     --write --confirm FIX_SIBLING_LOSS_POST_GRADUATION_V1 \
//     --pre-image /tmp/sibling_loss_pre_image.jsonl \
//     --out /tmp/sibling_loss_apply.json

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'FIX_SIBLING_LOSS_POST_GRADUATION_V1';
const RULES_VERSION = 'external_seed_deterministic_v1';
const CONSOLIDATION_VERSION = 'sibling_loss_correction_v1';

const QUALITY_SCORE_THRESHOLD = 65;
const MIN_DESCRIPTION_LENGTH = 50;

const CHUNK_SIZE = 50;
const ABORT_CONSECUTIVE_FAILURES = 5;
const ABORT_CUMULATIVE_FAILURE_RATE = 0.10;

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
// SQL
// ---------------------------------------------------------------------------

// Find content_keys where the best PQS sibling at our rules_version scores
// >= 65, but the current IPS row is still serving_eligible=false. Pulls all
// the fields we need to re-classify and re-upsert.
//
// PQS.details.source_backed_fields encodes what the graduation script saw
// at the moment it inserted: { title, description_length, image_count,
// price_amount, brand, category }. We reuse those to avoid re-querying
// catalog_products + offers + seeds again.
const FETCH_STUCK_SIBLINGS_SQL = `
  WITH ranked_pqs AS (
    SELECT
      pqs.merchant_id,
      pqs.platform,
      pqs.platform_product_id,
      pqs.content_quality_score,
      pqs.details,
      cp.content_key,
      cp.pivota_signature_id,
      ROW_NUMBER() OVER (
        PARTITION BY cp.content_key
        ORDER BY pqs.content_quality_score DESC,
                 pqs.snapshot_date DESC,
                 pqs.platform_product_id
      ) AS rk
    FROM product_quality_snapshot pqs
    JOIN catalog_products cp
      ON cp.merchant_id = pqs.merchant_id
     AND cp.platform = pqs.platform
     AND cp.source_product_id = pqs.platform_product_id
    WHERE pqs.rules_version = $1
  )
  SELECT
    rp.content_key,
    rp.pivota_signature_id,
    rp.merchant_id,
    rp.platform,
    rp.platform_product_id            AS best_source_product_id,
    rp.content_quality_score          AS best_score,
    rp.details                        AS best_details,
    EXISTS (
      SELECT 1 FROM pdp_identity_listing pil
      WHERE pil.merchant_id = rp.merchant_id
        AND pil.product_id = rp.platform_product_id
        AND pil.identity_status = 'approved'
        AND pil.live_read_enabled = true
        AND pil.review_required = false
    )                                 AS identity_resolved,
    row_to_json(ips.*)                AS pre_ips_row,
    ips.serving_eligible              AS current_serving_eligible,
    ips.blocker_code                  AS current_blocker_code,
    ips.pipeline_stage                AS current_pipeline_stage,
    ips.content_quality_score         AS current_content_quality_score
  FROM ranked_pqs rp
  JOIN index_pipeline_state ips ON ips.content_key = rp.content_key
  WHERE rp.rk = 1
    AND rp.content_quality_score >= ${QUALITY_SCORE_THRESHOLD}
    AND ips.quality_rules_version = $1
    AND ips.serving_eligible = false
  ORDER BY rp.content_key
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
// Classifier — must match the graduation script's classifyPostGraduation,
// since the IPS state we write here flows through the same Python nightly
// classifier on the next run.
// ---------------------------------------------------------------------------

function classifyFromBestSibling(row) {
  const details = row.best_details || {};
  const fields = details.source_backed_fields || {};
  const score = Number(row.best_score);
  const hasImage = (fields.image_count || 0) > 0;
  const hasPrice = fields.price_amount != null;
  const descriptionLength = Number(fields.description_length || 0);
  const titlePresent = Boolean(fields.title);
  const identityResolved = row.identity_resolved === true;

  let blockerCode = 'none';
  let blockerDetail = null;
  if (!titlePresent) {
    blockerCode = 'no_extraction';
    blockerDetail = 'best sibling has no title in source_backed_fields';
  } else if (score < QUALITY_SCORE_THRESHOLD) {
    blockerCode = 'low_quality';
    blockerDetail = `best sibling score ${score} < ${QUALITY_SCORE_THRESHOLD}`;
  } else if (!hasImage) {
    blockerCode = 'no_image';
    blockerDetail = 'best sibling has no image';
  } else if (!hasPrice) {
    blockerCode = 'no_price';
    blockerDetail = 'best sibling has no priced offer';
  } else if (descriptionLength < MIN_DESCRIPTION_LENGTH) {
    blockerCode = 'short_description';
    blockerDetail = `best sibling description length ${descriptionLength} < ${MIN_DESCRIPTION_LENGTH}`;
  } else if (!identityResolved) {
    blockerCode = 'entity_unresolved';
    blockerDetail = 'identity not resolved at correction time';
  }

  const servingEligible =
    blockerCode === 'none' &&
    score >= QUALITY_SCORE_THRESHOLD &&
    hasImage &&
    hasPrice &&
    descriptionLength >= MIN_DESCRIPTION_LENGTH &&
    identityResolved;

  let pipelineStage;
  if (servingEligible) {
    pipelineStage = 'shadow_indexed';
  } else if (
    titlePresent &&
    score >= QUALITY_SCORE_THRESHOLD &&
    hasImage &&
    hasPrice &&
    descriptionLength >= MIN_DESCRIPTION_LENGTH
  ) {
    pipelineStage = 'quality_gated';
  } else if (titlePresent) {
    pipelineStage = 'extracted';
  } else {
    pipelineStage = 'discovered';
  }

  return {
    pipelineStage,
    blockerCode,
    blockerDetail,
    servingEligible,
    score,
    hasImage,
    hasPrice,
    descriptionLength,
    identityResolved,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function writeOneRow(client, row, verdict) {
  await client.query(UPSERT_IPS_SQL, [
    row.content_key,
    row.pivota_signature_id,
    row.merchant_id,
    verdict.pipelineStage,
    verdict.blockerCode,
    verdict.blockerDetail,
    verdict.servingEligible,
    verdict.score,
    RULES_VERSION,
    'passed',
    verdict.identityResolved,
    row.pivota_signature_id,
    verdict.hasImage,
    verdict.hasPrice,
    verdict.descriptionLength,
    CONSOLIDATION_VERSION,
  ]);
}

async function applyChunk(client, runId, chunk, preImageStream) {
  await client.query('BEGIN');
  const applied = [];
  try {
    for (const row of chunk) {
      const verdict = classifyFromBestSibling(row);
      if (preImageStream) {
        preImageStream.write(
          `${JSON.stringify({
            run_id: runId,
            content_key: row.content_key,
            merchant_id: row.merchant_id,
            platform: row.platform,
            source_product_id: row.best_source_product_id,
            captured_at: new Date().toISOString(),
            pre_image: { ips_row: row.pre_ips_row },
          })}\n`,
        );
      }
      await writeOneRow(client, row, verdict);
      applied.push({
        content_key: row.content_key,
        best_source_product_id: row.best_source_product_id,
        best_score: row.best_score,
        pre: {
          serving_eligible: row.current_serving_eligible,
          blocker_code: row.current_blocker_code,
          pipeline_stage: row.current_pipeline_stage,
          content_quality_score: row.current_content_quality_score,
        },
        post: verdict,
        outcome: 'corrected',
      });
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
    corrected: 0,
    errored: 0,
    by_post_blocker: {},
    by_post_stage: {},
  };
  for (const r of results) {
    summary[r.outcome] = (summary[r.outcome] || 0) + 1;
    if (r.post) {
      const bc = r.post.blockerCode || 'none';
      summary.by_post_blocker[bc] = (summary.by_post_blocker[bc] || 0) + 1;
      const ps = r.post.pipelineStage || 'unknown';
      summary.by_post_stage[ps] = (summary.by_post_stage[ps] || 0) + 1;
    }
  }
  return summary;
}

async function main() {
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  const out = argValue('out');
  const preImagePath = argValue('pre-image');
  const runId = `sibling_loss_correction_${new Date().toISOString().replace(/[:.]/g, '-')}`;

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
    const { rows: stuck } = await client.query(FETCH_STUCK_SIBLINGS_SQL, [
      RULES_VERSION,
    ]);

    if (!write) {
      for (const row of stuck) {
        const verdict = classifyFromBestSibling(row);
        results.push({
          content_key: row.content_key,
          best_source_product_id: row.best_source_product_id,
          best_score: row.best_score,
          pre: {
            serving_eligible: row.current_serving_eligible,
            blocker_code: row.current_blocker_code,
            pipeline_stage: row.current_pipeline_stage,
            content_quality_score: row.current_content_quality_score,
          },
          post: verdict,
          outcome: 'planned',
        });
      }
    } else {
      for (let i = 0; i < stuck.length; i += CHUNK_SIZE) {
        const chunk = stuck.slice(i, i + CHUNK_SIZE);
        try {
          const applied = await applyChunk(client, runId, chunk, preImageStream);
          results.push(...applied);
          consecutiveFailures = 0;
        } catch (error) {
          totalErrors += chunk.length;
          consecutiveFailures += 1;
          for (const row of chunk) {
            results.push({
              content_key: row.content_key,
              best_source_product_id: row.best_source_product_id,
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
      pre_image_file: preImageStream ? preImagePath : null,
      summary,
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
