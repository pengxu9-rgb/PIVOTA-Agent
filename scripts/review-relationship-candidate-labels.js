#!/usr/bin/env node
'use strict';

/**
 * Relationship graph AI reviewer (generated -> ai_approved).
 *
 * Rubric v2, reconstructed from the existing ai_approved provenance rows
 * (reviewer=codex-gpt-5.5-xhigh, rubric=v2, primary_reason=valid_relationship)
 * plus the committed relationship graph audit/preflight rules. No standalone
 * rubric document was found in this checkout.
 *
 * Approve only when the evidence supports the requested relation:
 * - dupe: close lower-priced substitute with matching category/form, shopper
 *   job, target area, and use case. It does not have to be the same listing.
 * - competitive_alternative: same broad product job, target area, routine step,
 *   and category/use case; a shopper could compare or substitute them.
 * - niche_specialist: candidate is a more focused or specialist answer to the
 *   anchor/need use case, with category/function evidence.
 * - related_product: products belong in the same routine, kit, regimen, or
 *   complementary use case; not merely the same brand or seller.
 *
 * Reject when the pair is supported only by weak source/brand/category overlap,
 * lacks the price evidence expected for a dupe, has conflicting product jobs or
 * target areas, is a shade/format cross-product with no useful relationship,
 * has sparse or contradictory evidence, relies on unsupported medical/social
 * claims, or does not match the claimed relation_type.
 *
 * Confidence calibration:
 * - 0.90-1.00: direct title/category/use-case/function evidence.
 * - 0.75-0.89: strong but not exact evidence; minor ambiguity remains.
 * - 0.55-0.74: plausible but evidence is partial.
 * - below 0.55: reject or keep generated unless the relation is clearly valid.
 */

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { LlmError, createProviderFromEnv, z } = require('../src/llm/provider');

const REVIEWER_ID = 'codex-gpt-5.5-xhigh';
const RUBRIC_VERSION = 'v2';
const PRIMARY_REASON = 'valid_relationship';
const AI_APPROVAL_FRESHNESS_INTERVAL = '45 days';
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 5000;
const TEXT_LIMIT = 900;
const RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);
const DEFAULT_EXCLUDED_RELATION_TYPES = ['dupe'];

const VerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(12).max(700),
});

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/review-relationship-candidate-labels.js --cutoff <timestamp> [--min-score <n>] [--limit <n>] [--relation-types a,b] [--exclude-relation-types a,b] [--ids-file <path>] [--verdicts-file <path>] [--out <path>] [--apply]',
    '',
    'Dry-run is the default. --apply is fail-closed unless RELGRAPH_AI_REVIEW_APPLY=1 is set.',
    'AI approval excludes dupe by default. Use --allow-dupe-ai-approval only for a manual, audited run.',
  ].join('\n');
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseRelationTypes(value, { optionName = 'relation-types' } = {}) {
  const raw = normalizeString(value, 2000);
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const token of raw.split(/[,\s]+/)) {
    const relationType = normalizeString(token, 80).toLowerCase();
    if (!relationType) continue;
    if (!RELATION_TYPES.has(relationType)) {
      throw new Error(`invalid --${optionName} relation_type: ${relationType}`);
    }
    if (seen.has(relationType)) continue;
    seen.add(relationType);
    out.push(relationType);
  }
  return out;
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) {
    return { help: true };
  }

  const cutoff = String(argValue(argv, 'cutoff') || '').trim();
  const minScore = parseNumber(argValue(argv, 'min-score'), 0, { min: 0, max: 1 });
  const limit = Math.trunc(parseNumber(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT }));
  const idsFile = String(argValue(argv, 'ids-file') || '').trim();
  const verdictsFile = String(argValue(argv, 'verdicts-file') || '').trim();
  const out = String(argValue(argv, 'out') || '').trim();
  const apply = hasFlag(argv, 'apply');
  const allowDupeAiApproval = hasFlag(argv, 'allow-dupe-ai-approval');
  const relationTypes = parseRelationTypes(argValue(argv, 'relation-types'), { optionName: 'relation-types' });
  const explicitExcludedRelationTypes = parseRelationTypes(argValue(argv, 'exclude-relation-types'), {
    optionName: 'exclude-relation-types',
  });
  const excludeRelationTypes = allowDupeAiApproval
    ? explicitExcludedRelationTypes
    : Array.from(new Set([...DEFAULT_EXCLUDED_RELATION_TYPES, ...explicitExcludedRelationTypes]));

  if (!cutoff) throw new Error('--cutoff is required');
  const cutoffDate = new Date(cutoff);
  if (Number.isNaN(cutoffDate.getTime())) throw new Error(`invalid --cutoff timestamp: ${cutoff}`);

  return {
    cutoff,
    minScore,
    limit,
    idsFile,
    verdictsFile,
    out,
    apply,
    relationTypes,
    excludeRelationTypes,
    allowDupeAiApproval,
  };
}

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = String(filePath || '').trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function readIdsFile(filePath) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return [];
  const body = fs.readFileSync(resolved, 'utf8');
  return Array.from(
    new Set(
      body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith('#')),
    ),
  );
}

