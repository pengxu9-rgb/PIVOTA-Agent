#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const axios = require('axios');

const { closePool, query } = require('../src/db');
const { classifyExternalSeedProductKind } = require('../src/services/externalSeedProductKind');

const DEFAULT_GATEWAY_URL = 'https://agent.pivota.cc/api/gateway';

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return '';
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function countTextLeaves(value) {
  if (!value) return 0;
  if (typeof value === 'string') return value.trim() ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTextLeaves(item), 0);
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + countTextLeaves(item), 0);
  }
  return 0;
}

function moduleByType(pdp, type) {
  return asArray(pdp?.modules).find((item) => asString(item?.type) === type) || null;
}

function moduleData(pdp, type) {
  return asObject(moduleByType(pdp, type)?.data);
}

function getHeaders() {
  const apiKey = asString(
    process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY,
  );
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Agent-API-Key'] = apiKey;
    headers['X-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchRows({ market, domain, brand, externalProductId, limit, offset }) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [market];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (domain) where.push(`domain = ${bind(domain)}`);
  if (brand) {
    where.push(`lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', title, '')) = lower(${bind(brand)})`);
  }
  if (externalProductId) where.push(`external_product_id = ${bind(externalProductId)}`);

  params.push(limit);
  const limitBind = `$${params.length}`;
  params.push(offset);
  const offsetBind = `$${params.length}`;

  const result = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        domain,
        canonical_url,
        destination_url,
        title,
        price_amount,
        price_currency,
        availability,
        seed_data,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return result.rows || [];
}

function buildPayload(productId, { includeSimilar }) {
  const include = [
    'canonical',
    'product_intel',
    'reviews_preview',
    'variant_selector',
    'offers',
    'product_details',
    'product_facts',
    'active_ingredients',
    'ingredients_inci',
    'how_to_use',
    'product_overview',
    'supplemental_details',
  ];
  if (includeSimilar) include.push('similar');
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: 'external_seed',
        product_id: productId,
      },
      include,
      options: {
        debug: true,
        no_cache: true,
        cache_bypass: true,
        similar_cache_bypass: true,
      },
    },
    metadata: {
      scope: { catalog: 'global', region: 'US', language: 'en-US' },
      entry: 'external_seed_live_pdp_modules_audit',
    },
  };
}

async function invokePdp(productId, options) {
  const response = await axios.post(options.gatewayUrl, buildPayload(productId, options), {
    headers: getHeaders(),
    timeout: options.timeoutMs,
    validateStatus: () => true,
  });
  return {
    http_status: response.status,
    pdp: response.data,
  };
}

function hasUnavailableModule(pdp, type) {
  const missing = asArray(pdp?.missing);
  return missing.some((item) => asString(item?.type || item?.module || item?.id) === type);
}

function analyzeVariant(pdp) {
  const variantData = moduleData(pdp, 'variant_selector');
  const variants = asArray(variantData.variants);
  const optionValues = asArray(variantData.options).flatMap((option) =>
    asArray(option.values).map((value) => asString(value.label || value.value)),
  );
  const labels = uniqueStrings([
    ...variants.map((variant) => variant.display_label || variant.title),
    ...optionValues,
  ]);
  const badLabels = labels.filter((label) => /^(default|default title|single|single option|default option)$/i.test(label));
  const displayableLabels = labels.filter((label) => label && !badLabels.includes(label));
  return {
    module_present: Boolean(moduleByType(pdp, 'variant_selector')),
    variant_count: variants.length,
    label_count: displayableLabels.length,
    labels: displayableLabels.slice(0, 12),
    bad_labels: badLabels,
    ok: Boolean(moduleByType(pdp, 'variant_selector')) && displayableLabels.length > 0 && badLabels.length === 0,
  };
}

function analyzeReviews(pdp) {
  const data = moduleData(pdp, 'reviews_preview');
  const starDistribution = asArray(data.star_distribution || data.rating_distribution);
  const reviewCount = Number(data.review_count || data.exact_item_review_count || data.product_line_review_count || 0) || 0;
  return {
    module_present: Boolean(moduleByType(pdp, 'reviews_preview')),
    rating: Number(data.rating || 0) || null,
    review_count: reviewCount,
    chart_present: starDistribution.length >= 5,
    chart_estimated: Boolean(data.distribution_estimated || starDistribution.some((item) => item?.estimated)),
    preview_count: asArray(data.preview_items).length,
    ok: reviewCount <= 0 || starDistribution.length >= 5,
  };
}

