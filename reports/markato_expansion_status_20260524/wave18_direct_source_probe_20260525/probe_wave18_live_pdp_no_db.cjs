#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const GATEWAY_URL = process.env.PIVOTA_GATEWAY_URL || 'https://agent.pivota.cc/api/gateway';
const TIMEOUT_MS = Number(process.env.PIVOTA_PROBE_TIMEOUT_MS || 90000);

const PRODUCT_IDS = [
  'ext_3916e5e378df1e75041a1b68',
  'ext_3508560cf76c6d564d97f6d0',
  'ext_6cb55d2964fca74dbcade8e7',
  'ext_d8737399fc72ef06c147bd0c',
  'ext_443039d2322b0af440c1ce9a',
  'ext_ac6c6e795d7f3efe5cc22f7c',
];

const INCLUDE = [
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
  'similar',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function moduleByType(pdp, type) {
  return asArray(pdp?.modules).find((item) => asString(item?.type) === type) || null;
}

function moduleData(pdp, type) {
  return asObject(moduleByType(pdp, type)?.data);
}

function walkStrings(value, out = []) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) out.push(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkStrings(item, out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => walkStrings(item, out));
  }
  return out;
}

function buildPayload(productId) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        merchant_id: 'external_seed',
        product_id: productId,
      },
      include: INCLUDE,
      options: {
        debug: true,
        no_cache: true,
        cache_bypass: true,
        similar_cache_bypass: true,
      },
    },
    metadata: {
      scope: { catalog: 'global', region: 'US', language: 'en-US' },
      entry: 'wave18_abyssian_live_pdp_no_db_probe',
    },
  };
}

