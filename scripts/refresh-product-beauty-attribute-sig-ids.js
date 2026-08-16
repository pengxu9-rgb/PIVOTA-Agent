#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool } = require('../src/db');
const { refreshBeautyAttributeSigIds } = require('../src/auroraBff/productBeautyAttributes');

const CONFIRM_TOKEN = 'REFRESH_PBA_SIG_IDS';

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = normalizeString(filePath, 2000);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function parseDelimited(value) {
  return Array.from(
    new Set(
      String(value == null ? '' : value)
        .split(/[\s,;\t]+/g)
        .map((item) => normalizeString(item, 512))
        .filter(Boolean),
    ),
  );
}

function readIdsFile(filePath) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return [];
  return parseDelimited(fs.readFileSync(resolved, 'utf8'));
}

function readAffectedManifest(filePath) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return { externalProductIds: [], sigIds: [] };
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.affected_products)
      ? parsed.affected_products
      : Array.isArray(parsed)
        ? parsed
        : [];
  return {
    externalProductIds: [
      ...parseDelimited(parsed?.external_product_ids),
      ...parseDelimited(parsed?.externalProductIds),
      ...rows.map((row) => row && (row.external_product_id || row.externalProductId || row.source_product_id || row.sourceProductId)),
    ].filter(Boolean),
    sigIds: [
      ...parseDelimited(parsed?.sig_ids),
      ...parseDelimited(parsed?.sigIds),
      ...rows.map((row) => row && (row.pivota_signature_id || row.pivotaSignatureId || row.sig_id || row.sigId)),
    ].filter(Boolean),
  };
}

function writeJsonFile(filePath, payload) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/refresh-product-beauty-attribute-sig-ids.js [--affected-products-file path] [--external-product-ids a,b] [--sig-ids a,b] [--allow-empty-filter] [--out path] [--apply --confirm REFRESH_PBA_SIG_IDS]',
    '',
    'Dry-run by default. Updates product_beauty_attributes.sig_id from catalog_products only in apply mode.',
    'Refuses to run without at least one id filter (a filterless refresh would be catalog-wide).',
    '--allow-empty-filter turns an empty filter set into a recorded no-op instead: the scheduled',
    'routine passes it, because a quiet day legitimately selects zero affected products.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const manifest = readAffectedManifest(argValue(argv, 'affected-products-file') || argValue(argv, 'affectedProductsFile'));
  const externalProductIds = [
    ...manifest.externalProductIds,
    ...parseDelimited(argValue(argv, 'external-product-ids') || argValue(argv, 'externalProductIds')),
    ...readIdsFile(argValue(argv, 'external-product-ids-file') || argValue(argv, 'externalProductIdsFile')),
  ];
  const sigIds = [
    ...manifest.sigIds,
    ...parseDelimited(argValue(argv, 'sig-ids') || argValue(argv, 'sigIds')),
    ...readIdsFile(argValue(argv, 'sig-ids-file') || argValue(argv, 'sigIdsFile')),
  ];
  const apply = hasFlag(argv, 'apply');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if (apply && confirm !== CONFIRM_TOKEN) {
    throw new Error(`Refusing PBA sig refresh write without --confirm ${CONFIRM_TOKEN}`);
  }
  return {
    apply,
    externalProductIds,
    sigIds,
    allowEmptyFilter: hasFlag(argv, 'allow-empty-filter'),
    out: normalizeString(argValue(argv, 'out'), 2000),
  };
}

// The refresh helper throws missing_pba_sig_refresh_filter on an empty filter
// set, and rightly so for ad-hoc use — without a filter the UPDATE would be
// catalog-wide. On the scheduled routine an empty filter is not a mistake: the
// affected-products selector honestly returns zero rows on a day nothing was
// updated (the 2026-08-16T10:37Z production tick), and the build step already
// tolerates that via --allow-empty-build. So a no-op is the correct outcome
// there, recorded in the same report shape the query path produces. The helper
// stays the single judge of "empty" (it also discards mis-prefixed ids), so
// this catches its error code rather than re-deriving the rule.
async function refreshOrSkipEmpty(options, queryFn) {
  try {
    return await refreshBeautyAttributeSigIds({
      externalProductIds: options.externalProductIds,
      sigIds: options.sigIds,
      apply: options.apply,
      ...(queryFn ? { queryFn } : {}),
    });
  } catch (err) {
    if (options.allowEmptyFilter && err && err.code === 'MISSING_PBA_SIG_REFRESH_FILTER') {
      return {
        dry_run: !options.apply,
        skipped: true,
        skip_reason: 'empty_filter',
        matched_count: 0,
        updated_count: 0,
        rows: [],
      };
    }
    throw err;
  }
}

async function run(argv = process.argv.slice(2), { queryFn } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const result = await refreshOrSkipEmpty(options, queryFn);
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: !options.apply,
    external_product_id_filter_count: Array.from(new Set(options.externalProductIds)).length,
    sig_id_filter_count: Array.from(new Set(options.sigIds)).length,
    ...result,
  };
  if (options.out) writeJsonFile(options.out, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      closePool().catch(() => {});
    });
}

module.exports = {
  CONFIRM_TOKEN,
  parseArgs,
  readAffectedManifest,
  run,
};
