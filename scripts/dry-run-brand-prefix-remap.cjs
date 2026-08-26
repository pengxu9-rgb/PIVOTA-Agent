#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { closeReadOnlyPool, queryReadOnly } = require('./lib/read-only-db.cjs');

const KEY_PREFIX = 'ck_';
const KEY_HEX_LEN = 32;

const ACTIVE_PRODUCTS_QUERY = `
WITH active_products AS (
  SELECT
    cp.product_key,
    cp.brand,
    cp.title,
    cp.content_key,
    cp.source_system,
    cp.merchant_id,
    cp.platform,
    cp.source_product_id,
    cp.updated_at
  FROM catalog_products cp
  WHERE COALESCE(cp.sync_status, 'live') NOT IN ('inactive', 'archived', 'deleted')
    AND COALESCE(cp.pdp_lifecycle_stage, 'live') NOT IN ('hold', 'archived', 'deleted')
),
sku_summary AS (
  SELECT
    s.product_key,
    MAX(NULLIF(s.barcode, '')) AS gtin,
    COUNT(DISTINCT o.offer_id) FILTER (
      WHERE o.offer_id IS NOT NULL
        AND o.suppressed_at IS NULL
        AND COALESCE(o.list_price, 0) > 0
    )::int AS positive_offer_count
  FROM catalog_skus s
  LEFT JOIN catalog_offers o
    ON o.sku_key = s.sku_key
  WHERE s.product_key IN (SELECT product_key FROM active_products)
  GROUP BY s.product_key
),
identity_summary AS (
  SELECT
    ap.product_key,
    COUNT(DISTINCT pil.source_listing_ref) FILTER (
      WHERE pil.source_listing_ref IS NOT NULL
        AND pil.identity_status = 'approved'
        AND COALESCE(pil.live_read_enabled, false) = true
    )::int AS live_identity_count
  FROM active_products ap
  LEFT JOIN pdp_identity_listing pil
    ON pil.merchant_id = ap.merchant_id
   AND pil.product_id = ap.source_product_id
  GROUP BY ap.product_key
)
SELECT
  ap.product_key,
  ap.brand,
  ap.title,
  ap.content_key AS current_ck,
  ap.source_system,
  COALESCE(ss.gtin, '') AS gtin,
  COALESCE(ss.positive_offer_count, 0)::int AS positive_offer_count,
  COALESCE(isum.live_identity_count, 0)::int AS live_identity_count
FROM active_products ap
LEFT JOIN sku_summary ss ON ss.product_key = ap.product_key
LEFT JOIN identity_summary isum ON isum.product_key = ap.product_key
ORDER BY ap.updated_at DESC NULLS LAST, ap.product_key
`.trim();

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeBrand(brand) {
  let value = text(brand).toLowerCase();
  if (!value) return '';
  value = value.replace(/[®™]/g, '');
  value = value.replace(/\s*\((?:r|tm)\)\s*/g, ' ');
  let tokens = value.split(/\s+/).filter(Boolean);
  const suffixes = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'company']);
  while (tokens.length && suffixes.has(tokens[tokens.length - 1].replace(/[.,]+$/g, ''))) {
    tokens.pop();
  }
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title) {
  let value = text(title);
  if (!value) return '';
  value = value.normalize('NFKD').replace(/\p{Mark}/gu, '');
  value = value.toLowerCase();
  value = value.replace(/[^\p{Letter}\p{Number}_\s-]/gu, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeGtin(gtin) {
  const digits = text(gtin).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 14) return digits.padStart(14, '0');
  return digits;
}

function hashContentKey(brandNorm, titleNorm, gtinNorm) {
  if (!brandNorm || !titleNorm) return null;
  const digest = crypto
    .createHash('sha256')
    .update(`${brandNorm}::${titleNorm}::${gtinNorm}`, 'utf8')
    .digest('hex')
    .slice(0, KEY_HEX_LEN);
  return `${KEY_PREFIX}${digest}`;
}

function makeCurrentContentKey(brand, title, gtin = null) {
  return hashContentKey(normalizeBrand(brand), normalizeTitle(title), normalizeGtin(gtin));
}

function stripLeadingBrandPrefixFromNormalizedTitle(brand, title) {
  const brandNorm = normalizeTitle(brand);
  const titleNorm = normalizeTitle(title);
  if (!brandNorm || !titleNorm) return titleNorm;
  if (titleNorm === brandNorm) return '';
  if (!titleNorm.startsWith(brandNorm)) return titleNorm;
  const rest = titleNorm.slice(brandNorm.length);
  if (!/^(?:\s+|-+\s*)/.test(rest)) return titleNorm;
  return rest.replace(/^(?:\s+|-+\s*)/, '').trim();
}

function makeProposedBrandPrefixContentKey(brand, title, gtin = null) {
  return hashContentKey(
    normalizeBrand(brand),
    stripLeadingBrandPrefixFromNormalizedTitle(brand, title),
    normalizeGtin(gtin),
  );
}

function changed(currentCk, proposedCk) {
  return text(currentCk) !== text(proposedCk);
}

function uniq(values) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function groupRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

function analyzeRows(rows) {
  const enriched = rows.map((row) => ({
    ...row,
    proposed_ck: makeProposedBrandPrefixContentKey(row.brand, row.title, row.gtin),
  }));
  const changedRows = enriched.filter((row) => changed(row.current_ck, row.proposed_ck));
  const proposedGroups = Array.from(groupRows(enriched, (row) => row.proposed_ck).values());
  const collapseGroups = proposedGroups.filter((group) => {
    const currentKeys = uniq(group.map((row) => row.current_ck));
    const sources = uniq(group.map((row) => row.source_system));
    return currentKeys.length > 1 && sources.length > 1;
  });
  const proposedMergedRows = collapseGroups.flat();
  return {
    rows: enriched,
    totalRows: enriched.length,
    changedRows,
    collapseGroups,
    proposedMergedRows,
    proposedMergedRowsWithPositiveOffers: proposedMergedRows.filter((row) => Number(row.positive_offer_count || 0) > 0),
    proposedMergedRowsWithLiveIdentity: proposedMergedRows.filter((row) => Number(row.live_identity_count || 0) > 0),
  };
}

function table(headers, rows) {
  const escapeCell = (value) => text(value).replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((header) => escapeCell(row[header])).join(' | ')} |`),
  ].join('\n');
}

function renderReport(analysis, generatedAt) {
  const exampleRows = analysis.changedRows.slice(0, 50).map((row) => ({
    product_key: row.product_key,
    brand: row.brand,
    title: row.title,
    current_ck: row.current_ck,
    proposed_ck: row.proposed_ck,
  }));
  const collapseRows = analysis.collapseGroups.slice(0, 25).map((group) => ({
    proposed_ck: group[0].proposed_ck,
    rows: group.length,
    current_keys: uniq(group.map((row) => row.current_ck)).length,
    sources: uniq(group.map((row) => row.source_system)).join(', '),
    positive_offer_rows: group.filter((row) => Number(row.positive_offer_count || 0) > 0).length,
    live_identity_rows: group.filter((row) => Number(row.live_identity_count || 0) > 0).length,
  }));

  return [
    '# Content Key Brand Prefix Dry Run',
    '',
    `Generated at: ${generatedAt}`,
    '',
    '## Headline',
    '',
    `- Active catalog rows scanned: ${analysis.totalRows}`,
    `- Rows whose content_key would change: ${analysis.changedRows.length}`,
    `- Cross-source divergent groups that would collapse: ${analysis.collapseGroups.length}`,
    `- Proposed-merged rows with positive offers: ${analysis.proposedMergedRowsWithPositiveOffers.length}`,
    `- Proposed-merged rows with live identity: ${analysis.proposedMergedRowsWithLiveIdentity.length}`,
    '',
    '## Top 50 Example Diffs',
    '',
    exampleRows.length
      ? table(['product_key', 'brand', 'title', 'current_ck', 'proposed_ck'], exampleRows)
      : '_No changed rows._',
    '',
    '## Cross-Source Collapse Examples',
    '',
    collapseRows.length
      ? table(['proposed_ck', 'rows', 'current_keys', 'sources', 'positive_offer_rows', 'live_identity_rows'], collapseRows)
      : '_No cross-source divergent groups would collapse._',
    '',
    '## Scope',
    '',
    '- This report is read-only. No catalog rows were inserted, updated, deleted, or backfilled.',
    '- The proposed algorithm changes only the title input to the existing hash by stripping a leading brand prefix before hashing.',
    '',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { outDir: 'reports', date: new Date().toISOString().slice(0, 10).replace(/-/g, '') };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--out-dir') {
      args.outDir = argv[index + 1] || args.outDir;
      index += 1;
    } else if (item === '--date') {
      args.date = String(argv[index + 1] || args.date).replace(/-/g, '');
      index += 1;
    } else if (item === '--help') {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/dry-run-brand-prefix-remap.cjs [--out-dir reports] [--date YYYYMMDD]',
    '',
    'Reads active catalog_products through DATABASE_URL_PUBLIC and writes a markdown dry-run report.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const result = await queryReadOnly(ACTIVE_PRODUCTS_QUERY);
  const analysis = analyzeRows(result.rows || []);
  const generatedAt = new Date().toISOString();
  const report = renderReport(analysis, generatedAt);
  const outDir = path.resolve(process.cwd(), args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `CONTENT_KEY_BRAND_PREFIX_DRYRUN_${args.date}.md`);
  fs.writeFileSync(reportPath, report);
  process.stdout.write(`report_path=${reportPath}\n`);
  process.stdout.write(`rows_would_change=${analysis.changedRows.length}\n`);
  process.stdout.write(`cross_source_groups_would_collapse=${analysis.collapseGroups.length}\n`);
  return { reportPath, analysis };
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err?.message || err}\n`);
      process.exitCode = 1;
    })
    .finally(() => closeReadOnlyPool().catch(() => {}));
}

module.exports = {
  analyzeRows,
  makeCurrentContentKey,
  makeProposedBrandPrefixContentKey,
  normalizeBrand,
  normalizeGtin,
  normalizeTitle,
  stripLeadingBrandPrefixFromNormalizedTitle,
};
