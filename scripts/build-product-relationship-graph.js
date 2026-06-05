#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const {
  buildProductRelationshipGraphDryRun,
  CURATED_NEED_NODES,
  normalizeProductSnapshot,
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  upsertRelationshipCandidateLabel,
  reviewStatusToLabelState,
} = require('../src/auroraBff/productRelationshipGraph');
const {
  buildCandidatesByAnchorFromSources,
  loadProductRelationshipGraphSourceInputs,
} = require('../src/auroraBff/productRelationshipGraphSources');
const {
  applyAllGates,
} = require('../src/auroraBff/productRelationshipGraphPreflight');
const {
  lookupBeautyAttributesBatch,
  normalizeKey,
} = require('../src/auroraBff/productBeautyAttributes');
const { computeReviewPriority } = require('../src/auroraBff/relationshipReviewPriority');

// Lever-2: order the review-pending report highest-predicted-approval first so
// reviewers work the highest-yield candidates first. Pure: attaches
// edge.review_priority and returns a stably-sorted copy (priority DESC, unscored
// edges last). No-op (original order) when no model artifact is present.
function reviewPriorityBrand(snapshot) {
  return (snapshot && (snapshot.brand || snapshot.brand_name || snapshot.vendor)) || null;
}

function orderEdgesByReviewPriority(edges = [], attrsByKey = new Map()) {
  const scored = edges.map((edge, index) => {
    const priority = computeReviewPriority({
      anchorAttrs: attrsByKey.get(normalizeKey(edge.anchor_ref)),
      candidateAttrs: attrsByKey.get(normalizeKey(edge.candidate_product_ref)),
      relationType: edge.relation_type,
      scoreTotal: edge.score_total,
      anchorBrand: reviewPriorityBrand(edge.anchor_snapshot),
      candidateBrand: reviewPriorityBrand(edge.candidate_snapshot),
    });
    const next = priority == null ? edge : { ...edge, review_priority: priority };
    return { edge: next, priority, index };
  });
  scored.sort((a, b) => {
    if (a.priority == null && b.priority == null) return a.index - b.index;
    if (a.priority == null) return 1;
    if (b.priority == null) return -1;
    return b.priority - a.priority || a.index - b.index;
  });
  return scored.map((s) => s.edge);
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

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

// Pure helper: derive the default label_state from the --review-status arg.
//
//   - reviewStatusArg null/missing  → 'generated' (fresh builder output,
//     subject to Phase B preflight gating).
//   - reviewStatusArg present       → mapped via reviewStatusToLabelState;
//     gate is skipped because the reviewer's decision is authoritative.
//
// Used by main(); exported for unit testing.
function resolveDefaultLabelState(reviewStatusArg) {
  if (!reviewStatusArg) return 'generated';
  const normalized = normalizeLower(reviewStatusArg, 32);
  return reviewStatusToLabelState(normalized) || 'generated';
}

// Pure helper: classify a single edge into { label_state, prefilter_reasons,
// bucket } given resolved beauty attrs. Bucket is 'rejected' | 'passed' |
// 'skipped' (skipped = no attrs available on one or both sides).
//
// Used by main() in the apply loop; exported for unit testing.
function classifyEdgeForPrefilter({ edge, defaultLabelState, anchorAttrs, candidateAttrs }) {
  if (defaultLabelState !== 'generated') {
    return { label_state: defaultLabelState, prefilter_reasons: null, bucket: null };
  }
  const gateResult = applyAllGates(anchorAttrs, candidateAttrs, edge.relation_type);
  if (!gateResult.passes) {
    return {
      label_state: 'prefilter_rejected',
      prefilter_reasons: gateResult.prefilter_reasons,
      bucket: 'rejected',
    };
  }
  if (anchorAttrs && candidateAttrs) {
    return { label_state: 'generated', prefilter_reasons: null, bucket: 'passed' };
  }
  return { label_state: 'generated', prefilter_reasons: null, bucket: 'skipped' };
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
  fanOutFamilyCandidatesToSiblingAnchors = false,
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
      fanOutFamilyCandidatesToSiblingAnchors,
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
        fan_out_family_candidates_to_sibling_anchors: fanOutFamilyCandidatesToSiblingAnchors,
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
  const reviewStatusArg = argValue('review-status');
  // reviewStatus is stamped onto each generated edge as review_status. Fresh
  // builder output is 'pending' review by default.
  const reviewStatus = normalizeLower(reviewStatusArg || 'pending', 32) || 'pending';
  const defaultLabelState = resolveDefaultLabelState(reviewStatusArg);
  const maxPerAnchor = numberArg('max-per-anchor', 24, { min: 1, max: 100 });
  const includeTransitiveRecall = !hasFlag('no-transitive-recall');
  const maxBridgePerAnchor = numberArg('max-bridge-per-anchor', 8, { min: 1, max: 24 });
  const maxBridgeCandidates = numberArg('max-bridge-candidates', 8, { min: 1, max: 24 });
  const maxTransitivePerAnchor = numberArg('max-transitive-per-anchor', 8, { min: 0, max: 24 });
  const fanOutFamilyCandidatesToSiblingAnchors =
    hasFlag('fan-out-family-candidates') ||
    envFlag('RELATIONSHIP_GRAPH_FAN_OUT_FAMILY_CANDIDATES');
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
    fanOutFamilyCandidatesToSiblingAnchors,
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

  // defaultLabelState resolution above (via resolveDefaultLabelState):
  //   - No --review-status  → 'generated' (Phase B gate runs).
  //   - --review-status set → mapped reviewer state (gate skipped).
  // Phase B preflight gates. When defaultLabelState is 'generated' (no
  // explicit reviewer decision), run applyAllGates on each edge using the
  // anchor/candidate beauty attributes; gate failures are routed to
  // 'prefilter_rejected' so they never reach the reviewer queue.
  //
  // Explicit reviewer decisions (--review-status approved|rejected|pending)
  // bypass the gate — the reviewer's call is authoritative.
  // Resolve beauty attributes for the whole generated batch once. Used by the
  // prefilter gate (apply only) AND by review-priority ordering (always, so the
  // dry-run report is ranked too).
  let attrsByKey = new Map();
  if (defaultLabelState === 'generated' && report.edges.length) {
    const productKeys = new Set();
    for (const edge of report.edges) {
      const aKey = normalizeKey(edge.anchor_ref);
      const cKey = normalizeKey(edge.candidate_product_ref);
      if (aKey) productKeys.add(aKey);
      if (cKey) productKeys.add(cKey);
    }
    if (productKeys.size > 0) {
      attrsByKey = await lookupBeautyAttributesBatch(Array.from(productKeys));
    }
  }

  let applied = 0;
  let prefilterRejected = 0;
  let prefilterPassed = 0;
  let prefilterSkipped = 0;
  if (hasFlag('apply')) {
    for (const edge of report.edges) {
      const anchorAttrs = attrsByKey.get(normalizeKey(edge.anchor_ref));
      const candidateAttrs = attrsByKey.get(normalizeKey(edge.candidate_product_ref));
      const classification = classifyEdgeForPrefilter({
        edge,
        defaultLabelState,
        anchorAttrs,
        candidateAttrs,
      });
      if (classification.bucket === 'rejected') prefilterRejected += 1;
      else if (classification.bucket === 'passed') prefilterPassed += 1;
      else if (classification.bucket === 'skipped') prefilterSkipped += 1;

      // eslint-disable-next-line no-await-in-loop
      await upsertRelationshipCandidateLabel({
        ...edge,
        edge_id: edge.id,
        label_state: classification.label_state,
        prefilter_reasons: classification.prefilter_reasons,
      });
      applied += 1;
    }
  }

  // Lever-2: rank the review-pending report highest-predicted-approval first.
  const reviewPriorityOrdered = defaultLabelState === 'generated' && attrsByKey.size > 0;
  if (reviewPriorityOrdered) {
    report.edges = orderEdgesByReviewPriority(report.edges, attrsByKey);
  }

  const finalReport = {
    ...report,
    summary: {
      ...report.summary,
      source_counts: payload.sourceCounts || payload.source_counts || payload.sourceDiagnostics?.source_counts || null,
      source_diagnostics: payload.sourceDiagnostics || payload.source_diagnostics || null,
      dry_run: !hasFlag('apply'),
      applied_count: applied,
      prefilter_applied: hasFlag('apply') && defaultLabelState === 'generated',
      prefilter_rejected_count: prefilterRejected,
      prefilter_passed_count: prefilterPassed,
      prefilter_skipped_count: prefilterSkipped,
      review_priority_ordered: reviewPriorityOrdered,
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
  envFlag,
  numberArg,
  classifyEdgeForPrefilter,
  resolveDefaultLabelState,
  orderEdgesByReviewPriority,
};
