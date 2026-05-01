#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function normalizeMarket(value) {
  return asString(value).toUpperCase() || 'US';
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeFilePart(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'all';
}

function buildRecommendedCommands(entry, externalIdsFilePath) {
  const market = normalizeMarket(entry.market || 'US');
  const quotedBrand = JSON.stringify(entry.brand || '');
  return {
    dry_run_by_brand:
      `DATABASE_URL=<db_url> node scripts/backfill-external-product-seeds-catalog.js ` +
      `--market ${market} --brand ${quotedBrand} --include-commerce-facts --skip-insights --concurrency 1 --dry-run`,
    apply_by_brand:
      `DATABASE_URL=<db_url> node scripts/backfill-external-product-seeds-catalog.js ` +
      `--market ${market} --brand ${quotedBrand} --include-commerce-facts --skip-insights --concurrency 1`,
    ...(externalIdsFilePath
      ? {
          dry_run_by_external_ids:
            `DATABASE_URL=<db_url> node scripts/backfill-external-product-seeds-catalog.js ` +
            `--market ${market} --external-product-ids-file ${externalIdsFilePath} --include-commerce-facts --skip-insights --concurrency 1 --dry-run`,
          apply_by_external_ids:
            `DATABASE_URL=<db_url> node scripts/backfill-external-product-seeds-catalog.js ` +
            `--market ${market} --external-product-ids-file ${externalIdsFilePath} --include-commerce-facts --skip-insights --concurrency 1`,
        }
      : {}),
  };
}

function buildBacklogEntries(summary, summaryPath) {
  const reportDir = path.dirname(summaryPath);
  const manifests = Array.isArray(summary.manifests) ? summary.manifests : [];
  const entries = [];

  for (const manifestSummary of manifests) {
    const dryRun = manifestSummary.dry_run_summary || {};
    if (dryRun.database_available !== false) continue;
    if (!(Number(dryRun.would_insert_unverified) > 0)) continue;
    if (Number(manifestSummary.channel_row_count || 0) > 0) continue;
    if (!(Number(manifestSummary.gate_pass_count || 0) > 0)) continue;

    const manifestPath = path.resolve(reportDir, manifestSummary.file || '');
    const manifest = readJson(manifestPath, {});
    const items = Array.isArray(manifest.items) ? manifest.items : [];
    const targets = items
      .map((item) => item.seed_row || item.seedRow || item)
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        external_product_id: asString(row.external_product_id),
        title: asString(row.title),
        canonical_url: asString(row.canonical_url),
        destination_url: asString(row.destination_url),
        price_amount: row.price_amount ?? null,
        price_currency: asString(row.price_currency),
        availability: asString(row.availability),
      }))
      .filter((row) => row.external_product_id);

    const externalIdsFilePath = path.resolve(
      reportDir,
      `commerce_facts_backfill_targets_${safeFilePart(manifestSummary.brand)}_${safeFilePart(manifestSummary.market)}.txt`,
    );
    fs.writeFileSync(externalIdsFilePath, `${targets.map((row) => row.external_product_id).join('\n')}\n`);

    entries.push({
      brand: manifestSummary.brand,
      market: normalizeMarket(manifestSummary.market),
      manifest_file: manifestSummary.file,
      dry_run_file: manifestSummary.dry_run_file,
      item_count: Number(manifestSummary.item_count || 0),
      gate_pass_count: Number(manifestSummary.gate_pass_count || 0),
      would_insert_unverified: Number(dryRun.would_insert_unverified || 0),
      matched_preferred_titles: Array.isArray(manifestSummary.matched_preferred_titles)
        ? manifestSummary.matched_preferred_titles
        : [],
      targets_file: externalIdsFilePath,
      targets,
      recommended_commands: buildRecommendedCommands(manifestSummary, externalIdsFilePath),
    });
  }

  return entries;
}

async function main() {
  const summaryPath = path.resolve(
    argValue('summary') ||
      '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429/k_beauty_commerce_facts_refresh_summary.json',
  );
  const summary = readJson(summaryPath, {});
  const entries = buildBacklogEntries(summary, summaryPath);
  const outPath = path.resolve(
    argValue('out') ||
      path.join(path.dirname(summaryPath), 'commerce_facts_refresh_apply_backlog_20260501.json'),
  );
  const report = {
    generated_at: new Date().toISOString(),
    summary_path: summaryPath,
    backlog_count: entries.length,
    entries,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out: outPath, backlog_count: entries.length }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error?.code || error?.name || 'commerce_facts_refresh_backlog_audit_failed',
          message: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

module.exports = {
  buildBacklogEntries,
  buildRecommendedCommands,
};
