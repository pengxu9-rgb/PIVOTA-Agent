#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const { closePool, query } = require('../src/db');
const { createProviderFromEnv } = require('../src/llm/provider');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(v) {
  return String(v || '').trim();
}

function normalizeHost(value) {
  try {
    return new URL(asString(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// Pre-pass that preserves numeric variant tokens like "2.0", "3.0", "V2"
// before the punctuation strip in tokenize() destroys them. Codex review of
// PR #1445 round 1 flagged that "Cosmic EDP" vs "Cosmic EDP 2.0" tokenizes
// identically once dots and short tokens are dropped.
function extractVariantNumberTokens(text) {
  const out = new Set();
  const normalized = asString(text).toLowerCase();
  const re = /\b(\d+(?:\.\d+)+|v\d+(?:\.\d+)*)\b/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function tokenize(text) {
  const variantNums = extractVariantNumberTokens(text);
  const baseTokens = asString(text)
    .toLowerCase()
    .replace(/[^a-z0-9% +]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  // Dedupe so the LIKE-pattern builder in searchCandidateMatches doesn't
  // produce `%v2%v2%` for "Skincare V2" and under-recall versioned titles.
  return Array.from(new Set([...baseTokens, ...variantNums]));
}

function tokenOverlapScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const tok of ta) if (tb.has(tok)) overlap += 1;
  return overlap / Math.min(ta.size, tb.size);
}

// Tokens that indicate a child-bundle / set / collection. If they appear in
// the matched candidate's title but NOT in the LLM-extracted component title,
// the match is almost certainly wrong (one of codex's systemic findings:
// bundles getting resolved to sibling bundle PDPs instead of the single SKU).
const BUNDLE_CHILD_TOKENS = new Set([
  'set', 'bundle', 'kit', 'trio', 'duo', 'collection', 'pack',
  'box', 'mystery', 'gift', 'edition', 'value',
]);

// Variant-modifier tokens that the matcher used to accept as noise. If they
// appear in the matched title but NOT in the extracted title, the matcher
// is silently swapping in a sample/refill/travel variant for the full SKU.
// Codex's systemic finding #1, expanded for the round-2 review (added
// cleansing/cloth/cloths/pad/pads/disc/discs after the
// "Glow Tonic Cleansing Cloths" miss).
const VARIANT_NOISE_TOKENS = new Set([
  'sample', 'deluxe', 'mini', 'travel', 'refill', 'tester',
  'foam', 'rollerball', 'roller', 'spray', 'wipe', 'wipes',
  'cleansing', 'cloth', 'cloths', 'pad', 'pads', 'disc', 'discs', 'cotton',
  'pen', 'stick', 'powder', 'oil', 'cream', 'gel', 'serum',
  'lotion', 'wash', 'body', 'face', 'hand', 'foot', 'lip', 'eye',
]);
// Keep a "very-distinct" subset that should never silently appear in matched
// titles without explicit consent from the extracted title. The broader
// VARIANT_NOISE_TOKENS above is too aggressive to outright disqualify on
// (many legitimate product titles contain "serum", "cream", etc.), so we
// only treat the highly-disambiguating ones as hard penalties.
const VARIANT_HARD_NOISE = new Set([
  'sample', 'deluxe', 'mini', 'travel', 'refill', 'tester',
  'rollerball', 'roller', 'wipe', 'wipes', 'pen',
  'cloth', 'cloths', 'pad', 'pads', 'disc', 'discs', 'cotton', 'cleansing',
]);

// Extract size tokens like "30ml", "1.0 oz", "50 ml", "100ml" from a string.
// Returns lowercase normalized tokens like "30ml", "1oz", "50ml".
function extractSizeTokens(text) {
  const out = new Set();
  const normalized = asString(text).toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*(ml|oz|fl\s*oz|g|kg|lb|lbs|piece|pieces|pcs)\b/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const num = m[1].replace(/\.0+$/, '');
    const unit = m[2].replace(/\s+/g, '');
    out.add(`${num}${unit}`);
  }
  return out;
}

// Generic-label threshold: extracted component titles this short (in tokens)
// are too ambiguous to match without strong context evidence (parent-title
// overlap, size_label, or component_role). Codex round-2 finding: "Cleanser"
// got 1.0 overlap against any catalog product whose title contained the word.
const GENERIC_LABEL_TOKEN_THRESHOLD = 2;

/**
 * Score a candidate match against the extracted component title.
 *
 * Round 2 of matcher hardening (after codex re-review):
 *   1. Variant-noise: HARD disqualification when noise token appears in
 *      candidate title and is NOT supported by the extracted title, size
 *      label, component role, or parent bundle title.
 *   2. Bundle-child: HARD disqualification when matched title is itself a
 *      bundle/set/duo and the extracted title isn't.
 *   3. Size-aware: bonus on size match, penalty on size mismatch.
 *   4. Parent-context bonus: disambiguates generic labels via parent title.
 *   5. Generic-label guard: very short extracted titles (e.g. "Cleanser")
 *      require either a non-trivial parent-context overlap OR a matching
 *      size, otherwise they are flagged ineligible.
 */
function scoreCandidateMatch(candidate, {
  extractedTitle,
  parentTitle,
  parentHost,
  sizeLabel,
  componentRole,
} = {}) {
  const extractedTokens = new Set(tokenize(extractedTitle));
  const candidateTokens = new Set(tokenize(candidate.title));
  const sizeLabelText = asString(sizeLabel);
  const roleText = asString(componentRole);
  const parentText = asString(parentTitle);
  const sizeTokens = extractSizeTokens(`${extractedTitle} ${sizeLabelText}`);
  const candidateSizeTokens = extractSizeTokens(candidate.title);

  let overlap = 0;
  for (const tok of extractedTokens) if (candidateTokens.has(tok)) overlap += 1;
  // Count "unexplained" candidate tokens (in candidate, not in extracted) and
  // shave a small per-token penalty off the overlap ratio. Codex round-2
  // finding: preserved numeric tokens like "2.0" need to actually shift the
  // score — without this, "EDP" matches "EDP 2.0" at the same 1.0 ratio
  // because overlap/min keeps normalizing by the smaller set.
  let unexplained = 0;
  for (const tok of candidateTokens) if (!extractedTokens.has(tok)) unexplained += 1;
  const rawOverlap =
    extractedTokens.size === 0 || candidateTokens.size === 0
      ? 0
      : overlap / Math.min(extractedTokens.size, candidateTokens.size);
  const baseOverlap = Math.max(0, rawOverlap - 0.05 * unexplained);

  const hostMatch =
    parentHost && normalizeHost(candidate.canonical_url || candidate.destination_url) === parentHost;
  const hostBonus = hostMatch ? 0.3 : 0;

  // A token in the candidate is "context-supported" if it appears in any of
  // the signals the LLM was allowed to surface: extracted title, size label,
  // component role, or the parent bundle title. Round-2 fix: codex flagged
  // that hard-penalizing "travel" on a Travel Size variant blocked the
  // correct match when the extracted title only said "Glow Tonic". We now
  // exempt noise tokens whose support lives in adjacent fields.
  const supportingTokens = new Set([
    ...extractedTokens,
    ...tokenize(sizeLabelText),
    ...tokenize(roleText),
    ...tokenize(parentText),
  ]);

  // Bundle-child disqualification (guard #2). Bundle-shape words are checked
  // ONLY against the extracted title; parent context doesn't excuse them
  // because the parent IS a bundle and we'd be matching a sibling bundle.
  let bundleChildHit = false;
  for (const tok of candidateTokens) {
    if (BUNDLE_CHILD_TOKENS.has(tok) && !extractedTokens.has(tok)) {
      bundleChildHit = true;
      break;
    }
  }

  // Size-aware preference (guard #3) — computed BEFORE noise so the noise
  // check can use the size-match signal to exempt variant words.
  let sizeBonus = 0;
  let sizeMismatchHit = false;
  if (sizeTokens.size > 0) {
    let sizeAlignsWith = false;
    for (const sz of sizeTokens) if (candidateSizeTokens.has(sz)) sizeAlignsWith = true;
    if (sizeAlignsWith) {
      sizeBonus = 0.2;
    } else if (candidateSizeTokens.size > 0) {
      // Candidate names a DIFFERENT size — wrong-format match.
      sizeBonus = -0.25;
      sizeMismatchHit = true;
    }
  }

  // Variant-noise check (guard #1). Now context-aware AND size-aware: a
  // candidate token like "travel" is OK if the extracted title, size_label,
  // component_role, or parent_title also has it; OR if the candidate's size
  // matches the extracted size (a "Travel Size 100ml" with extracted size
  // "100ml" is a legitimate variant match — codex round-2 review #5).
  const FORMAT_VARIANT_NOISE = new Set(['mini', 'travel']);
  let hardNoiseHit = false;
  for (const tok of candidateTokens) {
    if (!VARIANT_HARD_NOISE.has(tok)) continue;
    if (supportingTokens.has(tok)) continue;
    // Format-variant tokens (mini/travel) are exempted when the candidate
    // also names the matching size.
    if (FORMAT_VARIANT_NOISE.has(tok) && sizeBonus > 0) continue;
    hardNoiseHit = true;
    break;
  }

  // Parent-context bonus (guard #4). Codex round-2 blocking finding: brand
  // tokens (e.g. "The Ordinary" on every Ordinary product) would otherwise
  // satisfy the generic-label guard on brand alone. Exclude the candidate's
  // own brand from the parent-context token set so the guard demands a
  // distinguishing word — product family, scent, formulation — to pass.
  const candidateBrandTokens = new Set(tokenize(asString(candidate.brand)));
  const parentTokens = tokenize(parentText)
    .filter((t) =>
      !BUNDLE_CHILD_TOKENS.has(t)
      && t.length >= 3
      && !candidateBrandTokens.has(t),
    );
  let contextOverlap = 0;
  for (const tok of parentTokens) if (candidateTokens.has(tok)) contextOverlap += 1;
  const contextBonus = parentTokens.length > 0
    ? 0.15 * (contextOverlap / parentTokens.length)
    : 0;
  const contextSupportRatio = parentTokens.length > 0
    ? (contextOverlap / parentTokens.length)
    : 0;

  // Generic-label guard (guard #5, new in round 2). Short extracted titles
  // are too ambiguous to match without strong context evidence. Threshold
  // tightens with shorter extracts:
  //   - 1 token (e.g. "Cleanser"): need contextOverlap ≥ 2 AND ≥0.5 ratio,
  //     OR a positive size match. Brand-name overlap alone isn't enough —
  //     the parent title also carries the brand and would otherwise lift
  //     every candidate from that brand.
  //   - 2 tokens (e.g. "Awaken Confidence"): need contextOverlap ≥ 1 AND
  //     ≥0.25 ratio, OR a positive size match.
  let genericLabelHit = false;
  if (extractedTokens.size <= GENERIC_LABEL_TOKEN_THRESHOLD) {
    const hasSizeSupport = sizeBonus > 0;
    const minRatio = extractedTokens.size <= 1 ? 0.5 : 0.25;
    const minOverlap = extractedTokens.size <= 1 ? 2 : 1;
    const hasContextSupport = contextSupportRatio >= minRatio && contextOverlap >= minOverlap;
    if (!hasSizeSupport && !hasContextSupport) {
      genericLabelHit = true;
    }
  }

  // Hard disqualifications (knock score below the 0.5 threshold so
  // pickBestMatch rejects). Round-2 codex requested: noise + size_mismatch
  // combined should be ineligible, not merely slightly lower-scored.
  const rawScore = baseOverlap + hostBonus + sizeBonus + contextBonus;
  let finalScore = rawScore;
  if (bundleChildHit) finalScore -= 1.0;
  if (hardNoiseHit) finalScore -= 1.0; // raised from -0.6; codex wants hard-fail
  if (genericLabelHit) finalScore -= 1.0;
  // Composite hard ineligibility: even a soft-noise candidate that ALSO has
  // a size mismatch is wrong.
  if (sizeMismatchHit && hardNoiseHit) finalScore -= 0.5;

  return {
    _title_overlap: baseOverlap,
    _host_match: hostMatch,
    _size_bonus: sizeBonus,
    _context_bonus: contextBonus,
    _context_support_ratio: contextSupportRatio,
    _bundle_child_hit: bundleChildHit,
    _hard_noise_hit: hardNoiseHit,
    _size_mismatch_hit: sizeMismatchHit,
    _generic_label_hit: genericLabelHit,
    _score: finalScore,
  };
}

const ComponentSchema = z.object({
  title: z.string().min(2).max(200),
  size_label: z.string().max(60).optional().default(''),
  component_role: z.string().max(60).optional().default(''),
});

const ExtractionSchema = z.object({
  components: z.array(ComponentSchema).min(0).max(20),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  reasoning: z.string().max(500).optional().default(''),
});

const EXTRACTION_INSTRUCTIONS = `You analyze a beauty/skincare bundle or gift-set product page and extract the
individual product SKUs that are packed inside the bundle.

Rules:
- Only list distinct named individual products that the description states are inside the bundle.
- Do NOT include the parent bundle itself in the list.
- Do NOT include marketing prose ("perfect for travel", "feels luxurious", etc.).
- If the description does not clearly list named constituents, return an empty components array
  with confidence "low".
- Keep titles as close to how the description writes them as possible. Do not add brand name
  to the title (the bundle and constituents share the brand).
- size_label: include a volume/weight if explicitly stated (e.g. "30ml", "1.0 oz"). Otherwise omit.
- component_role: short tag like "toner", "serum", "moisturizer", "cleanser", "balm" — only if obvious.

Return JSON: { components: [{title, size_label?, component_role?}], confidence: "high|medium|low", reasoning: "<=1 sentence" }.`;

async function callLlmForComponents(provider, { title, brand, description }) {
  const prompt = [
    EXTRACTION_INSTRUCTIONS,
    '',
    `Bundle title: ${title}`,
    brand ? `Brand: ${brand}` : null,
    '',
    'Description:',
    asString(description).slice(0, 3500),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await provider.analyzeTextToJson({ prompt, schema: ExtractionSchema });
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function loadBundleCandidates({ limit, market, ids }) {
  const filters = [
    `status = 'active'`,
    `(
      seed_data->>'product_family' = 'set_or_collection'
      OR seed_data->>'external_seed_product_family' = 'set_or_collection'
      OR seed_data->>'product_kind' = 'bundle'
      OR lower(title) ~ '\\m(set|bundle|kit|trio|duo|collection|pack)\\M'
    )`,
    `jsonb_array_length(COALESCE(seed_data->'bundle_component_refs','[]'::jsonb)) = 0`,
    `jsonb_array_length(COALESCE(seed_data->'snapshot'->'bundle_component_refs','[]'::jsonb)) = 0`,
    `length(COALESCE(seed_data->>'description', seed_data->'snapshot'->>'description', '')) >= 80`,
  ];
  const params = [];
  if (market) {
    params.push(market.toUpperCase());
    filters.push(`upper(market) = $${params.length}`);
  }
  if (ids && ids.length) {
    params.push(ids);
    filters.push(`external_product_id = ANY($${params.length}::text[])`);
  }
  const limitClause = Number.isFinite(limit) && limit > 0 ? `LIMIT ${Math.min(limit, 1000)}` : '';
  const sql = `
    SELECT external_product_id, market, title, canonical_url, destination_url, domain,
           COALESCE(seed_data->>'brand', seed_data->'snapshot'->>'brand') AS brand,
           COALESCE(seed_data->>'description', seed_data->'snapshot'->>'description', '') AS description
    FROM external_product_seeds
    WHERE ${filters.join(' AND ')}
    ORDER BY updated_at DESC NULLS LAST
    ${limitClause}
  `;
  const res = await query(sql, params);
  return res.rows || [];
}

async function searchCandidateMatches({ brand, title, parentTitle, parentHost, sizeLabel, componentRole }) {
  if (!brand && !title) return [];
  const brandNorm = asString(brand).toLowerCase();
  const titleTokens = tokenize(title).slice(0, 6);
  if (titleTokens.length === 0) return [];
  const ilikePattern = `%${titleTokens.slice(0, 4).join('%')}%`;
  const params = [];
  const filters = [`status = 'active'`];
  if (brandNorm) {
    params.push(brandNorm);
    filters.push(
      `lower(COALESCE(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')) = $${params.length}`,
    );
  }
  params.push(ilikePattern);
  filters.push(`lower(title) ILIKE $${params.length}`);
  const res = await query(
    `
      SELECT external_product_id, title, market, canonical_url, destination_url, domain,
             COALESCE(seed_data->>'brand', seed_data->'snapshot'->>'brand') AS brand,
             updated_at
      FROM external_product_seeds
      WHERE ${filters.join(' AND ')}
        AND seed_data->>'product_kind' IS DISTINCT FROM 'bundle'
        AND (seed_data->>'product_family' IS DISTINCT FROM 'set_or_collection'
             AND seed_data->>'external_seed_product_family' IS DISTINCT FROM 'set_or_collection')
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 25
    `,
    params,
  );
  const scored = (res.rows || []).map((row) => ({
    ...row,
    ...scoreCandidateMatch(row, {
      extractedTitle: title,
      parentTitle,
      parentHost,
      sizeLabel,
      componentRole,
    }),
  }));
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

function pickBestMatch(matches, { excludeIds = new Set() } = {}) {
  if (!matches.length) return null;
  // Take the highest-scoring candidate that:
  //   - isn't already used elsewhere in this bundle (dedup against parent +
  //     already-matched siblings prevents the self-loops codex saw),
  //   - clears the 0.5 score threshold (raised from 0.4; the new score is a
  //     compound of overlap + host + size + context with penalties applied).
  for (const m of matches) {
    if (excludeIds.has(m.external_product_id)) continue;
    if (m._score < 0.5) return null; // scored list is descending; nothing better below
    if (m._title_overlap < 0.4) continue; // raw overlap still must be respectable
    return m;
  }
  return null;
}

async function processCandidate({ candidate, provider, options }) {
  const parentHost = normalizeHost(candidate.canonical_url || candidate.destination_url);
  const llmResult = await callLlmForComponents(provider, {
    title: candidate.title,
    brand: candidate.brand,
    description: candidate.description,
  });
  if (!llmResult.ok) {
    return {
      external_product_id: candidate.external_product_id,
      title: candidate.title,
      brand: candidate.brand,
      status: 'llm_failed',
      error: llmResult.error,
    };
  }
  const { components, confidence, reasoning } = llmResult.data;
  if (!components.length) {
    return {
      external_product_id: candidate.external_product_id,
      title: candidate.title,
      brand: candidate.brand,
      status: 'no_components_extracted',
      confidence,
      reasoning,
    };
  }

  const matchedRefs = [];
  const unmatched = [];
  // Dedup set seeded with the parent bundle so a component can never resolve
  // back to its own parent (one of codex's round-2 systemic findings). As we
  // accept matches, their IDs join the set so the next sibling component
  // can't pick the same SKU twice.
  const usedIds = new Set();
  if (candidate.external_product_id) usedIds.add(candidate.external_product_id);
  for (const c of components) {
    const matches = await searchCandidateMatches({
      brand: candidate.brand,
      title: c.title,
      parentTitle: candidate.title,
      parentHost,
      sizeLabel: c.size_label,
      componentRole: c.component_role,
    });
    const best = pickBestMatch(matches, { excludeIds: usedIds });
    if (best) {
      usedIds.add(best.external_product_id);
      matchedRefs.push({
        external_product_id: best.external_product_id,
        title: c.title,
        size_label: c.size_label || undefined,
        component_role: c.component_role || undefined,
        inheritance_scope: ['how_to_use', 'ingredients_inci'],
        source_kind: 'llm_extraction_brand_title_match',
        _extracted_title: c.title,
        _matched_title: best.title,
        _title_overlap: Number(best._title_overlap.toFixed(3)),
        _score: Number(best._score.toFixed(3)),
        _host_match: Boolean(best._host_match),
        _size_bonus: Number(best._size_bonus.toFixed(3)),
        _context_bonus: Number(best._context_bonus.toFixed(3)),
      });
    } else {
      unmatched.push({
        extracted_title: c.title,
        candidates_considered: matches.slice(0, 3).map((m) => ({
          external_product_id: m.external_product_id,
          title: m.title,
          overlap: Number(m._title_overlap.toFixed(3)),
          score: Number(m._score.toFixed(3)),
          bundle_child_hit: m._bundle_child_hit,
          hard_noise_hit: m._hard_noise_hit,
        })),
      });
    }
  }

  return {
    external_product_id: candidate.external_product_id,
    title: candidate.title,
    brand: candidate.brand,
    status: matchedRefs.length === components.length ? 'all_matched' : matchedRefs.length > 0 ? 'partial_match' : 'no_match',
    confidence,
    reasoning,
    extracted_count: components.length,
    matched_count: matchedRefs.length,
    unmatched_count: unmatched.length,
    component_refs: matchedRefs,
    unmatched,
  };
}

function pruneInternalFields(refs) {
  return refs.map((ref) => {
    const out = { ...ref };
    for (const key of Object.keys(out)) {
      if (key.startsWith('_')) delete out[key];
    }
    return out;
  });
}

function buildMappingArtifact(results, { confidenceFloor }) {
  const mappings = [];
  const skipped = [];
  for (const r of results) {
    if (r.status !== 'all_matched') {
      skipped.push({
        external_product_id: r.external_product_id,
        title: r.title,
        status: r.status,
        error: r.error,
        confidence: r.confidence,
        matched_count: r.matched_count,
        unmatched_count: r.unmatched_count,
        unmatched: r.unmatched,
      });
      continue;
    }
    if (r.confidence === 'low' && confidenceFloor !== 'low') {
      skipped.push({
        external_product_id: r.external_product_id,
        title: r.title,
        status: 'confidence_below_floor',
        confidence: r.confidence,
      });
      continue;
    }
    mappings.push({
      external_product_id: r.external_product_id,
      evidence_source: 'llm_extraction_v1',
      evidence_note: `extracted via ${process.env.PIVOTA_BUNDLE_LLM_LABEL || 'llm'}, confidence=${r.confidence}; ${r.reasoning || ''}`.trim(),
      component_refs: pruneInternalFields(r.component_refs),
    });
  }
  return { mappings, skipped };
}

async function main() {
  const limit = Number(argValue('limit', '0')) || 0;
  const market = asString(argValue('market'));
  const idsArg = asString(argValue('external-product-id'));
  const ids = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const out = asString(argValue('out')) || path.resolve(process.cwd(), 'tmp/bundle-component-mapping.json');
  const reportPath = asString(argValue('report')) || path.resolve(process.cwd(), 'tmp/bundle-component-extraction-report.json');
  const confidenceFloor = asString(argValue('confidence-floor', 'medium')).toLowerCase();
  const concurrency = Math.max(1, Number(argValue('concurrency', '4')) || 4);
  const verbose = hasFlag('verbose');

  const provider = createProviderFromEnv('generic');
  if (typeof provider?.analyzeTextToJson !== 'function') {
    throw new Error('LLM provider does not expose analyzeTextToJson');
  }

  const candidates = await loadBundleCandidates({ limit, market, ids });
  process.stderr.write(`Loaded ${candidates.length} bundle candidates.\n`);

  const results = [];
  let processed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const candidate = candidates.shift();
      if (!candidate) return;
      const result = await processCandidate({ candidate, provider });
      results.push(result);
      processed += 1;
      if (verbose || processed % 10 === 0) {
        process.stderr.write(
          `[${processed}] ${candidate.external_product_id} ${candidate.title.slice(0, 50)} → ${result.status} matched=${result.matched_count || 0}/${result.extracted_count || 0}\n`,
        );
      }
    }
  });
  await Promise.all(workers);

  const artifact = buildMappingArtifact(results, { confidenceFloor });
  const summary = {
    generated_at: new Date().toISOString(),
    candidates: results.length,
    all_matched: results.filter((r) => r.status === 'all_matched').length,
    partial_match: results.filter((r) => r.status === 'partial_match').length,
    no_match: results.filter((r) => r.status === 'no_match').length,
    no_components: results.filter((r) => r.status === 'no_components_extracted').length,
    llm_failed: results.filter((r) => r.status === 'llm_failed').length,
    confidence_high: results.filter((r) => r.confidence === 'high').length,
    confidence_medium: results.filter((r) => r.confidence === 'medium').length,
    confidence_low: results.filter((r) => r.confidence === 'low').length,
    mapping_count: artifact.mappings.length,
    skipped_count: artifact.skipped.length,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ mappings: artifact.mappings }, null, 2));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ summary, results, skipped: artifact.skipped }, null, 2),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: err?.message || String(err), stack: err?.stack }, null, 2)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  tokenize,
  tokenOverlapScore,
  extractSizeTokens,
  extractVariantNumberTokens,
  scoreCandidateMatch,
  pickBestMatch,
  BUNDLE_CHILD_TOKENS,
  VARIANT_HARD_NOISE,
};
