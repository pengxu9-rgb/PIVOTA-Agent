#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { kbQuery } = require('../src/services/pciKbClient');
const {
  buildExternalSeedHarvesterCandidates,
  classifyIngredientScope,
} = require('../src/services/externalSeedHarvesterBridge');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function extractSeedIdFromSkuKey(skuKey) {
  const normalized = normalizeNonEmptyString(skuKey);
  return normalized.match(/^extseed:([^:]+):/)?.[1] || '';
}

function toCsv(rows) {
  const headers = [
    'sku_key',
    'external_seed_id',
    'brand',
    'product_name',
    'scope_decision',
    'scope_reason',
    'candidate_found',
    'source_ref',
    'canonical_url',
    'market',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function classifyKbRows(kbRows, seedRows) {
  const seedMap = new Map((seedRows || []).map((row) => [normalizeNonEmptyString(row.id), row]));
  const scopedRows = [];
  const counts = { allow: 0, review: 0, block: 0, missing_seed: 0 };

  for (const kbRow of kbRows || []) {
    const skuKey = normalizeNonEmptyString(kbRow.sku_key);
    const seedId = extractSeedIdFromSkuKey(skuKey);
    const seedRow = seedMap.get(seedId);
    if (!seedRow) {
      counts.missing_seed += 1;
      scopedRows.push({
        sku_key: skuKey,
        external_seed_id: seedId,
        brand: normalizeNonEmptyString(kbRow.brand),
        product_name: normalizeNonEmptyString(kbRow.product_name),
        scope_decision: 'missing_seed',
        scope_reason: 'missing_seed',
        candidate_found: false,
        source_ref: normalizeNonEmptyString(kbRow.source_ref),
        canonical_url: '',
        market: '',
      });
      continue;
    }

    const candidates = buildExternalSeedHarvesterCandidates(seedRow);
    const candidate =
      candidates.find((item) => normalizeNonEmptyString(item.candidate_id) === skuKey) ||
      candidates.find((item) => normalizeNonEmptyString(item.product_name) === normalizeNonEmptyString(kbRow.product_name)) ||
      null;

    if (!candidate) {
      counts.review += 1;
      scopedRows.push({
        sku_key: skuKey,
        external_seed_id: seedId,
        brand: normalizeNonEmptyString(kbRow.brand || seedRow.seed_data?.brand || seedRow.domain),
        product_name: normalizeNonEmptyString(kbRow.product_name),
        scope_decision: 'review',
        scope_reason: 'candidate_not_rebuilt',
        candidate_found: false,
        source_ref: normalizeNonEmptyString(kbRow.source_ref),
        canonical_url: normalizeNonEmptyString(seedRow.canonical_url),
        market: normalizeNonEmptyString(seedRow.market),
      });
      continue;
    }

    const scope = classifyIngredientScope(seedRow, candidate);
    counts[scope.decision] += 1;
    scopedRows.push({
      sku_key: skuKey,
      external_seed_id: seedId,
      brand: normalizeNonEmptyString(kbRow.brand || candidate.brand),
      product_name: normalizeNonEmptyString(candidate.product_name || kbRow.product_name),
      scope_decision: scope.decision,
      scope_reason: scope.reason,
      candidate_found: true,
      source_ref: normalizeNonEmptyString(candidate.source_ref || kbRow.source_ref),
      canonical_url: normalizeNonEmptyString(seedRow.canonical_url),
      market: normalizeNonEmptyString(seedRow.market),
    });
  }

  return {
    counts,
    scopedRows,
  };
}

async function fetchKbRows() {
  const tableCheck = await kbQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
  if (!tableCheck.rows?.[0]?.table_name) {
    throw new Error('pci_kb.sku_ingredients table is not available');
  }
  const res = await kbQuery(`
    SELECT sku_key, brand, product_name, source_ref, created_at
    FROM pci_kb.sku_ingredients
    ORDER BY created_at ASC NULLS LAST, sku_key ASC
  `);
  return res.rows || [];
}

async function fetchSeedRows(seedIds) {
  if (!seedIds.length) return [];
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
      WHERE id = ANY($1::text[])
    `,
    [seedIds],
  );
  return res.rows || [];
}

async function deleteBlockRows(rows) {
  const blockKeys = rows
    .filter((row) => row.scope_decision === 'block')
    .map((row) => normalizeNonEmptyString(row.sku_key))
    .filter(Boolean);

  if (!blockKeys.length) {
    return { deleted_count: 0, deleted_keys: [] };
  }

  const res = await kbQuery(
    `
      DELETE FROM pci_kb.sku_ingredients
      WHERE sku_key = ANY($1::text[])
      RETURNING sku_key
    `,
    [blockKeys],
  );

  return {
    deleted_count: (res.rows || []).length,
    deleted_keys: (res.rows || []).map((row) => normalizeNonEmptyString(row.sku_key)).filter(Boolean),
  };
}

async function main() {
  const outDir = argValue('out-dir') || path.join(process.cwd(), 'artifacts');
  const deleteBlock = hasFlag('delete-block');

  const kbRows = await fetchKbRows();
  const seedIds = [...new Set(kbRows.map((row) => extractSeedIdFromSkuKey(row.sku_key)).filter(Boolean))];
  const seedRows = await fetchSeedRows(seedIds);
  const audit = classifyKbRows(kbRows, seedRows);

  const allJsonPath = path.join(outDir, 'pci_kb_scope_audit.json');
  const reviewCsvPath = path.join(outDir, 'pci_kb_scope_review.csv');
  const blockCsvPath = path.join(outDir, 'pci_kb_scope_block.csv');

  ensureParentDir(allJsonPath);
  fs.writeFileSync(
    allJsonPath,
    JSON.stringify(
      {
        total_kb_rows: kbRows.length,
        counts: audit.counts,
        rows: audit.scopedRows,
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    reviewCsvPath,
    toCsv(audit.scopedRows.filter((row) => row.scope_decision === 'review')),
    'utf8',
  );
  fs.writeFileSync(
    blockCsvPath,
    toCsv(audit.scopedRows.filter((row) => row.scope_decision === 'block')),
    'utf8',
  );

  const deletion = deleteBlock ? await deleteBlockRows(audit.scopedRows) : { deleted_count: 0, deleted_keys: [] };

  process.stdout.write(
    `${JSON.stringify(
      {
        total_kb_rows: kbRows.length,
        counts: audit.counts,
        deleted_block_rows: deletion.deleted_count,
        outputs: {
          audit_json: allJsonPath,
          review_csv: reviewCsvPath,
          block_csv: blockCsvPath,
        },
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  classifyKbRows,
  extractSeedIdFromSkuKey,
  toCsv,
};