function analyzeInsights(pdp) {
  const data = moduleData(pdp, 'product_intel');
  const core = asObject(data.product_intel_core);
  const qualityState = asString(data.quality_state || core.quality_state);
  const evidenceProfile = asString(data.evidence_profile || core.evidence_profile);
  const provenance = asObject(data.provenance || core.provenance);
  const reviewStatus = asString(provenance.review_status || data.review_status).toLowerCase();
  const reviewDecision = asString(provenance.review_decision || data.review_decision).toLowerCase();
  const reviewer = asString(provenance.reviewer || provenance.reviewer_kind || data.reviewer);
  const reviewTier = asString(provenance.review_tier || data.review_tier);
  const headline = asString(core.what_it_is?.headline || data.what_it_is?.headline);
  const whyCount = asArray(core.why_it_stands_out || data.why_it_stands_out).length;
  const verified = /^(verified|reviewed|published)$/i.test(qualityState);
  const genericHeadline = /^(product insight|beauty product|skin care|skincare product)$/i.test(headline);
  const sellerGroundedReviewed =
    evidenceProfile === 'seller_only' &&
    verified &&
    Boolean(
      reviewer ||
        reviewTier ||
        reviewStatus === 'completed' ||
        ['pass', 'rewrite'].includes(reviewDecision),
    );
  return {
    module_present: Boolean(moduleByType(pdp, 'product_intel')),
    quality_state: qualityState || null,
    evidence_profile: evidenceProfile || null,
    seller_only_evidence: evidenceProfile === 'seller_only' && !sellerGroundedReviewed,
    seller_grounded_reviewed: sellerGroundedReviewed,
    headline: headline || null,
    why_count: whyCount,
    ok: Boolean(moduleByType(pdp, 'product_intel')) && verified && headline && !genericHeadline && whyCount > 0,
  };
}

function analyzeContent(pdp) {
  const ingredients = moduleData(pdp, 'ingredients_inci');
  const activeIngredients = moduleData(pdp, 'active_ingredients');
  const howTo = moduleData(pdp, 'how_to_use');
  const overview = moduleData(pdp, 'product_overview');
  const details = moduleData(pdp, 'product_details');
  const facts = moduleData(pdp, 'product_facts');
  const supplemental = moduleData(pdp, 'supplemental_details');
  const ingredientsSourceQuality = asString(ingredients.source_quality_status);
  const activeSourceQuality = asString(activeIngredients.source_quality_status);
  const ingredientsForceFilled =
    ingredients.force_filled === true ||
    ingredientsSourceQuality === 'force_filled_pending_source' ||
    asString(ingredients.source_origin) === 'pivota_force_fill';
  const activeIngredientsForceFilled =
    activeIngredients.force_filled === true ||
    activeSourceQuality === 'force_filled_pending_source' ||
    asString(activeIngredients.source_origin) === 'pivota_force_fill';
  return {
    ingredients_present: Boolean(moduleByType(pdp, 'ingredients_inci')) && countTextLeaves(ingredients) > 0,
    ingredients_text_count: countTextLeaves(ingredients),
    ingredients_source_origin: asString(ingredients.source_origin) || null,
    ingredients_source_quality_status: ingredientsSourceQuality || null,
    ingredients_force_filled: ingredientsForceFilled,
    active_ingredients_present: Boolean(moduleByType(pdp, 'active_ingredients')) && countTextLeaves(activeIngredients) > 0,
    active_ingredients_source_origin: asString(activeIngredients.source_origin) || null,
    active_ingredients_source_quality_status: activeSourceQuality || null,
    active_ingredients_force_filled: activeIngredientsForceFilled,
    how_to_present: Boolean(moduleByType(pdp, 'how_to_use')) && countTextLeaves(howTo) > 0,
    how_to_text_count: countTextLeaves(howTo),
    overview_present: Boolean(moduleByType(pdp, 'product_overview')) && countTextLeaves(overview) > 0,
    details_present:
      (Boolean(moduleByType(pdp, 'product_details')) && countTextLeaves(details) > 0) ||
      (Boolean(moduleByType(pdp, 'product_facts')) && countTextLeaves(facts) > 0) ||
      (Boolean(moduleByType(pdp, 'supplemental_details')) && countTextLeaves(supplemental) > 0),
    details_text_count: countTextLeaves(details) + countTextLeaves(facts) + countTextLeaves(supplemental),
  };
}

