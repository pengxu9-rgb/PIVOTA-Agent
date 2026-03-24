#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { query } = require('../src/db');
const { kbQuery } = require('../src/services/pciKbClient');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');
const { resolveIngredientRecallProfile } = require('../src/services/ingredientProductRecall');

const DEFAULT_INGREDIENTS = Object.freeze([
  'niacinamide',
  'ascorbic_acid',
  'hyaluronic_acid',
  'retinol',
  'salicylic_acid',
  'ceramide_np',
  'peptides',
]);

const SKINCARE_CATEGORY_TERMS = Object.freeze(['serum', 'moisturizer', 'cleanser', 'toner']);

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArgs(argv) {
  const args = {
    market: String(process.env.EXTERNAL_INGREDIENT_COVERAGE_MARKET || 'US').trim().toUpperCase(),
    outDir:
      process.env.EXTERNAL_INGREDIENT_COVERAGE_OUT_DIR ||
      'reports/external-seed-ingredient-coverage',
    ingredients:
      String(process.env.EXTERNAL_INGREDIENT_COVERAGE_INGREDIENTS || '')
        .split(',')
        .map((value) => String(value || '').trim())
        .filter(Boolean) || [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--market' && next) args.market = String(next).trim().toUpperCase();
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--ingredients' && next) {
      args.ingredients = String(next)
        .split(',')
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    }
  }
  return args;
}

function normalizeIngredientIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function extractReviewedIngredientIds(row) {
  const seedData = row && row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  const snapshot = seedData && seedData.snapshot && typeof seedData.snapshot === 'object'
    ? seedData.snapshot
    : {};
  const values = [
    row?.reviewed_ingredient_ids,
    seedData.reviewed_ingredient_ids,
    snapshot.reviewed_ingredient_ids,
  ].find((value) => Array.isArray(value));
  return normalizeIngredientIds(values);
}

function resolveIngredientTerms(ingredientId) {
  const profile = resolveIngredientRecallProfile({ ingredientId }) || {};
  return Array.from(new Set([
    ingredientId.replace(/_/g, ' '),
    ...(Array.isArray(profile.exact_phrases) ? profile.exact_phrases : []),
    ...(Array.isArray(profile.alias_phrases) ? profile.alias_phrases : []),
  ].map((value) => normalizeText(value)).filter(Boolean)));
}

function isSkincareWhitelistProduct(product, row) {
  const seedData = row && row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  const text = normalizeText([
    product?.product_type,
    row?.category,
    seedData?.category,
    product?.title,
  ].filter(Boolean).join(' '));
  return SKINCARE_CATEGORY_TERMS.some((term) => text.includes(term));
}

function buildSurfaceText(product, row) {
  const seedData = row && row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  return normalizeText([
    product?.title,
    product?.product_type,
    row?.canonical_url,
    row?.destination_url,
    seedData?.canonical_url,
    seedData?.destination_url,
  ].filter(Boolean).join(' '));
}

async function isKbTableAvailable() {
  const res = await kbQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
  return Boolean(res?.rows?.[0]?.table_name);
}

async function fetchReviewedKbCount(ingredientId, terms) {
  if (!(await isKbTableAvailable())) return null;
  const patterns = Array.from(new Set(terms.map((term) => `%${term}%`)));
  if (!patterns.length) return 0;
  const res = await kbQuery(
    `
      SELECT COUNT(*)::int AS total
      FROM pci_kb.sku_ingredients
      WHERE
        lower(coalesce(raw_ingredient_text_clean, '')) LIKE ANY($1::text[])
        OR lower(coalesce(inci_list, '')) LIKE ANY($1::text[])
        OR lower(coalesce(product_name, '')) LIKE ANY($1::text[])
        OR lower(coalesce(source_ref, '')) LIKE ANY($1::text[])
    `,
    [patterns],
  );
  return Number(res?.rows?.[0]?.total || 0) || 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ingredientIds = args.ingredients.length ? args.ingredients : Array.from(DEFAULT_INGREDIENTS);
  const result = await query(
    `
      SELECT
        id,
        market,
        tool,
        status,
        attached_product_key,
        title,
        canonical_url,
        destination_url,
        category,
        price_amount,
        price_currency,
        availability,
        seed_data,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND attached_product_key IS NULL
        AND market = $1
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
    `,
    [args.market],
  );

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const reportRows = [];
  for (const ingredientId of ingredientIds) {
    const terms = resolveIngredientTerms(ingredientId);
    const entry = {
      ingredient_id: ingredientId,
      market: args.market,
      active_seed_count: 0,
      skincare_seed_count: 0,
      structured_seed_count: 0,
      reviewed_seed_count: 0,
      title_anchor_count: 0,
      strict_positive_candidate_count: 0,
      reviewed_kb_row_count: await fetchReviewedKbCount(ingredientId, terms),
      sample_titles: [],
    };

    for (const row of rows) {
      const product = buildExternalSeedProduct(row);
      if (!product) continue;
      entry.active_seed_count += 1;
      if (!isSkincareWhitelistProduct(product, row)) continue;
      entry.skincare_seed_count += 1;

      const structuredIds = normalizeIngredientIds(product.ingredient_ids);
      const reviewedIds = extractReviewedIngredientIds(row);
      const surfaceText = buildSurfaceText(product, row);
      const hasStructured = structuredIds.includes(ingredientId);
      const hasReviewed = reviewedIds.includes(ingredientId);
      const hasTitleAnchor = terms.some((term) => surfaceText.includes(term));

      if (hasStructured) entry.structured_seed_count += 1;
      if (hasReviewed) entry.reviewed_seed_count += 1;
      if (hasTitleAnchor) entry.title_anchor_count += 1;
      if (hasStructured && hasTitleAnchor) {
        entry.strict_positive_candidate_count += 1;
        if (entry.sample_titles.length < 5) {
          entry.sample_titles.push(String(product.title || '').trim());
        }
      }
    }
    reportRows.push(entry);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    market: args.market,
    ingredient_count: reportRows.length,
  };

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `external_seed_ingredient_coverage_${timestamp()}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ summary, rows: reportRows }, null, 2),
    'utf8',
  );

  const markdown = [
    '# External Seed Ingredient Coverage',
    '',
    `- generated_at: ${summary.generated_at}`,
    `- market: ${summary.market}`,
    `- ingredient_count: ${summary.ingredient_count}`,
    '',
    '| ingredient_id | active_seed_count | skincare_seed_count | structured_seed_count | reviewed_seed_count | title_anchor_count | strict_positive_candidate_count | reviewed_kb_row_count | sample_titles |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...reportRows.map(
      (row) =>
        `| ${row.ingredient_id} | ${row.active_seed_count} | ${row.skincare_seed_count} | ${row.structured_seed_count} | ${row.reviewed_seed_count} | ${row.title_anchor_count} | ${row.strict_positive_candidate_count} | ${row.reviewed_kb_row_count == null ? '' : row.reviewed_kb_row_count} | ${row.sample_titles.join('; ')} |`,
    ),
    '',
  ].join('\n');
  fs.writeFileSync(mdPath, markdown, 'utf8');

  process.stdout.write(`${jsonPath}\n${mdPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
