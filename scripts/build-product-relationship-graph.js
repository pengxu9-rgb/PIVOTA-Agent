#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const {
  buildProductRelationshipGraphDryRun,
  CURATED_NEED_NODES,
  normalizeProductSnapshot,
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const { upsertRelationshipEdge } = require('../src/auroraBff/productRelationshipGraph');
const {
  buildCandidatesByAnchorFromSources,
  loadProductRelationshipGraphSourceInputs,
} = require('../src/auroraBff/productRelationshipGraphSources');

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

function numberArg(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = argValue(name);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function resolvePathMaybeRelative(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(process.cwd(), text);
}

function readInputFile(inputPath) {
  const resolved = resolvePathMaybeRelative(inputPath);
  if (!resolved) return null;
  const body = fs.readFileSync(resolved, 'utf8').trim();
  if (!body) return null;
  if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
  const rows = body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { anchors: rows };
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
  return normalizeString(value, max).toLowerCase();
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return toNumberOrNull(value.amount ?? value.value ?? value.price ?? value.min ?? value.sale_price);
  }
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeProductDataRow(row, sourceType) {
  const product = row && typeof row.product_data === 'object' && !Array.isArray(row.product_data)
    ? row.product_data
    : row && typeof row.seed_data === 'object' && !Array.isArray(row.seed_data)
      ? row.seed_data
      : row || {};
  const ref = normalizeString(
    row.product_ref ||
      row.external_product_id ||
      row.id ||
      product.product_ref ||
      product.product_id ||
      product.productId ||
      product.id ||
      product.url ||
      product.canonical_url,
  );
  const brand = normalizeString(product.brand || product.brand_name || product.vendor);
  const name = normalizeString(product.name || product.display_name || product.title);
  const category = normalizeString(product.category || product.category_taxonomy || product.product_type);
  const price = toNumberOrNull(product.price ?? product.price_amount ?? row.price_amount);
  return {
    ...product,
    product_ref: ref ? (ref.includes(':') ? ref : `product:${ref}`) : '',
    brand,
    name,
    category,
    category_taxonomy: Array.isArray(product.category_taxonomy) ? product.category_taxonomy : [category].filter(Boolean),
    price,
    source_refs: [{ type: sourceType, authoritative: true }],
    price_observed_at: row.updated_at || row.cached_at || row.created_at || new Date().toISOString(),
    evidence_grade: 'B',
  };
}

async function fetchProductsCacheBeautyRows(limit) {
  try {
    const res = await query(
      `
        SELECT
          COALESCE(NULLIF(platform_product_id, ''), NULLIF(product_data->>'id', ''), id::text) AS product_ref,
          product_data,
          cached_at,
          updated_at
        FROM products_cache
        WHERE (
          lower(to_jsonb(product_data)::text) LIKE '%beauty%'
          OR lower(to_jsonb(product_data)::text) LIKE '%skincare%'
          OR lower(to_jsonb(product_data)::text) LIKE '%serum%'
          OR lower(to_jsonb(product_data)::text) LIKE '%moisturizer%'
          OR lower(to_jsonb(product_data)::text) LIKE '%cleanser%'
          OR lower(to_jsonb(product_data)::text) LIKE '%sunscreen%'
        )
        ORDER BY cached_at DESC NULLS LAST, id DESC
        LIMIT $1
      `,
      [Math.max(20, Math.min(Number(limit) || 1000, 5000))],
    );
    return (Array.isArray(res?.rows) ? res.rows : []).map((row) => normalizeProductDataRow(row, 'products_cache'));
  } catch (err) {
    if (['NO_DATABASE', '42P01'].includes(String(err?.code || ''))) return [];
    throw err;
  }
}

async function fetchExternalSeedBeautyRows(limit) {
  try {
    const res = await query(
      `
        SELECT
          id,
          external_product_id,
          title,
          price_amount,
          market,
          seed_data,
          canonical_url,
          updated_at,
          created_at
        FROM external_product_seeds
        WHERE COALESCE(status, 'active') = 'active'
          AND upper(COALESCE(market, 'US')) = 'US'
          AND (
            lower(to_jsonb(seed_data)::text) LIKE '%beauty%'
            OR lower(to_jsonb(seed_data)::text) LIKE '%skincare%'
            OR lower(to_jsonb(seed_data)::text) LIKE '%serum%'
            OR lower(to_jsonb(seed_data)::text) LIKE '%moisturizer%'
            OR lower(to_jsonb(seed_data)::text) LIKE '%cleanser%'
            OR lower(to_jsonb(seed_data)::text) LIKE '%sunscreen%'
          )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $1
      `,
      [Math.max(20, Math.min(Number(limit) || 1000, 5000))],
    );
    return (Array.isArray(res?.rows) ? res.rows : []).map((row) => {
      const product = normalizeProductDataRow(row, 'external_product_seed');
      return {
        ...product,
        product_ref: product.product_ref || `external:${normalizeString(row.external_product_id || row.id)}`,
        name: product.name || normalizeString(row.title),
        url: normalizeString(row.canonical_url || product.url),
        price: toNumberOrNull(product.price ?? row.price_amount),
      };
    });
  } catch (err) {
    if (['NO_DATABASE', '42P01'].includes(String(err?.code || ''))) return [];
    throw err;
  }
}

function tokenSet(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3));
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / Math.max(a.size, b.size);
}

