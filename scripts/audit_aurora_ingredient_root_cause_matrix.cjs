#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = process.env.AURORA_AUDIT_BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_LIMIT = 6;
const DEFAULT_TIMEOUT_MS = Math.max(5_000, Number.parseInt(process.env.AURORA_AUDIT_TIMEOUT_MS, 10) || 25_000);
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
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    limit: DEFAULT_LIMIT,
    outPath: '',
    outMdPath: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    startIndex: 0,
    count: 0,
    shardIndex: 0,
    shardCount: 1,
    resume: false,
  };
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
    } else if (token === '--out-md') {
      out.outMdPath = String(argv[idx + 1] || '').trim();
      idx += 1;
    } else if (token === '--timeout-ms') {
      out.timeoutMs = Math.max(5_000, Number.parseInt(argv[idx + 1], 10) || DEFAULT_TIMEOUT_MS);
      idx += 1;
    } else if (token === '--start-index') {
      out.startIndex = Math.max(0, Number.parseInt(argv[idx + 1], 10) || 0);
      idx += 1;
    } else if (token === '--count') {
      out.count = Math.max(0, Number.parseInt(argv[idx + 1], 10) || 0);
      idx += 1;
    } else if (token === '--shard-index') {
      out.shardIndex = Math.max(0, Number.parseInt(argv[idx + 1], 10) || 0);
      idx += 1;
    } else if (token === '--shard-count') {
      out.shardCount = Math.max(1, Number.parseInt(argv[idx + 1], 10) || 1);
      idx += 1;
    } else if (token === '--resume') {
      out.resume = true;
    }
  }
  if (out.shardIndex >= out.shardCount) out.shardIndex = 0;
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
    ingredient_grounding:
      row?.ingredient_grounding && typeof row.ingredient_grounding === 'object'
        ? {
            admission_verdict: String(row.ingredient_grounding.admission_verdict || '').trim() || null,
            reject_reason: String(row.ingredient_grounding.reject_reason || '').trim() || null,
            target_surface_anchor_hits: Math.max(0, Number(row.ingredient_grounding.target_surface_anchor_hits || 0)),
            competing_surface_hits: Math.max(0, Number(row.ingredient_grounding.competing_surface_hits || 0)),
            source_ingredient_ids: Array.isArray(row.ingredient_grounding.source_ingredient_ids)
              ? row.ingredient_grounding.source_ingredient_ids
                  .map((value) => String(value || '').trim())
                  .filter(Boolean)
                  .slice(0, 8)
              : [],
            evidence_provenance:
              row.ingredient_grounding.evidence_provenance &&
              typeof row.ingredient_grounding.evidence_provenance === 'object'
                ? {
                    runtime_ingredient_evidence_source:
                      String(row.ingredient_grounding.evidence_provenance.runtime_ingredient_evidence_source || '').trim() || null,
                    seed_anchor_source_kind:
                      String(row.ingredient_grounding.evidence_provenance.seed_anchor_source_kind || '').trim() || null,
                    kb_explicit_provenance:
                      String(row.ingredient_grounding.evidence_provenance.kb_explicit_provenance || '').trim() || null,
                  }
                : null,
          }
        : null,
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
  const offSurfaceVisible = (Array.isArray(products) ? products : []).some((row) =>
    String(row?.ingredient_grounding?.reject_reason || '').trim() === 'off_surface_contamination' ||
    String(row?.ingredient_grounding?.admission_verdict || '').trim() === 'rejected',
  );
  const offSurfaceRejected = Number(rejectBreakdown.off_surface_contamination || 0) > 0;
  const stageCounts = metadata?.ingredient_direct_source_stage_counts || {};
  const sourceActive = hasStageActivity(stageCounts);

  if (offSurfaceVisible || offSurfaceRejected) return 'off_surface_contamination';
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
  if (normalized === 'off_surface_contamination') return 'seed_row_and_runtime_admission_cleanup';
  if (normalized === 'explicit_supply_present_but_filtered') return 'code_admission_or_step_surface_fix';
  if (normalized === 'explicit_supply_present_but_misranked') return 'ranking_fix';
  if (normalized === 'only_family_supply_present') return 'upstream_seed_or_kb_supply_remediation';
  if (normalized === 'no_explicit_supply_in_any_source') return 'upstream_seed_or_kb_supply_remediation';
  if (normalized === 'registry_not_resolved') return 'registry_resolution_fix';
  if (normalized === 'audit_error') return 'rerun_or_investigate_route_timeout';
  return 'manual_triage';
}

function resolveOutputPath(targetPath) {
  if (!targetPath) return '';
  if (path.isAbsolute(targetPath)) return targetPath;
  const normalized = targetPath.replace(/\\/g, '/');
  if (
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('output/')
  ) {
    return path.join(process.cwd(), targetPath);
  }
  return path.join(DEFAULT_OUTPUT_ROOT, targetPath);
}

function selectMatrixRows(args) {
  let entries = MATRIX.map((entry, index) => ({ index, entry }));
  if (args.shardCount > 1) {
    entries = entries.filter((row) => row.index % args.shardCount === args.shardIndex);
  }
  if (args.startIndex > 0) entries = entries.slice(args.startIndex);
  if (args.count > 0) entries = entries.slice(0, args.count);
  return entries;
}

