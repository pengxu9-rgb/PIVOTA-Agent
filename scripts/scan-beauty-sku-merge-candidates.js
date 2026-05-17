#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const BEAUTY_RE =
  /\b(beauty|skin\s*care|skincare|make\s*up|makeup|cosmetic|cosmetics|fragrance|perfume|cologne|hair\s*care|haircare|body\s*care|sunscreen|spf|serum|moisturi[sz]er|cleanser|toner|essence|ampoule|cream|lotion|mascara|lipstick|lip\s*gloss|blush|foundation|concealer|eyeliner|eye\s*shadow|eyeshadow|bronzer|powder|shampoo|conditioner|deodorant|nail|soap|body\s*wash)\b/i;
const TITLE_VARIANT_RE =
  /\b(mini|jumbo|travel|refill|refillable|duo|trio|set|kit|bundle|limited|matte|gloss|satin|shimmer|black|brown|blonde|clear|red|pink|rose|nude|beige|ivory|fair|light|medium|tan|deep|dark)\b/gi;
const SIZE_RE =
  /\b\d+(?:\.\d+)?\s*(?:ml|milliliter|milliliters|l|liter|liters|fl\s*oz|floz|oz|ounce|ounces|g|gram|grams|kg|count|ct|pc|pcs|piece|pieces|sheets?|pads?|capsules?|tablets?)\b|\b\d+\s*(?:-|x)?\s*(?:pack|pk)\b|\bpack\s*of\s*\d+\b/gi;
