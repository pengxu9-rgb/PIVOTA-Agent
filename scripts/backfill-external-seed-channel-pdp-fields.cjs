#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { query, closePool } = require('../src/db');

const CONTRACT_VERSION = 'external_seed.channel_pdp_fields.v1';
const PDP_CONTENT_ASSET_VERSION = 'pivota.pdp_content_asset.v1';
const SNAPSHOT_CONTRACT_VERSION = 'external_seed.snapshot_contract.v1';
const TRUSTED_CHANNEL_HOSTS = new Set([
  'sokoglam.com',
  'ohlolly.com',
  'bloomingkoco.com',
  'stylekorean.com',
  'yesstyle.com',
  'oliveyoung.com',
  'ulta.com',
  'sephora.com',
  'iherb.com',
  'peachandlily.com',
]);

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? String(value).trim() : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return normalizeText(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, ' - ')
    .replace(/&deg;/gi, 'deg')
    .replace(/&times;/gi, 'x')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : '';
    });
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|div|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringifyPostgresJsonb(value) {
  let text = JSON.stringify(value || {});
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text.replace(/\\+u0000/gi, '').replace(/\u0000/g, '');
  }
  return text;
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hashContent(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || '')).digest('hex');
}

function normalizeTitleTokens(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2 && !['the', 'and', 'with', 'for', 'skin1004'].includes(token)),
    ),
  );
}

function scoreProductTitleMatch(sourceTitle, targetTitle) {
  const sourceTokens = normalizeTitleTokens(sourceTitle);
  const targetTokens = new Set(normalizeTitleTokens(targetTitle));
  if (!sourceTokens.length || !targetTokens.size) return 0;
  const shared = sourceTokens.filter((token) => targetTokens.has(token)).length;
  return shared / Math.max(1, sourceTokens.length);
}