function analyzeGallery(pdp) {
  const canonical = moduleData(pdp, 'canonical');
  const payloadProduct = asObject(canonical.pdp_payload?.product);
  const visibleList = asArray(payloadProduct.image_urls).length > 0
    ? asArray(payloadProduct.image_urls)
    : asArray(payloadProduct.images);
  const allUrls = [...visibleList, asString(payloadProduct.image_url)].filter(Boolean);
  const urls = uniqueStrings(allUrls);
  return {
    image_count: urls.length,
    duplicate_url_count: Math.max(0, allUrls.length - urls.length),
    image_hosts: uniqueStrings(
      urls.map((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return '';
        }
      }),
    ).slice(0, 8),
    ok: urls.length > 0 && Math.max(0, allUrls.length - urls.length) <= 2,
  };
}

function analyzeSimilar(pdp) {
  const data = moduleData(pdp, 'similar');
  const items = asArray(data.items || data.products || data.recommendations);
  return {
    module_present: Boolean(moduleByType(pdp, 'similar')),
    count: items.length,
    status: asString(data.similar_status || data.status) || null,
  };
}

function analyzeProductKind(row, pdp) {
  const canonical = moduleData(pdp, 'canonical');
  const payloadProduct = asObject(canonical.pdp_payload?.product);
  const familyFromPayload = asString(
    payloadProduct.external_seed_product_family ||
      payloadProduct.product_family ||
      payloadProduct.external_seed_product_kind?.family,
  );
  const classified = classifyExternalSeedProductKind({
    ...row,
    title: asString(payloadProduct.title || row.title),
    category: asString(payloadProduct.category || row.category),
    product_type: asString(payloadProduct.product_type || row.product_type),
    canonical_url: asString(payloadProduct.canonical_url || row.canonical_url),
    destination_url: asString(payloadProduct.destination_url || row.destination_url),
    seed_data: row.seed_data,
  });
  const family = familyFromPayload || classified.family || 'unknown_product';
  const pdpSchemaProfile = asString(
    payloadProduct.pdp_schema_profile || canonical.pdp_payload?.pdp_schema_profile,
  );
  const formulaContentRequired = family === 'single_formula' || (
    pdpSchemaProfile === 'beauty_formula' &&
    !['accessory', 'non_merch', 'set_or_collection', 'unknown_product'].includes(family)
  );
  return {
    family,
    reasons: classified.reasons || [],
    pdp_schema_profile: pdpSchemaProfile || null,
    formula_content_required: formulaContentRequired,
  };
}