function attachCandidateSignals(anchor, candidate) {
  const categoryScore = Math.max(
    overlapScore(anchor.category, candidate.category),
    overlapScore(anchor.name, candidate.name),
  );
  const sameCategoryBoost = normalizeLower(anchor.category) && normalizeLower(anchor.category) === normalizeLower(candidate.category)
    ? 0.2
    : 0;
  const categoryUseCase = Math.min(1, categoryScore + sameCategoryBoost);
  const ingredientSimilarity = Math.max(
    overlapScore(anchor.description, candidate.description),
    overlapScore(anchor.tags, candidate.tags),
    categoryUseCase * 0.75,
  );
  return {
    ...candidate,
    category_use_case_match: categoryUseCase,
    ingredient_functional_similarity: ingredientSimilarity,
    similarity_score: Math.max(categoryUseCase, ingredientSimilarity),
  };
}

function buildCandidateMap(products, anchors, maxPerAnchor = 24) {
  const candidatesByAnchor = {};
  for (const anchor of anchors) {
    const anchorRef = normalizeProductSnapshot(anchor).product_ref;
    const rows = products
      .filter((candidate) => normalizeProductSnapshot(candidate).product_ref !== anchorRef)
      .map((candidate) => attachCandidateSignals(anchor, candidate))
      .filter((candidate) => Number(candidate.category_use_case_match || 0) >= 0.45)
      .sort((a, b) => Number(b.similarity_score || 0) - Number(a.similarity_score || 0))
      .slice(0, maxPerAnchor);
    candidatesByAnchor[anchorRef] = rows;
  }
  return candidatesByAnchor;
}

function buildNeedCandidateMap(products, maxPerNeed = 40) {
  const out = {};
  for (const need of CURATED_NEED_NODES) {
    const needText = [need.label, ...(Array.isArray(need.tags) ? need.tags : [])].join(' ');
    out[need.need_id] = products
      .map((product) => ({
        ...product,
        score_total: Math.max(
          overlapScore(needText, product.name),
          overlapScore(needText, product.description),
          overlapScore(needText, product.tags),
          overlapScore(needText, product.category),
        ),
        category_use_case_match: Math.max(0.65, overlapScore(needText, product.category)),
        ingredient_functional_similarity: Math.max(0.6, overlapScore(needText, product.description || product.tags)),
      }))
      .filter((product) => Number(product.score_total || 0) >= 0.25)
      .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
      .slice(0, maxPerNeed);
  }
  return out;
}

