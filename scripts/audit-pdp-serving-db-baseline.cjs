#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { Client } = require('pg');

function readArg(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

function readNumberArg(name, fallback, min = 0) {
  const n = Number(readArg(name, String(fallback)));
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBlocker(row) {
  const blocker = text(row.blocker_code);
  if (blocker && blocker !== 'none') return blocker;
  if (row.serving_eligible === true) return 'none';
  if (row.index_row_found !== true) return 'serving_eligibility_missing';
  return 'not_serving_eligible';
}

function classifyAction(row) {
  const blocker = normalizeBlocker(row);
  const detail = text(row.blocker_detail).toLowerCase();
  const title = text(row.title).toLowerCase();
  const sourceProductId = text(row.source_product_id).toLowerCase();
  const lifecycle = text(row.pdp_lifecycle_stage).toLowerCase();
  const syncStatus = text(row.sync_status).toLowerCase();
  const isTestLike =
    /\b(test|dummy|fixture|sample-only)\b/.test(title) ||
    /\b(test|dummy|fixture)\b/.test(sourceProductId);

  if (blocker === 'none') {
    return {
      lane: 'retain',
      action: 'serving_ready_no_action',
      rationale: 'index_pipeline_state marks this PDP serving_eligible=true',
    };
  }
  if (isTestLike) {
    return {
      lane: 'archive',
      action: 'archive_test_or_fixture_row',
      rationale: 'test-like title or source id should not be public PDP material',
    };
  }
  if (
    blocker === 'non_core_product' ||
    blocker === 'not_live' ||
    blocker === 'terminal_hold' ||
    lifecycle === 'archived' ||
    lifecycle === 'hold' ||
    syncStatus === 'archived' ||
    syncStatus === 'deleted' ||
    syncStatus === 'inactive'
  ) {
    return {
      lane: 'quarantine',
      action: 'keep_non_serving_or_archive_after_owner_review',
      rationale: 'lifecycle or blocker indicates this is not a public-serving PDP',
    };
  }
  if (
    blocker === 'low_quality' ||
    blocker === 'quality_snapshot_missing' ||
    detail.includes('quality snapshot') ||
    detail.includes('content_quality_score')
  ) {
    return {
      lane: 'repair',
      action: 'repair_quality_snapshot_then_recompute_index_state',
      rationale: 'quality evidence is missing or below serving threshold',
    };
  }
  if (blocker === 'no_seed' || blocker === 'serving_eligibility_missing') {
    return {
      lane: 'repair',
      action: 'repair_catalog_mirror_or_agent_pdp_view_then_recompute_index_state',
      rationale: 'public sig exists but serving eligibility evidence is missing',
    };
  }
  if (blocker === 'missing_price' || blocker === 'no_price') {
    return {
      lane: 'repair',
      action: 'repair_exact_source_offer_price_then_recompute_index_state',
      rationale: 'commerce offer evidence is incomplete',
    };
  }
  if (blocker === 'no_image' || blocker === 'missing_image') {
    return {
      lane: 'repair',
      action: 'repair_exact_source_image_then_recompute_index_state',
      rationale: 'catalog or seed image evidence is incomplete',
    };
  }
  if (
    blocker === 'short_description' ||
    blocker === 'missing_description' ||
    blocker === 'description_missing'
  ) {
    return {
      lane: 'repair',
      action: 'repair_exact_source_description_then_recompute_index_state',
      rationale: 'PDP content evidence is incomplete',
    };
  }
  if (
    blocker === 'entity_unresolved' ||
    blocker === 'identity_unresolved' ||
    blocker === 'seed_audit_fail' ||
    blocker === 'extractor_regression'
  ) {
    return {
      lane: 'repair',
      action: 'repair_identity_or_extractor_audit_then_recompute_index_state',
      rationale: 'identity/extractor gate must be corrected before public serving',
    };
  }
  return {
    lane: 'quarantine',
    action: 'quarantine_until_blocker_has_owner',
    rationale: 'unrecognized non-serving blocker should stay out of public PDPs',
  };
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) || 'none';
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

async function ensureParent(filePath) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName],
  );
  return result.rowCount > 0;
}

