#!/usr/bin/env node
'use strict';

// Rollback runner for graduate_ips_stuck_identity_approved.cjs.
//
// Consumes the pre-image JSONL file written by the graduation runner and:
//   1. UPDATEs index_pipeline_state back to the pre-image snapshot
//      (every column the graduation runner touched).
//   2. DELETEs product_quality_snapshot rows the graduation runner inserted,
//      keyed on (merchant_id, platform, platform_product_id) with our
//      RULES_VERSION tag. Pre-existing PQS rows at other rules_versions are
//      not touched.
//
// Idempotent: if the current IPS row already equals the pre-image, the
// UPDATE is a no-op. If the PQS row no longer exists, DELETE affects 0 rows.
// Safe to re-run.
//
// Usage:
//   # Dry-run (default), no DB writes:
//   node scripts/rollback_ips_stuck_identity_graduation.cjs \
//     --pre-image /tmp/pre_image.jsonl \
//     --out /tmp/rollback_dry_run.json
//
//   # Apply:
//   node scripts/rollback_ips_stuck_identity_graduation.cjs \
//     --pre-image /tmp/pre_image.jsonl \
//     --write --confirm ROLLBACK_IPS_STUCK_IDENTITY_GRADUATION_V1 \
//     --out /tmp/rollback_apply.json

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Client } = require('pg');

const CONFIRM_TOKEN = 'ROLLBACK_IPS_STUCK_IDENTITY_GRADUATION_V1';
// Must match graduate_ips_stuck_identity_approved.cjs:
const RULES_VERSION = 'external_seed_deterministic_v1';

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
// Pre-image loading
// ---------------------------------------------------------------------------

