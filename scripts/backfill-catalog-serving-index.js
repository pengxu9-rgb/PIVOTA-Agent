#!/usr/bin/env node

const {
  backfillCatalogServingIndex,
  getCatalogServingIndexConfig,
} = require('../src/services/catalogServingIndex');
const { query, closePool } = require('../src/db');

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

async function seedDocumentMemberships(memberships = [], { queryFn = query } = {}) {
  const sourceRefs = [];
  const documentIds = [];
  const seen = new Set();
  for (const membership of memberships) {
    const documentId = asString(membership?.doc_id);
    if (!documentId) continue;
    for (const sourceRef of membership?.source_refs || []) {
      const normalizedSourceRef = asString(sourceRef);
      if (!normalizedSourceRef) continue;
      const key = `${normalizedSourceRef}\u0000${documentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceRefs.push(normalizedSourceRef);
      documentIds.push(documentId);
    }
  }
  if (!sourceRefs.length) return 0;
  const result = await queryFn(
    `INSERT INTO commerce_index_search_memberships (source_ref, document_id, updated_at)
     SELECT source_ref, document_id, NOW()
       FROM UNNEST($1::text[], $2::text[]) AS t(source_ref, document_id)
     ON CONFLICT (source_ref) DO UPDATE
       SET document_id = EXCLUDED.document_id, updated_at = EXCLUDED.updated_at`,
    [sourceRefs, documentIds],
  );
  return Number(result?.rowCount || sourceRefs.length);
}

async function main() {
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || 500) || 500));
  const brand = asString(argValue('brand')) || null;
  const market = asString(argValue('market') || process.env.DEFAULT_DISCOVERY_EXTERNAL_SEED_MARKET || 'US') || 'US';
  const dryRun = hasFlag('dry-run');
  const refresh = hasFlag('refresh');
  const seedMemberships = hasFlag('seed-memberships');
  const includeNonPublic = !hasFlag('public-only');
  const result = await backfillCatalogServingIndex({
    limit,
    brand,
    market,
    dryRun,
    refresh,
    includeNonPublic,
  });
  let membershipsSeeded = 0;
  if (seedMemberships) {
    if (dryRun) {
      throw new Error('--seed-memberships cannot be combined with --dry-run');
    }
    if (result.source !== 'opensearch_compatible') {
      throw new Error(`membership seeding requires an OpenSearch backfill: source=${result.source}`);
    }
    membershipsSeeded = await seedDocumentMemberships(result.document_memberships || []);
  }
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
          seed_memberships: seedMemberships,
          include_non_public: includeNonPublic,
        },
        index: {
          enabled: config.enabled,
          base_url: config.base_url || null,
          index_name: config.index_name || null,
          shadow_read_enabled: config.shadow_read_enabled === true,
        },
        result: { ...result, memberships_seeded: membershipsSeeded },
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
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
  }).finally(() => closePool().catch(() => {}));
}

module.exports = {
  main,
  seedDocumentMemberships,
};