async function buildInputsFromDb({
  limit,
  sourceLimit = limit,
  anchorOffset = 0,
  market = 'US',
  maxPerAnchor = 24,
  includeTransitiveRecall = true,
  maxBridgePerAnchor = 8,
  maxBridgeCandidates = 8,
  maxTransitivePerAnchor = 8,
} = {}) {
  const sourceInputs = await loadProductRelationshipGraphSourceInputs({
    queryFn: query,
    limit: sourceLimit,
    market,
  });
  const products = sourceInputs.products || [];
  const offset = Math.max(0, Number(anchorOffset) || 0);
  const anchors = products.slice(offset, offset + limit);
  return {
    anchors,
    candidatesByAnchor: buildCandidatesByAnchorFromSources({
      anchors,
      products,
      legacyDupes: sourceInputs.legacyDupes,
      intelRows: sourceInputs.intelRows,
      maxPerAnchor,
      includeTransitiveRecall,
      maxBridgePerAnchor,
      maxBridgeCandidates,
      maxTransitivePerAnchor,
    }),
    needCandidatesById: buildNeedCandidateMap(products),
    sourceCounts: sourceInputs.source_counts,
    sourceDiagnostics: {
      database_configured: Boolean(process.env.DATABASE_URL),
      products_available: products.length,
      source_counts: sourceInputs.source_counts,
      builder_options: {
        source_limit: sourceLimit,
        anchor_offset: offset,
        max_per_anchor: maxPerAnchor,
        include_transitive_recall: includeTransitiveRecall,
        max_bridge_per_anchor: maxBridgePerAnchor,
        max_bridge_candidates: maxBridgeCandidates,
        max_transitive_per_anchor: maxTransitivePerAnchor,
      },
    },
  };
}

async function main() {
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 200), 2000));
  const sourceLimit = numberArg('source-limit', limit, { min: limit, max: 5000 });
  const anchorOffset = numberArg('anchor-offset', 0, { min: 0, max: 5000 });
  const market = normalizeString(argValue('market') || 'US', 24).toUpperCase() || 'US';
  const input = readInputFile(argValue('input'));
  const reviewStatus = normalizeLower(argValue('review-status') || 'pending', 32) || 'pending';
  const maxPerAnchor = numberArg('max-per-anchor', 24, { min: 1, max: 100 });
  const includeTransitiveRecall = !hasFlag('no-transitive-recall');
  const maxBridgePerAnchor = numberArg('max-bridge-per-anchor', 8, { min: 1, max: 24 });
  const maxBridgeCandidates = numberArg('max-bridge-candidates', 8, { min: 1, max: 24 });
  const maxTransitivePerAnchor = numberArg('max-transitive-per-anchor', 8, { min: 0, max: 24 });
  const payload = input || await buildInputsFromDb({
    limit,
    sourceLimit,
    anchorOffset,
    market,
    maxPerAnchor,
    includeTransitiveRecall,
    maxBridgePerAnchor,
    maxBridgeCandidates,
    maxTransitivePerAnchor,
  });
  const report = buildProductRelationshipGraphDryRun({
    anchors: payload.anchors || [],
    candidatesByAnchor: payload.candidatesByAnchor || payload.candidates_by_anchor || {},
    needCandidatesById: payload.needCandidatesById || payload.need_candidates_by_id || {},
    needs: payload.needs || CURATED_NEED_NODES,
    market,
    reviewStatus,
    limit,
  });

  let applied = 0;
  if (hasFlag('apply')) {
    for (const edge of report.edges) {
      // eslint-disable-next-line no-await-in-loop
      await upsertRelationshipEdge(edge);
      applied += 1;
    }
  }

  const finalReport = {
    ...report,
    summary: {
      ...report.summary,
      source_counts: payload.sourceCounts || payload.source_counts || payload.sourceDiagnostics?.source_counts || null,
      source_diagnostics: payload.sourceDiagnostics || payload.source_diagnostics || null,
      dry_run: !hasFlag('apply'),
      applied_count: applied,
    },
  };
  if (hasFlag('require-anchors') && Number(finalReport.summary.anchor_count || 0) <= 0) {
    const err = new Error('product_relationship_graph_builder_zero_anchors');
    err.summary = finalReport.summary;
    const outPath = resolvePathMaybeRelative(argValue('out'));
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
    }
    throw err;
  }
  const outPath = resolvePathMaybeRelative(argValue('out'));
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(finalReport.summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildInputsFromDb,
  buildCandidateMap,
  buildNeedCandidateMap,
  attachCandidateSignals,
  numberArg,
};
