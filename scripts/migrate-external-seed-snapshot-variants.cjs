#!/usr/bin/env node

const { withClient } = require('../src/db');
const {
  ensureJsonObject,
  canonicalizeExternalSeedSnapshot,
} = require('../src/services/externalSeedProducts');

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function stableJson(value) {
  return JSON.stringify(value || {});
}

function hasLegacyVariantContainers(seedData) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const checks = [
    Array.isArray(seedData?.variants) && seedData.variants.length > 0,
    Array.isArray(seedData?.skus) && seedData.skus.length > 0,
    Array.isArray(seedData?.product?.variants) && seedData.product.variants.length > 0,
    Array.isArray(seedData?.product?.skus) && seedData.product.skus.length > 0,
    Array.isArray(snapshot?.product?.variants) && snapshot.product.variants.length > 0,
    Array.isArray(snapshot?.product?.skus) && snapshot.product.skus.length > 0,
    Array.isArray(snapshot?.skus) && snapshot.skus.length > 0,
  ];
  return checks.some(Boolean);
}

async function fetchRows(client, options) {
  const params = [];
  const where = [`seed_data IS NOT NULL`];

  if (options.seedId) {
    params.push(options.seedId);
    where.push(`id::text = $${params.length}`);
  }

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
    SELECT
      id,
      external_product_id,
      canonical_url,
      destination_url,
      title,
      seed_data,
      updated_at
    FROM external_product_seeds
    WHERE ${where.join('\n      AND ')}
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  const res = await client.query(sql, params);
  return res.rows || [];
}

async function main() {
  const options = {
    seedId: argValue('seed-id') || '',
    limit: Math.max(1, Math.min(Number(argValue('limit') || 500), 5000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    dryRun: hasFlag('dry-run'),
    stripLegacy: hasFlag('strip-legacy'),
  };

  const summary = {
    scanned: 0,
    candidates: 0,
    changed: 0,
    updated: 0,
    unchanged: 0,
    skipped_no_legacy: 0,
    strip_legacy: options.stripLegacy,
    dry_run: options.dryRun,
    sample: [],
  };

  await withClient(async (client) => {
    const rows = await fetchRows(client, options);
    summary.scanned = rows.length;

    for (const row of rows) {
      const currentSeedData = ensureJsonObject(row.seed_data);
      const snapshot = ensureJsonObject(currentSeedData.snapshot);
      const snapshotVariants = Array.isArray(snapshot.variants) ? snapshot.variants : [];
      const legacyPresent = hasLegacyVariantContainers(currentSeedData);
      const needsCanonicalSnapshot = snapshotVariants.length === 0 || legacyPresent;

      if (!needsCanonicalSnapshot) {
        summary.skipped_no_legacy += 1;
        continue;
      }

      summary.candidates += 1;
      const nextSeedData = canonicalizeExternalSeedSnapshot(currentSeedData, row, {
        stripLegacy: options.stripLegacy,
      });
      const changed = stableJson(nextSeedData) !== stableJson(currentSeedData);

      if (!changed) {
        summary.unchanged += 1;
        continue;
      }

      summary.changed += 1;
      if (summary.sample.length < 20) {
        summary.sample.push({
          id: row.id,
          title: row.title,
          snapshot_variant_count_before: snapshotVariants.length,
          snapshot_variant_count_after: Array.isArray(nextSeedData.snapshot?.variants)
            ? nextSeedData.snapshot.variants.length
            : 0,
          legacy_present_before: legacyPresent,
        });
      }

      if (options.dryRun) continue;

      await client.query(
        `
          UPDATE external_product_seeds
          SET seed_data = $2::jsonb, updated_at = now()
          WHERE id = $1
        `,
        [row.id, JSON.stringify(nextSeedData)],
      );
      summary.updated += 1;
    }
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error?.message || String(error),
        stack: error?.stack || null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