const STOP_TOKENS = new Set([
  'the',
  'and',
  'for',
  'with',
  'without',
  'skin',
  'face',
  'facial',
  'beauty',
  'new',
]);

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseDelimited(value) {
  return unique(
    asString(value)
      .split(/;;|,|\n/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

async function readDelimitedFile(filePath) {
  const target = asString(filePath);
  if (!target) return [];
  const text = await fs.readFile(path.resolve(target), 'utf8');
  return parseDelimited(text);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join('/');
  return String(value).trim();
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function unique(values) {
  return Array.from(new Set(values.map(asString).filter(Boolean))).sort();
}

function normalizeText(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[™®©]/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9.%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBrand(value) {
  return normalizeText(value)
    .replace(/\b(?:inc|llc|ltd|co|company|beauty|cosmetics)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleWithoutBrand(title, brand) {
  let out = normalizeText(title);
  const brandKey = normalizeBrand(brand);
  if (!out || !brandKey) return out;
  const tokens = brandKey.split(/\s+/).filter(Boolean);
  if (!tokens.length) return out;
  return out
    .replace(new RegExp(`\\b(?:${tokens.map(escapeRegex).join('\\s+')})\\b`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCore(title, brand) {
  return titleWithoutBrand(title, brand)
    .replace(SIZE_RE, ' ')
    .replace(/\b(?:mini|jumbo|travel\s*size|value\s*size|refill|refillable)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_TOKENS.has(token));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function parsePayload(row) {
  const payload = asObject(row.product_payload);
  const seedData = asObject(payload.seed_data);
  const externalSeed = asObject(payload.external_seed);
  const snapshot = asObject(seedData.snapshot || payload.snapshot);
  return { payload, seedData, externalSeed, snapshot };
}

function first(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function categorySignals(row) {
  const { payload, seedData, externalSeed, snapshot } = parsePayload(row);
  return [
    row.category_path,
    row.category,
    row.product_type,
    payload.category_path,
    payload.catalog_category_path,
    payload.category,
    payload.product_type,
    seedData.category_path,
    seedData.catalog_category_path,
    seedData.category,
    seedData.product_type,
    externalSeed.category_path,
    externalSeed.category,
    externalSeed.product_type,
    snapshot.category_path,
    snapshot.catalog_category_path,
    snapshot.category,
    snapshot.product_type,
  ].map(asString).filter(Boolean);
}

function beautyScope(row) {
  const categoryText = categorySignals(row).join(' ');
  if (BEAUTY_RE.test(categoryText)) return { ok: true, reason: 'category_or_product_type' };
  const payloadText = JSON.stringify(parsePayload(row).payload || {});
  if (/\bbeauty\/(?:skincare|makeup|fragrance|hair|body)\b/i.test(payloadText)) {
    return { ok: true, reason: 'payload_beauty_category_path' };
  }
  return { ok: false, reason: 'not_beauty_category' };
}

function hostFromUrl(value) {
  const text = asString(value);
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function rowUrls(row) {
  const { payload, seedData, externalSeed, snapshot } = parsePayload(row);
  return [
    row.official_url,
    row.canonical_url,
    payload.destination_url,
    payload.destinationUrl,
    payload.source_url,
    payload.sourceUrl,
    payload.url,
    payload.canonical_url,
    payload.canonicalUrl,
    externalSeed.destination_url,
    externalSeed.canonical_url,
    externalSeed.url,
    seedData.destination_url,
    seedData.canonical_url,
    seedData.url,
    snapshot.destination_url,
    snapshot.canonical_url,
    snapshot.url,
  ].map(asString).filter(Boolean);
}

function sellerSurface(row) {
  if (asString(row.merchant_id) !== EXTERNAL_SEED_MERCHANT_ID) {
    return {
      key: `merchant:${asString(row.merchant_id)}`,
      label: first(row.merchant_name, row.merchant_id),
      host: '',
    };
  }
  const { payload, seedData, externalSeed, snapshot } = parsePayload(row);
  const host = rowUrls(row).map(hostFromUrl).find(Boolean) || '';
  return {
    key: host ? `external_host:${host}` : EXTERNAL_SEED_MERCHANT_ID,
    label: first(
      payload.merchant_name,
      payload.seller_name,
      payload.store_name,
      externalSeed.merchant_name,
      externalSeed.seller_name,
      seedData.merchant_display_name,
      seedData.merchant_name,
      seedData.merchant_inferred,
      seedData.seller_name,
      snapshot.merchant_name,
      host,
      EXTERNAL_SEED_MERCHANT_ID,
    ),
    host,
  };
}

function extractSizes(...values) {
  const text = normalizeText(values.join(' '));
  const out = [];
  let match;
  const re = new RegExp(SIZE_RE.source, 'gi');
  while ((match = re.exec(text))) out.push(match[0].replace(/\s+/g, ''));
  return unique(out);
}

function extractVariantWords(...values) {
  const text = normalizeText(values.join(' '));
  const out = [];
  let match;
  const re = new RegExp(TITLE_VARIANT_RE.source, 'gi');
  while ((match = re.exec(text))) out.push(match[0].toLowerCase());
  return unique(out);
}

function extractGtins(row) {
  const strong = asObject(row.strong_identity);
  const { payload, seedData, externalSeed, snapshot } = parsePayload(row);
  const candidates = [
    ...asArray(strong.gtins),
    ...asArray(strong.gtin),
    ...asArray(strong.upcs),
    ...asArray(strong.upc),
    ...asArray(strong.ean),
    ...asArray(payload.gtin),
    ...asArray(payload.upc),
    ...asArray(seedData.gtin),
    ...asArray(seedData.upc),
    ...asArray(externalSeed.gtin),
    ...asArray(externalSeed.upc),
    ...asArray(snapshot.gtin),
    ...asArray(snapshot.upc),
  ];
  return unique(
    candidates
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .map((item) => asString(item).replace(/[^0-9A-Za-z]/g, '').toLowerCase()),
  );
}

function member(row) {
  return {
    product_key: asString(row.product_key),
    merchant_id: asString(row.merchant_id),
    seller_surface: row.seller_surface_key,
    seller_label: row.seller_surface_label,
    host: row.seller_host,
    product_id: asString(row.source_product_id),
    title: asString(row.title),
    brand: asString(row.brand || row.brand_norm),
    category: first(row.category_path, row.category, row.product_type),
    content_key: asString(row.content_key),
    sig: asString(row.pivota_signature_id),
    product_group_id: asString(row.product_group_id),
    is_primary: row.is_primary === true,
    sku_count: Number(row.sku_count || 0),
    offer_count: Number(row.offer_count || 0),
    sku_titles: asArray(row.sku_titles).slice(0, 8),
    sizes: row.sizes,
    variant_words: row.variant_words,
    gtins: row.gtins,
    urls: rowUrls(row).slice(0, 4),
  };
}

function groupBy(rows, fn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function summarizeGroup(rows) {
  return {
    member_count: rows.length,
    seller_surface_count: unique(rows.map((row) => row.seller_surface_key)).length,
    content_keys: unique(rows.map((row) => row.content_key)),
    product_group_ids: unique(rows.map((row) => row.product_group_id)),
    sig_ids: unique(rows.map((row) => row.pivota_signature_id)),
    brands: unique(rows.map((row) => row.brand_key)),
    title_cores: unique(rows.map((row) => row.title_core_key)),
    sku_count: rows.reduce((sum, row) => sum + Number(row.sku_count || 0), 0),
    offer_count: rows.reduce((sum, row) => sum + Number(row.offer_count || 0), 0),
    members: rows
      .slice()
      .sort((a, b) => Number(b.is_primary === true) - Number(a.is_primary === true) || a.seller_surface_key.localeCompare(b.seller_surface_key))
      .map(member),
  };
}

function classifySameContentKey(rows) {
  const productGroupIds = unique(rows.map((row) => row.product_group_id));
  const missingMembers = rows.filter((row) => !asString(row.product_group_id)).length;
  const primaryCount = rows.filter((row) => row.is_primary === true).length;
  if (missingMembers > 0 || productGroupIds.length > 1 || primaryCount !== 1) {
    return {
      action: 'merge_needed',
      reason: [
        missingMembers ? `${missingMembers} members missing product_group_members` : '',
        productGroupIds.length > 1 ? 'split product_group_members' : '',
        primaryCount !== 1 ? `primary_count=${primaryCount}` : '',
      ].filter(Boolean).join('; '),
    };
  }
  return { action: 'already_merged', reason: 'same content_key already has one product group' };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let idx = 0; idx < items.length; idx += size) chunks.push(items.slice(idx, idx + size));
  return chunks;
}

async function fetchSkuAgg(productKeys) {
  const out = new Map();
  for (const keys of chunkArray(productKeys, 500)) {
    const result = await query(
      `
        SELECT
          s.product_key,
          COUNT(*)::int AS sku_count,
          jsonb_agg(DISTINCT s.sku_key) FILTER (WHERE s.sku_key IS NOT NULL) AS sku_keys,
          jsonb_agg(DISTINCT COALESCE(s.sku, s.source_variant_id, s.sku_key::text))
            FILTER (WHERE COALESCE(s.sku, s.source_variant_id, s.sku_key::text) IS NOT NULL) AS sku_ids,
          jsonb_agg(DISTINCT s.title) FILTER (WHERE s.title IS NOT NULL) AS sku_titles
        FROM catalog_skus s
        WHERE s.product_key = ANY($1::text[])
        GROUP BY s.product_key
      `,
      [keys],
    );
    for (const row of result.rows || []) out.set(asString(row.product_key), row);
  }
  return out;
}

async function fetchOfferAgg(productKeys) {
  const out = new Map();
  for (const keys of chunkArray(productKeys, 500)) {
    const result = await query(
      `
        SELECT
          s.product_key,
          COUNT(DISTINCT o.offer_id)::int AS offer_count,
          MIN(COALESCE(o.merchant_effective_price, o.estimated_best_price, o.list_price)) AS offer_price_min,
          MAX(COALESCE(o.merchant_effective_price, o.estimated_best_price, o.list_price)) AS offer_price_max
        FROM catalog_skus s
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        WHERE s.product_key = ANY($1::text[])
        GROUP BY s.product_key
      `,
      [keys],
    );
    for (const row of result.rows || []) out.set(asString(row.product_key), row);
  }
  return out;
}

async function fetchRows({ market, sqlBeautyPrefilter = false }) {
  return fetchRowsForScope({ market, sqlBeautyPrefilter });
}

function buildScopedSqlFilters({ brandFilters = [], sourceProductIds = [] }, params) {
  const filters = [];
  const lowerBrands = unique(brandFilters.map((brand) => brand.toLowerCase()));
  if (lowerBrands.length) {
    const patterns = unique(lowerBrands.flatMap((brand) => [`%${brand}%`, `%${normalizeBrand(brand)}%`]));
    const normBrands = unique(lowerBrands.map(normalizeBrand));
    params.push(lowerBrands);
    const exactIdx = params.length;
    params.push(patterns);
    const patternIdx = params.length;
    params.push(normBrands);
    const normIdx = params.length;
    filters.push(`
      (
        LOWER(COALESCE(cp.brand, pil.brand_norm, cp.product_payload->>'brand', cp.product_payload->'snapshot'->>'brand', '')) = ANY($${exactIdx}::text[])
        OR LOWER(COALESCE(cp.brand, pil.brand_norm, cp.product_payload->>'brand', cp.product_payload->'snapshot'->>'brand', '')) LIKE ANY($${patternIdx}::text[])
        OR btrim(regexp_replace(
          LOWER(COALESCE(cp.brand, pil.brand_norm, cp.product_payload->>'brand', cp.product_payload->'snapshot'->>'brand', '')),
          '[^a-z0-9]+',
          ' ',
          'g'
        )) = ANY($${normIdx}::text[])
      )
    `);
  }

  const productIds = unique(sourceProductIds);
  if (productIds.length) {
    params.push(productIds);
    filters.push(`cp.source_product_id = ANY($${params.length}::text[])`);
  }

  return filters.length ? `AND (${filters.join('\nOR\n')})` : '';
}

async function fetchRowsForScope({ market, sqlBeautyPrefilter = false, brandFilters = [], sourceProductIds = [] }) {
  const prefilterSql = sqlBeautyPrefilter
    ? `
        AND (
             cp.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'
          OR COALESCE(cp.category_path, '') ~* '(beauty|skin.?care|skincare|make.?up|makeup|cosmetic|fragrance|perfume|hair.?care|body.?care)'
          OR COALESCE(cp.category, '') ~* '(beauty|skin.?care|skincare|make.?up|makeup|cosmetic|fragrance|perfume|hair.?care|body.?care)'
          OR COALESCE(cp.product_type, '') ~* '(beauty|skin.?care|skincare|make.?up|makeup|cosmetic|fragrance|perfume|hair.?care|body.?care|serum|moisturi[sz]er|cleanser|toner|cream|lotion|mascara|lipstick|blush|foundation|concealer|eyeliner|eyeshadow)'
        )
      `
    : '';
  const params = [market];
  const scopedFilterSql = buildScopedSqlFilters({ brandFilters, sourceProductIds }, params);
  const result = await query(
    `
      SELECT
        cp.product_key,
        cp.merchant_id,
        cp.platform,
        cp.source_product_id,
        cp.title,
        cp.brand,
        cp.category,
        cp.product_type,
        cp.category_path,
        cp.canonical_url,
        cp.image_url,
        cp.product_payload,
        cp.pivota_signature_id,
        cp.content_key,
        cp.pdp_lifecycle_stage,
        cp.updated_at,
        cm.merchant_name,
        pgm.product_group_id,
        COALESCE(pgm.is_primary, false) AS is_primary,
        pil.source_listing_ref,
        pil.sellable_item_group_id,
        pil.brand_norm,
        pil.title_core_norm,
        pil.variant_axes,
        pil.strong_identity,
        pil.official_url
      FROM catalog_products cp
      LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      LEFT JOIN pdp_identity_listing pil
        ON pil.merchant_id = cp.merchant_id
       AND pil.product_id = cp.source_product_id
      WHERE (cp.pdp_lifecycle_stage IS NULL OR cp.pdp_lifecycle_stage NOT IN ('hold','archived'))
        AND COALESCE(cp.product_payload->>'market', cp.product_payload->>'market_code', cp.product_payload->'snapshot'->>'market', 'US') = $1
        ${prefilterSql}
        ${scopedFilterSql}
    `,
    params,
  );
  const rows = result.rows || [];
  const productKeys = unique(rows.map((row) => row.product_key));
  const skuAgg = await fetchSkuAgg(productKeys);
  const offerAgg = await fetchOfferAgg(productKeys);
  return rows.map((row) => {
    const sku = skuAgg.get(asString(row.product_key)) || {};
    const offer = offerAgg.get(asString(row.product_key)) || {};
    return {
      ...row,
      sku_count: Number(sku.sku_count || 0),
      sku_keys: sku.sku_keys || [],
      sku_ids: sku.sku_ids || [],
      sku_titles: sku.sku_titles || [],
      offer_count: Number(offer.offer_count || 0),
      offer_price_min: offer.offer_price_min || null,
      offer_price_max: offer.offer_price_max || null,
    };
  });
}

function enrichRows(rows) {
  return rows.map((row) => {
    const scope = beautyScope(row);
    const surface = sellerSurface(row);
    const skuText = asArray(row.sku_titles).join(' ');
    const brand = first(row.brand, row.brand_norm);
    const core = titleCore(row.title, brand);
    return {
      ...row,
      beauty_scope: scope.ok,
      beauty_scope_reason: scope.reason,
      seller_surface_key: surface.key,
      seller_surface_label: surface.label,
      seller_host: surface.host,
      brand_key: normalizeBrand(brand),
      title_core_key: core,
      title_tokens: tokens(core),
      sizes: extractSizes(row.title, skuText),
      variant_words: extractVariantWords(row.title, skuText),
      gtins: extractGtins(row),
    };
  });
}

function buildSameContentKeyGroups(rows) {
  const out = [];
  for (const [contentKey, members] of groupBy(rows, (row) => row.content_key).entries()) {
    if (!contentKey) continue;
    if (unique(members.map((row) => row.seller_surface_key)).length < 2) continue;
    const classification = classifySameContentKey(members);
    out.push({
      kind: 'same_content_key_cross_seller',
      content_key: contentKey,
      ...classification,
      ...summarizeGroup(members),
    });
  }
  return out.sort((a, b) => a.action.localeCompare(b.action) || b.offer_count - a.offer_count);
}

function buildGtinCandidates(rows) {
  const expanded = [];
  for (const row of rows) {
    for (const gtin of row.gtins) expanded.push({ gtin, row });
  }
  const out = [];
  for (const [gtin, entries] of groupBy(expanded, (entry) => entry.gtin).entries()) {
    const members = entries.map((entry) => entry.row);
    if (members.length < 2) continue;
    if (unique(members.map((row) => row.seller_surface_key)).length < 2) continue;
    if (unique(members.map((row) => row.product_group_id)).length <= 1) continue;
    out.push({
      kind: 'exact_gtin_cross_group',
      action: 'merge_needed',
      reason: 'same GTIN across different product groups/content keys',
      gtin,
      ...summarizeGroup(members),
    });
  }
  return out.sort((a, b) => b.seller_surface_count - a.seller_surface_count || b.offer_count - a.offer_count);
}

function buildExactTitleCandidates(rows, max = 200) {
  const out = [];
  const byKey = groupBy(rows, (row) => {
    const sizeSig = row.sizes.join('|');
    return `${row.brand_key}|${row.title_core_key}|${sizeSig}`;
  });
  for (const [key, members] of byKey.entries()) {
    if (!key || members.length < 2) continue;
    if (unique(members.map((row) => row.seller_surface_key)).length < 2) continue;
    if (unique(members.map((row) => row.product_group_id)).length <= 1) continue;
    if (unique(members.map((row) => row.content_key)).length <= 1) continue;
    const variantWordSigs = unique(members.map((row) => row.variant_words.join('|')));
    out.push({
      kind: 'exact_brand_title_size_cross_content_key',
      action: variantWordSigs.length <= 1 ? 'manual_review' : 'hold_variant_conflict',
      reason: variantWordSigs.length <= 1
        ? 'exact normalized brand/title/size but different content_key; needs source page review before merge'
        : 'exact title core but variant/shade/set words differ',
      key,
      variant_word_signatures: variantWordSigs,
      ...summarizeGroup(members),
    });
  }
  return out.sort((a, b) => a.action.localeCompare(b.action) || b.offer_count - a.offer_count).slice(0, max);
}

function buildFuzzyReviewCandidates(rows, max = 100) {
  const bySurface = groupBy(rows, (row) => row.seller_surface_key);
  const surfaces = Array.from(bySurface.keys()).sort();
  const out = [];
  const seen = new Set();
  for (let i = 0; i < surfaces.length; i += 1) {
    for (let j = i + 1; j < surfaces.length; j += 1) {
      const leftRows = bySurface.get(surfaces[i]) || [];
      const rightRows = bySurface.get(surfaces[j]) || [];
      const rightIndex = groupBy(rightRows, (row) => `${row.brand_key}|${row.title_tokens[0] || ''}`);
      for (const left of leftRows) {
        const possible = rightIndex.get(`${left.brand_key}|${left.title_tokens[0] || ''}`) || [];
        for (const right of possible) {
          if (left.product_group_id && left.product_group_id === right.product_group_id) continue;
          if (left.content_key && left.content_key === right.content_key) continue;
          const score = jaccard(left.title_tokens, right.title_tokens);
          if (score < 0.82) continue;
          const sizeMismatch = left.sizes.length && right.sizes.length && left.sizes.join('|') !== right.sizes.join('|');
          const key = [left.product_key, right.product_key].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            kind: 'fuzzy_cross_content_key',
            action: sizeMismatch ? 'hold_size_conflict' : 'manual_review',
            reason: sizeMismatch ? 'similar title but size differs' : 'strong title similarity; no deterministic shared identity',
            score: Number(score.toFixed(4)),
            left: member(left),
            right: member(right),
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.action.localeCompare(b.action) || b.score - a.score).slice(0, max);
}

function csvRows(items) {
  const rows = [[
    'kind',
    'action',
    'reason',
    'brand',
    'title',
    'seller_surfaces',
    'content_keys',
    'product_group_ids',
    'sig_ids',
    'sku_count',
    'offer_count',
    'member_titles',
    'member_urls',
  ]];
  for (const item of items) {
    const members = item.members || [item.left, item.right].filter(Boolean);
    rows.push([
      item.kind,
      item.action,
      item.reason,
      unique(members.map((row) => row.brand)).join(' | '),
      unique(members.map((row) => row.title)).join(' | '),
      unique(members.map((row) => row.seller_surface || row.seller_label)).join(' | '),
      unique(members.map((row) => row.content_key)).join(' | '),
      unique(members.map((row) => row.product_group_id)).join(' | '),
      unique(members.map((row) => row.sig)).join(' | '),
      item.sku_count || members.reduce((sum, row) => sum + Number(row.sku_count || 0), 0),
      item.offer_count || members.reduce((sum, row) => sum + Number(row.offer_count || 0), 0),
      unique(members.map((row) => row.title)).join(' | '),
      unique(members.flatMap((row) => row.urls || [])).join(' | '),
    ]);
  }
  return rows.map((row) => row.map((value) => `"${asString(value).replace(/"/g, '""')}"`).join(',')).join('\n');
}

async function run() {
  const market = readArg('market', 'US');
  const outDir = readArg('out-dir', '');
  const fuzzyLimit = clampInt(readArg('fuzzy-limit', '100'), 100, 0, 1000);
  const sqlBeautyPrefilter = hasFlag('sql-beauty-prefilter') || hasFlag('sqlBeautyPrefilter');
  const brandFilters = parseDelimited(readArg('brands', ''));
  const sourceProductIds = unique([
    ...parseDelimited(readArg('source-product-ids', '')),
    ...(await readDelimitedFile(readArg('source-product-ids-file', ''))),
  ]);
  const allRows = enrichRows(await fetchRowsForScope({ market, sqlBeautyPrefilter, brandFilters, sourceProductIds }));
  const beautyRows = allRows.filter((row) => row.beauty_scope);
  const sameContentKey = buildSameContentKeyGroups(beautyRows);
  const gtinCandidates = buildGtinCandidates(beautyRows);
  const exactTitleCandidates = buildExactTitleCandidates(beautyRows);
  const fuzzyCandidates = buildFuzzyReviewCandidates(beautyRows, fuzzyLimit);
  const allCandidates = [
    ...sameContentKey.filter((item) => item.action !== 'already_merged'),
    ...gtinCandidates,
    ...exactTitleCandidates,
    ...fuzzyCandidates,
  ];

  const summary = {
    generated_at: new Date().toISOString(),
    market,
    sql_beauty_prefilter: sqlBeautyPrefilter,
    brand_filter_count: brandFilters.length,
    source_product_id_filter_count: sourceProductIds.length,
    product_rows_scanned: allRows.length,
    beauty_product_rows: beautyRows.length,
    beauty_product_groups: unique(beautyRows.map((row) => row.product_group_id)).length,
    beauty_content_keys: unique(beautyRows.map((row) => row.content_key)).length,
    beauty_seller_surfaces: unique(beautyRows.map((row) => row.seller_surface_key)).length,
    beauty_sku_count: beautyRows.reduce((sum, row) => sum + Number(row.sku_count || 0), 0),
    beauty_offer_count: beautyRows.reduce((sum, row) => sum + Number(row.offer_count || 0), 0),
    same_content_key_cross_seller_groups: sameContentKey.length,
    same_content_key_already_merged: sameContentKey.filter((item) => item.action === 'already_merged').length,
    same_content_key_merge_needed: sameContentKey.filter((item) => item.action === 'merge_needed').length,
    exact_gtin_merge_needed: gtinCandidates.length,
    exact_title_manual_review: exactTitleCandidates.filter((item) => item.action === 'manual_review').length,
    exact_title_variant_conflict_hold: exactTitleCandidates.filter((item) => item.action === 'hold_variant_conflict').length,
    fuzzy_manual_review: fuzzyCandidates.filter((item) => item.action === 'manual_review').length,
    fuzzy_conflict_hold: fuzzyCandidates.filter((item) => item.action !== 'manual_review').length,
    deterministic_merge_needed_total:
      sameContentKey.filter((item) => item.action === 'merge_needed').length + gtinCandidates.length,
  };

  const report = {
    status: 'success',
    summary,
    same_content_key_cross_seller: sameContentKey,
    exact_gtin_merge_candidates: gtinCandidates,
    exact_title_review_candidates: exactTitleCandidates,
    fuzzy_review_candidates: fuzzyCandidates,
  };

  if (outDir) {
    const target = path.resolve(outDir);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await fs.writeFile(path.join(target, 'beauty_sku_merge_scan.json'), `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(path.join(target, 'merge_candidates.csv'), `${csvRows(allCandidates)}\n`);
  }

  if (hasFlag('json') || !outDir) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ status: 'success', out_dir: path.resolve(outDir), summary }, null, 2)}\n`);
  }
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