function loadExistingRows(outPath) {
  if (!outPath || !fs.existsSync(outPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

function buildSummaryPayload({ args, baseUrl, rows, serviceCommit, completed, selectedEntries }) {
  return {
    generated_at: new Date().toISOString(),
    completed,
    base_url: baseUrl,
    timeout_ms: args.timeoutMs,
    x_service_commit: serviceCommit || null,
    shard_index: args.shardIndex,
    shard_count: args.shardCount,
    start_index: args.startIndex,
    count: args.count || null,
    selected_ingredient_count: selectedEntries.length,
    ingredient_count: rows.length,
    bucket_counts: rows.reduce((acc, row) => {
      const key = String(row.root_cause_bucket || 'unknown').trim() || 'unknown';
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {}),
    rows,
  };
}

function writeSummary(outPath, payload) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildMarkdownSummary(payload) {
  const lines = [
    '# Aurora Ingredient Root Cause Matrix',
    '',
    `- Generated At: ${payload.generated_at || ''}`,
    `- Base URL: ${payload.base_url || ''}`,
    `- X-Service-Commit: ${payload.x_service_commit || 'unknown'}`,
    '',
    '## Bucket Counts',
    '',
  ];
  const bucketCounts = payload.bucket_counts && typeof payload.bucket_counts === 'object'
    ? payload.bucket_counts
    : {};
  for (const [bucket, count] of Object.entries(bucketCounts)) {
    lines.push(`- ${bucket}: ${count}`);
  }
  lines.push('', '## Rows', '');
  for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
    lines.push(`### ${row.ingredient_name || row.ingredient_id || 'unknown'}`);
    lines.push(`- Ingredient ID: ${row.ingredient_id || ''}`);
    lines.push(`- Query: ${row.query || ''}`);
    lines.push(`- Root Cause: ${row.root_cause_bucket || 'unknown'}`);
    lines.push(`- Recommended Action: ${row.recommended_action || 'manual_triage'}`);
    lines.push(`- Direct Main Path Status: ${row.direct_main_path_status || 'n/a'}`);
    lines.push(`- Miss Reason: ${row.miss_reason || 'n/a'}`);
    const topProducts = Array.isArray(row.top_products) ? row.top_products : [];
    if (topProducts.length > 0) {
      lines.push('- Top Products:');
      for (const product of topProducts) {
        const grounding = product?.ingredient_grounding || null;
        const groundingSuffix = grounding
          ? ` [${grounding.admission_verdict || 'unknown'}${grounding.reject_reason ? ` / ${grounding.reject_reason}` : ''}]`
          : '';
        lines.push(`  - ${product.name || 'unknown'}${groundingSuffix}`);
      }
    }
    const rejectedSamples = Array.isArray(row.rejected_samples) ? row.rejected_samples : [];
    if (rejectedSamples.length > 0) {
      lines.push(`- Rejected Samples: ${rejectedSamples.length}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function writeMarkdownSummary(outPath, payload) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildMarkdownSummary(payload), 'utf8');
}

async function fetchAuditRow(baseUrl, limit, timeoutMs, [ingredientClass, ingredientId, ingredientName, query]) {
  let response = null;
  let body = {};
  let metadata = {};
  let products = [];
  let fetchError = null;
  try {
    response = await fetch(buildUrl(baseUrl, query, limit), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json().catch(() => ({}));
    metadata = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    products = Array.isArray(body?.products) ? body.products : [];
  } catch (error) {
    fetchError = error;
  }
  if (fetchError) {
    const message = String(fetchError?.name === 'TimeoutError' ? 'audit_timeout' : fetchError?.message || fetchError).trim();
    return {
      ingredient_class: ingredientClass,
      ingredient_id: ingredientId,
      ingredient_name: ingredientName,
      query,
      query_source: null,
      x_service_commit: null,
      direct_main_path_status: null,
      registry_match: false,
      registry_source: null,
      profile_source: null,
      miss_reason: message || 'audit_error',
      root_cause_bucket: 'audit_error',
      recommended_action: 'rerun_or_investigate_route_timeout',
      candidate_evidence_breakdown: {},
      direct_source_stage_counts: {},
      direct_source_reject_breakdown: {},
      source_statuses: {},
      top_products: [],
      ranked_samples: [],
      rejected_samples: [],
    };
  }
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
  const outPath = resolveOutputPath(args.outPath);
  const outMdPath = resolveOutputPath(
    args.outMdPath || (outPath && outPath.endsWith('.json') ? outPath.replace(/\.json$/i, '.md') : ''),
  );
  const selectedEntries = selectMatrixRows(args);
  const existingRows = args.resume ? loadExistingRows(outPath) : [];
  const existingByIngredientId = new Map(
    existingRows
      .filter((row) => row && typeof row === 'object' && String(row.ingredient_id || '').trim())
      .map((row) => [String(row.ingredient_id || '').trim(), row]),
  );
  const rows = [];
  let serviceCommit = '';
  for (const { entry } of selectedEntries) {
    const ingredientId = String(entry?.[1] || '').trim();
    let row = existingByIngredientId.get(ingredientId);
    if (!row) {
      row = await fetchAuditRow(baseUrl, args.limit, args.timeoutMs, entry);
      row.recommended_action = row.recommended_action || classifyRecommendedAction(row.root_cause_bucket);
    }
    if (!serviceCommit && row.x_service_commit) serviceCommit = row.x_service_commit;
    rows.push(row);
    writeSummary(
      outPath,
      buildSummaryPayload({
        args,
        baseUrl,
        rows,
        serviceCommit,
        completed: rows.length === selectedEntries.length,
        selectedEntries,
      }),
    );
    writeMarkdownSummary(
      outMdPath,
      buildSummaryPayload({
        args,
        baseUrl,
        rows,
        serviceCommit,
        completed: rows.length === selectedEntries.length,
        selectedEntries,
      }),
    );
  }
  const summary = buildSummaryPayload({
    args,
    baseUrl,
    rows,
    serviceCommit,
    completed: true,
    selectedEntries,
  });
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(output);
  writeSummary(outPath, summary);
  writeMarkdownSummary(outMdPath, summary);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
