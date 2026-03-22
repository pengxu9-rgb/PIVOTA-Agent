#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = process.env.AURORA_AUDIT_BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_LIMIT = 6;
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output', 'live-smoke');
const MATRIX = Object.freeze([
  ['barrier', 'ceramide_np', 'Ceramide NP', 'ceramide moisturizer'],
  ['barrier', 'panthenol', 'Panthenol (B5)', 'panthenol repair serum'],
  ['balancing', 'niacinamide', 'Niacinamide', 'niacinamide serum'],
  ['balancing', 'zinc_pca', 'Zinc PCA', 'zinc pca serum'],
  ['exfoliant', 'salicylic_acid', 'Salicylic acid', 'salicylic acid serum'],
  ['active', 'azelaic_acid', 'Azelaic acid', 'azelaic acid cream'],
  ['antioxidant', 'ascorbic_acid', 'Vitamin C', 'vitamin c serum'],
  ['retinoid', 'retinol', 'Retinol', 'retinol serum'],
  ['acne', 'benzoyl_peroxide', 'Benzoyl peroxide', 'benzoyl peroxide gel'],
  ['sunscreen', 'sunscreen_filters', 'UV filters', 'broad spectrum sunscreen'],
  ['humectant', 'glycerin', 'Glycerin', 'glycerin moisturizer'],
  ['humectant', 'hyaluronic_acid', 'Hyaluronic acid', 'hyaluronic acid serum'],
  ['brightening', 'alpha_arbutin', 'Alpha arbutin', 'alpha arbutin serum'],
  ['oil', 'squalane', 'Squalane', 'squalane oil'],
  ['soothing', 'centella_asiatica', 'Centella asiatica', 'centella serum'],
  ['brightening', 'tranexamic_acid', 'Tranexamic acid', 'tranexamic acid serum'],
  ['exfoliant', 'glycolic_acid', 'Glycolic acid', 'glycolic acid toner'],
  ['exfoliant', 'lactic_acid', 'Lactic acid', 'lactic acid serum'],
  ['exfoliant', 'mandelic_acid', 'Mandelic acid', 'mandelic acid serum'],
  ['peptide', 'peptides', 'Peptides', 'peptide serum'],
]);

