#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { kbQuery } = require('../src/services/pciKbClient');
const { buildExternalSeedHarvesterCandidates, filterCandidatesForHarvester } = require('../src/services/externalSeedHarvesterBridge');

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

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function fetchRows(options) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [options.market];
  let idx = params.length;

  const bind = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  if (options.seedId) where.push(`id::text = ${bind(options.seedId)}`);
  if (options.externalProductId) where.push(`external_product_id = ${bind(options.externalProductId)}`);
  if (options.domain) where.push(`domain = ${bind(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', '')) = lower(${bind(options.brand)})`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
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
    WHERE ${where.join('\n      AND ')}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  const res = await query(sql, params);
  return res.rows || [];
}

async function fetchExistingKbKeys(candidateIds) {
  if (!candidateIds.length) return { tableAvailable: false, keys: new Set() };

  try {
    const runQuery = async (text, params) => (await kbQuery(text, params)) || query(text, params);
    const tableCheck = await runQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
    if (!tableCheck.rows?.[0]?.table_name) {
      return { tableAvailable: false, keys: new Set() };
    }

    const res = await runQuery(
      `
        SELECT sku_key
        FROM pci_kb.sku_ingredients
        WHERE sku_key = ANY($1::text[])
      `,
      [candidateIds],
    );

    return {
      tableAvailable: true,
      keys: new Set((res.rows || []).map((row) => normalizeNonEmptyString(row.sku_key)).filter(Boolean)),
    };
  } catch {
    return { tableAvailable: false, keys: new Set() };
  }
}

function toCsv(rows) {
  const headers = [
    'candidate_id',
    'sku_key',
    'external_seed_id',
    'external_product_id',
    'market',
    'brand',
    'product_name',
    'variant_sku',
    'variant_id',
    'source_type',
    'source_ref',
    'url',
    'raw_ingredient_text',
  ];

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = {
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    seedId: argValue('seed-id') || argValue('seedId') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 200), 5000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    includeBlocked: hasFlag('include-blocked'),
    includeNonSkincare: hasFlag('include-non-skincare'),
    includeExistingKb: hasFlag('include-existing-kb'),
    out: argValue('out') || path.join(process.cwd(), 'artifacts', 'external_seed_harvester_candidates.csv'),
  };

  const rows = await fetchRows(options);
  const filtered = filterCandidatesForHarvester(rows, {
    includeBlocked: options.includeBlocked,
    includeNonSkincare: options.includeNonSkincare,
  });
  const allCandidates = filtered.exported.flatMap((item) => item.candidates);
  const kbKeys = await fetchExistingKbKeys(allCandidates.map((candidate) => candidate.candidate_id));
  const exportRows = options.includeExistingKb
    ? allCandidates
    : allCandidates.filter((candidate) => !kbKeys.keys.has(candidate.candidate_id));
  const csv = toCsv(exportRows);

  ensureParentDir(options.out);
  fs.writeFileSync(options.out, csv, 'utf8');

  const summary = {
    scanned_rows: rows.length,
    exported_rows: exportRows.length,
    blocked_rows: filtered.skipped.length,
    kb_table_available: kbKeys.tableAvailable,
    skipped_existing_kb: allCandidates.length - exportRows.length,
    output: options.out,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchRows,
  toCsv,
  fetchExistingKbKeys,
  buildExternalSeedHarvesterCandidates,
};
