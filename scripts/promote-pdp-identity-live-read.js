#!/usr/bin/env node

const { promotePdpIdentityLiveRead } = require('../src/services/pdpIdentityGraph');

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
  const refs = asString(argValue('source-listing-refs'))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || 500) || 500));
  const dryRun = !hasFlag('write');
  const requireBrandSource = !hasFlag('allow-merchant-only-groups');
  const createdBy = asString(argValue('created-by') || 'cli');

  const result = await promotePdpIdentityLiveRead({
    brand,
    sourceListingRefs: refs,
    limit,
    dryRun,
    requireBrandSource,
    createdBy,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: 'PDP_IDENTITY_PROMOTE_LIVE_READ_FAILED',
        message: err?.message || String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
