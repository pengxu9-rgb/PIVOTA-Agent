#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cell(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function table(headers, rows) {
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function main() {
  const snapshotDir = process.argv[2] || path.join(__dirname, 'markato_project_cohort_snapshot_20260526');
  const outFile = process.argv[3] || path.join(snapshotDir, 'markato_project_cohort_report_20260526.md');
  const summary = readJson(path.join(snapshotDir, 'summary.json'));
  const brands = readJson(path.join(snapshotDir, 'brand_coverage.json'));

  const lines = [];
  lines.push('# Markato Project Cohort PDP Coverage Snapshot');
  lines.push('');
  lines.push(`Generated: ${summary.generated_at}`);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push('- Source: production DB current state.');
  lines.push('- Cohort: Wave5 Markato brand domains plus wave6-wave22 targeted `ext_*` SKUs found in local Markato apply/catalog/product-intel artifacts.');
  lines.push('- This excludes the broader Pivota external-seed pool used in the previous snapshot.');
  lines.push('- Catalog PDP coverage means a production `catalog_products` external-seed mirror exists.');
  lines.push('- DB serving-ready means `index_pipeline_state.serving_eligible = true` at snapshot time.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(table(
    ['Metric', 'Value'],
    [
      ['Markato project brands', summary.brands],
      ['Markato target products', summary.production_target_products],
      ['Products in catalog PDP', summary.catalog_pdp_products],
      ['Catalog PDP coverage', pct(summary.catalog_pdp_coverage_pct)],
      ['DB serving-ready products', summary.db_serving_ready_products],
      ['DB serving-ready coverage', pct(summary.db_serving_ready_coverage_pct)],
      ['Identity-ready products', summary.identity_ready_products],
      ['Reviewed product-intel products', summary.reviewed_product_intel_products],
      ['High-quality product-intel products', summary.high_quality_product_intel_products],
      ['High-quality intel coverage', pct(summary.high_quality_intel_coverage_pct)],
      ['Brands with 100% catalog coverage', summary.brands_100pct_catalog],
      ['Brands with 100% DB serving-ready', summary.brands_100pct_serving_ready],
      ['Brands with 0 DB serving-ready', summary.brands_0pct_serving_ready],
    ],
  ));
  lines.push('');
  lines.push('## Blockers');
  lines.push('');
  lines.push(table(
    ['Blocker', 'Products'],
    summary.blocker_summary.map((row) => [row.blocker_code, row.product_count]),
  ));
  lines.push('');
  lines.push('## Per-Brand Coverage');
  lines.push('');
  lines.push(table(
    ['Domain', 'Brand', 'Target SKUs', 'Catalog PDP', 'Catalog %', 'DB Ready', 'Ready %', 'Identity Ready', 'HQ Intel', 'HQ Intel %', 'Blockers'],
    brands.map((row) => [
      row.domain,
      row.brand,
      row.target_products,
      row.catalog_pdp_products,
      pct(row.catalog_pdp_coverage_pct),
      row.db_serving_ready_products,
      pct(row.db_serving_ready_coverage_pct),
      row.identity_ready_products,
      row.high_quality_product_intel_products,
      pct(row.high_quality_intel_coverage_pct),
      row.blocker_summary,
    ]),
  ));
  lines.push('');
  lines.push('## Read');
  lines.push('');
  lines.push('Catalog inclusion is complete for this Markato project cohort, and the content/identity side is almost complete. The current production serving-index state does not match the stronger wave closeout readiness claims for many SKUs; this should be treated as the next operational gap before more expansion.');
  lines.push('');

  fs.writeFileSync(outFile, `${lines.join('\n')}\n`);
  process.stdout.write(`${outFile}\n`);
}

main();