function buildRowAudit(row, probe) {
  const pdp = probe.pdp || {};
  const seedData = asObject(row.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const variant = analyzeVariant(pdp);
  const reviews = analyzeReviews(pdp);
  const insights = analyzeInsights(pdp);
  const content = analyzeContent(pdp);
  const gallery = analyzeGallery(pdp);
  const similar = analyzeSimilar(pdp);
  const productKind = analyzeProductKind(row, pdp);
  const requiresVariantClarity =
    productKind.formula_content_required ||
    variant.bad_labels.length > 0 ||
    variant.variant_count > 1;

  const blockingReasons = [];
  if (!gallery.ok) blockingReasons.push('gallery_missing_or_bloated');
  if (requiresVariantClarity && !variant.ok) blockingReasons.push('missing_variant_clarity');
  if (!insights.ok) blockingReasons.push('missing_or_weak_insights');
  if (insights.seller_only_evidence) blockingReasons.push('seller_only_insights');
  if (!reviews.ok) blockingReasons.push('missing_reviews_chart');
  if (productKind.formula_content_required && !content.ingredients_present) blockingReasons.push('missing_ingredients');
  if (productKind.formula_content_required && content.ingredients_force_filled) blockingReasons.push('force_filled_ingredients');
  if (content.active_ingredients_force_filled) blockingReasons.push('force_filled_active_ingredients');
  if (!content.how_to_present) blockingReasons.push('missing_how_to');
  if (!content.overview_present) blockingReasons.push('missing_overview');
  if (!content.details_present) blockingReasons.push('missing_details');
  if (hasUnavailableModule(pdp, 'product_intel')) blockingReasons.push('product_intel_unavailable');

  const coreReady =
    gallery.ok &&
    variant.ok &&
    insights.ok &&
    !insights.seller_only_evidence &&
    reviews.ok &&
    (!productKind.formula_content_required || content.ingredients_present) &&
    (!productKind.formula_content_required || !content.ingredients_force_filled) &&
    !content.active_ingredients_force_filled &&
    content.how_to_present &&
    content.overview_present;

  return {
    external_product_id: row.external_product_id,
    seed_id: row.id,
    market: row.market,
    domain: row.domain,
    title: asString(snapshot.title || seedData.title || row.title),
    canonical_url: asString(row.canonical_url || snapshot.canonical_url || seedData.canonical_url),
    http_status: probe.http_status,
    pdp_status: asString(pdp.status),
    build_id: asString(pdp.build_id),
    module_types: asArray(pdp.modules).map((item) => asString(item.type)).filter(Boolean),
    missing_modules: asArray(pdp.missing).map((item) => asString(item.type || item.module || item.id)).filter(Boolean),
    gallery,
    variant,
    reviews,
    insights,
    content,
    similar,
    product_kind: productKind,
    blocking_reasons: uniqueStrings(blockingReasons),
    pdp_quality_bucket: coreReady ? 'ready' : blockingReasons.length <= 2 ? 'thin' : 'not_conversion_ready',
    conversion_ready: coreReady,
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(rows) {
  const countBy = (items, getter) => {
    const counts = {};
    for (const item of items) {
      const values = [].concat(getter(item)).filter(Boolean);
      for (const value of values) counts[value] = (counts[value] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([key, count]) => ({ key, count }));
  };
  return {
    scanned: rows.length,
    ready: rows.filter((row) => row.pdp_quality_bucket === 'ready').length,
    thin: rows.filter((row) => row.pdp_quality_bucket === 'thin').length,
    not_conversion_ready: rows.filter((row) => row.pdp_quality_bucket === 'not_conversion_ready').length,
    by_domain: countBy(rows, (row) => row.domain),
    blocker_counts: countBy(rows, (row) => row.blocking_reasons),
    weak_insights_ids: rows
      .filter((row) => row.blocking_reasons.includes('missing_or_weak_insights'))
      .map((row) => row.external_product_id),
    seller_only_insights_ids: rows
      .filter((row) => row.blocking_reasons.includes('seller_only_insights'))
      .map((row) => row.external_product_id),
    force_filled_ids: rows
      .filter((row) =>
        row.blocking_reasons.some((reason) =>
          ['force_filled_ingredients', 'force_filled_active_ingredients'].includes(reason),
        ),
      )
      .map((row) => row.external_product_id),
    content_gap_ids: rows
      .filter((row) =>
        row.blocking_reasons.some((reason) =>
          ['missing_ingredients', 'missing_how_to', 'missing_overview', 'missing_details', 'missing_variant_clarity'].includes(reason),
        ),
      )
      .map((row) => row.external_product_id),
  };
}

async function main() {
  const market = asString(argValue('market') || 'US').toUpperCase();
  const rows = await fetchRows({
    market,
    domain: asString(argValue('domain')),
    brand: asString(argValue('brand')),
    externalProductId: asString(argValue('external-product-id')),
    limit: parsePositiveInt(argValue('limit'), 50, 1, 500),
    offset: Math.max(0, Number(argValue('offset') || 0) || 0),
  });
  const options = {
    gatewayUrl: asString(argValue('gateway-url') || argValue('gateway')) || DEFAULT_GATEWAY_URL,
    timeoutMs: parsePositiveInt(argValue('timeout-ms'), 25000, 1000, 120000),
    includeSimilar: !hasArg('skip-similar'),
  };
  const concurrency = parsePositiveInt(argValue('concurrency'), 4, 1, 12);
  const audits = await runWithConcurrency(rows, concurrency, async (row) => {
    try {
      const probe = await invokePdp(row.external_product_id, options);
      return buildRowAudit(row, probe);
    } catch (error) {
      return {
        external_product_id: row.external_product_id,
        seed_id: row.id,
        market: row.market,
        domain: row.domain,
        title: asString(asObject(row.seed_data).snapshot?.title || asObject(row.seed_data).title || row.title),
        canonical_url: asString(row.canonical_url),
        probe_error: asString(error?.message || error),
        blocking_reasons: ['live_pdp_probe_failed'],
        pdp_quality_bucket: 'not_conversion_ready',
        conversion_ready: false,
      };
    }
  });
  const report = {
    generated_at: new Date().toISOString(),
    source: 'external_seed_live_pdp_modules_audit',
    query: {
      market,
      domain: asString(argValue('domain')) || null,
      brand: asString(argValue('brand')) || null,
      external_product_id: asString(argValue('external-product-id')) || null,
      limit: parsePositiveInt(argValue('limit'), 50, 1, 500),
      offset: Math.max(0, Number(argValue('offset') || 0) || 0),
      include_similar: options.includeSimilar,
    },
    summary: summarize(audits),
    rows: audits,
  };

  const out = asString(argValue('out'));
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
    });
}

module.exports = {
  analyzeContent,
  analyzeGallery,
  analyzeInsights,
  analyzeReviews,
  analyzeVariant,
  buildRowAudit,
  summarize,
};
