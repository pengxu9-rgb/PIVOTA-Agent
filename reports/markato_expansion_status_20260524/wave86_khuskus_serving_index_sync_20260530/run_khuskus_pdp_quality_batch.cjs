#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(__dirname, 'live_pdp_quality_after_serving_sync');

const TARGETS = [
  ['ext_4dace0e8a2fe70b378b91c2c', 'bleu-body-serum'],
  ['ext_290f05b3b8bfbfdb4e079d09', 'd-drop-humectant-factor'],
  ['ext_f27f918bac908cf6ba236b83', 'kai-repair-balm'],
  ['ext_f86a3606bf6dc20fc810f99d', 'sans-age-face-serum'],
  ['ext_6ae70ce8a0cf2d0f8615d4dc', 'surya-body-elixir'],
];

function summarizeResult(row) {
  return {
    external_product_id: row?.external_product_id || '',
    status: row?.status || 'missing_result',
    seed_gate: row?.seed_gate?.status || null,
    extractor_gate: row?.extractor_gate?.status || null,
    identity_gate: row?.identity_gate?.status || null,
    product_intel_gate: row?.product_intel_gate?.status || null,
    live_pdp_gate: row?.live_pdp_gate?.status || null,
    similar_gate: row?.similar_gate?.status || null,
    variant_gate: row?.variant_gate?.status || null,
    image_broken: row?.live_pdp_gate?.image_health?.broken_count ?? null,
    image_scanned: row?.live_pdp_gate?.image_health?.scanned_count ?? null,
    failure_reasons: row?.failure_reasons || [],
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summaries = [];
  for (const [externalProductId, slug] of TARGETS) {
    const outFile = path.join(OUT_DIR, `${slug}_${externalProductId}.json`);
    const args = [
      'scripts/audit-external-product-pdp-quality.js',
      '--market',
      'US',
      '--external-product-id',
      externalProductId,
      '--include-attached',
      '--include-all-tools',
      '--format',
      'json',
      '--pdp-timeout-ms',
      '45000',
      '--details-pdp-timeout-ms',
      '45000',
      '--similar-timeout-ms',
      '45000',
      '--catalog-timeout-ms',
      '90000',
      '--out',
      outFile,
    ];
    const run = spawnSync(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.status !== 0) {
      summaries.push({
        external_product_id: externalProductId,
        status: 'audit_command_failed',
        exit_code: run.status,
        stderr: String(run.stderr || '').slice(0, 4000),
      });
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    summaries.push({
      output_file: path.relative(ROOT, outFile),
      ...summarizeResult(Array.isArray(parsed) ? parsed[0] : parsed),
    });
  }
  const summary = {
    generated_at: new Date().toISOString(),
    target_count: TARGETS.length,
    passed_count: summaries.filter((item) => item.status === 'passed').length,
    failed_count: summaries.filter((item) => item.status !== 'passed').length,
    broken_images: summaries.reduce((total, item) => total + Number(item.image_broken || 0), 0),
    gate_counts: summaries.reduce((acc, item) => {
      const key = item.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    rows: summaries,
  };
  const summaryFile = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
