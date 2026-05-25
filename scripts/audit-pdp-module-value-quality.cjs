#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const { normalizePdpImageUrls } = require('../src/utils/pdpImageUrls');

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

function compact(values) {
  return values.map(asString).filter(Boolean);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = asString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function parsePositiveInt(value, fallback, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0 && allowZero) return 0;
  if (parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function inc(map, key, amount = 1) {
  const normalized = asString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 50) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function firstObject(...values) {
  for (const value of values) {
    const obj = asObject(value);
    if (Object.keys(obj).length > 0) return obj;
  }
  return {};
}

function collectImageUrls(...sources) {
  const out = [];
  for (const source of sources) {
    const obj = asObject(source);
    out.push(...compact(asArray(obj.image_urls)));
    out.push(...compact(asArray(obj.images)));
    if (asString(obj.image_url)) out.push(asString(obj.image_url));
    for (const variant of asArray(obj.variants)) {
      out.push(...compact(asArray(variant.image_urls)));
      if (asString(variant.image_url)) out.push(asString(variant.image_url));
    }
  }
  const normalized = normalizePdpImageUrls(out);
  return normalized.length ? normalized : unique(out);
}

function collectVariants(...sources) {
  const out = [];
  for (const source of sources) {
    const obj = asObject(source);
    out.push(...asArray(obj.variants));
    const snapshot = asObject(obj.snapshot);
    out.push(...asArray(snapshot.variants));
  }
  return out.filter((item) => item && typeof item === 'object');
}

function variantLabels(variant) {
  const labels = [];
  const obj = asObject(variant);
  for (const key of ['display_label', 'displayLabel', 'label', 'title', 'name', 'option_value', 'optionValue']) {
    if (asString(obj[key])) labels.push(asString(obj[key]));
  }
  const options = asArray(obj.options);
  for (const option of options) {
    const name = asString(option?.name || option?.option_name || option?.label);
    const value = asString(option?.value || option?.option_value || option?.label);
    if (name && value) labels.push(`${name}: ${value}`);
    else if (value) labels.push(value);
  }
  return unique(labels);
}

function skuValues(variants, row) {
  const out = [
    row.source_product_id,
    row.external_product_id,
    row.product_key,
    row.pivota_signature_id,
  ];
  for (const variant of variants) {
    const obj = asObject(variant);
    out.push(obj.sku, obj.sku_id, obj.variant_id, obj.id);
  }
  return unique(out).map((item) => item.toLowerCase());
}

function normalizeCompact(value) {
  return asString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isDefaultVariantLabel(label) {
  return /^(?:default|default title|single|single item|title|variant|option|n\/a)$/i.test(asString(label));
}

function isSkuLikeSizeLabel(label, skuTokens) {
  const text = asString(label);
  if (!text) return false;
  if (/(?:denomination|amount|value)\s*:|\$\s*\d/i.test(text)) return false;
  const value = text.includes(':') ? text.split(':').pop().trim() : text;
  const compactValue = normalizeCompact(value);
  if (/^\d{5,}(?:cm|mm|ml|g|oz|floz)?$/i.test(compactValue)) return true;
  if (/^\d{5,}[a-z]{1,5}$/i.test(compactValue)) return true;
  for (const sku of skuTokens) {
    const compactSku = normalizeCompact(sku);
    if (compactSku && compactSku.length >= 5 && compactValue === compactSku) return true;
    if (compactSku && compactSku.length >= 5 && compactValue === `${compactSku}cm`) return true;
  }
  return false;
}

function isWeakUnderspecifiedSize(label, row) {
  const text = asString(label);
  const category = asString(row.category_path || row.product_type || '').toLowerCase();
  if (!/(beauty|skincare|makeup|fragrance|hair)/.test(category)) return false;
  if (!/^(?:standard|mini|full size|travel size)$/i.test(text)) return false;
  return true;
}

function extractUltaSkuIds(urls) {
  return unique(
    urls.flatMap((url) => {
      const matches = [...asString(url).matchAll(/\/(?:i|images?)\/ulta\/(\d{5,})/gi)];
      return matches.map((match) => match[1]);
    }),
  );
}

function textIncludesAny(value, patterns) {
  const text = asString(value);
  return patterns.some((pattern) => pattern.test(text));
}

function collectIngredientTexts(seedData, snapshot, payload) {
  const ingredientIntel = asObject(firstObject(seedData.ingredient_intel, snapshot.ingredient_intel, payload.ingredient_intel));
  return unique(
    compact([
      seedData.inci_list,
      snapshot.inci_list,
      payload.inci_list,
      ingredientIntel.inci_raw,
      ingredientIntel.inci_list,
      ingredientIntel.raw_ingredient_text_clean,
      seedData.ingredients_raw,
      snapshot.ingredients_raw,
      payload.ingredients_raw,
      seedData.pdp_ingredients_raw,
      snapshot.pdp_ingredients_raw,
      payload.pdp_ingredients_raw,
    ]),
  );
}

function collectHowToTexts(seedData, snapshot, payload) {
  return unique(
    compact([
      seedData.how_to_use_raw,
      snapshot.how_to_use_raw,
      payload.how_to_use_raw,
      seedData.pdp_how_to_use_raw,
      snapshot.pdp_how_to_use_raw,
      payload.pdp_how_to_use_raw,
      seedData.how_to_use,
      snapshot.how_to_use,
      payload.how_to_use,
    ]),
  );
}

function collectDetailSections(seedData, snapshot, payload) {
  return [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(payload.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
    ...asArray(payload.details_sections),
  ].filter((item) => item && typeof item === 'object');
}

function findIntel(row) {
  const intel = asObject(row.intel_analysis);
  const sourceMeta = asObject(row.intel_source_meta);
  const productIntel = asObject(intel.product_intel_v1);
  const provenance = asObject(productIntel.provenance);
  const searchCard = asObject(productIntel.search_card);
  const shoppingCard = asObject(productIntel.shopping_card);
  return {
    kb_key: asString(row.intel_kb_key),
    source: asString(row.intel_source),
    quality_state: asString(
      productIntel.quality_state ||
        intel.quality_state ||
        intel.review_state ||
        sourceMeta.quality_state ||
        sourceMeta.review_state ||
        provenance.review_status,
    ),
    evidence_profile: asString(
      searchCard.evidence_profile ||
        intel.evidence_profile ||
        sourceMeta.evidence_profile ||
        sourceMeta.reanalysis_audit?.evidence_profile_after ||
        provenance.external_highlight_review_status,
    ),
    review_status: asString(
      sourceMeta.review_status ||
        sourceMeta.review_decision ||
        provenance.review_status ||
        provenance.review_decision ||
        provenance.external_highlight_review_status,
    ),
    review_tier: asString(sourceMeta.review_tier || provenance.review_tier),
    headline: asString(intel.headline || intel.summary?.headline || intel.card?.headline || shoppingCard.title || searchCard.title_candidate),
    analysis: intel,
  };
}

function analyzeRow(row) {
  const payload = asObject(row.product_payload);
  const seedData = firstObject(row.seed_data, payload.seed_data);
  const snapshot = asObject(seedData.snapshot);
  const variants = collectVariants(seedData, snapshot, payload);
  const labels = unique([
    ...variants.flatMap(variantLabels),
    seedData.variant_detail_label,
    snapshot.variant_detail_label,
    payload.variant_detail_label,
    seedData.size_detail_label,
    snapshot.size_detail_label,
    payload.size_detail_label,
    seedData.volume,
    snapshot.volume,
    payload.volume,
    seedData.variant_title,
    snapshot.variant_title,
    payload.variant_title,
  ]);
  const skuTokens = skuValues(variants, row);
  const images = collectImageUrls(seedData, snapshot, payload);
  const ingredients = collectIngredientTexts(seedData, snapshot, payload);
  const howToTexts = collectHowToTexts(seedData, snapshot, payload);
  const detailSections = collectDetailSections(seedData, snapshot, payload);
  const intel = findIntel(row);

  const issues = [];
  const add = (module, reason_code, severity, evidence, recommended_action = '') => {
    issues.push({
      module,
      reason_code,
      severity,
      evidence,
      recommended_action,
    });
  };

  const badVariantLabels = labels.filter((label) => isDefaultVariantLabel(label));
  if (badVariantLabels.length) {
    add('variant', 'variant_default_or_placeholder_label', 'high', badVariantLabels.slice(0, 5), 'replace with source-backed size/shade/count label or hide selector only after showing single-SKU spec');
  }
  const skuLikeLabels = labels.filter((label) => isSkuLikeSizeLabel(label, skuTokens));
  if (skuLikeLabels.length) {
    add('variant', 'variant_size_value_looks_like_sku_or_asset_suffix', 'critical', skuLikeLabels.slice(0, 8), 're-extract source variant axes; do not surface SKU/image filename suffix as shopper size');
  }
  const weakSizeLabels = labels.filter((label) => isWeakUnderspecifiedSize(label, row));
  if (weakSizeLabels.length) {
    add('variant', 'variant_size_label_missing_actual_amount', 'medium', weakSizeLabels.slice(0, 5), 'fill actual net content/size from official or verified retailer source');
  }
  if (variants.length === 0 && /beauty|skincare|makeup|fragrance|hair/i.test(asString(row.category_path))) {
    add('variant', 'variant_missing_for_beauty_pdp', 'high', [], 'derive single-SKU size/count label or true variant axes from source');
  }

  const ultaSkuIds = extractUltaSkuIds(images);
  const productSkuHints = skuTokens.filter((token) => /^\d{5,}$/.test(token));
  const extraUltaIds = ultaSkuIds.filter((id) => !productSkuHints.includes(id));
  if (images.length === 0) {
    add('gallery', 'gallery_missing', 'critical', [], 'recover source-backed image or quarantine row until image is available');
  }
  if (images.length > 16) {
    add('gallery', 'gallery_excessive_image_count', 'medium', { count: images.length }, 'trim gallery to product-specific images only');
  }
  const relatedCardUrls = images.filter((url) => /\$ProductCard|ProductCardNeutral|recommend|related|also[_-]?like/i.test(url));
  if (relatedCardUrls.length) {
    add('gallery', 'gallery_related_product_card_leak', 'critical', relatedCardUrls.slice(0, 8), 'quarantine PLP/recommendation/card assets; keep PDP product assets only');
  }
  if (extraUltaIds.length >= 3) {
    add('gallery', 'gallery_cross_product_sku_ids', 'critical', extraUltaIds.slice(0, 12), 'filter retailer recommendation/product-card images by source SKU or product PDP image set');
  }

  if (!ingredients.length) {
    add('ingredients', 'ingredients_missing_source_backed_inci', 'high', [], 'fill from official INCI or verified retailer ingredient panel');
  } else {
    const badIngredientTexts = ingredients.filter((text) =>
      textIncludesAny(text, [
        /^clean ingredients$/i,
        /^ingredients and safety$/i,
        /^key ingredients$/i,
        /^ask a question$/i,
        /clean ingredients,\s*[a-z]/i,
      ]),
    );
    if (badIngredientTexts.length) {
      add('ingredients', 'ingredients_marketing_label_or_heading_not_inci', 'critical', badIngredientTexts.slice(0, 8), 'replace with actual INCI list; move marketing badges/headings to quarantine');
    }
  }

  const badHowTo = howToTexts.filter((text) =>
    textIncludesAny(text, [
      /^how to use$/i,
      /^directions$/i,
      /^use according to (?:the )?merchant directions/i,
      /patch test first if you have sensitivity/i,
      /^refer to (?:the )?(?:brand|merchant)/i,
    ]),
  );
  if (badHowTo.length) {
    add('how_to_use', 'how_to_placeholder_or_generic', 'high', badHowTo.slice(0, 8), 'replace with source-backed use directions or mark module unavailable');
  }
  const formulaRequired = /serum|moisturizer|cleanser|sunscreen|spf|treatment|cream|toner|essence|mask|foundation|lip|fragrance/i.test(
    `${row.category_path || ''} ${row.product_type || ''} ${row.title || ''}`,
  );
  if (!howToTexts.length && formulaRequired) {
    add('how_to_use', 'how_to_missing_for_formula', 'medium', [], 'fill source-backed directions where source exposes them');
  }

  const noisySections = detailSections.filter((section) => {
    const heading = asString(section.heading || section.title);
    const body = asString(section.body || section.text || section.content);
    return /^faq$/i.test(heading) && /^ask a question$/i.test(body);
  });
  if (noisySections.length) {
    add('questions', 'faq_cta_noise_in_details', 'high', noisySections.slice(0, 5), 'drop CTA-only FAQ artifacts from PDP and Q&A modules');
  }
  const headingOnlySections = detailSections.filter((section) => {
    const body = asString(section.body || section.text || section.content);
    return /^(?:how to use|clean ingredients|ask a question)$/i.test(body);
  });
  if (headingOnlySections.length) {
    add('details', 'details_heading_or_badge_as_body', 'high', headingOnlySections.slice(0, 8), 'quarantine headings/badges that were captured as section body');
  }

  const priceAmount = Number(payload.price_amount ?? seedData.price_amount ?? row.seed_price_amount);
  const currency = asString(payload.price_currency || seedData.price_currency || row.seed_price_currency);
  const market = asString(row.market || payload.market_id || 'US');
  if (Number.isFinite(priceAmount) && priceAmount <= 0) {
    add('offer', 'offer_non_positive_price', 'critical', { price_amount: priceAmount }, 'refresh commerce facts from source');
  }
  if (market === 'US' && currency && currency !== 'USD') {
    add('offer', 'offer_currency_mismatch_for_us_market', 'critical', { market, currency }, 'refresh regional commerce facts and default offer');
  }

  if (!intel.kb_key) {
    add('insights', 'insights_missing_reviewed_bundle', 'high', [], 'generate/review/publish Pivota Insights from source-backed facts');
  } else if (!/(reviewed|published|community_supported|seller_grounded|eligible|completed|pass|human|assistant_reviewed|strict_human|seller_plus_formula)/i.test(`${intel.quality_state} ${intel.evidence_profile} ${intel.review_status} ${intel.review_tier} ${intel.source}`)) {
    add('insights', 'insights_review_state_unclear_or_weak', 'medium', {
      kb_key: intel.kb_key,
      source: intel.source,
      quality_state: intel.quality_state,
      evidence_profile: intel.evidence_profile,
      review_status: intel.review_status,
      review_tier: intel.review_tier,
    }, 'manual-review existing intel bundle before considering it conversion-ready');
  }

  if (Number(row.review_count || 0) === 0 && Number(row.review_possible_key_count || 0) > 0) {
    add('reviews', 'reviews_key_mapping_ambiguous_or_unresolved', 'medium', {
      review_possible_key_count: Number(row.review_possible_key_count || 0),
    }, 'resolve review key/group mapping before concluding no reviews exist');
  }

  const criticalCount = issues.filter((issue) => issue.severity === 'critical').length;
  const highCount = issues.filter((issue) => issue.severity === 'high').length;
  const bucket = criticalCount > 0 ? 'blocked_value_defect' : highCount > 0 ? 'needs_value_repair' : issues.length > 0 ? 'review' : 'pass';

  return {
    product_key: row.product_key,
    pivota_signature_id: asString(row.pivota_signature_id),
    external_product_id: asString(row.external_product_id || row.source_product_id),
    title: asString(row.title),
    brand: asString(row.brand),
    domain: asString(row.domain),
    market: asString(row.market),
    category_path: asString(row.category_path),
    canonical_url: asString(row.canonical_url || row.destination_url),
    bucket,
    issue_count: issues.length,
    module_status: {
      variant_label_count: labels.length,
      variant_labels_sample: labels.slice(0, 12),
      variant_count: variants.length,
      image_count: images.length,
      image_hosts_sample: unique(images.map((url) => {
        try {
          return new URL(url).hostname;
        } catch (_err) {
          return '';
        }
      })).slice(0, 8),
      ingredient_texts_sample: ingredients.slice(0, 5),
      how_to_texts_sample: howToTexts.slice(0, 5),
      detail_section_count: detailSections.length,
      intel_kb_key: intel.kb_key,
      review_count: Number(row.review_count || 0),
      qna_count: Number(row.qna_count || 0),
    },
    issues,
  };
}

function buildWhere(options, params) {
  const where = [
    `cp.pivota_signature_id IS NOT NULL`,
    `cp.merchant_id = 'external_seed'`,
    `cp.platform = 'external_seed'`,
  ];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (options.sig) where.push(`cp.pivota_signature_id = ${bind(options.sig)}`);
  if (options.externalProductId) where.push(`cp.source_product_id = ${bind(options.externalProductId)}`);
  if (options.brand) where.push(`lower(coalesce(cp.brand, eps.seed_data->>'brand', eps.seed_data->'snapshot'->>'brand', '')) = lower(${bind(options.brand)})`);
  if (options.domain) where.push(`eps.domain = ${bind(options.domain)}`);
  if (options.market) where.push(`coalesce(eps.market, 'US') = ${bind(options.market)}`);
  if (!options.includeInactive) {
    where.push(`coalesce(eps.status, 'active') = 'active'`);
    where.push(`coalesce(cp.sync_status, 'active') <> 'archived'`);
  }
  return where;
}

async function fetchRows(options) {
  const params = [];
  const where = buildWhere(options, params);
  const limit = options.limit;
  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const result = await query(
    `
      SELECT
        cp.product_key,
        cp.pivota_signature_id,
        cp.title,
        cp.brand,
        cp.product_type,
        cp.category_path,
        cp.canonical_url,
        cp.product_payload,
        cp.source_product_id,
        cp.source_system,
        cp.sync_status,
        eps.external_product_id,
        eps.domain,
        eps.market,
        eps.status AS seed_status,
        eps.destination_url,
        eps.canonical_url AS seed_canonical_url,
        eps.price_amount AS seed_price_amount,
        eps.price_currency AS seed_price_currency,
        eps.seed_data,
        kb.kb_key AS intel_kb_key,
        kb.source AS intel_source,
        kb.source_meta AS intel_source_meta,
        kb.analysis AS intel_analysis,
        COALESCE(review_counts.review_count, 0) AS review_count,
        COALESCE(review_counts.possible_key_count, 0) AS review_possible_key_count,
        COALESCE(qna_counts.qna_count, 0) AS qna_count
      FROM catalog_products cp
      LEFT JOIN external_product_seeds eps
        ON cp.merchant_id = 'external_seed'
       AND cp.platform = 'external_seed'
       AND cp.source_product_id = eps.external_product_id
      LEFT JOIN LATERAL (
        SELECT kb_key, source, source_meta, analysis
        FROM aurora_product_intel_kb
        WHERE kb_key IN (
          'product:' || cp.pivota_signature_id,
          'product:' || cp.source_product_id,
          'product:' || eps.external_product_id,
          'product:' || cp.product_key
        )
        ORDER BY CASE
          WHEN kb_key = 'product:' || cp.pivota_signature_id THEN 0
          WHEN kb_key = 'product:' || cp.source_product_id THEN 1
          WHEN kb_key = 'product:' || eps.external_product_id THEN 2
          ELSE 3
        END
        LIMIT 1
      ) kb ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE status = 'active') AS review_count,
          count(*) AS possible_key_count
        FROM product_reviews pr
        WHERE pr.product_key::text IN (cp.product_key::text, cp.pivota_signature_id::text, cp.source_product_id::text, eps.external_product_id::text)
           OR pr.platform_product_id::text IN (cp.source_product_id::text, eps.external_product_id::text, cp.pivota_signature_id::text)
           OR pr.group_id::text IN (cp.product_key::text, cp.pivota_signature_id::text, cp.source_product_id::text, eps.external_product_id::text)
      ) review_counts ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE status = 'active') AS qna_count
        FROM ugc_questions q
        WHERE q.subject_id::text IN (cp.product_key::text, cp.pivota_signature_id::text, cp.source_product_id::text, eps.external_product_id::text)
      ) qna_counts ON true
      WHERE ${where.join('\n        AND ')}
      ORDER BY cp.updated_at DESC NULLS LAST, cp.created_at DESC NULLS LAST
      ${limitSql}
    `,
    params,
  );
  return result.rows || [];
}

function writeJson(filePath, data) {
  const target = asString(filePath);
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function summarize(rows) {
  const byBucket = {};
  const byReason = {};
  const byModule = {};
  const byBrand = {};
  const byDomain = {};
  for (const row of rows) {
    inc(byBucket, row.bucket);
    inc(byBrand, row.brand || 'unknown');
    inc(byDomain, row.domain || 'unknown');
    for (const issue of row.issues) {
      inc(byReason, issue.reason_code);
      inc(byModule, issue.module);
    }
  }
  return {
    scanned: rows.length,
    by_bucket: topEntries(byBucket),
    by_reason: topEntries(byReason),
    by_module: topEntries(byModule),
    top_brands: topEntries(byBrand, 20),
    top_domains: topEntries(byDomain, 20),
  };
}

async function main() {
  const options = {
    sig: asString(argValue('sig')),
    externalProductId: asString(argValue('external-product-id')),
    brand: asString(argValue('brand')),
    domain: asString(argValue('domain')),
    market: asString(argValue('market') || 'US'),
    limit: parsePositiveInt(argValue('limit'), 500, { allowZero: true }),
    out: asString(argValue('out')),
    includeInactive: hasArg('include-inactive'),
  };
  const rows = await fetchRows(options);
  const auditedRows = rows.map(analyzeRow);
  const output = {
    generated_at: new Date().toISOString(),
    source: 'pdp_module_value_quality_audit_v1',
    query: options,
    summary: summarize(auditedRows),
    rows: auditedRows,
  };
  writeJson(options.out, output);
  console.log(JSON.stringify(output.summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