async function columnsFor(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function firstColumn(columns, names) {
  return names.find((name) => columns.has(name)) || null;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const outDir = readArg('out-dir', 'reports/pdp_serving_baseline_20260524/db');
  const liveBaselinePath = readArg('live-baseline', null);
  const limit = readNumberArg('limit', 0, 0);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const hasQualitySnapshot = await tableExists(client, 'product_quality_snapshot');
    const qualityColumns = hasQualitySnapshot
      ? await columnsFor(client, 'product_quality_snapshot')
      : new Set();
    const qualityContentKey = firstColumn(qualityColumns, ['content_key']);
    const qualityScore = firstColumn(qualityColumns, ['content_quality_score', 'quality_score', 'score']);
    const qualityScoredAt = firstColumn(qualityColumns, ['quality_scored_at', 'scored_at', 'updated_at', 'created_at']);
    const qualityJoin =
      hasQualitySnapshot && qualityContentKey
        ? `LEFT JOIN product_quality_snapshot pqs ON pqs.${qualityContentKey} = cp.content_key`
        : '';
    const qualitySelect =
      hasQualitySnapshot && qualityContentKey
        ? `,
          TRUE AS quality_snapshot_table_found,
          pqs.${qualityContentKey} IS NOT NULL AS quality_snapshot_found,
          ${qualityScore ? `pqs.${qualityScore}` : 'NULL'} AS quality_snapshot_score,
          ${qualityScoredAt ? `pqs.${qualityScoredAt}` : 'NULL'} AS quality_snapshot_scored_at`
        : `,
          ${hasQualitySnapshot ? 'TRUE' : 'FALSE'} AS quality_snapshot_table_found,
          FALSE AS quality_snapshot_found,
          NULL AS quality_snapshot_score,
          NULL AS quality_snapshot_scored_at`;

    let liveSitemapIds = new Set();
    if (liveBaselinePath) {
      try {
        const live = JSON.parse(await fs.readFile(liveBaselinePath, 'utf8'));
        liveSitemapIds = new Set((live.rows || []).map((row) => text(row.product_id)).filter(Boolean));
      } catch (_err) {
        liveSitemapIds = new Set();
      }
    }

    const sql = `
      SELECT
        cp.pivota_signature_id AS sig_id,
        cp.content_key,
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_system,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.product_type,
        cp.canonical_url,
        cp.pivota_canonical_url,
        cp.image_url AS catalog_image_url,
        cp.description AS catalog_description,
        cp.sync_status,
        cp.pdp_lifecycle_stage,
        cp.updated_at AS catalog_updated_at,
        ips.content_key IS NOT NULL AS index_row_found,
        ips.serving_eligible,
        ips.pipeline_stage,
        ips.blocker_code,
        ips.blocker_detail,
        ips.content_quality_score,
        ips.quality_scored_at,
        eps.id AS external_seed_id,
        eps.external_product_id,
        eps.status AS external_seed_status,
        eps.canonical_url AS seed_canonical_url,
        eps.destination_url AS seed_destination_url,
        eps.image_url AS seed_image_url,
        eps.price_amount AS seed_price_amount,
        eps.price_currency AS seed_price_currency
        ${qualitySelect}
      FROM catalog_products cp
      LEFT JOIN index_pipeline_state ips ON ips.content_key = cp.content_key
      LEFT JOIN external_product_seeds eps
        ON cp.source_system = 'external_product_seeds_mirror_v1'
       AND eps.external_product_id = cp.source_product_id
      ${qualityJoin}
      WHERE cp.pivota_signature_id LIKE 'sig_%'
      ORDER BY
        COALESCE(ips.serving_eligible, FALSE) ASC,
        COALESCE(ips.blocker_code, 'serving_eligibility_missing') ASC,
        cp.updated_at DESC NULLS LAST,
        cp.pivota_signature_id ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}
    `;
    const result = await client.query(sql);
    const rows = result.rows.map((row) => {
      const blocker = normalizeBlocker(row);
      const action = classifyAction(row);
      return {
        sig_id: text(row.sig_id),
        content_key: text(row.content_key),
        product_key: text(row.product_key),
        merchant_id: text(row.merchant_id),
        source_system: text(row.source_system),
        source_product_id: text(row.source_product_id),
        title: text(row.title),
        brand: text(row.brand),
        canonical_url: text(row.canonical_url),
        public_url: `https://agent.pivota.cc/products/${text(row.sig_id)}`,
        in_live_sitemap_baseline: liveSitemapIds.has(text(row.sig_id)),
        index_row_found: row.index_row_found === true,
        serving_eligible: row.serving_eligible === true,
        blocker_code: blocker,
        blocker_detail: text(row.blocker_detail),
        content_quality_score: row.content_quality_score == null ? null : Number(row.content_quality_score),
        quality_scored_at: row.quality_scored_at,
        quality_snapshot_table_found: row.quality_snapshot_table_found === true,
        quality_snapshot_found: row.quality_snapshot_found === true,
        quality_snapshot_score: row.quality_snapshot_score == null ? null : Number(row.quality_snapshot_score),
        quality_snapshot_scored_at: row.quality_snapshot_scored_at,
        external_seed_id: text(row.external_seed_id),
        external_product_id: text(row.external_product_id),
        external_seed_status: text(row.external_seed_status),
        seed_canonical_url: text(row.seed_canonical_url),
        seed_destination_url: text(row.seed_destination_url),
        seed_image_url: text(row.seed_image_url),
        seed_price_amount: row.seed_price_amount,
        seed_price_currency: text(row.seed_price_currency),
        sync_status: text(row.sync_status),
        pdp_lifecycle_stage: text(row.pdp_lifecycle_stage),
        catalog_updated_at: row.catalog_updated_at,
        lane: action.lane,
        recommended_action: action.action,
        action_rationale: action.rationale,
      };
    });

    const blockedRows = rows.filter((row) => !row.serving_eligible);
    const summary = {
      generated_at: new Date().toISOString(),
      scope: 'catalog_products_sig_index_pipeline_state',
      total_sig_rows: rows.length,
      serving_eligible_count: rows.filter((row) => row.serving_eligible).length,
      non_serving_count: blockedRows.length,
      live_sitemap_baseline_count: liveSitemapIds.size,
      live_sitemap_rows_in_db_baseline: rows.filter((row) => row.in_live_sitemap_baseline).length,
      quality_snapshot_table_found: rows.some((row) => row.quality_snapshot_table_found),
      by_blocker: countBy(rows, (row) => row.blocker_code),
      by_lane: countBy(rows, (row) => row.lane),
      by_recommended_action: countBy(rows, (row) => row.recommended_action),
      by_source_system: countBy(rows, (row) => row.source_system || 'unknown'),
      exposed_non_serving_rows: blockedRows.filter((row) => row.in_live_sitemap_baseline).length,
    };

    const actionRows = rows.filter((row) => row.lane !== 'retain');
    const paths = {
      summary: path.join(outDir, 'summary.json'),
      rows: path.join(outDir, 'rows.json'),
      actions: path.join(outDir, 'actions.json'),
      actionsCsv: path.join(outDir, 'actions.csv'),
    };
    await Promise.all(Object.values(paths).map(ensureParent));
    await fs.writeFile(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(paths.rows, `${JSON.stringify(rows, null, 2)}\n`);
    await fs.writeFile(paths.actions, `${JSON.stringify(actionRows, null, 2)}\n`);
    await fs.writeFile(
      paths.actionsCsv,
      toCsv(actionRows, [
        'lane',
        'recommended_action',
        'blocker_code',
        'sig_id',
        'content_key',
        'source_system',
        'source_product_id',
        'external_seed_id',
        'external_product_id',
        'title',
        'content_quality_score',
        'quality_snapshot_found',
        'sync_status',
        'pdp_lifecycle_stage',
        'public_url',
        'action_rationale',
      ]),
    );

    process.stdout.write(`${JSON.stringify({ summary, paths }, null, 2)}\n`);
    if (summary.non_serving_count > 0 || summary.exposed_non_serving_rows > 0) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
