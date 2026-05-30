#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(__dirname, 'live_pdp_quality_after_serving_sync');

const TARGETS = [
  ['ext_0d844fc65fd3348e35a09c80', 'abu-dhabi'],
  ['ext_151aebc5b6246b8d2d9a877b', 'agra'],
  ['ext_152e5d39e5ef4ee3a67894b7', 'guanajuato'],
  ['ext_22c3e831a335c12bc33fca2f', 'java'],
  ['ext_2c4793f5f96ec2d4680fd55b', 'zhangye'],
  ['ext_2d506dd9dc7428de2d3d0cc8', 'seville'],
  ['ext_36b452da1e0dde5c19bd2ed0', 'casablanca'],
  ['ext_45293e532ad5a5f33438d38f', 'nizwa'],
  ['ext_5f55c01bae5cd6b5f0a0e78e', 'dakar'],
  ['ext_799b3d12caaa6ad1842840dd', 'sakura'],
  ['ext_9a469b8f450d59f67ae21f6d', 'paris'],
  ['ext_a36359795b89961a7c052b21', 'karachi'],
  ['ext_ab5107f3a835da10508757c6', 'havana'],
  ['ext_abd25039dea2189dfcca8079', 'patagonia'],
  ['ext_afb163014d0bffd3a6493c05', 'marrakesh'],
  ['ext_c6d113bff874c00abfb4ba33', 'tallinn'],
  ['ext_efe7512de8c6df9f75ca19e0', 'dubrovnik'],
  ['ext_faf89834933316df0d8da973', 'azores'],
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
