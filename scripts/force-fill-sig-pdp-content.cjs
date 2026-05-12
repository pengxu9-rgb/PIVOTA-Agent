#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const FORCE_FILL_CONTRACT_VERSION = 'pivota.pdp.force_fill.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const PRODUCT_INTEL_CONTRACT_VERSION = 'pivota.product_intel.v1';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !String(value).startsWith('--') ? String(value).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\\u0000/gi, '').replace(/\s+/g, ' ').trim();
}

function stripNullByteSequences(value) {
  let out = String(value || '').replace(/\u0000/g, '');
  while (/\\+u0000/i.test(out)) {
    out = out.replace(/\\+u0000/gi, '');
  }
  return out;
}

function sanitizeJsonValue(value) {
  if (typeof value === 'string') return stripNullByteSequences(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        stripNullByteSequences(key),
        sanitizeJsonValue(item),
      ]),
    );
  }
  return value;
}

function sanitizeJsonPayload(value) {
  return stripNullByteSequences(JSON.stringify(sanitizeJsonValue(value)));
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = text(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function canonicalizeUrl(rawUrl) {
  const raw = text(rawUrl);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || ['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref', 'ref_src'].includes(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    if (typeof parsed.searchParams.sort === 'function') parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return raw;
  }
}

function normalizeUnit(unit) {
  return text(unit)
    .toLowerCase()
    .replace(/fluid\s*ounces?/g, 'fl oz')
    .replace(/fl\.?\s*oz\.?/g, 'fl oz')
    .replace(/m\s*l/g, 'ml')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSize(amount, unit) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const displayAmount = String(numeric).replace(/\.0+$/, '');
  const normalizedUnit = normalizeUnit(unit);
  if (!normalizedUnit) return '';
  if (normalizedUnit === 'ml') return `${displayAmount} mL`;
  if (normalizedUnit === 'l') return `${displayAmount} L`;
  if (normalizedUnit === 'fl oz') return `${displayAmount} fl oz`;
  return `${displayAmount} ${normalizedUnit}`.trim();
}

function extractSize(value) {
  const raw = text(value)
    .replace(/[_-]+/g, ' ')
    .replace(/%20/g, ' ');
  if (!raw) return '';
  const match = raw.match(/\b(\d+(?:\.\d+)?)\s*(ml|m\s*l|g|oz|fl\.?\s*oz\.?|fluid\s*ounces?|ct|count|pads?|sheets?|masks?|pcs?|pieces?)\b/i);
  if (!match) return '';
  return formatSize(match[1], match[2]);
}

function hasField(seedData, snapshot, ...keys) {
  return keys.some((key) => text(seedData[key] || snapshot[key]));
}

function readIngredients(seedData, snapshot) {
  return firstText(
    snapshot.pdp_ingredients_raw,
    seedData.pdp_ingredients_raw,
    snapshot.ingredients,
    seedData.ingredients,
  );
}

function readHowTo(seedData, snapshot) {
  return firstText(
    snapshot.pdp_how_to_use_raw,
    seedData.pdp_how_to_use_raw,
    snapshot.how_to,
    seedData.how_to,
  );
}

function readDescription(row, seedData, snapshot) {
  return firstText(
    snapshot.pdp_description_raw,
    seedData.pdp_description_raw,
    row.description,
    snapshot.description,
    seedData.description,
  );
}

function classifyProduct(row, seedData, snapshot) {
  const haystack = [
    row.title,
    row.brand,
    row.category,
    row.product_type,
    snapshot.category,
    snapshot.product_type,
    seedData.category,
    seedData.product_type,
    readDescription(row, seedData, snapshot),
  ].map(text).join(' ').toLowerCase();
  if (/\b(spf|sunscreen|sun screen|sunblock|uv protection|sun protection)\b/.test(haystack)) return 'sunscreen';
  if (/\b(cleanser|cleansing|face wash|foam wash)\b/.test(haystack)) return 'cleanser';
  if (/\b(serum|ampoule|essence|treatment|retinol|vitamin c|niacinamide|acid)\b/.test(haystack)) return 'serum';
  if (/\b(toner|mist)\b/.test(haystack)) return 'toner';
  if (/\b(moisturi[sz]er|cream|lotion|balm)\b/.test(haystack)) return 'moisturizer';
  if (/\b(mask|sheet mask|sleeping pack)\b/.test(haystack)) return 'mask';
  if (/\b(fragrance|parfum|perfume|eau de parfum|eau de toilette|cologne)\b/.test(haystack)) return 'fragrance';
  if (/\b(lipstick|lip gloss|lip oil|lip balm|foundation|concealer|blush|mascara|eyeliner|eyeshadow|bronzer|makeup)\b/.test(haystack)) return 'makeup';
  if (/\b(shampoo|conditioner|hair|scalp)\b/.test(haystack)) return 'hair';
  return 'general';
}

function buildHowTo(row, seedData, snapshot) {
  const type = classifyProduct(row, seedData, snapshot);
  if (type === 'sunscreen') {
    return 'Apply generously as the last step of your morning skincare routine before sun exposure. Reapply at least every 2 hours, and more often after sweating, swimming, or towel drying.';
  }
  if (type === 'cleanser') return 'Massage onto damp skin, then rinse thoroughly. Use morning and/or evening as tolerated.';
  if (type === 'serum') return 'Apply a small amount after cleansing and toning, before moisturizer. Start slowly if the formula contains strong actives, and use sunscreen during the day.';
  if (type === 'toner') return 'Apply after cleansing with hands or a cotton pad, then follow with serum and moisturizer.';
  if (type === 'moisturizer') return 'Apply to clean skin after treatment steps. Use morning and/or evening, adjusting amount based on skin comfort.';
  if (type === 'mask') return 'Apply to clean skin as directed by the merchant, then rinse off or leave on according to the product format.';
  if (type === 'fragrance') return 'Apply lightly to pulse points such as wrists, neck, or behind the ears. Avoid rubbing after application.';
  if (type === 'makeup') return 'Apply to the target area and build as needed. Remove thoroughly at the end of the day.';
  if (type === 'hair') return 'Apply to hair or scalp as directed by the merchant, then rinse or style according to the product format.';
  return 'Use according to the merchant directions for this product. Patch test first if you have sensitivity concerns.';
}

function buildIngredientForceFill(row) {
  return {
    contract_version: FORCE_FILL_CONTRACT_VERSION,
    field: 'ingredients_inci',
    source_origin: 'pivota_force_fill',
    source_quality_status: 'force_filled_pending_source',
    content_review_state: 'assistant_reviewed',
    reason: 'approved_source_not_captured',
    display_note:
      'Full INCI has not been captured from an approved source yet. Check the merchant page before purchase if you avoid specific ingredients or have sensitivity concerns.',
    external_product_id: row.external_product_id,
    updated_at: new Date().toISOString(),
  };
}

function firstSentence(value, fallback = '') {
  const clean = text(value);
  if (!clean) return fallback;
  const match = clean.match(/[^.!?]+[.!?]?/);
  return text(match ? match[0] : clean) || fallback;
}

function inferInsightStep(type) {
  if (type === 'sunscreen') return 'sunscreen';
  if (type === 'cleanser') return 'cleanser';
  if (type === 'serum') return 'serum';
  if (type === 'toner') return 'toner';
  if (type === 'moisturizer') return 'moisturizer';
  if (type === 'fragrance') return 'fragrance';
  if (type === 'makeup') return 'makeup';
  if (type === 'hair') return 'haircare';
  return 'product';
}

function buildProductIntelBundle(row, seedData, snapshot) {
  const type = classifyProduct(row, seedData, snapshot);
  const title = firstText(row.title, snapshot.title, seedData.title, 'Product');
  const brand = firstText(row.brand, snapshot.brand, seedData.brand);
  const category = firstText(row.category, row.product_type, snapshot.category, snapshot.product_type, seedData.category, seedData.product_type, type);
  const description = readDescription(row, seedData, snapshot);
  const intro = firstSentence(
    description,
    `${brand ? `${brand} ` : ''}${title} is a ${category || type} product with limited approved source detail available in the current PDP record}.`,
  );
  const typeLabel = type === 'general' ? category || 'product' : type;
  const concerns = [];
  const combined = `${title} ${description}`.toLowerCase();
  if (/\bacne|blemish|pore|sebum|oil\b/.test(combined)) concerns.push('blemish-prone or oily skin routines');
  if (/\bhydrat|moistur|barrier|oat|ceramide|panthenol\b/.test(combined)) concerns.push('hydration and barrier comfort');
  if (/\bspf|sunscreen|uv|sun protection\b/.test(combined)) concerns.push('daytime UV protection');
  if (/\bbright|tone|dark spot|vitamin c|niacinamide\b/.test(combined)) concerns.push('tone and brightness support');
  if (/\bretinol|peptide|firm|wrinkle|fine line\b/.test(combined)) concerns.push('early aging or firmness routines');

  const bestFor = concerns.length
    ? concerns.slice(0, 3).map((label) => ({
        tag: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        label,
        confidence: 'moderate',
      }))
    : [{ tag: 'routine_fit_review_needed', label: 'Routine fit needs source review', confidence: 'low' }];

  const why = [];
  if (type === 'sunscreen') {
    why.push({
      headline: 'Daytime protection role',
      body: 'The product is positioned as an SPF step, so the main PDP decision point is UV protection plus finish and skin feel.',
      evidence_strength: 'seller_grounded',
    });
  } else if (concerns.length) {
    why.push({
      headline: 'Clear routine target',
      body: `The listing language points to ${concerns.slice(0, 2).join(' and ')} rather than a generic category-only product.`,
      evidence_strength: 'seller_grounded',
    });
  } else {
    why.push({
      headline: 'Seller-grounded product role',
      body: `The approved record identifies this as a ${typeLabel} product; richer claims should wait for source review.`,
      evidence_strength: 'seller_grounded_limited',
    });
  }

  return {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    display_name: 'Pivota Insights',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: row.external_product_id,
      platform: 'external',
    },
    product_intel_core: {
      what_it_is: {
        headline: typeLabel ? typeLabel.replace(/\b\w/g, (m) => m.toUpperCase()) : 'Product',
        body: intro,
      },
      best_for: bestFor,
      why_it_stands_out: why,
      routine_fit: {
        step: inferInsightStep(type),
        am_pm: type === 'sunscreen' ? ['am'] : type === 'fragrance' || type === 'makeup' ? ['as_needed'] : ['am', 'pm'],
        pairing_notes: [
          type === 'sunscreen'
            ? 'Use as the final morning skincare step and pair with cleansing at night.'
            : 'Pair with compatible routine steps and avoid layering multiple strong actives unless your skin tolerates them.',
        ],
      },
      watchouts: [
        {
          type: 'source_review',
          label: 'Claims beyond the seller PDP record should wait for approved source review.',
          severity: 'low',
        },
      ],
      display_name: 'Pivota Insights',
      freshness: { source_version: 'force_filled_seller_only_v1', generated_at: new Date().toISOString() },
      quality_state: 'limited',
      evidence_profile: 'seller_only',
    },
    community_signals: {
      status: 'unavailable',
      unavailable_reason: 'insufficient_feedback',
      confidence: 'low',
      evidence_profile: 'seller_only',
    },
    recommendation_intents: {
      similar: [],
      complementary: [],
      routine_pairing: [],
      underfill_reason: 'not_generated_in_force_fill',
      confidence: 'low',
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title,
      subtitle: category || typeLabel,
      highlight: concerns[0] || `${typeLabel} role`,
      intro,
      evidence_profile: 'seller_only',
    },
    search_card: {
      title_candidate: title,
      compact_candidate: category || typeLabel,
      highlight_candidate: concerns[0] || `${typeLabel} role`,
      intro_candidate: intro,
    },
    quality_state: 'limited',
    evidence_profile: 'seller_only',
    confidence: { level: 'moderate', score: 0.62, reasons: ['force_filled_seller_only', 'assistant_reviewed'] },
    freshness: { source_version: 'force_filled_seller_only_v1', generated_at: new Date().toISOString() },
    provenance: {
      source: 'pivota_force_fill',
      generator: 'deterministic_force_fill',
      reviewer_kind: 'assistant',
      review_status: 'completed',
      review_decision: 'seller_only_fallback',
      review_tier: 'assistant_reviewed',
      selection_strategy: 'curated_override',
      force_filled: true,
      generated_at: new Date().toISOString(),
    },
  };
}

function collectCandidateStrings(row, seedData, snapshot) {
  const out = [
    row.title,
    row.destination_url,
    row.canonical_url,
    row.catalog_canonical_url,
    row.image_url,
    seedData.image_url,
    snapshot.image_url,
  ];
  for (const field of ['image_urls', 'images']) {
    out.push(...asArray(seedData[field]));
    out.push(...asArray(snapshot[field]));
  }
  for (const variant of [...asArray(seedData.variants), ...asArray(snapshot.variants)]) {
    out.push(variant?.title, variant?.option_value, variant?.image_url, variant?.url, variant?.deep_link, variant?.product_url);
    out.push(...asArray(variant?.image_urls), ...asArray(variant?.images));
  }
  return out;
}

function hasDisplayableVariantOptions(variants) {
  return asArray(variants).some((variant) => isDisplayableVariant(variant));
}

function isDisplayableVariant(variant) {
  return asArray(variant?.options).some((option) => {
    const name = text(option?.name).toLowerCase();
    const value = text(option?.value).toLowerCase();
    if (!name || !value) return false;
    if (['default', 'default title', 'single', 'title', 'variant'].includes(value)) return false;
    return true;
  });
}

function isPlaceholderVariant(variant) {
  const title = text(variant?.title).toLowerCase();
  const optionValue = text(variant?.option_value || variant?.optionValue).toLowerCase();
  const displayLabel = text(variant?.display_label || variant?.displayLabel).toLowerCase();
  const sourceQualityStatus = text(variant?.source_quality_status || variant?.sourceQualityStatus).toLowerCase();
  const hasOptions = asArray(variant?.options).length > 0;
  const placeholderValue = /^(default|default title|single|variant \d*)$/.test(title) ||
    /^(default|default title|single|variant \d*)$/.test(optionValue) ||
    /^(default|default option|single)$/.test(displayLabel);
  return (placeholderValue && !isDisplayableVariant(variant)) ||
    (sourceQualityStatus === 'blocked' && !isDisplayableVariant(variant) && (!hasOptions || placeholderValue));
}

function dropPlaceholderVariantsWhenSafe(variants) {
  const list = asArray(variants);
  if (list.length <= 1 || !hasDisplayableVariantOptions(list)) {
    return { variants: list, removed: 0 };
  }
  const filtered = list.filter((variant) => !isPlaceholderVariant(variant));
  return {
    variants: filtered.length > 0 ? filtered : list,
    removed: list.length - filtered.length,
  };
}

function isSingleUndisplayableVariant(seedData, snapshot) {
  const variants = asArray(snapshot.variants).length ? asArray(snapshot.variants) : asArray(seedData.variants);
  if (variants.length !== 1) return false;
  if (hasDisplayableVariantOptions(variants)) return false;
  const title = text(variants[0]?.title).toLowerCase();
  return !title || /^(default|default title|single|variant \d+)$/.test(title) || asArray(variants[0]?.options).length === 0;
}

async function fetchSourceEvidence(row) {
  const sourceUrl = firstText(row.destination_url, row.canonical_url, row.catalog_canonical_url);
  if (!sourceUrl) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 PivotaForceFill/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (isLikelyNonProductSourceHtml(html)) return [];
    const out = [];
    for (const attrs of html.matchAll(/<meta\b([^>]*)>/gi)) {
      const attrText = attrs[1] || '';
      const key =
        attrText.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase() ||
        '';
      if (!['og:title', 'twitter:title', 'og:description', 'twitter:description', 'description', 'og:image', 'twitter:image'].includes(key)) {
        continue;
      }
      const content = attrText.match(/\bcontent=["']([^"']+)["']/i)?.[1];
      if (content) out.push(content);
    }
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(match[1].trim());
        collectProductJsonLdEvidence(parsed, out);
      } catch {
        // Ignore malformed embedded JSON-LD.
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function isLikelyNonProductSourceHtml(html) {
  const raw = text(html).slice(0, 100000);
  if (!raw) return true;
  return /"template"\s*:\s*"404"/i.test(raw) ||
    /["']?page_type["']?\s*:\s*["']404["']/i.test(raw) ||
    /<title>[^<]*(?:404|not found)[^<]*<\/title>/i.test(raw) ||
    /<body[^>]+(?:template|class)=["'][^"']*404/i.test(raw);
}

function collectProductJsonLdEvidence(value, out, depth = 0) {
  if (depth > 4 || !value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectProductJsonLdEvidence(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const type = value['@type'];
  const types = Array.isArray(type) ? type.map((item) => text(item).toLowerCase()) : [text(type).toLowerCase()];
  if (types.includes('product')) {
    out.push(value.name, value.description);
    out.push(...asArray(value.image));
    out.push(...asArray(value.offers).map((offer) => offer?.name || offer?.sku));
  }
  collectProductJsonLdEvidence(value['@graph'], out, depth + 1);
  collectProductJsonLdEvidence(value.mainEntity, out, depth + 1);
  collectProductJsonLdEvidence(value.itemListElement, out, depth + 1);
}

function inferSingleSkuSpecFromTitle(row, seedData, snapshot) {
  const title = firstText(row.title, snapshot.title, seedData.title);
  if (!title) return null;
  const lower = title.toLowerCase();
  const shadeMatch = title.match(/\s[—–-]\s*([^—–-]{2,80})$/);
  if (shadeMatch) {
    const value = text(shadeMatch[1]).replace(/^shade\s+/i, '');
    if (value && !/^(default|default title|single|one size)$/i.test(value)) {
      return {
        size: value,
        value,
        optionName: 'Shade',
        axisKind: 'shade',
        source: 'reviewed_title_pattern',
        evidence: title,
        measured: false,
      };
    }
  }
  const setLike = /\b(set|kit|bundle|duo|trio|pack of|value pack|collection)\b/.test(lower);
  if (setLike) {
    const value =
      lower.includes('duo') ? 'Duo'
        : lower.includes('trio') ? 'Trio'
          : /\b(set|kit|bundle|collection)\b/.test(lower) ? 'Set'
            : 'Multipack';
    return {
      size: value,
      value,
      optionName: 'Format',
      axisKind: 'format',
      source: 'reviewed_title_pattern',
      evidence: title,
      measured: false,
    };
  }
  if (!setLike && /\b(mask|sheet mask)\b/.test(lower)) {
    return {
      size: 'Single mask',
      value: 'Single mask',
      optionName: 'Format',
      axisKind: 'format',
      source: 'reviewed_title_pattern',
      evidence: title,
      measured: false,
    };
  }
  if (/\b(brush|sponge|puff|applicator|mirror|sharpener|tool|gua sha|gwalsa)\b/.test(lower)) {
    return {
      size: 'One piece',
      value: 'One piece',
      optionName: 'Format',
      axisKind: 'format',
      source: 'reviewed_title_pattern',
      evidence: title,
      measured: false,
    };
  }
  if (/\b(eau de parfum|eau de toilette|parfum|perfume|fragrance|cologne)\b/.test(lower)) {
    return {
      size: 'Single bottle',
      value: 'Single bottle',
      optionName: 'Format',
      axisKind: 'format',
      source: 'reviewed_title_pattern',
      evidence: title,
      measured: false,
    };
  }
  return {
    size: 'Single item',
    value: 'Single item',
    optionName: 'Format',
    axisKind: 'format',
    source: 'force_filled_single_sku_default',
    evidence: title,
    measured: false,
  };
}

async function inferSize(row, seedData, snapshot, { fetchSource = false } = {}) {
  for (const candidate of collectCandidateStrings(row, seedData, snapshot)) {
    const size = extractSize(candidate);
    if (size) return { size, value: size, optionName: 'Size', axisKind: 'size', source: 'stored_seed_evidence', evidence: text(candidate).slice(0, 240), measured: true };
  }
  if (fetchSource) {
    for (const candidate of await fetchSourceEvidence(row)) {
      const size = extractSize(candidate);
      if (size) return { size, value: size, optionName: 'Size', axisKind: 'size', source: 'official_source_page', evidence: text(candidate).slice(0, 240), measured: true };
    }
  }
  return inferSingleSkuSpecFromTitle(row, seedData, snapshot);
}

function mergeQuality(seedData, snapshot, key, sourceQualityStatus, reasonCode) {
  const now = new Date().toISOString();
  const quality = {
    ...asObject(snapshot.pdp_field_quality_summary),
    ...asObject(seedData.pdp_field_quality_summary),
  };
  quality[key] = {
    source_origin: 'pivota_force_fill',
    source_quality_status: sourceQualityStatus,
    source_kinds: ['force_fill'],
    reason_codes: [reasonCode],
    updated_at: now,
  };
  seedData.pdp_field_quality_summary = quality;
  snapshot.pdp_field_quality_summary = quality;
}

function mergeSnapshotContract(seedData, snapshot) {
  const now = new Date().toISOString();
  const contract = {
    ...asObject(snapshot.external_seed_snapshot_contract),
    ...asObject(seedData.external_seed_snapshot_contract),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'replace_not_merge',
    updated_at: now,
  };
  seedData.external_seed_snapshot_contract = contract;
  snapshot.external_seed_snapshot_contract = contract;
}

function mergeForceFillMeta(seedData, snapshot, field, meta) {
  const existing = {
    ...asObject(snapshot.pdp_force_fill_v1),
    ...asObject(seedData.pdp_force_fill_v1),
  };
  const next = {
    ...existing,
    contract_version: FORCE_FILL_CONTRACT_VERSION,
    updated_at: new Date().toISOString(),
    fields: {
      ...asObject(existing.fields),
      [field]: meta,
    },
  };
  seedData.pdp_force_fill_v1 = next;
  snapshot.pdp_force_fill_v1 = next;
}

function patchSingleVariantSpec(seedData, snapshot, spec) {
  const value = text(spec?.value || spec?.size);
  if (!value) return;
  const optionName = text(spec?.optionName || spec?.option_name || 'Size') || 'Size';
  const axisKind = text(spec?.axisKind || spec?.axis_kind || optionName).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'size';
  const patchList = (list) =>
    asArray(list).map((variant) => ({
      ...asObject(variant),
      title: value,
      options: [{ name: optionName, value, axis_kind: axisKind }],
      option_name: optionName,
      option_value: value,
      display_label: `${optionName}: ${value}`,
      axis_kind: axisKind,
      source_quality_status: 'captured',
    }));
  if (asArray(seedData.variants).length === 1) seedData.variants = patchList(seedData.variants);
  if (asArray(snapshot.variants).length === 1) snapshot.variants = patchList(snapshot.variants);
}

function patchSingleVariantSize(seedData, snapshot, size) {
  patchSingleVariantSpec(seedData, snapshot, { value: size, optionName: 'Size', axisKind: 'size' });
}

async function buildPlan(row, kbKeysWithIntel, opts) {
  const seedData = JSON.parse(JSON.stringify(asObject(row.seed_data)));
  const snapshot = asObject(seedData.snapshot);
  seedData.snapshot = snapshot;
  const changedFields = [];
  const planned = { external_product_id: row.external_product_id, sig: row.pivota_signature_id, title: row.title, changed_fields: changedFields };

  if (!readHowTo(seedData, snapshot)) {
    const howTo = buildHowTo(row, seedData, snapshot);
    seedData.pdp_how_to_use_raw = howTo;
    snapshot.pdp_how_to_use_raw = howTo;
    mergeQuality(seedData, snapshot, 'how_to_use_raw', 'force_filled_reviewed_pattern', 'missing_how_to');
    mergeForceFillMeta(seedData, snapshot, 'how_to_use', { source: 'deterministic_reviewed_pattern', content_review_state: 'assistant_reviewed' });
    changedFields.push('how_to_use');
  }

  const ingredientIntel = { ...asObject(seedData.ingredient_intel), ...asObject(snapshot.ingredient_intel) };
  if (!readIngredients(seedData, snapshot) && !asObject(ingredientIntel.force_fill_contract).contract_version) {
    const forceFill = buildIngredientForceFill(row);
    seedData.ingredient_intel = { ...asObject(seedData.ingredient_intel), force_fill_contract: forceFill };
    snapshot.ingredient_intel = { ...asObject(snapshot.ingredient_intel), force_fill_contract: forceFill };
    mergeQuality(seedData, snapshot, 'ingredients_inci', 'force_filled_pending_source', 'missing_ingredients');
    mergeForceFillMeta(seedData, snapshot, 'ingredients_inci', { source: 'ingredient_intel.force_fill_contract', content_review_state: 'assistant_reviewed' });
    changedFields.push('ingredients_inci');
  }

  const rootVariantCleanup = dropPlaceholderVariantsWhenSafe(seedData.variants);
  const snapshotVariantCleanup = dropPlaceholderVariantsWhenSafe(snapshot.variants);
  if (rootVariantCleanup.removed > 0 || snapshotVariantCleanup.removed > 0) {
    if (rootVariantCleanup.removed > 0) seedData.variants = rootVariantCleanup.variants;
    if (snapshotVariantCleanup.removed > 0) snapshot.variants = snapshotVariantCleanup.variants;
    mergeQuality(seedData, snapshot, 'variants', 'force_filled_reviewed_pattern', 'placeholder_variant_removed');
    mergeForceFillMeta(seedData, snapshot, 'variant_sanitized', {
      source: 'deterministic_placeholder_filter',
      root_removed: rootVariantCleanup.removed,
      snapshot_removed: snapshotVariantCleanup.removed,
      content_review_state: 'assistant_reviewed',
    });
    changedFields.push('variant_sanitized');
  }

  if (
    isSingleUndisplayableVariant(seedData, snapshot) &&
    !hasField(seedData, snapshot, 'size_detail_label', 'net_size', 'net_content')
  ) {
    const inferred = await inferSize(row, seedData, snapshot, { fetchSource: opts.fetchSource });
    if (inferred?.size) {
      const optionName = inferred.optionName || 'Size';
      const axisKind = inferred.axisKind || 'size';
      const value = inferred.value || inferred.size;
      seedData.variant_detail_label = `${optionName}: ${value}`;
      snapshot.variant_detail_label = `${optionName}: ${value}`;
      if (axisKind === 'size') {
        seedData.size_detail_label = value;
        snapshot.size_detail_label = value;
        if (inferred.measured !== false) {
          seedData.net_size = value;
          snapshot.net_size = value;
        }
      } else if (axisKind === 'shade') {
        seedData.shade_detail_label = value;
        snapshot.shade_detail_label = value;
      } else if (axisKind === 'format') {
        seedData.format_detail_label = value;
        snapshot.format_detail_label = value;
      }
      patchSingleVariantSpec(seedData, snapshot, { value, optionName, axisKind });
      const sourceQuality =
        inferred.source === 'official_source_page'
          ? 'high'
          : inferred.source === 'force_filled_single_sku_default'
            ? 'force_filled_reviewed_pattern'
            : 'medium';
      mergeQuality(seedData, snapshot, axisKind === 'size' ? 'size_detail_label' : 'variant_detail_label', sourceQuality, 'single_sku_variant_clarity_inferred');
      mergeQuality(seedData, snapshot, 'variants', sourceQuality, 'single_sku_variant_clarity_inferred');
      mergeForceFillMeta(seedData, snapshot, 'variant_size', {
        source: inferred.source,
        evidence: inferred.evidence,
        value,
        option_name: optionName,
        axis_kind: axisKind,
        content_review_state: inferred.source === 'official_source_page' ? 'source_verified' : 'assistant_reviewed',
      });
      changedFields.push('variant_size');
    } else {
      planned.variant_size_blocked = true;
    }
  }

  const kbKeys = buildKbKeys(row);
  const hasIntel = kbKeys.some((key) => kbKeysWithIntel.has(key));
  let kbUpserts = [];
  if (!hasIntel) {
    const bundle = buildProductIntelBundle(row, seedData, snapshot);
    kbUpserts = kbKeys.slice(0, 2).map((kbKey) => ({
      kb_key: kbKey,
      analysis: {
        product_intel_v1: bundle,
        force_fill_contract: {
          contract_version: FORCE_FILL_CONTRACT_VERSION,
          field: 'product_intel',
          source_origin: 'pivota_force_fill',
          content_review_state: 'assistant_reviewed',
          updated_at: new Date().toISOString(),
        },
      },
      source: 'pivota_force_fill_v1',
      source_meta: {
        external_product_id: row.external_product_id,
        pivota_signature_id: row.pivota_signature_id,
        force_filled: true,
      },
    }));
    changedFields.push('product_intel');
  }

  if (changedFields.length) {
    mergeSnapshotContract(seedData, snapshot);
  }

  return {
    ...planned,
    changed: changedFields.length > 0,
    next_seed_data: seedData,
    kb_upserts: kbUpserts,
  };
}

function buildKbKeys(row) {
  const keys = [`product:${row.external_product_id}`];
  for (const url of uniq([row.catalog_canonical_url, row.canonical_url, row.destination_url])) {
    const canonical = canonicalizeUrl(url);
    if (canonical) keys.push(`url:${canonical}`);
  }
  return uniq(keys);
}

async function fetchRows(client, opts) {
  const params = [];
  const where = ["cp.pivota_signature_id LIKE 'sig_%'", "eps.status = 'active'"];
  if (opts.productId) {
    params.push(opts.productId);
    where.push(`(cp.pivota_signature_id = $${params.length} OR eps.external_product_id = $${params.length})`);
  }
  if (opts.domain) {
    params.push(opts.domain);
    where.push(`eps.domain ILIKE '%' || $${params.length} || '%'`);
  }
  const limitSql = opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : '';
  const res = await client.query(
    `
      SELECT cp.pivota_signature_id, cp.product_key, cp.source_product_id, cp.title AS catalog_title,
             cp.brand, cp.category, cp.product_type, cp.canonical_url AS catalog_canonical_url,
             cp.description, cp.image_url,
             eps.id, eps.external_product_id, eps.title, eps.domain, eps.market,
             eps.canonical_url, eps.destination_url, eps.seed_data
      FROM catalog_products cp
      JOIN external_product_seeds eps ON eps.external_product_id = cp.source_product_id
      WHERE ${where.join(' AND ')}
      ORDER BY cp.pivota_signature_id
      ${limitSql}
    `,
    params,
  );
  return res.rows || [];
}

async function fetchKbIntelKeys(client, rows) {
  const keys = uniq(rows.flatMap((row) => buildKbKeys(row)));
  if (!keys.length) return new Set();
  const res = await client.query(
    `
      SELECT kb_key
      FROM aurora_product_intel_kb
      WHERE kb_key = ANY($1::text[])
        AND (
          analysis->'product_intel_v1' IS NOT NULL OR
          analysis->'product_intel' IS NOT NULL OR
          analysis->>'contract_version' = $2
        )
    `,
    [keys, PRODUCT_INTEL_CONTRACT_VERSION],
  );
  return new Set((res.rows || []).map((row) => row.kb_key));
}

async function applyPlans(client, plans) {
  let seedUpdates = 0;
  let kbUpserts = 0;
  for (const plan of plans) {
    if (plan.changed && plan.changed_fields.some((field) => field !== 'product_intel')) {
      try {
        if (plan.changed_fields.every((field) => field === 'variant_size' || field === 'variant_sanitized')) {
          const patch = buildVariantOnlySeedPatch(plan.next_seed_data);
          await client.query(
            `
              UPDATE external_product_seeds
              SET seed_data = jsonb_set(
                    (seed_data || $2::jsonb),
                    '{snapshot}',
                    (COALESCE(seed_data->'snapshot', '{}'::jsonb) || $3::jsonb),
                    true
                  ),
                  updated_at = NOW()
              WHERE external_product_id = $1
            `,
            [
              plan.external_product_id,
              sanitizeJsonPayload(patch.rootPatch),
              sanitizeJsonPayload(patch.snapshotPatch),
            ],
          );
        } else {
          await client.query(
            `UPDATE external_product_seeds SET seed_data = $2::jsonb, updated_at = NOW() WHERE external_product_id = $1`,
            [plan.external_product_id, sanitizeJsonPayload(plan.next_seed_data)],
          );
        }
      } catch (error) {
        error.message = `${error.message} (external_product_id=${plan.external_product_id})`;
        throw error;
      }
      seedUpdates += 1;
    }
    for (const item of plan.kb_upserts || []) {
      await client.query(
        `
          INSERT INTO aurora_product_intel_kb (kb_key, analysis, source, source_meta, last_success_at, created_at, updated_at)
          VALUES ($1, $2::jsonb, $3, $4::jsonb, NOW(), NOW(), NOW())
          ON CONFLICT (kb_key) DO UPDATE
          SET analysis = EXCLUDED.analysis,
              source = EXCLUDED.source,
              source_meta = EXCLUDED.source_meta,
              last_success_at = NOW(),
              updated_at = NOW()
        `,
        [item.kb_key, JSON.stringify(item.analysis), item.source, JSON.stringify(item.source_meta)],
      );
      kbUpserts += 1;
    }
  }
  return { seedUpdates, kbUpserts };
}

function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function buildVariantOnlySeedPatch(seedData) {
  const snapshot = asObject(seedData.snapshot);
  const patchKeys = [
    'variants',
    'variant_detail_label',
    'size_detail_label',
    'net_size',
    'shade_detail_label',
    'format_detail_label',
    'pdp_field_quality_summary',
    'pdp_force_fill_v1',
    'external_seed_snapshot_contract',
  ];
  return {
    rootPatch: pickDefined(seedData, patchKeys),
    snapshotPatch: pickDefined(snapshot, patchKeys),
  };
}

function summarize(plans) {
  const byField = {};
  for (const plan of plans) {
    for (const field of plan.changed_fields || []) {
      byField[field] = (byField[field] || 0) + 1;
    }
  }
  return {
    scanned: plans.length,
    changed_rows: plans.filter((plan) => plan.changed).length,
    by_field: byField,
    variant_size_blocked: plans.filter((plan) => plan.variant_size_blocked).length,
  };
}

async function main() {
  const apply = hasFlag('apply');
  const opts = {
    apply,
    fetchSource: hasFlag('fetch-source') || hasFlag('fetchSource'),
    limit: Math.max(0, Number(argValue('limit') || 0) || 0),
    productId: argValue('product-id') || argValue('productId'),
    domain: argValue('domain') || argValue('host'),
    out: argValue('out'),
  };
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  try {
    const rows = await fetchRows(client, opts);
    const kbKeysWithIntel = await fetchKbIntelKeys(client, rows);
    const plans = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      plans.push(await buildPlan(row, kbKeysWithIntel, opts));
    }
    const applyResult = apply ? await applyPlans(client, plans) : { seedUpdates: 0, kbUpserts: 0 };
    const report = {
      generated_at: new Date().toISOString(),
      dry_run: !apply,
      options: opts,
      summary: { ...summarize(plans), ...applyResult },
      samples: plans
        .filter((plan) => plan.changed || plan.variant_size_blocked)
        .slice(0, 25)
        .map(({ next_seed_data: _nextSeedData, kb_upserts: _kbUpserts, ...plan }) => plan),
    };
    if (opts.out) {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.samples.length) console.log(JSON.stringify(report.samples.slice(0, 5), null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  _internals: {
    extractSize,
    fetchSourceEvidence,
    inferSingleSkuSpecFromTitle,
    isLikelyNonProductSourceHtml,
    dropPlaceholderVariantsWhenSafe,
    sanitizeJsonPayload,
    buildVariantOnlySeedPatch,
    buildHowTo,
    buildIngredientForceFill,
    buildProductIntelBundle,
  },
};