function cleanSectionText(value) {
  return stripHtml(value)
    .replace(/\b(?:Share|You may also like|Customer Reviews)\b[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeFullInci(value) {
  const text = normalizeText(value);
  if (text.length < 80) return false;
  const items = text.split(/,\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length < 6) return false;
  if (!/\b(water|aqua|glycerin|glycol|niacinamide|panthenol|ceramide|hyaluronate|acid|extract|dimethicone|squalane)\b/i.test(text)) {
    return false;
  }
  if (/\b(add to cart|shop now|you may also like|customer reviews|soko rewards|guarantee)\b/i.test(text)) return false;
  return true;
}

function looksLikeHowToUse(value) {
  const text = normalizeText(value);
  if (text.length < 20 || text.length > 900) return false;
  if (!/\b(apply|use|pour|wipe|massage|spread|dispense|cleanse|rinse)\b/i.test(text)) return false;
  if (/\b(add to cart|shop now|customer reviews|wishlist|soko rewards)\b/i.test(text)) return false;
  return true;
}

function parseDelimitedIds(value) {
  return Array.from(new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)));
}

function readCandidateMappings() {
  const explicitIds = parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds'));
  const candidateBoard = argValue('candidate-board') || argValue('candidateBoard');
  const mappingFile = argValue('mapping-file') || argValue('mappingFile');
  if (mappingFile) {
    const parsed = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
    return (Array.isArray(parsed) ? parsed : parsed.mappings || []).map((item) => ({
      target_id: item.target_id || item.external_product_id,
      source_url: item.source_url || item.candidate_url,
      source_external_product_id: item.source_external_product_id || item.candidate_id || null,
    })).filter((item) => item.target_id && item.source_url);
  }
  if (candidateBoard) {
    const parsed = JSON.parse(fs.readFileSync(candidateBoard, 'utf8'));
    return asArray(parsed.grouped).flatMap((group) => {
      if (explicitIds.length && !explicitIds.includes(group.target_id)) return [];
      const candidate = asArray(group.candidates).find((item) => item.is_channelish && item.candidate_url);
      if (!candidate) return [];
      return [{
        target_id: group.target_id,
        source_url: candidate.candidate_url,
        source_external_product_id: candidate.candidate_id,
      }];
    });
  }
  return explicitIds.map((id) => ({ target_id: id, source_url: argValue('source-url') || argValue('sourceUrl') }))
    .filter((item) => item.source_url);
}

function extractFirst(pattern, value) {
  const match = String(value || '').match(pattern);
  return match ? match[1] : '';
}

function extractSokoGlamFields(html) {
  const raw = String(html || '');
  const title = cleanSectionText(extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, raw));
  const howTo = cleanSectionText(
    extractFirst(/<h3>\s*How to Use\s*<\/h3>[\s\S]{0,500}?<div class="metafield-rich_text_field">([\s\S]*?)<\/div>/i, raw),
  );
  const details = cleanSectionText(
    extractFirst(/<h2[^>]*>\s*Details\s*<\/h2>[\s\S]{0,900}?<div class="accordion__content rte"[^>]*>([\s\S]*?)<\/div>\s*<\/details>/i, raw),
  );
  const ingredientsBlock = extractFirst(
    /<h2[^>]*>\s*Ingredients\s*<\/h2>[\s\S]{0,900}?<div class="accordion__content rte"[^>]*>([\s\S]*?)<\/div>\s*<\/details>/i,
    raw,
  );
  const active = cleanSectionText(
    extractFirst(/<h6>\s*Ingredients We Love\s*<\/h6>\s*<div class="metafield-rich_text_field">([\s\S]*?)<\/div>/i, ingredientsBlock),
  );
  const ingredients = cleanSectionText(
    extractFirst(/<h6>\s*Full List of Ingredients\s*<\/h6>\s*<div class="metafield-rich_text_field">([\s\S]*?)<\/div>/i, ingredientsBlock),
  );
  const reviewSummary = parseOkendoReviewSummary(raw);
  return {
    source_title: title,
    pdp_how_to_use_raw: looksLikeHowToUse(howTo) ? howTo : '',
    pdp_details_sections: details.length >= 80 ? [{ heading: 'Details', body: details }] : [],
    pdp_active_ingredients_raw: active.length >= 10 ? active : '',
    pdp_ingredients_raw: looksLikeFullInci(ingredients) ? ingredients : '',
    review_summary: reviewSummary,
  };
}

