#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { processRow } = require('./backfill-external-product-seeds-catalog');
const {
  buildGuardDecision,
  fieldState,
  summarizeStatusCounts,
  summarizeGuardDecisions,
  summarizeFinalDb,
} = require('./run_external_seed_completeness_tranche.cjs');

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

const BUNDLE_LIKE_TITLE_RE =
  /\b(?:bundle|duo|trio|set|kit|collection|party of \d+|pair|vault|routine|regimen)\b/i;
const MARKETING_PARTIAL_TITLE_RE =
  /\b(?:giftset|gift set|ritual|glow[- ]up|glow up|like a goddess|the iconics|pink fever|infinite glow)\b/i;

const CROSS_BRAND_RULES = Object.freeze([
  { name: 'mufe', match: /\b(?:mufe|make up for ever)\b/i, domains: ['makeupforever.com', 'mufe.com'] },
  { name: 'fenty', match: /\bfenty(?: beauty)?\b/i, domains: ['fentybeauty.com'] },
  { name: 'tom_ford', match: /\btom\s*ford\b/i, domains: ['tomfordbeauty.com'] },
  { name: 'pixi', match: /\bpixi(?: beauty)?\b/i, domains: ['pixibeauty.com'] },
  { name: 'rare_beauty', match: /\brare beauty\b/i, domains: ['rarebeauty.com'] },
  { name: 'the_ordinary', match: /\bthe ordinary\b/i, domains: ['theordinary.com'] },
  { name: 'nuxe', match: /\bnuxe\b/i, domains: ['nuxe.com'] },
  { name: 'jurlique', match: /\bjurlique\b/i, domains: ['jurlique.com'] },
  { name: 'kylie', match: /\bkylie(?: cosmetics)?\b/i, domains: ['kyliecosmetics.com'] },
  { name: 'sigma', match: /\bsigma(?: beauty)?\b/i, domains: ['sigmabeauty.com'] },
  { name: 'guerlain', match: /\bguerlain\b/i, domains: ['guerlain.com'] },
  { name: 'dermalogica', match: /\bdermalogica\b/i, domains: ['dermalogica.com'] },
  { name: 'ole_henriksen', match: /\bole henriksen\b/i, domains: ['olehenriksen.com'] },
  { name: 'patyka', match: /\bpatyka\b/i, domains: ['patyka.com'] },
  { name: 'skintific', match: /\bskintific\b/i, domains: ['skintific.com'] },
  { name: 'biologique_recherche', match: /\bbiologique recherche\b/i, domains: ['biologique-recherche.com'] },
  { name: 'embryolisse', match: /\bembryolisse\b/i, domains: ['embryolisse.com'] },
]);

function looksLikeBundleLikeProduct(value) {
  return BUNDLE_LIKE_TITLE_RE.test(normalizeNonEmptyString(value));
}

function looksLikeMarketingPartialTitle(value) {
  return MARKETING_PARTIAL_TITLE_RE.test(normalizeNonEmptyString(value));
}

