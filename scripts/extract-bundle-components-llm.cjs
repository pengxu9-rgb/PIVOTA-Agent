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

function tokenize(text) {
  return asString(text)
    .toLowerCase()
    .replace(/[^a-z0-9% +]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function tokenOverlapScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const tok of ta) if (tb.has(tok)) overlap += 1;
  return overlap / Math.min(ta.size, tb.size);
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
      OR lower(title) ~ '\\\\b(set|bundle|kit|trio|duo|collection|pack)\\\\b'
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

async function searchCandidateMatches({ brand, title, parentHost }) {
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
  const scored = (res.rows || []).map((row) => {
    const titleOverlap = tokenOverlapScore(title, row.title);
    const hostMatch = parentHost && normalizeHost(row.canonical_url || row.destination_url) === parentHost ? 1 : 0;
    return {
      ...row,
      _title_overlap: titleOverlap,
      _host_match: hostMatch,
      _score: titleOverlap + hostMatch * 0.3,
    };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

function pickBestMatch(matches) {
  if (!matches.length) return null;
  const best = matches[0];
  if (best._title_overlap < 0.4) return null;
  return best;
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
  for (const c of components) {
    const matches = await searchCandidateMatches({
      brand: candidate.brand,
      title: c.title,
      parentHost,
    });
    const best = pickBestMatch(matches);
    if (best) {
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
        _host_match: Boolean(best._host_match),
      });
    } else {
      unmatched.push({
        extracted_title: c.title,
        candidates_considered: matches.slice(0, 3).map((m) => ({
          external_product_id: m.external_product_id,
          title: m.title,
          overlap: Number(m._title_overlap.toFixed(3)),
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
