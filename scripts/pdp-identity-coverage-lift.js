#!/usr/bin/env node

const {
  runPdpIdentityCoverageLift,
} = require('../src/services/pdpIdentityGraph');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

async function main() {
  const brand = asString(argValue('brand')) || null;
  const topBrands = Math.max(1, Math.min(50, Number(argValue('top-brands') || 5) || 5));
  const sourceLimitPerBrand = Math.max(
    1,
    Math.min(5000, Number(argValue('source-limit-per-brand') || 100) || 100),
  );
  const minSourceRows = Math.max(0, Math.min(500000, Number(argValue('min-source-rows') || 10) || 0));
  const maxReviewRatio = Math.max(0, Math.min(1, Number(argValue('max-review-ratio') || 0.65) || 0));
  const dryRun = !hasFlag('write');
  const promoteLiveRead = !hasFlag('no-promote');
  const requireBrandSource = !hasFlag('allow-merchant-only-groups');
  const beautyOnly = !hasFlag('include-non-beauty');
  const createdBy = asString(argValue('created-by') || 'cli');

  const result = await runPdpIdentityCoverageLift({
    brand,
    topBrands,
    sourceLimitPerBrand,
    minSourceRows,
    maxReviewRatio,
    dryRun,
    promoteLiveRead,
    requireBrandSource,
    beautyOnly,
    createdBy,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: 'PDP_IDENTITY_COVERAGE_LIFT_FAILED',
        message: err?.message || String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