function parseOkendoReviewSummary(html) {
  const previewItems = [];
  let rating = 0;
  let reviewCount = 0;
  let starDistribution = null;

  for (const match of String(html || '').matchAll(/<script[^>]+data-oke-metafield-data[^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed = null;
    try {
      parsed = JSON.parse(decodeHtmlEntities(match[1]));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.averageRating || parsed.reviewCount) {
      rating = Number(parsed.averageRating || parsed.rating || rating || 0);
      reviewCount = Number(parsed.reviewCount || parsed.review_count || reviewCount || 0);
    }
    const aggregate = ensureObject(parsed.reviewAggregate);
    if (aggregate.reviewCount || aggregate.ratingAndReviewCount) {
      const count = Number(aggregate.reviewCount || aggregate.ratingAndReviewCount || 0);
      const total = Number(aggregate.reviewRatingValuesTotal || aggregate.ratingAndReviewValuesTotal || 0);
      if (count > 0 && total > 0) {
        rating = total / count;
        reviewCount = count;
      }
      const distribution = ensureObject(aggregate.reviewCountByLevel || aggregate.ratingAndReviewCountByLevel);
      const levels = [5, 4, 3, 2, 1].map((level) => ({
        rating: level,
        count: Number(distribution[`level${level}Count`] || 0),
      }));
      if (levels.some((item) => item.count > 0)) starDistribution = levels;
    }
    for (const review of asArray(parsed.reviews)) {
      const body = normalizeText(review.body);
      if (body.length < 25) continue;
      if (/\b(price|shipping|delivery|package|customer service|discount|coupon)\b/i.test(body)) continue;
      const idHash = crypto
        .createHash('sha1')
        .update(`okendo|${review.reviewId || ''}|${review.reviewer?.displayName || ''}|${body}`)
        .digest('hex')
        .slice(0, 16);
      previewItems.push({
        review_id: `okendo_${idHash}`,
        rating: Math.max(1, Math.min(5, Math.round(Number(review.rating || 5) || 5))),
        author_label: normalizeText(review.reviewer?.displayName) || 'Verified buyer',
        ...(normalizeText(review.title) ? { title: normalizeText(review.title).slice(0, 120) } : {}),
        text_snippet: body.slice(0, 360),
        source: 'retailer_public',
        source_kind: 'okendo_metafield_json',
        source_scope: 'retailer_public',
        public_visible: true,
        verified_buyer: review.reviewer?.isVerified === true,
        content_review_state: 'assistant_reviewed',
      });
      if (previewItems.length >= 6) break;
    }
  }

  if (!rating || !reviewCount) return null;
  return {
    rating: Math.round(rating * 10) / 10,
    scale: 5,
    review_count: Math.round(reviewCount),
    exact_item_review_count: Math.round(reviewCount),
    aggregation_scope: 'product',
    source_origin: 'retail_pdp_reviews',
    ...(starDistribution ? { star_distribution: starDistribution, rating_distribution: starDistribution } : {}),
    ...(previewItems.length ? { preview_items: previewItems } : {}),
  };
}

function extractChannelFields(host, html) {
  if (host === 'sokoglam.com') return extractSokoGlamFields(html);
  return {};
}

function readExistingQuality(seedData, snapshot, summaryKey, assetKey = summaryKey) {
  const summaries = [
    ensureObject(seedData.pdp_field_quality_summary),
    ensureObject(snapshot.pdp_field_quality_summary),
    ensureObject(seedData.pdp_content_asset_v1).fields,
    ensureObject(snapshot.pdp_content_asset_v1).fields,
  ];
  for (const summary of summaries) {
    const item = ensureObject(summary?.[summaryKey] || summary?.[assetKey]);
    const status = normalizeText(item.source_quality_status).toLowerCase();
    const origin = normalizeText(item.source_origin).toLowerCase();
    if (status || origin) return { status, origin };
  }
  return { status: '', origin: '' };
}

function isForceFilledExisting(seedData, snapshot, summaryKey, assetKey = summaryKey) {
  const quality = readExistingQuality(seedData, snapshot, summaryKey, assetKey);
  return quality.status.startsWith('force_filled') || /pivota_force_fill|force_fill/.test(quality.origin);
}

function buildSnapshotContract(existing) {
  return {
    ...ensureObject(existing),
    contract_version: SNAPSHOT_CONTRACT_VERSION,
    source: 'retail_pdp_channel_backfill',
    authoritative: true,
    structured_fields_authoritative: true,
    legacy_fields_quarantined: true,
    replace_strategy: 'missing_only_preserve_best_available',
    updated_at: new Date().toISOString(),
  };
}

function mergeQualitySummary(existing, patchKeys, sourceUrl) {
  const next = { ...ensureObject(existing) };
  const now = new Date().toISOString();
  const set = (key, sourceKind) => {
    next[key] = {
      source_origin: 'retail_pdp',
      source_quality_status: 'medium',
      source_kinds: [sourceKind],
      source_url: sourceUrl,
      reason_codes: ['exact_title_retailer_pdp_secondary_authority'],
      updated_at: now,
    };
  };
  if (patchKeys.includes('pdp_ingredients_raw')) set('ingredients_raw', 'retailer_pdp_full_ingredients');
  if (patchKeys.includes('pdp_active_ingredients_raw')) set('active_ingredients_raw', 'retailer_pdp_key_ingredients');
  if (patchKeys.includes('pdp_how_to_use_raw')) set('how_to_use_raw', 'retailer_pdp_how_to_use');
  if (patchKeys.includes('pdp_details_sections')) set('details_sections', 'retailer_pdp_details_section');
  return next;
}

function mergeContentAsset(existing, extracted, sourceUrl) {
  const next = {
    contract_version: PDP_CONTENT_ASSET_VERSION,
    owner: 'pivota',
    fields: { ...ensureObject(ensureObject(existing).fields) },
  };
  const now = new Date().toISOString();
  const set = (fieldKey, value, sourceKind) => {
    next.fields[fieldKey] = {
      review_state: 'assistant_reviewed',
      overwrite_policy: 'preserve_best_available',
      source_quality_status: 'medium',
      source_origin: 'retail_pdp',
      source_kind: sourceKind,
      source_url: sourceUrl,
      content_hash: hashContent(value),
      updated_at: now,
    };
  };
  if (extracted.pdp_ingredients_raw) set('ingredients_raw', extracted.pdp_ingredients_raw, 'retailer_pdp_full_ingredients');
  if (extracted.pdp_active_ingredients_raw) set('active_ingredients_raw', extracted.pdp_active_ingredients_raw, 'retailer_pdp_key_ingredients');
  if (extracted.pdp_how_to_use_raw) set('how_to_use_raw', extracted.pdp_how_to_use_raw, 'retailer_pdp_how_to_use');
  if (asArray(extracted.pdp_details_sections).length) set('details_sections', extracted.pdp_details_sections, 'retailer_pdp_details_section');
  return next;
}

function mergeDetails(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const section of [...asArray(existing), ...asArray(incoming)]) {
    const heading = normalizeText(section?.heading || section?.title);
    const body = normalizeText(section?.body || section?.content || section?.text);
    if (!heading || body.length < 20) continue;
    const key = `${heading.toLowerCase()}::${body.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ heading, body });
    if (out.length >= 8) break;
  }
  return out;
}

function reviewPreviewCount(summary) {
  const safe = ensureObject(summary);
  return asArray(safe.preview_items).length || asArray(safe.snippets).length;
}

function hasReviewAggregate(summary) {
  const safe = ensureObject(summary);
  return Number(safe.rating || safe.average_rating || 0) > 0 && Number(safe.review_count || safe.count || safe.total || 0) > 0;
}

function mergeReviewSummary(existing, incoming, sourceUrl) {
  const current = ensureObject(existing);
  const next = {
    ...current,
    ...incoming,
    source_origin: 'retail_pdp_reviews',
    source_url: sourceUrl,
    content_review_state: 'assistant_reviewed',
    review_policy: 'source_backed_retailer_public_reviews',
    updated_at: new Date().toISOString(),
  };
  if (asArray(current.star_distribution).length && !asArray(incoming.star_distribution).length) {
    next.star_distribution = current.star_distribution;
    next.rating_distribution = current.rating_distribution || current.star_distribution;
  }
  return next;
}

function buildSeedDataPatch(row, extracted, sourceUrl, options = {}) {
  const seedData = JSON.parse(JSON.stringify(ensureObject(row.seed_data)));
  const snapshot = ensureObject(seedData.snapshot);
  const patchKeys = [];
  const missingFieldsOnly = options.missingFieldsOnly !== false;
  const hasExisting = (fieldKey) => {
    if (!missingFieldsOnly) return false;
    if (fieldKey === 'pdp_ingredients_raw') {
      if (isForceFilledExisting(seedData, snapshot, 'ingredients_raw')) return false;
      return looksLikeFullInci(seedData.pdp_ingredients_raw || snapshot.pdp_ingredients_raw || seedData.raw_ingredient_text_clean || snapshot.raw_ingredient_text_clean);
    }
    if (fieldKey === 'pdp_active_ingredients_raw') {
      if (isForceFilledExisting(seedData, snapshot, 'active_ingredients_raw')) return false;
      return normalizeText(seedData.pdp_active_ingredients_raw || snapshot.pdp_active_ingredients_raw).length >= 20 ||
        asArray(seedData.active_ingredients || snapshot.active_ingredients).length > 0;
    }
    if (fieldKey === 'pdp_how_to_use_raw') {
      if (isForceFilledExisting(seedData, snapshot, 'how_to_use_raw')) return false;
      return looksLikeHowToUse(seedData.pdp_how_to_use_raw || snapshot.pdp_how_to_use_raw);
    }
    if (fieldKey === 'pdp_details_sections') {
      return asArray(seedData.pdp_details_sections || snapshot.pdp_details_sections).length > 0;
    }
    if (fieldKey === 'review_summary') {
      const existing = ensureObject(seedData.review_summary || snapshot.review_summary);
      return hasReviewAggregate(existing) && reviewPreviewCount(existing) > 0;
    }
    return false;
  };

  if (extracted.pdp_ingredients_raw && !hasExisting('pdp_ingredients_raw')) {
    seedData.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    seedData.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    snapshot.pdp_ingredients_raw = extracted.pdp_ingredients_raw;
    snapshot.raw_ingredient_text_clean = extracted.pdp_ingredients_raw;
    patchKeys.push('pdp_ingredients_raw');
  }
  if (extracted.pdp_active_ingredients_raw && !hasExisting('pdp_active_ingredients_raw')) {
    const activeItems = Array.from(new Set(extracted.pdp_active_ingredients_raw.split(/,|;|\n/).map(normalizeText).filter(Boolean)));
    seedData.pdp_active_ingredients_raw = extracted.pdp_active_ingredients_raw;
    seedData.active_ingredients = activeItems;
    snapshot.pdp_active_ingredients_raw = extracted.pdp_active_ingredients_raw;
    snapshot.active_ingredients = activeItems;
    patchKeys.push('pdp_active_ingredients_raw');
  }
  if (extracted.pdp_how_to_use_raw && !hasExisting('pdp_how_to_use_raw')) {
    seedData.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    snapshot.pdp_how_to_use_raw = extracted.pdp_how_to_use_raw;
    patchKeys.push('pdp_how_to_use_raw');
  }
  if (asArray(extracted.pdp_details_sections).length && !hasExisting('pdp_details_sections')) {
    const merged = mergeDetails(seedData.pdp_details_sections || snapshot.pdp_details_sections, extracted.pdp_details_sections);
    seedData.pdp_details_sections = merged;
    snapshot.pdp_details_sections = merged;
    patchKeys.push('pdp_details_sections');
  }
  if (extracted.review_summary && !hasExisting('review_summary')) {
    const incoming = mergeReviewSummary(seedData.review_summary || snapshot.review_summary, extracted.review_summary, sourceUrl);
    seedData.review_summary = incoming;
    snapshot.review_summary = incoming;
    patchKeys.push('review_summary');
  }

  if (patchKeys.some((key) => key !== 'review_summary')) {
    const quality = mergeQualitySummary(seedData.pdp_field_quality_summary || snapshot.pdp_field_quality_summary, patchKeys, sourceUrl);
    seedData.pdp_field_quality_summary = quality;
    snapshot.pdp_field_quality_summary = quality;
    seedData.pdp_content_asset_v1 = mergeContentAsset(seedData.pdp_content_asset_v1 || snapshot.pdp_content_asset_v1, extracted, sourceUrl);
    snapshot.pdp_content_asset_v1 = seedData.pdp_content_asset_v1;
    seedData.external_seed_snapshot_contract = buildSnapshotContract(seedData.external_seed_snapshot_contract);
    snapshot.external_seed_snapshot_contract = buildSnapshotContract(snapshot.external_seed_snapshot_contract);
  }

  if (patchKeys.length) {
    const marker = {
      contract_version: CONTRACT_VERSION,
      source_origin: 'retail_pdp',
      source_url: sourceUrl,
      updated_at: new Date().toISOString(),
      fields: patchKeys,
      authority_scope: 'secondary_content_authority_exact_product_match',
    };
    seedData.channel_pdp_fields_v1 = marker;
    snapshot.channel_pdp_fields_v1 = marker;
  }

  seedData.snapshot = snapshot;
  return { seedData, patchKeys };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(process.env.CHANNEL_PDP_TIMEOUT_MS || 20000)),
    headers: {
      'user-agent': 'Mozilla/5.0 Pivota channel PDP field audit',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  const html = await response.text();
  return { status: response.status, final_url: response.url, html };
}

async function fetchRows(ids, market) {
  const result = await query(
    `
      SELECT id, external_product_id, title, domain, market, canonical_url, destination_url, price_currency, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        AND ($2::text = '' OR market = $2::text)
      ORDER BY array_position($1::text[], external_product_id::text)
    `,
    [ids, market],
  );
  return result.rows || [];
}

function buildServingPayloadPatch(seedData, patchKeys) {
  const snapshot = ensureObject(seedData.snapshot);
  const patch = {};
  const copyFirst = (targetKey, ...sourceKeys) => {
    for (const key of sourceKeys) {
      if (seedData[key] !== undefined) {
        patch[targetKey] = seedData[key];
        return;
      }
      if (snapshot[key] !== undefined) {
        patch[targetKey] = snapshot[key];
        return;
      }
    }
  };
  if (patchKeys.includes('pdp_ingredients_raw')) {
    copyFirst('pdp_ingredients_raw', 'pdp_ingredients_raw');
    copyFirst('raw_ingredient_text_clean', 'raw_ingredient_text_clean', 'pdp_ingredients_raw');
  }
  if (patchKeys.includes('pdp_active_ingredients_raw')) {
    copyFirst('pdp_active_ingredients_raw', 'pdp_active_ingredients_raw');
    copyFirst('active_ingredients', 'active_ingredients');
  }
  if (patchKeys.includes('pdp_how_to_use_raw')) copyFirst('pdp_how_to_use_raw', 'pdp_how_to_use_raw');
  if (patchKeys.includes('pdp_details_sections')) copyFirst('pdp_details_sections', 'pdp_details_sections');
  if (patchKeys.includes('review_summary')) copyFirst('review_summary', 'review_summary');
  copyFirst('pdp_field_quality_summary', 'pdp_field_quality_summary');
  copyFirst('pdp_content_asset_v1', 'pdp_content_asset_v1');
  copyFirst('channel_pdp_fields_v1', 'channel_pdp_fields_v1');
  copyFirst('external_seed_snapshot_contract', 'external_seed_snapshot_contract');
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

async function syncServingMirrors(externalProductId, seedData, patchKeys) {
  const payloadPatch = buildServingPayloadPatch(seedData, patchKeys);
  if (!Object.keys(payloadPatch).length) return { catalog_products: 0, pdp_identity_listing: 0 };
  const payloadJson = stringifyPostgresJsonb(payloadPatch);
  const reviewSummaryJson = payloadPatch.review_summary ? stringifyPostgresJsonb(payloadPatch.review_summary) : null;
  const catalogRes = await query(
    `
      UPDATE catalog_products
      SET product_payload = COALESCE(product_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE merchant_id = 'external_seed'
        AND platform = 'external_seed'
        AND source_product_id = $1
    `,
    [externalProductId, payloadJson],
  );
  const identityRes = await query(
    `
      UPDATE pdp_identity_listing
      SET source_payload = COALESCE(source_payload, '{}'::jsonb) || $2::jsonb,
          review_summary = CASE
            WHEN $3::jsonb IS NULL THEN review_summary
            ELSE $3::jsonb
          END,
          updated_at = NOW()
      WHERE source_listing_ref = $1
    `,
    [`external_seed:${externalProductId}`, payloadJson, reviewSummaryJson],
  );
  return {
    catalog_products: Number(catalogRes.rowCount || 0),
    pdp_identity_listing: Number(identityRes.rowCount || 0),
  };
}

async function main() {
  const mappings = readCandidateMappings();
  if (!mappings.length) throw new Error('missing_candidate_mappings');
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun') || !hasFlag('apply');
  const market = normalizeText(argValue('market') || 'US').toUpperCase();
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const rows = await fetchRows(Array.from(new Set(mappings.map((item) => item.target_id))), market);
  const rowsById = new Map(rows.map((row) => [row.external_product_id, row]));
  const results = [];

  for (const mapping of mappings) {
    const row = rowsById.get(mapping.target_id);
    const sourceUrl = normalizeText(mapping.source_url);
    const sourceHost = hostFromUrl(sourceUrl);
    const result = {
      external_product_id: mapping.target_id,
      title: row?.title || '',
      source_external_product_id: mapping.source_external_product_id || null,
      source_url: sourceUrl,
      source_host: sourceHost,
      status: 'skipped',
      patch_keys: [],
    };
    if (!row) {
      result.reason = 'target_not_found';
      results.push(result);
      continue;
    }
    if (!TRUSTED_CHANNEL_HOSTS.has(sourceHost)) {
      result.reason = 'untrusted_channel_host';
      results.push(result);
      continue;
    }
    try {
      const fetched = await fetchHtml(sourceUrl);
      result.http_status = fetched.status;
      result.final_url = fetched.final_url;
      if (fetched.status < 200 || fetched.status >= 300) {
        result.reason = 'source_http_not_ok';
        results.push(result);
        continue;
      }
      const extracted = extractChannelFields(sourceHost, fetched.html);
      const titleScore = scoreProductTitleMatch(extracted.source_title, row.title);
      result.source_title = extracted.source_title;
      result.title_match_score = Number(titleScore.toFixed(3));
      result.extracted_summary = {
        ingredients_chars: normalizeText(extracted.pdp_ingredients_raw).length,
        active_ingredients_chars: normalizeText(extracted.pdp_active_ingredients_raw).length,
        how_to_chars: normalizeText(extracted.pdp_how_to_use_raw).length,
        details_sections_count: asArray(extracted.pdp_details_sections).length,
        review_count: extracted.review_summary?.review_count || 0,
        rating: extracted.review_summary?.rating || 0,
        review_preview_count: reviewPreviewCount(extracted.review_summary),
      };
      if (titleScore < 0.9) {
        result.reason = 'source_title_mismatch';
        results.push(result);
        continue;
      }
      const { seedData, patchKeys } = buildSeedDataPatch(row, extracted, sourceUrl, { missingFieldsOnly: true });
      result.patch_keys = patchKeys;
      if (!patchKeys.length) {
        result.reason = 'no_missing_channel_fields';
        results.push(result);
        continue;
      }
      result.status = dryRun ? 'dry_run' : 'updated';
      if (!dryRun) {
        await query(
          `
            UPDATE external_product_seeds
            SET seed_data = $2::jsonb,
                updated_at = NOW()
            WHERE external_product_id = $1
          `,
          [row.external_product_id, stringifyPostgresJsonb(seedData)],
        );
        result.serving_mirror_sync = await syncServingMirrors(row.external_product_id, seedData, patchKeys);
      } else {
        result.serving_mirror_sync = { planned: true };
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error?.message || String(error);
    }
    results.push(result);
  }

  const summary = {
    scanned: rows.length,
    dry_run: results.filter((item) => item.status === 'dry_run').length,
    updated: results.filter((item) => item.status === 'updated').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
    by_field: results.reduce((acc, item) => {
      for (const key of item.patch_keys || []) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    market,
    contract_version: CONTRACT_VERSION,
    summary,
    results,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
