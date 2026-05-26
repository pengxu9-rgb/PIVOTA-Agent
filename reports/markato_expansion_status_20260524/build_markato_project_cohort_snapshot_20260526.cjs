#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../src/db');

const REPORT_ROOT = __dirname;
const WAVE5_DOMAINS = ['activedrip.com', 'coconutmatter.com', 'joujoubotanicals.com'];

function asText(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return '';
}

function readJsonMaybe(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function brandFromSeed(row) {
  const seedData = asObject(readJsonMaybe(row.seed_data));
  const snapshot = asObject(seedData.snapshot);
  return firstText(
    asObject(seedData.brand).name,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    row.catalog_brand,
    row.domain,
  );
}

function productIntelStatus(row) {
  const analysis = asObject(readJsonMaybe(row.kb_analysis));
  const bundle = asObject(analysis.product_intel_v1);
  const legacyBundle = asObject(analysis.product_intel);
  const selected = Object.keys(bundle).length > 0 ? bundle : legacyBundle;
  const core = asObject(selected.product_intel_core);
  const quality = firstText(selected.quality_state, core.quality_state).toLowerCase();
  const evidence = firstText(selected.evidence_profile, core.evidence_profile).toLowerCase();
  const why = asArray(core.why_it_stands_out || selected.why_it_stands_out);
  const headline = firstText(core.what_it_is?.headline, selected.what_it_is?.headline);
  const reviewed = ['reviewed', 'verified', 'published'].includes(quality);
  return {
    reviewed,
    highQuality: Boolean(row.kb_key && reviewed && headline && why.length > 0 && evidence && evidence !== 'seller_only'),
  };
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function csvEscape(value) {
  const text = typeof value === 'number' ? String(value) : asText(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'markato_coverage_snapshot_20260526') continue;
      if (entry.name.includes('candidate_probe')) continue;
      walkFiles(filePath, files);
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function isTargetArtifact(filePath) {
  const relative = path.relative(REPORT_ROOT, filePath);
  if (!relative.endsWith('.json') && !relative.endsWith('.csv')) return false;
  if (relative.includes('candidate_probe')) return false;
  if (relative.includes('agent_wave7')) return false;
  if (relative.includes('agent_wave6')) return false;
  if (relative.includes('readiness_inventory')) return false;
  if (relative.includes('identity_payload_audit')) return false;
  if (relative === 'wave6_prod_apply_candidate_manifest.json') return true;
  if (/^wave(1[1-9]|2[0-2])_/.test(relative)) {
    return /(^|\/)(candidate_manifest|db_ready_candidate_manifest|masami_candidate_manifest|prod_db_apply|catalog_sync_apply|product_intel_publish_apply|official_seed_product_intel_report|wave20_nubest_official_candidate_manifest).*\.json$/.test(path.basename(relative))
      || /candidate_manifest.*\.json$/.test(path.basename(relative));
  }
  if (relative === 'wave5_official_source_gap_sheet_20260524.csv') return true;
  if (relative === 'wave5_cactus_nectar_reviewed_inci_manifest.json') return true;
  return false;
}

function collectTargetIds() {
  const ids = new Map();
  for (const filePath of walkFiles(REPORT_ROOT)) {
    if (!isTargetArtifact(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const match of text.matchAll(/\bext_[a-f0-9]{16,}\b/g)) {
      const id = match[0];
      if (!ids.has(id)) ids.set(id, new Set());
      ids.get(id).add(path.relative(REPORT_ROOT, filePath));
    }
  }
  return ids;
}

function increment(map, key, count = 1) {
  map.set(key, (map.get(key) || 0) + count);
}

async function main() {
  const outDir = process.argv[2] || path.join(REPORT_ROOT, 'markato_project_cohort_snapshot_20260526');
  fs.mkdirSync(outDir, { recursive: true });

  const targetIdSources = collectTargetIds();
  const targetIds = Array.from(targetIdSources.keys()).sort();

  const result = await query(`
    WITH seed_rows AS (
      SELECT
        eps.id AS seed_id,
        eps.external_product_id,
        eps.domain,
        eps.market,
        eps.status,
        eps.tool,
        eps.title,
        eps.seed_data,
        eps.attached_product_key,
        eps.updated_at
      FROM external_product_seeds eps
      WHERE eps.status = 'active'
        AND eps.market = 'US'
        AND (
          eps.external_product_id = ANY($1::text[])
          OR eps.domain = ANY($2::text[])
        )
    ),
    catalog_one AS (
      SELECT DISTINCT ON (cp.source_product_id)
        cp.source_product_id,
        cp.product_key,
        cp.content_key,
        cp.brand AS catalog_brand,
        cp.title AS catalog_title
      FROM catalog_products cp
      WHERE cp.merchant_id = 'external_seed'
        AND cp.platform = 'external_seed'
        AND cp.source_system = 'external_product_seeds_mirror_v1'
      ORDER BY cp.source_product_id, cp.updated_at DESC NULLS LAST, cp.product_key DESC NULLS LAST, cp.content_key DESC NULLS LAST
    )
    SELECT
      s.*,
      c.product_key AS catalog_product_key,
      c.content_key,
      c.catalog_brand,
      c.catalog_title,
      ips.serving_eligible,
      ips.blocker_code,
      pil.identity_status,
      pil.live_read_enabled,
      pil.review_required,
      pil.sellable_item_group_id,
      kb.kb_key,
      kb.analysis AS kb_analysis
    FROM seed_rows s
    LEFT JOIN catalog_one c
      ON c.source_product_id = s.external_product_id
    LEFT JOIN index_pipeline_state ips
      ON ips.content_key = c.content_key
    LEFT JOIN pdp_identity_listing pil
      ON pil.merchant_id = 'external_seed'
     AND pil.product_id = s.external_product_id
    LEFT JOIN aurora_product_intel_kb kb
      ON kb.kb_key = ('product:' || s.external_product_id)
    ORDER BY s.domain, s.external_product_id
  `, [targetIds, WAVE5_DOMAINS]);

  const byDomain = new Map();
  const blockerCounts = new Map();
  const rows = result.rows || [];
  const productRows = [];
  for (const row of rows) {
    const domain = asText(row.domain) || 'unknown';
    if (!byDomain.has(domain)) {
      byDomain.set(domain, {
        domain,
        brand: '',
        target_products: 0,
        catalog_pdp_products: 0,
        db_serving_ready_products: 0,
        identity_ready_products: 0,
        reviewed_product_intel_products: 0,
        high_quality_product_intel_products: 0,
        explicit_blocker_products: 0,
        blocker_summary: '',
      });
    }
    const item = byDomain.get(domain);
    const brand = brandFromSeed(row);
    if (!item.brand && brand) item.brand = brand;
    item.target_products += 1;
    if (row.catalog_product_key) item.catalog_pdp_products += 1;
    if (row.serving_eligible === true) item.db_serving_ready_products += 1;
    if (
      row.identity_status === 'approved' &&
      row.live_read_enabled === true &&
      row.review_required !== true &&
      asText(row.sellable_item_group_id)
    ) {
      item.identity_ready_products += 1;
    }
    const intel = productIntelStatus(row);
    if (intel.reviewed) item.reviewed_product_intel_products += 1;
    if (intel.highQuality) item.high_quality_product_intel_products += 1;
    const blockerCode = asText(row.blocker_code);
    if (blockerCode && blockerCode !== 'none') {
      item.explicit_blocker_products += 1;
      increment(blockerCounts, blockerCode);
      increment(item._blockers || (item._blockers = new Map()), blockerCode);
    }
    productRows.push({
      domain,
      brand,
      external_product_id: row.external_product_id,
      title: row.title,
      catalog_product_key: row.catalog_product_key || '',
      content_key: row.content_key || '',
      serving_eligible: row.serving_eligible === true,
      blocker_code: blockerCode,
      identity_ready: Boolean(
        row.identity_status === 'approved' &&
        row.live_read_enabled === true &&
        row.review_required !== true &&
        asText(row.sellable_item_group_id)
      ),
      product_intel_reviewed: intel.reviewed,
      product_intel_high_quality: intel.highQuality,
    });
  }

  const brandRows = Array.from(byDomain.values()).map((item) => {
    const blocker_summary = item._blockers
      ? Array.from(item._blockers.entries()).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}:${count}`).join(' | ')
      : '';
    delete item._blockers;
    return {
      ...item,
      brand: item.brand || item.domain,
      catalog_pdp_coverage_pct: pct(item.catalog_pdp_products, item.target_products),
      db_serving_ready_coverage_pct: pct(item.db_serving_ready_products, item.target_products),
      high_quality_intel_coverage_pct: pct(item.high_quality_product_intel_products, item.target_products),
      blocker_summary,
    };
  }).sort((a, b) => b.target_products - a.target_products || a.domain.localeCompare(b.domain));

  const summary = {
    generated_at: new Date().toISOString(),
    source: 'markato_project_targeted_sku_cohort_from_local_wave_artifacts_plus_wave5_domains',
    target_artifact_external_ids: targetIds.length,
    wave5_domain_scope: WAVE5_DOMAINS,
    production_target_products: rows.length,
    brands: brandRows.length,
    catalog_pdp_products: brandRows.reduce((sum, row) => sum + row.catalog_pdp_products, 0),
    db_serving_ready_products: brandRows.reduce((sum, row) => sum + row.db_serving_ready_products, 0),
    identity_ready_products: brandRows.reduce((sum, row) => sum + row.identity_ready_products, 0),
    reviewed_product_intel_products: brandRows.reduce((sum, row) => sum + row.reviewed_product_intel_products, 0),
    high_quality_product_intel_products: brandRows.reduce((sum, row) => sum + row.high_quality_product_intel_products, 0),
    catalog_pdp_coverage_pct: pct(brandRows.reduce((sum, row) => sum + row.catalog_pdp_products, 0), rows.length),
    db_serving_ready_coverage_pct: pct(brandRows.reduce((sum, row) => sum + row.db_serving_ready_products, 0), rows.length),
    high_quality_intel_coverage_pct: pct(brandRows.reduce((sum, row) => sum + row.high_quality_product_intel_products, 0), rows.length),
    brands_100pct_catalog: brandRows.filter((row) => row.catalog_pdp_coverage_pct === 100).length,
    brands_100pct_serving_ready: brandRows.filter((row) => row.db_serving_ready_coverage_pct === 100).length,
    brands_0pct_serving_ready: brandRows.filter((row) => row.db_serving_ready_products === 0).length,
    blocker_summary: Array.from(blockerCounts.entries()).map(([blocker_code, product_count]) => ({ blocker_code, product_count })).sort((a, b) => b.product_count - a.product_count),
  };

  const brandColumns = [
    'domain',
    'brand',
    'target_products',
    'catalog_pdp_products',
    'catalog_pdp_coverage_pct',
    'db_serving_ready_products',
    'db_serving_ready_coverage_pct',
    'identity_ready_products',
    'reviewed_product_intel_products',
    'high_quality_product_intel_products',
    'high_quality_intel_coverage_pct',
    'explicit_blocker_products',
    'blocker_summary',
  ];
  const productColumns = [
    'domain',
    'brand',
    'external_product_id',
    'title',
    'catalog_product_key',
    'content_key',
    'serving_eligible',
    'blocker_code',
    'identity_ready',
    'product_intel_reviewed',
    'product_intel_high_quality',
  ];

  writeJson(path.join(outDir, 'summary.json'), summary);
  writeJson(path.join(outDir, 'brand_coverage.json'), brandRows);
  writeJson(path.join(outDir, 'product_coverage.json'), productRows);
  writeJson(path.join(outDir, 'target_id_sources.json'), Object.fromEntries(Array.from(targetIdSources.entries()).map(([id, files]) => [id, Array.from(files)])));
  writeCsv(path.join(outDir, 'brand_coverage.csv'), brandRows, brandColumns);
  writeCsv(path.join(outDir, 'product_coverage.csv'), productRows, productColumns);

  process.stdout.write(`${JSON.stringify({ ok: true, out_dir: outDir, summary, brandRows }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
