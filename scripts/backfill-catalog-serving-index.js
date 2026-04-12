#!/usr/bin/env node

const {
  backfillCatalogServingIndex,
  getCatalogServingIndexConfig,
} = require('../src/services/catalogServingIndex');

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
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || 500) || 500));
  const brand = asString(argValue('brand')) || null;
  const market = asString(argValue('market') || process.env.DEFAULT_DISCOVERY_EXTERNAL_SEED_MARKET || 'US') || 'US';
  const dryRun = hasFlag('dry-run');
  const refresh = hasFlag('refresh');
  const includeNonPublic = !hasFlag('public-only');
  const result = await backfillCatalogServingIndex({
    limit,
    brand,
    market,
    dryRun,
    refresh,
    includeNonPublic,
  });
  const config = getCatalogServingIndexConfig(process.env);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        requested: {
          limit,
          brand,
          market,
          dry_run: dryRun,
          refresh,
          include_non_public: includeNonPublic,
        },
        index: {
          enabled: config.enabled,
          base_url: config.base_url || null,
          index_name: config.index_name || null,
          shadow_read_enabled: config.shadow_read_enabled === true,
        },
        result,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: 'CATALOG_SERVING_BACKFILL_FAILED',
        message: err?.message || String(err),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