function readVerdictsFile(filePath) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.decisions)
      ? parsed.decisions
      : Array.isArray(parsed && parsed.verdicts)
        ? parsed.verdicts
        : [];
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = normalizeString(row.id, 160);
    if (!id) continue;
    const verdict = normalizeString(row.verdict, 20).toLowerCase();
    if (!['approve', 'reject'].includes(verdict)) {
      throw new Error(`invalid verdict for ${id}: ${row.verdict}`);
    }
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`invalid confidence for ${id}: ${row.confidence}`);
    }
    const rationale = normalizeString(row.rationale, 700);
    if (!rationale) throw new Error(`missing rationale for ${id}`);
    byId.set(id, {
      verdict,
      confidence: Number(confidence.toFixed(4)),
      rationale,
    });
  }
  return { path: resolved, byId, count: byId.size };
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function truncateText(value, max = TEXT_LIMIT) {
  const text = normalizeString(value, max + 1);
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactArray(value, max = 12) {
  return asArray(value)
    .map((item) => {
      if (typeof item === 'string') return normalizeString(item, 120);
      if (item && typeof item === 'object') {
        return normalizeString(item.label || item.tag || item.headline || item.type || item.name || item.title, 160);
      }
      return normalizeString(item, 120);
    })
    .filter(Boolean)
    .slice(0, max);
}

function stripProductRef(ref) {
  const text = normalizeString(ref, 260);
  return text.replace(/^product:/i, '');
}

function productRefVariants(ref) {
  const bare = stripProductRef(ref);
  const out = new Set();
  if (bare) {
    out.add(bare);
    out.add(`product:${bare}`);
  }
  const text = normalizeString(ref, 260);
  if (text) out.add(text);
  return Array.from(out);
}

function indexProductSupplement(map, key, value) {
  const text = normalizeString(key, 260);
  if (!text) return;
  for (const variant of productRefVariants(text)) {
    if (!map.has(variant.toLowerCase())) map.set(variant.toLowerCase(), value);
  }
}

function findProductSupplement(map, ref) {
  for (const variant of productRefVariants(ref)) {
    const hit = map.get(variant.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function pickScoreBreakdown(scoreBreakdown) {
  const src = asObject(scoreBreakdown);
  const keys = [
    'score_total',
    'category_use_case_match',
    'ingredient_functional_similarity',
    'evidence_quality',
    'availability_confidence',
    'social_reference_strength',
    'price_advantage',
  ];
  const out = {};
  for (const key of keys) {
    const n = Number(src[key]);
    if (Number.isFinite(n)) out[key] = Number(n.toFixed(4));
  }
  return out;
}

function summarizeWhyCandidate(value) {
  const src = asObject(value);
  return {
    summary: truncateText(src.summary, 320),
    reasons_user_visible: compactArray(src.reasons_user_visible || src.reasonsUserVisible, 8),
  };
}

function summarizeSourceRefs(value) {
  return asArray(value)
    .map((ref) => {
      if (typeof ref === 'string') return { label: normalizeString(ref, 240) };
      const obj = asObject(ref);
      return {
        type: normalizeString(obj.type || obj.source_type || obj.source, 80),
        name: normalizeString(obj.name || obj.label || obj.title, 160),
        authoritative: obj.authoritative === true ? true : undefined,
        url: normalizeString(obj.url || obj.href, 240),
      };
    })
    .filter((ref) => Object.values(ref).some((v) => v !== '' && v != null))
    .slice(0, 8);
}

function summarizeBeautyAttrs(attrs) {
  const src = asObject(attrs);
  if (!Object.keys(src).length) return null;
  return {
    product_form: normalizeString(src.product_form, 120),
    category_leaf: normalizeString(src.category_leaf, 120),
    target_area: normalizeString(src.target_area, 120),
    shade_or_color_family: normalizeString(src.shade_or_color_family, 120),
    scent_family: normalizeString(src.scent_family, 120),
    spf_or_otc_flag: normalizeString(src.spf_or_otc_flag, 80),
    skin_concern: compactArray(src.skin_concern, 10),
    claim_risk_level: normalizeString(src.claim_risk_level, 80),
  };
}

function summarizeCatalog(catalog) {
  const src = asObject(catalog);
  if (!Object.keys(src).length) return null;
  return {
    title: normalizeString(src.title, 220),
    brand: normalizeString(src.brand, 120),
    category: normalizeString(src.category || src.category_label || src.product_type, 160),
    category_path: normalizeString(src.category_path, 220),
    use_case_tags: compactArray(src.use_case_tags, 10),
    tags: compactArray(src.tags, 10),
    canonical_url: normalizeString(src.canonical_url || src.pivota_canonical_url, 240),
  };
}

function summarizeExternalSeed(seed) {
  const src = asObject(seed);
  if (!Object.keys(src).length) return null;
  const seedData = asObject(src.seed_data);
  return {
    title: normalizeString(src.title || seedData.title || seedData.name, 220),
    price_amount: Number.isFinite(Number(src.price_amount)) ? Number(src.price_amount) : null,
    price_currency: normalizeString(src.price_currency || seedData.currency, 16),
    availability: normalizeString(src.availability || seedData.availability, 80),
    status: normalizeString(src.status, 80),
    canonical_url: normalizeString(src.canonical_url || seedData.canonical_url || seedData.url, 240),
    domain: normalizeString(src.domain, 120),
  };
}

function summarizeProductSnapshot(snapshot, supplement) {
  const src = asObject(snapshot);
  const productIntel = asObject(src.product_intel);
  const core = asObject(productIntel.product_intel_core);
  const routineFit = asObject(core.routine_fit);
  const whatItIs = asObject(core.what_it_is);
  const confidence = asObject(productIntel.confidence);
  const provenance = asObject(productIntel.provenance);
  const sourceCoverage = asObject(productIntel.source_coverage || core.source_coverage);

  return {
    ref: normalizeString(src.product_ref || src.product_id, 260),
    product_id: normalizeString(src.product_id, 180),
    title: normalizeString(src.name || src.title || asObject(src.search_card).title_candidate, 240),
    brand: normalizeString(src.brand, 120),
    category: normalizeString(src.category, 160),
    category_taxonomy: compactArray(src.category_taxonomy, 12),
    tags: compactArray(src.tags, 12),
    price: src.price == null ? null : Number(src.price),
    description: truncateText(src.description || src.intel_text || whatItIs.body, TEXT_LIMIT),
    ingredient_text: truncateText(src.ingredient_text, 700),
    routine_fit: {
      step: normalizeString(routineFit.step, 80),
      am_pm: compactArray(routineFit.am_pm, 4),
      pairing_notes: compactArray(routineFit.pairing_notes, 5),
    },
    best_for: compactArray(core.best_for, 10),
    watchouts: compactArray(core.watchouts, 5),
    why_it_stands_out: compactArray(core.why_it_stands_out, 5),
    evidence_profile: normalizeString(productIntel.evidence_profile || core.evidence_profile, 120),
    confidence_tier: normalizeString(confidence.tier, 80),
    source_signals: compactArray(provenance.source_signals, 12),
    source_coverage: sourceCoverage,
    beauty_attrs: summarizeBeautyAttrs(supplement && supplement.beauty_attrs),
    catalog: summarizeCatalog(supplement && supplement.catalog),
    external_seed: summarizeExternalSeed(supplement && supplement.external_seed),
  };
}

function buildEvidence(row, supplements) {
  const anchorSupplement = findProductSupplement(supplements, row.anchor_ref);
  const candidateSupplement = findProductSupplement(supplements, row.candidate_product_ref);
  return {
    id: row.id,
    anchor_type: row.anchor_type,
    anchor_ref: row.anchor_ref,
    candidate_product_ref: row.candidate_product_ref,
    relation_type: row.relation_type,
    market: row.market,
    vertical: row.vertical,
    use_case: normalizeString(row.use_case, 180),
    category_taxonomy: compactArray(row.category_taxonomy, 12),
    score_total: Number.isFinite(Number(row.score_total)) ? Number(Number(row.score_total).toFixed(4)) : null,
    score_breakdown: pickScoreBreakdown(row.score_breakdown),
    why_candidate: summarizeWhyCandidate(row.why_candidate),
    tradeoffs: compactArray(row.tradeoffs, 6),
    watchouts: compactArray(row.watchouts, 6),
    source_refs: summarizeSourceRefs(row.source_refs),
    price_evidence: asObject(row.price_evidence),
    anchor: summarizeProductSnapshot(row.anchor_snapshot, anchorSupplement),
    candidate: summarizeProductSnapshot(row.candidate_snapshot, candidateSupplement),
  };
}

function normalizeRelationTypeList(value) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const relationType = normalizeString(item, 80).toLowerCase();
    if (!relationType || !RELATION_TYPES.has(relationType) || seen.has(relationType)) continue;
    seen.add(relationType);
    out.push(relationType);
  }
  return out;
}

async function fetchCandidates({
  cutoff,
  minScore,
  limit,
  ids = [],
  relationTypes = [],
  excludeRelationTypes = [],
  queryFn = query,
}) {
  const params = [cutoff, minScore, limit];
  let idsSql = '';
  if (ids.length) {
    params.push(ids);
    idsSql = `AND id = ANY($${params.length}::text[])`;
  }
  const includedRelationTypes = normalizeRelationTypeList(relationTypes);
  const excludedRelationTypes = normalizeRelationTypeList(excludeRelationTypes);
  let relationTypesSql = '';
  if (includedRelationTypes.length) {
    params.push(includedRelationTypes);
    relationTypesSql = `AND relation_type = ANY($${params.length}::text[])`;
  }
  let excludeRelationTypesSql = '';
  if (excludedRelationTypes.length) {
    params.push(excludedRelationTypes);
    excludeRelationTypesSql = `AND NOT (relation_type = ANY($${params.length}::text[]))`;
  }

  const res = await queryFn(
    `
      SELECT
        id, edge_id, anchor_type, anchor_ref, anchor_snapshot,
        candidate_product_ref, candidate_snapshot, relation_type,
        display_label, market, vertical, category_taxonomy, use_case,
        label_state, score_total, score_breakdown, price_evidence,
        source_refs, evidence_grade, why_candidate, tradeoffs, watchouts,
        provenance, created_at, updated_at
      FROM relationship_candidate_labels
      WHERE label_state = 'generated'
        AND created_at >= $1::timestamptz
        AND COALESCE(score_total, 0) >= $2::double precision
        ${idsSql}
        ${relationTypesSql}
        ${excludeRelationTypesSql}
      ORDER BY score_total DESC NULLS LAST, created_at ASC, id ASC
      LIMIT $3::int
    `,
    params,
  );
  return Array.isArray(res && res.rows) ? res.rows : [];
}

async function fetchSupplementsForRows(rows, queryFn = query) {
  const keys = Array.from(
    new Set(
      rows
        .flatMap((row) => [stripProductRef(row.anchor_ref), stripProductRef(row.candidate_product_ref)])
        .map((key) => normalizeString(key, 260))
        .filter(Boolean),
    ),
  );
  const supplements = new Map();
  if (!keys.length) return supplements;

  const [catalogRes, seedRes, attrsRes] = await Promise.all([
    queryFn(
      `
        SELECT
          product_key, source_product_id, pivota_signature_id, title, description,
          brand, product_type, category, category_path, category_label,
          canonical_url, pivota_canonical_url, tags, use_case_tags
        FROM catalog_products
        WHERE product_key = ANY($1::text[])
           OR source_product_id = ANY($1::text[])
           OR pivota_signature_id = ANY($1::text[])
      `,
      [keys],
    ).catch((err) => {
      if (String(err && err.code) === '42P01') return { rows: [] };
      throw err;
    }),
    queryFn(
      `
        SELECT
          id, external_product_id, title, price_amount, price_currency,
          availability, status, canonical_url, domain, seed_data
        FROM external_product_seeds
        WHERE id = ANY($1::text[])
           OR external_product_id = ANY($1::text[])
      `,
      [keys],
    ).catch((err) => {
      if (String(err && err.code) === '42P01') return { rows: [] };
      throw err;
    }),
    queryFn(
      `
        SELECT *
        FROM product_beauty_attributes
        WHERE product_key = ANY($1::text[])
      `,
      [keys],
    ).catch((err) => {
      if (String(err && err.code) === '42P01') return { rows: [] };
      throw err;
    }),
  ]);

  function ensureSupplement(key) {
    const text = normalizeString(key, 260);
    if (!text) return null;
    const lower = text.toLowerCase();
    const existing = supplements.get(lower) || {};
    supplements.set(lower, existing);
    for (const variant of productRefVariants(text)) {
      indexProductSupplement(supplements, variant, existing);
    }
    return existing;
  }

  for (const row of catalogRes.rows || []) {
    const targets = [row.product_key, row.source_product_id, row.pivota_signature_id].filter(Boolean);
    for (const key of targets) {
      const supplement = ensureSupplement(key);
      if (supplement) supplement.catalog = row;
    }
  }
  for (const row of seedRes.rows || []) {
    const targets = [row.id, row.external_product_id].filter(Boolean);
    for (const key of targets) {
      const supplement = ensureSupplement(key);
      if (supplement) supplement.external_seed = row;
    }
  }
  for (const row of attrsRes.rows || []) {
    const supplement = ensureSupplement(row.product_key);
    if (supplement) supplement.beauty_attrs = row;
  }

  return supplements;
}

function buildReviewPrompt(evidence) {
  return [
    'You are the relationship graph AI reviewer for Pivota beauty commerce.',
    'Return strict JSON only with keys: verdict, confidence, rationale.',
    '',
    'Rubric v2:',
    '- Approve only when the evidence supports the claimed relation_type.',
    '- dupe means a close lower-priced substitute with matching category/form, shopper job, target area, and use case; it does not have to be the same listing.',
    '- competitive_alternative means same shopper job, routine step, category/use case, and target area; substitutable or directly comparable.',
    '- niche_specialist means candidate is a more focused/specialized answer to the anchor or need use case.',
    '- related_product means same routine, kit, regimen, or complementary usage; same brand alone is not enough.',
    '- Reject if evidence is sparse, generic, brand-only, source-only, missing the price evidence expected for a dupe, mismatched category/target area, an unhelpful shade/format cross-product, or not aligned to relation_type.',
    '- Never assume unstated ingredient, medical, social, or performance claims.',
    '',
    'Decision rules:',
    '- Use approve or reject. Do not use hold.',
    '- Confidence must be a real number from 0 to 1.',
    '- Rationale must cite concrete evidence: product titles/categories/use-case/function/ingredients/signals.',
    '',
    'Candidate evidence JSON:',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
}

async function reviewEvidenceWithLlm(provider, evidence) {
  const prompt = buildReviewPrompt(evidence);
  const result = await provider.analyzeTextToJson({ prompt, schema: VerdictSchema });
  const confidence = Math.max(0, Math.min(1, Number(result.confidence)));
  return {
    verdict: result.verdict,
    confidence: Number(confidence.toFixed(4)),
    rationale: normalizeString(result.rationale, 700),
  };
}

function buildAiReview(decision) {
  return {
    reviewer: REVIEWER_ID,
    rubric: RUBRIC_VERSION,
    reason: PRIMARY_REASON,
    primary_reason: PRIMARY_REASON,
    confidence: decision.confidence,
    rationale: decision.rationale,
  };
}

async function applyApproval(row, decision, queryFn = query, { allowDupeAiApproval = false } = {}) {
  if (normalizeString(row && row.relation_type, 80).toLowerCase() === 'dupe' && !allowDupeAiApproval) {
    const err = new Error('dupe_ai_approval_requires_explicit_allow_dupe_ai_approval');
    err.code = 'DUPE_AI_APPROVAL_BLOCKED';
    throw err;
  }
  const aiReview = buildAiReview(decision);
  const res = await queryFn(
    `
      UPDATE relationship_candidate_labels
      SET
        label_state = 'ai_approved',
        provenance = jsonb_set(COALESCE(provenance, '{}'::jsonb), '{ai_review}', $2::jsonb, true),
        last_verified_at = now(),
        expires_at = now() + $3::interval,
        updated_at = now()
      WHERE id = $1
        AND label_state = 'generated'
      RETURNING id, 'generated'::text AS old_label_state, label_state AS new_label_state
    `,
    [row.id, JSON.stringify(aiReview), AI_APPROVAL_FRESHNESS_INTERVAL],
  );
  return Array.isArray(res && res.rows) && res.rows[0] ? res.rows[0] : null;
}

function verdictToLine(row, decision, appliedRow, { apply }) {
  const oldState = 'generated';
  const newState = decision.verdict === 'approve'
    ? (apply ? (appliedRow ? 'ai_approved' : 'generated') : 'ai_approved')
    : 'generated';
  const mode = apply ? 'apply' : 'dry-run';
  const applyNote = apply && decision.verdict === 'approve' && !appliedRow ? ' guarded_noop' : '';
  return [
    `[${mode}]`,
    row.id,
    `${oldState}->${newState}`,
    `verdict=${decision.verdict}`,
    `confidence=${decision.confidence.toFixed(4)}`,
    `relation=${row.relation_type}`,
    `score=${Number(row.score_total || 0).toFixed(4)}`,
    applyNote,
    `rationale=${decision.rationale}`,
  ].filter(Boolean).join(' ');
}

async function runReview({
  cutoff,
  minScore,
  limit,
  idsFile = '',
  verdictsFile = '',
  out = '',
  apply = false,
  relationTypes = [],
  excludeRelationTypes = DEFAULT_EXCLUDED_RELATION_TYPES,
  allowDupeAiApproval = false,
  queryFn = query,
  provider = null,
} = {}) {
  if (apply && process.env.RELGRAPH_AI_REVIEW_APPLY !== '1') {
    throw new Error('--apply requested but RELGRAPH_AI_REVIEW_APPLY=1 is not set');
  }

  const ids = readIdsFile(idsFile);
  const includedRelationTypes = normalizeRelationTypeList(relationTypes);
  const excludedRelationTypes = normalizeRelationTypeList(excludeRelationTypes);
  const rows = await fetchCandidates({
    cutoff,
    minScore,
    limit,
    ids,
    relationTypes: includedRelationTypes,
    excludeRelationTypes: excludedRelationTypes,
    queryFn,
  });
  const supplements = await fetchSupplementsForRows(rows, queryFn);
  const verdictReplay = readVerdictsFile(verdictsFile);
  const llmProvider = verdictReplay ? null : (provider || createProviderFromEnv('relationship_graph_ai_review'));

  const decisions = [];
  let appliedCount = 0;
  for (const row of rows) {
    const evidence = buildEvidence(row, supplements);
    // eslint-disable-next-line no-await-in-loop
    const decision = verdictReplay
      ? verdictReplay.byId.get(row.id)
      : await reviewEvidenceWithLlm(llmProvider, evidence);
    if (!decision) {
      throw new Error(`missing verdict replay row for candidate ${row.id}`);
    }
    let appliedRow = null;
    if (apply && decision.verdict === 'approve') {
      // eslint-disable-next-line no-await-in-loop
      appliedRow = await applyApproval(row, decision, queryFn, { allowDupeAiApproval });
      if (appliedRow) appliedCount += 1;
    }
    const outputRow = {
      id: row.id,
      anchor_ref: row.anchor_ref,
      candidate_product_ref: row.candidate_product_ref,
      relation_type: row.relation_type,
      score_total: Number.isFinite(Number(row.score_total)) ? Number(Number(row.score_total).toFixed(4)) : null,
      verdict: decision.verdict,
      confidence: decision.confidence,
      rationale: decision.rationale,
      old_label_state: 'generated',
      new_label_state: decision.verdict === 'approve' ? 'ai_approved' : 'generated',
      applied: Boolean(appliedRow),
    };
    decisions.push(outputRow);
    process.stdout.write(`${verdictToLine(row, decision, appliedRow, { apply })}\n`);
  }

  const approvedCount = decisions.filter((row) => row.verdict === 'approve').length;
  const rejectedCount = decisions.filter((row) => row.verdict === 'reject').length;
  const approvalRate = decisions.length ? approvedCount / decisions.length : 0;
  const summary = {
    dry_run: !apply,
    cutoff,
    min_score: minScore,
    limit,
    ids_filter_count: ids.length,
    relation_types_filter: includedRelationTypes,
    excluded_relation_types: excludedRelationTypes,
    dupe_ai_approval_allowed: allowDupeAiApproval,
    reviewed_count: decisions.length,
    verdicts_file: verdictReplay ? verdictReplay.path : null,
    verdicts_file_count: verdictReplay ? verdictReplay.count : 0,
    approved_count: approvedCount,
    rejected_count: rejectedCount,
    applied_count: appliedCount,
    approval_rate: Number(approvalRate.toFixed(4)),
    reviewer: REVIEWER_ID,
    rubric: RUBRIC_VERSION,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (out) {
    const resolved = resolvePathMaybeRelative(out);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(
      resolved,
      `${JSON.stringify({ generated_at: new Date().toISOString(), summary, decisions }, null, 2)}\n`,
      'utf8',
    );
  }

  return { summary, decisions };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runReview(args);
}

if (require.main === module) {
  main()
    .catch((err) => {
      if (err instanceof LlmError && err.code === 'LLM_CONFIG_MISSING') {
        process.stderr.write(`${err.message}\n`);
      } else {
        process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch {
        // No-op.
      }
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  REVIEWER_ID,
  RUBRIC_VERSION,
  PRIMARY_REASON,
  AI_APPROVAL_FRESHNESS_INTERVAL,
  VerdictSchema,
  applyApproval,
  buildEvidence,
  buildReviewPrompt,
  buildAiReview,
  fetchCandidates,
  fetchSupplementsForRows,
  parseArgs,
  runReview,
};