function normalizeHostname(value) {
  const next = normalizeNonEmptyString(value).toLowerCase();
  if (!next) return '';
  const host = next.replace(/^https?:\/\//, '').split('/')[0];
  return host.replace(/^www\./, '');
}

function deriveCurrentHost(title, targetUrl, nextState) {
  return normalizeHostname(nextState?.canonical_url || targetUrl);
}

function detectCrossBrandTitleAnomaly(title, targetUrl, nextState) {
  const normalizedTitle = normalizeNonEmptyString(title);
  if (!normalizedTitle) return null;

  const currentHost = deriveCurrentHost(title, targetUrl, nextState);
  if (!currentHost) return null;

  for (const rule of CROSS_BRAND_RULES) {
    if (!rule.match.test(normalizedTitle)) continue;
    const allowed = rule.domains.some((domain) => currentHost === domain || currentHost.endsWith(`.${domain}`));
    if (allowed) return null;
    return {
      foreign_brand: rule.name,
      current_host: currentHost,
    };
  }

  return null;
}

function summarizeMissingFields(state) {
  if (!state) return ['pdp_description_raw', 'ingredients_or_active', 'pdp_how_to_use_raw', 'pdp_details_sections', 'raw_ingredient_text_clean'];

  const missing = [];
  if (!state.pdp_description_raw_present) missing.push('pdp_description_raw');
  if (!state.pdp_ingredients_raw_present && !state.pdp_active_ingredients_raw_present) missing.push('ingredients_or_active');
  if (!state.pdp_how_to_use_raw_present) missing.push('pdp_how_to_use_raw');
  if (Number(state.pdp_details_sections_count || 0) <= 0) missing.push('pdp_details_sections');
  if (!state.raw_ingredient_text_clean_present) missing.push('raw_ingredient_text_clean');
  return missing;
}

function summarizeCompletenessDelta(beforeState, afterState) {
  const beforeMissing = summarizeMissingFields(beforeState);
  const afterMissing = summarizeMissingFields(afterState);
  const beforeSet = new Set(beforeMissing);
  const afterSet = new Set(afterMissing);

  const improvedFields = beforeMissing.filter((field) => !afterSet.has(field));
  const regressedFields = afterMissing.filter((field) => !beforeSet.has(field));

  return {
    missing_before: beforeMissing,
    missing_after: afterMissing,
    improved_fields: improvedFields,
    regressed_fields: regressedFields,
    improved: improvedFields.length > 0,
    regressed: regressedFields.length > 0,
  };
}

function hasSubstantiveCompletenessImprovement(delta) {
  const improvements = Array.isArray(delta?.improved_fields) ? delta.improved_fields : [];
  return improvements.some((field) =>
    ['pdp_description_raw', 'ingredients_or_active', 'pdp_how_to_use_raw', 'raw_ingredient_text_clean'].includes(field),
  );
}

function buildBatchCandidateDecision({ status, target_url, title, before_state, next_state }, market, options = {}) {
  const baseDecision = buildGuardDecision({ status, target_url, next_state }, market);
  const delta = summarizeCompletenessDelta(before_state, next_state);
  const reasons = Array.isArray(baseDecision.reasons) ? [...baseDecision.reasons] : [];
  const allowBundles = Boolean(options.allowBundles);
  const crossBrandAnomaly = detectCrossBrandTitleAnomaly(title, target_url, next_state);

  if (!delta.improved) reasons.push('no_missing_field_improvement');
  if (delta.improved && !hasSubstantiveCompletenessImprovement(delta)) reasons.push('details_only_improvement');
  if (delta.regressed) reasons.push('regressed_existing_field');
  if (!allowBundles && (looksLikeBundleLikeProduct(title) || looksLikeBundleLikeProduct(target_url))) {
    reasons.push('bundle_like_product');
  }
  if (looksLikeMarketingPartialTitle(title)) reasons.push('marketing_partial_title');
  if (crossBrandAnomaly) reasons.push('cross_brand_title_anomaly');

  return {
    allow_apply: reasons.length === 0,
    reasons,
    base_guard: baseDecision,
    cross_brand_anomaly: crossBrandAnomaly,
    delta,
  };
}

function chunkList(items, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchIncompleteRows({ domain, market, limit, offset }) {
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
      WHERE status = 'active'
        AND market = $1
        AND domain = $2
        AND (
          coalesce(seed_data->>'pdp_description_raw', seed_data#>>'{snapshot,pdp_description_raw}', '') = ''
          OR (
            coalesce(seed_data->>'pdp_ingredients_raw', seed_data#>>'{snapshot,pdp_ingredients_raw}', '') = ''
            AND coalesce(seed_data->>'pdp_active_ingredients_raw', seed_data#>>'{snapshot,pdp_active_ingredients_raw}', '') = ''
          )
          OR coalesce(seed_data->>'pdp_how_to_use_raw', seed_data#>>'{snapshot,pdp_how_to_use_raw}', '') = ''
          OR coalesce(seed_data->>'raw_ingredient_text_clean', seed_data#>>'{snapshot,raw_ingredient_text_clean}', '') = ''
          OR coalesce(
            jsonb_array_length(
              CASE
                WHEN jsonb_typeof(seed_data->'pdp_details_sections') = 'array' THEN seed_data->'pdp_details_sections'
                WHEN jsonb_typeof(seed_data#>'{snapshot,pdp_details_sections}') = 'array' THEN seed_data#>'{snapshot,pdp_details_sections}'
                ELSE '[]'::jsonb
              END
            ),
            0
          ) = 0
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $3
      OFFSET $4
    `,
    [market, domain, limit, offset],
  );
  return res.rows || [];
}

async function fetchRowsByIds(seedIds) {
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
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
  const byId = new Map((res.rows || []).map((row) => [row.id, row]));
  return seedIds.map((seedId) => byId.get(seedId)).filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= list.length) break;
      results[current] = await fn(list[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeBatchRuns(batchRuns) {
  return {
    batches_total: batchRuns.length,
    selected: batchRuns.reduce((sum, batch) => sum + (batch.seed_ids?.length || 0), 0),
    apply: summarizeStatusCounts(batchRuns.flatMap((batch) => batch.apply_results || [])),
    postcheck: summarizeStatusCounts(batchRuns.flatMap((batch) => batch.postcheck_results || [])),
    final_db: summarizeFinalDb(batchRuns.flatMap((batch) => batch.final_db || [])),
  };
}

async function runBatch({ seedIds, options }) {
  const rows = await fetchRowsByIds(seedIds);
  const applyResults = await mapWithConcurrency(rows, options.concurrency, async (row) => {
    const result = await processRow(row, { ...options, dryRun: false, limit: 1, offset: 0 });
    return {
      seed_id: row.id,
      status: result.status,
      reason: result.reason || null,
      target_url: result.targetUrl || null,
    };
  });

  const postRows = await fetchRowsByIds(seedIds);
  const postcheckResults = await mapWithConcurrency(postRows, options.concurrency, async (row) => {
    const result = await processRow(row, { ...options, dryRun: true, limit: 1, offset: 0 });
    return {
      seed_id: row.id,
      status: result.status,
      reason: result.reason || null,
      target_url: result.targetUrl || null,
      next_state: result.payload?.nextRow
        ? fieldState({ ...row, ...result.payload.nextRow, seed_data: result.payload.nextRow.seed_data })
        : null,
    };
  });

  const finalRows = await fetchRowsByIds(seedIds);
  return {
    seed_ids: seedIds,
    apply_results: applyResults,
    postcheck_results: postcheckResults,
    final_db: finalRows.map(fieldState),
  };
}

async function main() {
  const domain = normalizeNonEmptyString(argValue('domain'));
  const outPath = normalizeNonEmptyString(argValue('out'));
  if (!domain || !outPath) {
    throw new Error(
      'Usage: node scripts/run_external_seed_completeness_batches.cjs --domain <domain> --out <json> [--market US] [--limit 100] [--offset 0] [--batch-size 10] [--max-batches 3] [--concurrency 2] [--apply]',
    );
  }

  const options = {
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    limit: Math.max(1, Math.min(Number(argValue('limit') || 100), 500)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    batchSize: Math.max(1, Math.min(Number(argValue('batch-size') || 10), 100)),
    maxBatches: Math.max(1, Math.min(Number(argValue('max-batches') || 5), 50)),
    concurrency: Math.max(1, Math.min(Number(argValue('concurrency') || 2), 5)),
    allowBundles: hasFlag('allow-bundles'),
    baseUrl:
      normalizeNonEmptyString(argValue('base-url')) ||
      process.env.CATALOG_INTELLIGENCE_BASE_URL ||
      'https://pivota-catalog-intelligence-production.up.railway.app',
    apply: hasFlag('apply'),
  };

  const rows = await fetchIncompleteRows({
    domain,
    market: options.market,
    limit: options.limit,
    offset: options.offset,
  });
  const precheck = rows.map(fieldState);

  const dryRunResults = await mapWithConcurrency(rows, options.concurrency, async (row) => {
    const beforeState = fieldState(row);
    const result = await processRow(row, { ...options, dryRun: true });
    const nextState = result.payload?.nextRow
      ? fieldState({ ...row, ...result.payload.nextRow, seed_data: result.payload.nextRow.seed_data })
      : null;
    return {
      seed_id: row.id,
      title: normalizeNonEmptyString(row.title),
      canonical_url: normalizeNonEmptyString(row.canonical_url || row.destination_url),
      status: result.status,
      reason: result.reason || null,
      target_url: result.targetUrl || null,
      before_state: beforeState,
      next_state: nextState,
      guard: buildBatchCandidateDecision(
        {
          status: result.status,
          target_url: result.targetUrl || null,
          title: row.title,
          before_state: beforeState,
          next_state: nextState,
        },
        options.market,
        options,
      ),
    };
  });

  const allowedCandidates = dryRunResults.filter((item) => item.status === 'dry_run' && item.guard?.allow_apply);
  const batches = chunkList(allowedCandidates, options.batchSize).slice(0, options.maxBatches);
  const batchRuns = [];

  if (options.apply) {
    for (const batch of batches) {
      batchRuns.push(await runBatch({ seedIds: batch.map((item) => item.seed_id), options }));
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    domain,
    market: options.market,
    options: {
      limit: options.limit,
      offset: options.offset,
      batch_size: options.batchSize,
      max_batches: options.maxBatches,
      concurrency: options.concurrency,
      allow_bundles: options.allowBundles,
      base_url: options.baseUrl,
      apply: options.apply,
    },
    summary: {
      precheck_total: precheck.length,
      dry_run: summarizeStatusCounts(dryRunResults),
      guard: summarizeGuardDecisions(dryRunResults.filter((item) => item.status === 'dry_run')),
      batch_plan: {
        candidate_count: allowedCandidates.length,
        batches_total: batches.length,
        selected: batches.reduce((sum, batch) => sum + batch.length, 0),
      },
      batch_runs: options.apply ? summarizeBatchRuns(batchRuns) : null,
    },
    precheck,
    dry_run_results: dryRunResults,
    candidates: allowedCandidates,
    batch_seed_lists: batches.map((batch, index) => ({
      batch_index: index + 1,
      seed_ids: batch.map((item) => item.seed_id),
    })),
    batch_runs: options.apply ? batchRuns : [],
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildBatchCandidateDecision,
  chunkList,
  detectCrossBrandTitleAnomaly,
  hasSubstantiveCompletenessImprovement,
  looksLikeBundleLikeProduct,
  looksLikeMarketingPartialTitle,
  normalizeHostname,
  summarizeCompletenessDelta,
  summarizeMissingFields,
};