function buildSimilarPayload(productId) {
  return {
    operation: 'find_similar_products',
    payload: {
      similar: {
        merchant_id: 'external_seed',
        product_id: productId,
        limit: 6,
      },
      options: {
        debug: true,
        no_cache: true,
        cache_bypass: true,
        similar_cache_bypass: true,
      },
    },
    metadata: {
      scope: { catalog: 'global', region: 'US', language: 'en-US' },
      entry: 'wave18_abyssian_similar_no_db_probe',
    },
  };
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw_text: text };
    }
    return { http_status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function analyze(productId, probe, similarProbe) {
  const pdp = asObject(probe.data);
  const canonical = moduleData(pdp, 'canonical');
  const canonicalPayload = asObject(canonical.pdp_payload);
  const product = asObject(canonicalPayload.product);
  const mediaItems = asArray(moduleData(canonicalPayload, 'media_gallery').items);
  const variants = asArray(moduleData(pdp, 'variant_selector').variants);
  const offerData = moduleData(pdp, 'offers');
  const offers = asArray(offerData.offers);
  const ingredients = moduleData(pdp, 'ingredients_inci');
  const howTo = moduleData(pdp, 'how_to_use');
  const overview = moduleData(pdp, 'product_overview');
  const details = moduleData(pdp, 'product_details');
  const intel = moduleData(pdp, 'product_intel');
  const similar = moduleData(pdp, 'similar');
  const moduleTypes = asArray(pdp.modules).map((item) => asString(item.type)).filter(Boolean);
  const visibleText = [
    ...walkStrings(overview),
    ...walkStrings(details),
    ...walkStrings(intel.shopping_card),
    ...walkStrings(intel.search_card),
  ].join('\n');
  const pollutionTerms = [
    /\bofficial[_ -]?pdp[_ -]?seed\b/i,
    /\bowner[_ -]?delegated\b/i,
    /\bcodex[_ -]?quality/i,
    /\binternal\b/i,
    /\bsource[_ -]?coverage\b/i,
    /\bprovenance\b/i,
  ];
  const publicTextPollution = pollutionTerms
    .filter((pattern) => pattern.test(visibleText))
    .map((pattern) => String(pattern));
  const directSimilar = asObject(similarProbe?.data);
  const directSimilarItems = asArray(directSimilar.products || directSimilar.items);
  const requiredFailures = [];
  const warnings = [];
  if (probe.http_status !== 200) requiredFailures.push('http_not_200');
  if (pdp.status !== 'success') requiredFailures.push('pdp_status_not_success');
  if (!canonicalPayload.product) requiredFailures.push('missing_canonical_product');
  if (!product.title) requiredFailures.push('missing_title');
  if (mediaItems.length < 1) requiredFailures.push('missing_media_gallery');
  if (variants.length < 1) requiredFailures.push('missing_variants');
  if (offers.length < 1) requiredFailures.push('missing_offers');
  if (asArray(ingredients.items).length < 8) requiredFailures.push('missing_or_short_inci');
  if (!asString(howTo.raw_text) || asString(howTo.raw_text).length < 40) requiredFailures.push('missing_or_short_how_to');
  if (asArray(overview.sections).length < 1) requiredFailures.push('missing_overview');
  if (asArray(details.sections).length < 1) requiredFailures.push('missing_details');
  if (asObject(intel.product_intel_core).quality_state !== 'reviewed') requiredFailures.push('product_intel_not_reviewed');
  if (publicTextPollution.length > 0) requiredFailures.push('public_text_pollution');
  if (similarProbe?.error) warnings.push('direct_similar_probe_exception');
  if (!similarProbe?.error && similarProbe?.http_status !== 200) warnings.push('direct_similar_http_not_200');
  if (!similarProbe?.error && directSimilar.status !== 'success') warnings.push('direct_similar_status_not_success');
  if (directSimilarItems.length < 1) warnings.push('direct_similar_underfill');

  return {
    external_product_id: productId,
    http_status: probe.http_status,
    pdp_status: asString(pdp.status),
    request_id: asString(pdp.request_id),
    build_id: asString(pdp.build_id),
    title: asString(product.title),
    canonical_subject_id: asString(pdp.subject?.id),
    product_group_id: asString(product.product_group_id || canonical.product_group_id),
    price: product.price || null,
    variants: variants.map((variant) => ({
      variant_id: asString(variant.variant_id),
      title: asString(variant.title || variant.display_label),
      price: variant.price || null,
      image_url: asString(variant.image_url || variant.label_image_url),
    })),
    module_types: moduleTypes,
    module_counts: {
      media_gallery_items: mediaItems.length,
      variants: variants.length,
      offers: offers.length,
      ingredients_inci: asArray(ingredients.items).length,
      how_to_steps: asArray(howTo.steps).length,
      overview_sections: asArray(overview.sections).length,
      detail_sections: asArray(details.sections).length,
    },
    product_intel: {
      quality_state: asString(asObject(intel.product_intel_core).quality_state || intel.quality_state),
      evidence_profile: asString(asObject(intel.product_intel_core).evidence_profile || intel.evidence_profile),
      shopping_card_title: asString(intel.shopping_card?.title),
      shopping_card_highlight: asString(intel.shopping_card?.highlight),
      search_card_highlight: asString(intel.search_card?.highlight_candidate),
    },
    similar: {
      status: asString(similar.status),
      reason_code: asString(similar.reason_code),
      item_count: asArray(similar.items).length,
      metadata: asObject(similar.metadata),
    },
    direct_similar: {
      http_status: similarProbe?.http_status || null,
      status: asString(directSimilar.status),
      strategy: asString(directSimilar.strategy),
      similar_status: asString(directSimilar.metadata?.similar_status),
      item_count: directSimilarItems.length,
      underfill: directSimilar.metadata?.underfill ?? null,
      retrieval_mix: asObject(directSimilar.metadata?.retrieval_mix),
      error: similarProbe?.error || null,
    },
    missing: asArray(pdp.missing).map((item) => ({
      type: asString(item.type || item.module || item.id),
      reason: asString(item.reason),
    })),
    module_health: asObject(pdp.metadata?.module_health),
    public_text_pollution: publicTextPollution,
    status: requiredFailures.length === 0 ? 'ready' : 'failed',
    warning_reasons: warnings,
    failure_reasons: requiredFailures,
  };
}

async function main() {
  const out = process.argv[2] || path.join(__dirname, 'live_pdp_direct_gateway_probe.json');
  const results = [];
  for (const productId of PRODUCT_IDS) {
    process.stderr.write(`probing ${productId}\n`);
    try {
      const probe = await postJson(GATEWAY_URL, buildPayload(productId));
      let similarProbe = null;
      try {
        similarProbe = await postJson(GATEWAY_URL, buildSimilarPayload(productId));
      } catch (error) {
        similarProbe = {
          error: { message: asString(error?.message || error), name: asString(error?.name) },
        };
      }
      results.push(analyze(productId, probe, similarProbe));
    } catch (error) {
      results.push({
        external_product_id: productId,
        status: 'failed',
        failure_reasons: ['probe_exception'],
        error: { message: asString(error?.message || error), name: asString(error?.name) },
      });
    }
  }
  const summary = {
    generated_at: new Date().toISOString(),
    gateway_url: GATEWAY_URL,
    scanned: results.length,
    ready: results.filter((item) => item.status === 'ready').length,
    failed: results.filter((item) => item.status !== 'ready').length,
    failure_reason_counts: results.reduce((acc, item) => {
      asArray(item.failure_reasons).forEach((reason) => {
        acc[reason] = (acc[reason] || 0) + 1;
      });
      return acc;
    }, {}),
    warning_reason_counts: results.reduce((acc, item) => {
      asArray(item.warning_reasons).forEach((reason) => {
        acc[reason] = (acc[reason] || 0) + 1;
      });
      return acc;
    }, {}),
    similar_status_counts: results.reduce((acc, item) => {
      const key = item.similar?.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    direct_similar_status_counts: results.reduce((acc, item) => {
      const key = item.direct_similar?.similar_status || item.direct_similar?.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  const payload = { summary, results };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.failed > 0) process.exitCode = 1;
}

main();