async function loadPreImage(filePath) {
  const entries = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineno = 0;
  for await (const line of rl) {
    lineno += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `pre-image line ${lineno} is not valid JSON: ${error?.message || error}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`pre-image line ${lineno} is not a JSON object`);
    }
    if (!parsed.content_key) {
      throw new Error(`pre-image line ${lineno} missing content_key`);
    }
    const ipsRow = parsed?.pre_image?.ips_row;
    if (!ipsRow || typeof ipsRow !== 'object') {
      throw new Error(
        `pre-image line ${lineno} (content_key=${parsed.content_key}) missing pre_image.ips_row — cannot rollback safely`,
      );
    }
    entries.push(parsed);
  }
  return entries;
}

// Pre-image JSONLs can contain duplicate content_keys for two reasons:
//   1. A single content_key has multiple catalog_products siblings (different
//      source_product_id). The graduation script writes one JSONL entry per
//      sibling because PQS is keyed on source_product_id, but IPS is keyed on
//      content_key.
//   2. Multiple graduation runs (canary + full + later corrections) appended
//      to the same file.
//
// We DO NOT dedupe at load time. The rollback iterates every entry:
//   - PQS DELETE is scoped to (merchant_id, platform, source_product_id,
//     rules_version) — every sibling's PQS row needs its own DELETE.
//   - IPS UPDATE is scoped to content_key. Running it once per entry is
//     idempotent across siblings (they share the same pre-image ips_row);
//     across runs the JSONL-order is chronological, so the LAST entry per
//     content_key wins, which is the desired "restore to most recent state
//     before the latest run" semantics.
//
// Net effect: 36 extra IPS UPDATEs in the 1,294-row case, all no-ops. Cheap
// insurance against PQS orphaning.

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Restore every IPS column the graduation UPSERT touched, sourced from the
// pre-image row. NULL values restore cleanly (the graduation runner's UPSERT
// can write NULL into all these columns except content_key/serving_eligible).
//
// Param order ($1..$17) matches IPS_UPDATE_VALUES below.
const IPS_RESTORE_SQL = `
  UPDATE index_pipeline_state SET
    pivota_signature_id        = $2,
    merchant_id                = $3,
    pipeline_stage             = $4,
    blocker_code               = $5,
    blocker_detail             = $6,
    serving_eligible           = $7,
    content_quality_score      = $8,
    quality_rules_version      = $9,
    quality_scored_at          = $10,
    seed_audit_status          = $11,
    identity_resolved          = $12,
    product_group_id           = $13,
    has_image                  = $14,
    has_price                  = $15,
    description_length         = $16,
    consolidation_version      = $17,
    last_consolidated_at       = $18
  WHERE content_key = $1
`;

// Delete only the rows our graduation runner inserted (tagged by
// RULES_VERSION). Pre-existing PQS rows with other rules_versions are kept.
const PQS_DELETE_SQL = `
  DELETE FROM product_quality_snapshot
  WHERE merchant_id = $1
    AND platform = $2
    AND platform_product_id = $3
    AND rules_version = $4
`;

function ipsRestoreParams(entry) {
  const ips = entry.pre_image.ips_row;
  return [
    entry.content_key,
    ips.pivota_signature_id ?? null,
    ips.merchant_id ?? null,
    ips.pipeline_stage ?? 'discovered',
    ips.blocker_code ?? 'none',
    ips.blocker_detail ?? null,
    ips.serving_eligible ?? false,
    ips.content_quality_score ?? null,
    ips.quality_rules_version ?? null,
    ips.quality_scored_at ?? null,
    ips.seed_audit_status ?? null,
    ips.identity_resolved ?? false,
    ips.product_group_id ?? null,
    ips.has_image ?? false,
    ips.has_price ?? false,
    ips.description_length ?? null,
    ips.consolidation_version ?? null,
    ips.last_consolidated_at ?? null,
  ];
}

function pqsDeleteParams(entry) {
  const ips = entry.pre_image.ips_row;
  // merchant_id/platform/source_product_id aren't always on the IPS row, but
  // they are on the top-level pre-image entry (graduation runner writes
  // merchant_id/platform/source_product_id alongside ips_row). Fall back to
  // ips.merchant_id if the top-level field is missing.
  const merchantId = entry.merchant_id ?? ips.merchant_id ?? null;
  const platform = entry.platform ?? null;
  const sourceProductId = entry.source_product_id ?? null;
  return [merchantId, platform, sourceProductId, RULES_VERSION];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyChunk(client, chunk) {
  await client.query('BEGIN');
  const applied = [];
  try {
    for (const entry of chunk) {
      const params = ipsRestoreParams(entry);
      // Defensive: if we can't identify merchant_id/platform/source_product_id,
      // we can still restore IPS but cannot scope a PQS delete safely. Refuse.
      const [, , , , , , , , , , , , , , , , ,] = params; // unused destructure for lint
      const pqsParams = pqsDeleteParams(entry);
      if (pqsParams.some((v) => v === null || v === undefined || v === '')) {
        throw new Error(
          `cannot safely delete PQS for content_key=${entry.content_key}: missing merchant_id/platform/source_product_id in pre-image`,
        );
      }
      const ipsResult = await client.query(IPS_RESTORE_SQL, params);
      const pqsResult = await client.query(PQS_DELETE_SQL, pqsParams);
      applied.push({
        content_key: entry.content_key,
        merchant_id: pqsParams[0],
        platform: pqsParams[1],
        source_product_id: pqsParams[2],
        ips_rows_updated: Number(ipsResult.rowCount || 0),
        pqs_rows_deleted: Number(pqsResult.rowCount || 0),
        outcome: 'rolled_back',
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return applied;
}

function planFor(entry) {
  return {
    content_key: entry.content_key,
    merchant_id: entry.merchant_id ?? entry.pre_image?.ips_row?.merchant_id ?? null,
    platform: entry.platform ?? null,
    source_product_id: entry.source_product_id ?? null,
    target_ips: {
      pipeline_stage: entry.pre_image.ips_row.pipeline_stage,
      blocker_code: entry.pre_image.ips_row.blocker_code,
      serving_eligible: entry.pre_image.ips_row.serving_eligible,
      content_quality_score: entry.pre_image.ips_row.content_quality_score,
      quality_rules_version: entry.pre_image.ips_row.quality_rules_version,
      consolidation_version: entry.pre_image.ips_row.consolidation_version,
    },
    will_delete_pqs_rules_version: RULES_VERSION,
  };
}

function summarize(results) {
  const summary = {
    total: results.length,
    rolled_back: 0,
    errored: 0,
    ips_rows_updated: 0,
    pqs_rows_deleted: 0,
    by_outcome: {},
  };
  for (const r of results) {
    summary.by_outcome[r.outcome] = (summary.by_outcome[r.outcome] || 0) + 1;
    if (r.outcome === 'rolled_back') summary.rolled_back += 1;
    if (r.outcome === 'error') summary.errored += 1;
    summary.ips_rows_updated += Number(r.ips_rows_updated || 0);
    summary.pqs_rows_deleted += Number(r.pqs_rows_deleted || 0);
  }
  return summary;
}

async function main() {
  const preImagePath = argValue('pre-image');
  const write = hasFlag('write');
  const confirm = argValue('confirm');
  const out = argValue('out');
  const runId = `rollback_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  if (!preImagePath) {
    throw new Error('--pre-image <path> is required');
  }
  if (!fs.existsSync(preImagePath)) {
    throw new Error(`pre-image file not found: ${preImagePath}`);
  }
  if (write && confirm !== CONFIRM_TOKEN) {
    throw new Error(`--write requires --confirm ${CONFIRM_TOKEN}`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required');
  }

  const entries = await loadPreImage(preImagePath);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();

  const results = [];
  let consecutiveFailures = 0;
  let totalErrors = 0;
  let aborted = false;
  let abortReason = null;

  try {
    if (!write) {
      for (const entry of entries) {
        results.push({ ...planFor(entry), outcome: 'planned' });
      }
    } else {
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        try {
          const applied = await applyChunk(client, chunk);
          results.push(...applied);
          consecutiveFailures = 0;
        } catch (error) {
          totalErrors += chunk.length;
          consecutiveFailures += 1;
          for (const entry of chunk) {
            results.push({
              ...planFor(entry),
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
      pre_image_file: preImagePath,
      pre_image_entries_total: entries.length,
      pre_image_entries_unique_content_keys: new Set(
        entries.map((e) => e.content_key),
      ).size,
      rules_version_targeted_for_pqs_delete: RULES_VERSION,
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
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
