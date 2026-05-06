#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { query, closePool } = require('../src/db');

function argValue(name, argv = process.argv) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

function normalizeString(value) {
  return String(value || '').trim();
}

function parsePositiveInteger(value, fallback, { min = 1, max = 500 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseArgs(argv = process.argv) {
  const fetchMode = normalizeString(argValue('fetch-mode', argv) || 'auto').toLowerCase();
  if (!['auto', 'direct', 'browser'].includes(fetchMode)) {
    throw new Error('--fetch-mode must be auto, direct, or browser');
  }
  const productId = normalizeString(argValue('product-id', argv));
  return {
    productId,
    brand: normalizeString(argValue('brand', argv)),
    host: normalizeString(argValue('host', argv)).toLowerCase(),
    market: normalizeString(argValue('market', argv) || 'US').toUpperCase(),
    limit: parsePositiveInteger(argValue('limit', argv), productId ? 1 : 25, { min: 1, max: 500 }),
    offset: parsePositiveInteger(argValue('offset', argv), 0, { min: 0, max: 100000 }),
    fetchMode,
    forceCache: hasFlag('force-cache', argv) || normalizeString(argValue('force-cache', argv)).toLowerCase() === 'true',
    requestedBy: normalizeString(argValue('requested-by', argv) || process.env.GITHUB_RUN_ID || 'manual'),
    out: normalizeString(argValue('out', argv)),
  };
}

function writeJsonFile(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function enqueueImageCacheJob(args = parseArgs()) {
  if (!args.productId && !args.brand && !args.host) {
    throw new Error('At least one of --product-id, --brand, or --host is required');
  }
  const filters = {
    ...(args.productId ? { product_id: args.productId } : {}),
    ...(args.brand ? { brand: args.brand } : {}),
    ...(args.host ? { host: args.host } : {}),
    market: args.market || 'US',
    limit: args.limit,
    offset: args.offset,
    fetch_mode: args.fetchMode,
    force_cache: args.forceCache,
  };
  const res = await query(
    `
      INSERT INTO external_seed_image_cache_jobs (status, mode, filters, requested_by, updated_at)
      VALUES ('queued', 'apply', $1::jsonb, $2, now())
      RETURNING id, status, mode, filters, requested_by, created_at
    `,
    [JSON.stringify(filters), args.requestedBy || null],
  );
  const job = res.rows[0];
  const report = {
    mode: 'enqueue',
    generated_at: new Date().toISOString(),
    job,
  };
  writeJsonFile(args.out, report);
  return report;
}

if (require.main === module) {
  enqueueImageCacheJob()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => null));
}

module.exports = {
  _internals: {
    enqueueImageCacheJob,
    parseArgs,
  },
};
