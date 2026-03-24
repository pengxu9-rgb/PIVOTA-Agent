#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { processRow } = require('./backfill-external-product-seeds-catalog');

const LOCALE_PATH_SEGMENT_RE = /^[a-z]{2}(?:-|_)[a-z]{2}$/i;
const NON_PRODUCT_PATH_RE =
  /(?:^|\/)(?:collections?|collection|category|catalogsearch|search|cart|account|customer|blog|blogs|pages?|faq|privacy|terms|wishlist|gift(?:ing)?|store-locator|customer-service|all-products|appointments?|booking|online-booking|locations?|contact-us)(?:\/|$)/i;
const MARKET_LOCALE_SEGMENT = {
  US: 'en-us',
  'EU-DE': 'de-de',
  SG: 'en-sg',
  JP: 'ja-jp',
};

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return normalizeNonEmptyString(value);
}

function normalizeUrlLike(value) {
  const next = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(next) ? next : '';
}

function normalizeReasonKey(value) {
  return normalizeNonEmptyString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function getLocaleSegment(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[0] && LOCALE_PATH_SEGMENT_RE.test(segments[0]) ? segments[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

function looksLikeNonProductUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;

  try {
    const parsed = new URL(normalized);
    const pathName = parsed.pathname.toLowerCase();
    return NON_PRODUCT_PATH_RE.test(pathName);
  } catch {
    return false;
  }
}

function looksLikeCatalogFeedUrl(value) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.pathname.toLowerCase().endsWith('.js');
  } catch {
    return normalized.toLowerCase().endsWith('.js');
  }
}

function hasAcceptableLocale(value, market) {
  const normalized = normalizeUrlLike(value);
  if (!normalized) return true;
  const actualLocale = getLocaleSegment(normalized);
  if (!actualLocale) return true;
  const expectedLocale = normalizeNonEmptyString(MARKET_LOCALE_SEGMENT[normalizeText(market).toUpperCase()]).toLowerCase();
  if (!expectedLocale) return true;
  return actualLocale === expectedLocale;
}

function resolveSeedDataValue(seedData, key) {
  const nextSeedData = ensureObject(seedData);
  const snapshot = ensureObject(nextSeedData.snapshot);
  return normalizeText(nextSeedData[key] || snapshot[key]);
}

function resolveDetailsCount(seedData) {
  const nextSeedData = ensureObject(seedData);
  const snapshot = ensureObject(nextSeedData.snapshot);
  const sections = Array.isArray(nextSeedData.pdp_details_sections)
    ? nextSeedData.pdp_details_sections
    : Array.isArray(snapshot.pdp_details_sections)
    ? snapshot.pdp_details_sections
    : [];
  return sections.length;
}

function fieldState(row) {
  const seedData = ensureObject(row?.seed_data);
  const ingredientsRaw = resolveSeedDataValue(seedData, 'pdp_ingredients_raw');
  const activeIngredientsRaw = resolveSeedDataValue(seedData, 'pdp_active_ingredients_raw');
  const descriptionRaw = resolveSeedDataValue(seedData, 'pdp_description_raw');
  const howToUseRaw = resolveSeedDataValue(seedData, 'pdp_how_to_use_raw');
  const rawIngredientTextClean = resolveSeedDataValue(seedData, 'raw_ingredient_text_clean');
  const detailsCount = resolveDetailsCount(seedData);

  return {
    seed_id: normalizeText(row?.id),
    title: normalizeText(row?.title),
    canonical_url: normalizeText(row?.canonical_url || row?.destination_url),
    seed_description_origin: resolveSeedDataValue(seedData, 'seed_description_origin') || null,
    pdp_description_raw_present: Boolean(descriptionRaw),
    pdp_ingredients_raw_present: Boolean(ingredientsRaw),
    pdp_active_ingredients_raw_present: Boolean(activeIngredientsRaw),
    pdp_how_to_use_raw_present: Boolean(howToUseRaw),
    pdp_details_sections_count: detailsCount,
    raw_ingredient_text_clean_present: Boolean(rawIngredientTextClean),
    core_complete: Boolean(descriptionRaw) && Boolean(ingredientsRaw || activeIngredientsRaw) && detailsCount > 0,
    extended_complete:
      Boolean(descriptionRaw) &&
      Boolean(ingredientsRaw || activeIngredientsRaw) &&
      Boolean(howToUseRaw) &&
      detailsCount > 0,
  };
}

