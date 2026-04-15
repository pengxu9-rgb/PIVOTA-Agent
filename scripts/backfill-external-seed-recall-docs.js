#!/usr/bin/env node

const fs = require('node:fs');
const { query } = require('../src/db');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const {
  BROAD_RECALL_CATEGORY_KEYS,
  buildExternalSeedRecallDoc,
  readStoredRecallDoc,
} = require('../src/services/externalSeedRecall');

const CATEGORY_REPAIR_BROAD_CATEGORY_VALUES = Object.freeze(Array.from(BROAD_RECALL_CATEGORY_KEYS || []));

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeComparableString(value) {
  return normalizeNonEmptyString(value).toLowerCase();
}

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

function readSeedIdFile(filePath) {
  const normalizedPath = normalizeNonEmptyString(filePath);
  if (!normalizedPath) return [];
  const body = fs.readFileSync(normalizedPath, 'utf8');
  const ids = [];
  const seen = new Set();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    const candidates =
      parsed && typeof parsed === 'object'
        ? [parsed.seed_id, parsed.id, parsed.external_seed_id]
        : line.split(/[\s,]+/);
    for (const candidate of candidates) {
      const id = normalizeNonEmptyString(candidate);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function recallDocHasSearchSurface(recall) {
  const doc = ensureJsonObject(recall);
  return Boolean(
    normalizeNonEmptyString(doc.retrieval_title) ||
      normalizeNonEmptyString(doc.retrieval_summary) ||
      normalizeNonEmptyString(doc.retrieval_body),
  );
}

function comparableJson(value) {
  if (Array.isArray(value)) return value.map((item) => comparableJson(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = comparableJson(value[key]);
    }
    return out;
  }
  return value;
}

function buildRecallDocUpdate(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const previousRecall = readStoredRecallDoc(seedData);
  const nextRecall = buildExternalSeedRecallDoc({ row, seedData, snapshot });
  const nextSeedData = {
    ...seedData,
    derived: {
      ...ensureJsonObject(seedData.derived),
      recall: nextRecall,
    },
  };
  const previousRecallCategory = normalizeNonEmptyString(previousRecall.category);
  const nextRecallCategory = normalizeNonEmptyString(nextRecall.category);
  const changed = JSON.stringify(comparableJson(previousRecall)) !== JSON.stringify(comparableJson(nextRecall));
  return {
    changed,
    nextSeedData,
    recall: nextRecall,
    previous_recall_category: previousRecallCategory || null,
    next_recall_category: nextRecallCategory || null,
    category_changed: normalizeComparableString(previousRecallCategory) !== normalizeComparableString(nextRecallCategory),
  };
}

async function fetchRows(options = {}) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [normalizeNonEmptyString(options.market || 'US').toUpperCase()];

  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  let seedIdsBind = null;
  const seedIds = Array.isArray(options.seedIds)
    ? options.seedIds.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  if (normalizeNonEmptyString(options.seedId)) where.push(`id::text = ${addParam(options.seedId)}`);
  if (seedIds.length > 0) {
    seedIdsBind = addParam(seedIds);
    where.push(`id::text = ANY(${seedIdsBind}::text[])`);
  }
  if (normalizeNonEmptyString(options.externalProductId)) {
    where.push(`external_product_id = ${addParam(options.externalProductId)}`);
  }
  if (normalizeNonEmptyString(options.domain)) where.push(`domain = ${addParam(options.domain)}`);
  if (normalizeNonEmptyString(options.brand)) {
    where.push(
      `lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')) = lower(${addParam(options.brand)})`,
    );
  }
  if (options.categoryRepair) {
    const broadCategoryBind = addParam(CATEGORY_REPAIR_BROAD_CATEGORY_VALUES);
    where.push(`(
      length(coalesce(seed_data#>>'{derived,recall,category}', '')) = 0
      OR lower(coalesce(seed_data#>>'{derived,recall,category}', '')) = ANY(${broadCategoryBind}::text[])
      OR length(coalesce(
        seed_data->>'product_type',
        seed_data->'product'->>'product_type',
        seed_data->'snapshot'->>'product_type',
        ''
      )) > 0
      OR length(coalesce(
        seed_data->>'category',
        seed_data->'product'->>'category',
        seed_data->'snapshot'->>'category',
        ''
      )) > 0
      OR (
        length(coalesce(seed_data#>>'{derived,recall,category}', '')) > 0
        AND length(coalesce(title, seed_data->>'title', seed_data->'snapshot'->>'title', '')) > 0
      )
    )`);
  }
  if (options.onlyMissing !== false && !options.categoryRepair) {
    where.push(`NOT (
      length(coalesce(seed_data#>>'{derived,recall,retrieval_title}', '')) > 0
      OR length(coalesce(seed_data#>>'{derived,recall,retrieval_summary}', '')) > 0
      OR length(coalesce(seed_data#>>'{derived,recall,retrieval_body}', '')) > 0
    )`);
  }

  params.push(Math.max(1, Math.min(Number(options.limit || 1000), 10000)));
  const limitBind = `$${params.length}`;
  params.push(Math.max(0, Number(options.offset || 0)));
  const offsetBind = `$${params.length}`;

  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        coalesce(seed_data->>'category', seed_data->'product'->>'category', seed_data->'snapshot'->>'category') AS seed_category,
        coalesce(
          seed_data->>'product_type',
          seed_data->'product'->>'product_type',
          seed_data->'snapshot'->>'product_type'
        ) AS seed_product_type,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${
        seedIdsBind
          ? `array_position(${seedIdsBind}::text[], id::text) ASC NULLS LAST, updated_at DESC NULLS LAST, created_at DESC NULLS LAST`
          : 'id::text ASC'
      }
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function processRow(row, options = {}) {
  const update = buildRecallDocUpdate(row);
  const storedRecall = readStoredRecallDoc(ensureJsonObject(row?.seed_data));
  const hadRecall = recallDocHasSearchSurface(storedRecall);
  const categoryMetadata = {
    previous_recall_category: update.previous_recall_category,
    next_recall_category: update.next_recall_category,
    category_changed: update.category_changed,
  };
  if (!update.changed) {
    return {
      status: 'skipped',
      reason: 'unchanged',
      row,
      had_recall: hadRecall,
      recall: update.recall,
      ...categoryMetadata,
    };
  }
  if (options.dryRun) {
    return { status: 'dry_run', row, had_recall: hadRecall, recall: update.recall, ...categoryMetadata };
  }

  await query(
    options.touchUpdatedAt
      ? `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb, updated_at = now()
      WHERE id = $1
    `
      : `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb
      WHERE id = $1
    `,
    [row.id, JSON.stringify(update.nextSeedData)],
  );
  return { status: 'updated', row, had_recall: hadRecall, recall: update.recall, ...categoryMetadata };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Number(concurrency) || 1) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeResults(results) {
  const byDomain = {};
  for (const result of Array.isArray(results) ? results : []) {
    const domain = normalizeNonEmptyString(result?.row?.domain) || 'unknown';
    byDomain[domain] = byDomain[domain] || { scanned: 0, updated: 0, dry_run: 0, skipped: 0 };
    byDomain[domain].scanned += 1;
    if (result?.status === 'updated') byDomain[domain].updated += 1;
    if (result?.status === 'dry_run') byDomain[domain].dry_run += 1;
    if (result?.status === 'skipped') byDomain[domain].skipped += 1;
  }
  return {
    scanned: results.length,
    updated: results.filter((result) => result.status === 'updated').length,
    dry_run: results.filter((result) => result.status === 'dry_run').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    had_recall: results.filter((result) => result.had_recall).length,
    category_changed: results.filter((result) => result.category_changed).length,
    by_domain: byDomain,
  };
}

async function main() {
  const seedIds = readSeedIdFile(argValue('seed-id-file') || argValue('seedIdFile'));
  const categoryRepair =
    hasFlag('category-repair') || hasFlag('categoryRepair') || hasFlag('only-category-repair');
  const options = {
    seedId: argValue('seed-id') || argValue('seedId') || null,
    seedIds,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    limit: Math.max(1, Math.min(Number(argValue('limit') || 1000), 10000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    concurrency: Math.max(1, Math.min(Number(argValue('concurrency') || 5), 20)),
    categoryRepair,
    onlyMissing: categoryRepair ? false : !(hasFlag('include-existing') || hasFlag('includeExisting') || hasFlag('all')),
    dryRun: hasFlag('dry-run') || hasFlag('dryRun'),
    touchUpdatedAt: hasFlag('touch-updated-at') || hasFlag('touchUpdatedAt'),
  };

  const rows = await fetchRows(options);
  const results = await mapWithConcurrency(rows, options.concurrency, (row) => processRow(row, options));
  console.log(
    JSON.stringify(
      {
        options,
        summary: summarizeResults(results),
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  readSeedIdFile,
  recallDocHasSearchSurface,
  buildRecallDocUpdate,
  fetchRows,
  processRow,
  summarizeResults,
};