function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE_URL, limit: DEFAULT_LIMIT, outPath: '' };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (token === '--base-url') {
      out.baseUrl = String(argv[idx + 1] || '').trim() || DEFAULT_BASE_URL;
      idx += 1;
    } else if (token === '--limit') {
      out.limit = Math.max(1, Math.min(12, Number.parseInt(argv[idx + 1], 10) || DEFAULT_LIMIT));
      idx += 1;
    } else if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    }
  }
  return out;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function buildUrl(baseUrl, query, limit) {
  const url = new URL('/agent/v1/products/search', baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fast_mode', 'true');
  url.searchParams.set('source', 'aurora-bff');
  url.searchParams.set('catalog_surface', 'beauty');
  return url;
}

function summarizeProducts(products, limit = 3) {
  return (Array.isArray(products) ? products : []).slice(0, limit).map((row) => ({
    name: String(row?.name || row?.title || row?.display_name || '').trim() || null,
    brand: String(row?.brand || '').trim() || null,
    retrieval_source: String(row?.retrieval_source || '').trim() || null,
    url: String(
      row?.open_url ||
      row?.openUrl ||
      row?.product_url ||
      row?.productUrl ||
      row?.pdp_url ||
      row?.pdpUrl ||
      row?.url ||
      '',
    ).trim() || null,
  }));
}

function summarizeSamples(samples, limit = 5) {
  return (Array.isArray(samples) ? samples : []).slice(0, limit).map((row) => ({
    title: String(row?.title || '').trim() || null,
    brand: String(row?.brand || '').trim() || null,
    domain: String(row?.domain || '').trim() || null,
    candidate_url: String(row?.candidate_url || '').trim() || null,
    external_seed_id: String(row?.external_seed_id || '').trim() || null,
    attached_product_key: String(row?.attached_product_key || '').trim() || null,
    source_tag: String(row?.source_tag || '').trim() || null,
    source_bucket: String(row?.source_bucket || '').trim() || null,
    reject_reason: String(row?.reject_reason || '').trim() || null,
    candidate_step: String(row?.candidate_step || '').trim() || null,
    family_relation: String(row?.family_relation || '').trim() || null,
    kb_explicit: Math.max(0, Number(row?.kb_explicit || 0)),
    explicit_hits: Math.max(0, Number(row?.explicit_hits || 0)),
    family_only: Math.max(0, Number(row?.family_only || 0)),
    target_anchor_hits: Math.max(0, Number(row?.target_anchor_hits || 0)),
    strong_target_anchor_hits: Math.max(0, Number(row?.strong_target_anchor_hits || 0)),
    surface_explicit_hits: Math.max(0, Number(row?.surface_explicit_hits || 0)),
    kb_step_hint_match: Math.max(0, Number(row?.kb_step_hint_match || 0)),
    same_family_gate_required: Math.max(0, Number(row?.same_family_gate_required || 0)),
    target_step_negative_signal: Math.max(0, Number(row?.target_step_negative_signal || 0)),
  }));
}

function hasExplicitEvidenceBreakdown(row) {
  const breakdown = row && typeof row === 'object' ? row : {};
  return (
    Number(breakdown.kb_explicit || 0) > 0 ||
    Number(breakdown.title_exact || 0) > 0 ||
    Number(breakdown.title_alias || 0) > 0 ||
    Number(breakdown.ingredient_token_exact || 0) > 0 ||
    Number(breakdown.ingredient_token_alias || 0) > 0 ||
    Number(breakdown.url_alias || 0) > 0
  );
}

function hasStageActivity(stageCounts = {}) {
  return Object.values(stageCounts).some((row) =>
    row && typeof row === 'object' &&
    ['fetched', 'admitted', 'rejected', 'final'].some((key) => Number(row[key] || 0) > 0),
  );
}

function classifyRootCause(metadata, products) {
  const directStatus = String(metadata?.ingredient_direct_main_path_status || '').trim();
  const registryMatch = metadata?.ingredient_registry_match === true;
  const breakdown = metadata?.ingredient_candidate_evidence_breakdown || {};
  const hasExplicitEvidence = hasExplicitEvidenceBreakdown(breakdown);
  const familyOnly = Number(breakdown.family_only || 0) > 0 || metadata?.family_fallback_used === true;
  const rejectBreakdown = metadata?.ingredient_candidate_reject_breakdown || {};
  const rejectTotal = Object.values(rejectBreakdown).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  const hasRejects = rejectTotal > 0;
  const stageCounts = metadata?.ingredient_direct_source_stage_counts || {};
  const sourceActive = hasStageActivity(stageCounts);

  if (directStatus === 'direct_hit' && Array.isArray(products) && products.length > 0) return 'direct_hit';
  if (!registryMatch) return 'registry_not_resolved';
  if (hasExplicitEvidence && hasRejects) return 'explicit_supply_present_but_filtered';
  if (hasExplicitEvidence && sourceActive) return 'explicit_supply_present_but_misranked';
  if (familyOnly) return 'only_family_supply_present';
  if (sourceActive && hasRejects) return 'explicit_supply_present_but_filtered';
  return 'no_explicit_supply_in_any_source';
}

function classifyRecommendedAction(bucket) {
  const normalized = String(bucket || '').trim();
  if (normalized === 'direct_hit') return 'none';
  if (normalized === 'explicit_supply_present_but_filtered') return 'code_admission_or_step_surface_fix';
  if (normalized === 'explicit_supply_present_but_misranked') return 'ranking_fix';
  if (normalized === 'only_family_supply_present') return 'upstream_seed_or_kb_supply_remediation';
  if (normalized === 'no_explicit_supply_in_any_source') return 'upstream_seed_or_kb_supply_remediation';
  if (normalized === 'registry_not_resolved') return 'registry_resolution_fix';
  return 'manual_triage';
}

async function fetchAuditRow(baseUrl, limit, [ingredientClass, ingredientId, ingredientName, query]) {
  const response = await fetch(buildUrl(baseUrl, query, limit), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  const metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const products = Array.isArray(body?.products) ? body.products : [];
  return {
    ingredient_class: ingredientClass,
    ingredient_id: ingredientId,
    ingredient_name: ingredientName,
    query,
    query_source: String(metadata.query_source || '').trim() || null,
    x_service_commit: String(response.headers.get('x-service-commit') || '').trim() || null,
    direct_main_path_status: String(metadata.ingredient_direct_main_path_status || '').trim() || null,
    registry_match: metadata.ingredient_registry_match === true,
    registry_source: String(metadata.ingredient_registry_source || '').trim() || null,
    profile_source: String(metadata.ingredient_profile_source || '').trim() || null,
    miss_reason: String(metadata.ingredient_direct_miss_reason || metadata.strict_empty_reason || '').trim() || null,
    root_cause_bucket: classifyRootCause(metadata, products),
    recommended_action: null,
    candidate_evidence_breakdown:
      metadata.ingredient_candidate_evidence_breakdown &&
      typeof metadata.ingredient_candidate_evidence_breakdown === 'object'
        ? metadata.ingredient_candidate_evidence_breakdown
        : {},
    direct_source_stage_counts:
      metadata.ingredient_direct_source_stage_counts &&
      typeof metadata.ingredient_direct_source_stage_counts === 'object'
        ? metadata.ingredient_direct_source_stage_counts
        : {},
    direct_source_reject_breakdown:
      metadata.ingredient_direct_source_reject_breakdown &&
      typeof metadata.ingredient_direct_source_reject_breakdown === 'object'
        ? metadata.ingredient_direct_source_reject_breakdown
        : {},
    source_statuses:
      metadata.ingredient_direct_source_statuses &&
      typeof metadata.ingredient_direct_source_statuses === 'object'
        ? metadata.ingredient_direct_source_statuses
        : {},
    top_products: summarizeProducts(products),
    ranked_samples: summarizeSamples(metadata.ingredient_ranked_candidate_samples, 5),
    rejected_samples: summarizeSamples(metadata.ingredient_rejected_candidate_samples, 5),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const rows = [];
  let serviceCommit = '';
  for (const entry of MATRIX) {
    const row = await fetchAuditRow(baseUrl, args.limit, entry);
    row.recommended_action = classifyRecommendedAction(row.root_cause_bucket);
    if (!serviceCommit && row.x_service_commit) serviceCommit = row.x_service_commit;
    rows.push(row);
  }
  const summary = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    x_service_commit: serviceCommit || null,
    ingredient_count: rows.length,
    bucket_counts: rows.reduce((acc, row) => {
      const key = String(row.root_cause_bucket || 'unknown').trim() || 'unknown';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {}),
    rows,
  };
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(output);
  if (args.outPath) {
    const outPath = path.isAbsolute(args.outPath)
      ? args.outPath
      : path.join(DEFAULT_OUTPUT_ROOT, args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf8');
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