async function fetchRowsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
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
    [ids],
  );
  const byId = new Map((res.rows || []).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = next++;
      if (current >= list.length) break;
      results[current] = await fn(list[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeStatusCounts(items) {
  return {
    dry_run: items.filter((item) => item.status === 'dry_run').length,
    updated: items.filter((item) => item.status === 'updated').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };
}

function buildGuardDecision(result, market) {
  if (!result || result.status !== 'dry_run') {
    return {
      allow_apply: false,
      reasons: ['not_dry_run_candidate'],
    };
  }

  const reasons = [];
  const nextState = result.next_state || null;
  const targetUrl = normalizeUrlLike(result.target_url);
  const canonicalUrl = normalizeUrlLike(nextState?.canonical_url);

  if (!nextState) reasons.push('missing_next_state');
  if (looksLikeCatalogFeedUrl(targetUrl)) reasons.push('target_catalog_feed');
  if (looksLikeNonProductUrl(targetUrl)) reasons.push('target_non_product');
  if (!hasAcceptableLocale(targetUrl, market)) reasons.push('target_market_locale_mismatch');

  if (canonicalUrl) {
    if (looksLikeCatalogFeedUrl(canonicalUrl)) reasons.push('canonical_catalog_feed');
    if (looksLikeNonProductUrl(canonicalUrl)) reasons.push('canonical_non_product');
    if (!hasAcceptableLocale(canonicalUrl, market)) reasons.push('canonical_market_locale_mismatch');
  }

  const keyFieldGain =
    Boolean(nextState?.pdp_ingredients_raw_present) ||
    Boolean(nextState?.pdp_active_ingredients_raw_present) ||
    Boolean(nextState?.pdp_how_to_use_raw_present) ||
    Boolean(nextState?.raw_ingredient_text_clean_present) ||
    Number(nextState?.pdp_details_sections_count || 0) > 0;
  if (!keyFieldGain) reasons.push('insufficient_key_field_gain');

  return {
    allow_apply: reasons.length === 0,
    reasons,
  };
}

function summarizeGuardDecisions(items) {
  const summary = {
    apply_allowed: 0,
    apply_blocked: 0,
    blocked_by_reason: {},
  };

  for (const item of items) {
    const guard = item.guard || { allow_apply: false, reasons: ['missing_guard'] };
    if (guard.allow_apply) {
      summary.apply_allowed += 1;
      continue;
    }
    summary.apply_blocked += 1;
    for (const reason of Array.isArray(guard.reasons) ? guard.reasons : []) {
      const key = normalizeReasonKey(reason) || 'unknown';
      summary.blocked_by_reason[key] = (summary.blocked_by_reason[key] || 0) + 1;
    }
  }

  return summary;
}

function summarizeFinalDb(items) {
  return {
    pdp_description_raw_present: items.filter((item) => item.pdp_description_raw_present).length,
    ingredient_or_active_present: items.filter(
      (item) => item.pdp_ingredients_raw_present || item.pdp_active_ingredients_raw_present,
    ).length,
    pdp_how_to_use_raw_present: items.filter((item) => item.pdp_how_to_use_raw_present).length,
    pdp_details_sections_present: items.filter((item) => item.pdp_details_sections_count > 0).length,
    raw_ingredient_text_clean_present: items.filter((item) => item.raw_ingredient_text_clean_present).length,
    core_complete: items.filter((item) => item.core_complete).length,
    extended_complete: items.filter((item) => item.extended_complete).length,
  };
}

async function main() {
  const seedListPath = normalizeText(argValue('seed-list'));
  const outPath = normalizeText(argValue('out'));
  if (!seedListPath || !outPath) {
    throw new Error('Usage: node scripts/run_external_seed_completeness_tranche.cjs --seed-list <json> --out <json> [--concurrency 2] [--base-url <url>]');
  }

  const seedList = JSON.parse(fs.readFileSync(seedListPath, 'utf8'));
  const seedIds = (Array.isArray(seedList.rows) ? seedList.rows : []).map((row) => normalizeText(row?.id)).filter(Boolean);
  if (!seedIds.length) throw new Error(`No seed ids found in ${seedListPath}`);

  const options = {
    baseUrl:
      normalizeText(argValue('base-url')) ||
      process.env.CATALOG_INTELLIGENCE_BASE_URL ||
      'https://pivota-catalog-intelligence-production.up.railway.app',
    concurrency: Math.max(1, Math.min(Number(argValue('concurrency') || 2), 5)),
    market: normalizeText(argValue('market') || 'US').toUpperCase(),
  };

  const preRows = await fetchRowsByIds(seedIds);
  const precheck = preRows.map(fieldState);

  const dryRunResults = await mapWithConcurrency(preRows, options.concurrency, async (row) => {
    const result = await processRow(row, { ...options, dryRun: true, limit: 1, offset: 0 });
    const guard = buildGuardDecision(
      {
        seed_id: row.id,
        status: result.status,
        target_url: result.targetUrl || null,
        next_state: result.payload?.nextRow
          ? fieldState({ ...row, ...result.payload.nextRow, seed_data: result.payload.nextRow.seed_data })
          : null,
      },
      options.market,
    );
    return {
      seed_id: row.id,
      status: result.status,
      reason: result.reason || null,
      target_url: result.targetUrl || null,
      next_state: result.payload?.nextRow
        ? fieldState({ ...row, ...result.payload.nextRow, seed_data: result.payload.nextRow.seed_data })
        : null,
      guard,
    };
  });

  const applyRows = preRows.filter((row) => {
    const candidate = dryRunResults.find((item) => item.seed_id === row.id);
    return candidate?.status === 'dry_run' && candidate?.guard?.allow_apply;
  });
  const applyResults = await mapWithConcurrency(applyRows, options.concurrency, async (row) => {
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
  const finalDb = finalRows.map(fieldState);

  const payload = {
    generated_at: new Date().toISOString(),
    tranche: normalizeText(seedList.tranche || path.basename(seedListPath, path.extname(seedListPath))),
    seed_ids: seedIds,
    summary: {
      selected: seedIds.length,
      dry_run: summarizeStatusCounts(dryRunResults),
      guard: summarizeGuardDecisions(dryRunResults.filter((item) => item.status === 'dry_run')),
      apply: summarizeStatusCounts(applyResults),
      postcheck: summarizeStatusCounts(postcheckResults),
      final_db: summarizeFinalDb(finalDb),
    },
    precheck,
    dry_run_results: dryRunResults,
    apply_results: applyResults,
    postcheck_results: postcheckResults,
    final_db: finalDb,
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
  buildGuardDecision,
  fieldState,
  hasAcceptableLocale,
  looksLikeCatalogFeedUrl,
  looksLikeNonProductUrl,
  summarizeStatusCounts,
  summarizeGuardDecisions,
  summarizeFinalDb,
};
