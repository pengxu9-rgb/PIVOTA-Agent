#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../../src/db');
const { ensureJsonObject } = require('../../../src/services/externalSeedProducts');
const {
  buildExternalSeedRecallDoc,
  readStoredRecallDoc,
} = require('../../../src/services/externalSeedRecall');

const TARGETS = Object.freeze([
  {
    seed_id: 'eps_d7bbe1c523ff1a28e9fc0feb',
    external_product_id: 'ext_1e27467ab07ddb83ad74c213',
    title: 'PROPOWAX Antioxidant Shampoo 300ml',
    recall_category: 'Shampoo',
    recall_vertical: 'haircare',
  },
  {
    seed_id: 'eps_392eec0063f18198755a2dc6',
    external_product_id: 'ext_4e95b920b4c6a5295d55aa46',
    title: 'PROPOWAX Antioxidant Conditioner 300ml',
    recall_category: 'Conditioner',
    recall_vertical: 'haircare',
  },
  {
    seed_id: 'eps_233fb6937fe8094b020b5a16',
    external_product_id: 'ext_d17dfc05f98d0400d5129f1c',
    title: 'PROPOWAX Antioxidant Shower Gel 300ml',
    recall_category: 'Body Wash',
    recall_vertical: 'bodycare',
  },
  {
    seed_id: 'eps_a1dfe4e0954933aef1121656',
    external_product_id: 'ext_c0e5209513c083e2c649c1a1',
    title: 'PROPOWAX Antioxidant Body Lotion 300ml',
    recall_category: 'Body Lotion',
    recall_vertical: 'bodycare',
  },
  {
    seed_id: 'eps_8b28f12a815d856a4c1c81e7',
    external_product_id: 'ext_d3d708f481903ba2a6f9b732',
    title: 'PROPOWAX Antioxidant Dry Oil 100ml',
    recall_category: 'Body Oil',
    recall_vertical: 'bodycare',
  },
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const target = normalizeNonEmptyString(filePath);
  if (!target) {
    process.stdout.write(body);
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, body, 'utf8');
  process.stdout.write(body);
}

function comparableJson(value) {
  if (Array.isArray(value)) return value.map((item) => comparableJson(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = comparableJson(value[key]);
    return out;
  }
  return value;
}

function recallHasSearchSurface(recall) {
  const doc = ensureJsonObject(recall);
  return Boolean(
    normalizeNonEmptyString(doc.retrieval_title) ||
      normalizeNonEmptyString(doc.retrieval_summary) ||
      normalizeNonEmptyString(doc.retrieval_body),
  );
}

function summarizeRecall(recall) {
  const doc = ensureJsonObject(recall);
  return {
    category: normalizeNonEmptyString(doc.category) || null,
    vertical: normalizeNonEmptyString(doc.vertical) || null,
    retrieval_title: normalizeNonEmptyString(doc.retrieval_title) || null,
    retrieval_summary_length: normalizeNonEmptyString(doc.retrieval_summary).length,
    retrieval_body_length: normalizeNonEmptyString(doc.retrieval_body).length,
    alias_token_count: Array.isArray(doc.alias_tokens) ? doc.alias_tokens.length : 0,
    exclusion_flags: ensureJsonObject(doc.exclusion_flags),
  };
}

async function fetchRows() {
  const seedIds = TARGETS.map((target) => target.seed_id);
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
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE id::text = ANY($1::text[])
      ORDER BY array_position($1::text[], id::text)
    `,
    [seedIds],
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

function applyReviewedRecallOverride(recall, target) {
  const category = normalizeNonEmptyString(target.recall_category);
  const vertical = normalizeNonEmptyString(target.recall_vertical);
  if (!category && !vertical) return recall;
  return {
    ...ensureJsonObject(recall),
    ...(category ? { category } : {}),
    ...(vertical ? { vertical } : {}),
    reviewed_override: {
      source: 'wave12_apiceuticals_official_pdp_review',
      reason: 'exact_target_product_kind_review',
    },
  };
}

function buildUpdate(row, target) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const previousRecall = readStoredRecallDoc(seedData);
  const nextRecall = applyReviewedRecallOverride(
    buildExternalSeedRecallDoc({ row, seedData, snapshot }),
    target,
  );
  const nextSeedData = {
    ...seedData,
    derived: {
      ...ensureJsonObject(seedData.derived),
      recall: nextRecall,
    },
  };
  const changed = JSON.stringify(comparableJson(previousRecall)) !== JSON.stringify(comparableJson(nextRecall));
  return {
    changed,
    previousRecall,
    nextRecall,
    nextSeedData,
  };
}

async function main() {
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const rows = await fetchRows();
  const rowById = new Map(rows.map((row) => [normalizeNonEmptyString(row.id), row]));
  const results = [];

  if (!dryRun) await query('BEGIN');
  try {
    for (const target of TARGETS) {
      const row = rowById.get(target.seed_id);
      if (!row) {
        results.push({
          ...target,
          status: 'missing',
          reason: 'seed_row_not_found',
        });
        continue;
      }
      if (row.external_product_id !== target.external_product_id) {
        results.push({
          ...target,
          status: 'blocked',
          reason: 'external_product_id_mismatch',
          observed_external_product_id: row.external_product_id,
        });
        continue;
      }
      if (row.status !== 'active') {
        results.push({
          ...target,
          status: 'blocked',
          reason: 'seed_not_active',
          observed_status: row.status,
        });
        continue;
      }
      const update = buildUpdate(row, target);
      const result = {
        ...target,
        status: update.changed ? (dryRun ? 'would_update' : 'updated') : 'unchanged',
        attached_product_key: row.attached_product_key || null,
        had_recall_surface: recallHasSearchSurface(update.previousRecall),
        next_has_recall_surface: recallHasSearchSurface(update.nextRecall),
        previous_recall: summarizeRecall(update.previousRecall),
        next_recall: summarizeRecall(update.nextRecall),
      };
      results.push(result);
      if (!dryRun && update.changed) {
        await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb
            WHERE id = $1
          `,
          [row.id, JSON.stringify(update.nextSeedData)],
        );
      }
    }
    if (!dryRun) await query('COMMIT');
  } catch (error) {
    if (!dryRun) await query('ROLLBACK').catch(() => {});
    throw error;
  }

  const blocked = results.filter((result) => ['missing', 'blocked'].includes(result.status));
  const output = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    target_count: TARGETS.length,
    scanned_rows: rows.length,
    blocked_count: blocked.length,
    would_update_count: results.filter((result) => result.status === 'would_update').length,
    updated_count: results.filter((result) => result.status === 'updated').length,
    unchanged_count: results.filter((result) => result.status === 'unchanged').length,
    all_next_have_recall_surface: results.every((result) => result.next_has_recall_surface === true),
    results,
  };
  writeJson(argValue('out'), output);
  if (blocked.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
