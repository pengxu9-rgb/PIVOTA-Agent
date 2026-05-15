#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { isTrustedSourceBackedShadeTextureUrl } = require('./backfill-source-backed-shade-swatches.cjs');

const DEFAULT_GATEWAY = 'https://agent.pivota.cc/api/gateway';
const DEFAULT_FRONTEND = 'https://agent.pivota.cc';
const DEFAULT_QUERIES = [
  'concealer',
  'foundation',
  'skin tint',
  'tinted moisturizer',
  'lipstick',
  'lip gloss',
  'lip liner',
  'blush',
  'bronzer',
  'eyeshadow',
  'eyeliner',
  'brow pencil',
];

const SHADE_AXIS_NAMES = new Set(['shade', 'color', 'colour', 'tone', 'hue']);
const PRODUCT_IMAGE_PATTERN =
  /(?:^|[^a-z0-9])(t\d+(?:product|beauty)|product|primary|hero|main|model|silo|ecomm|ecommerce|flat[-_\s]?lay|packaging|package|box|bottle|tube|compact|closed|open[-_\s]?box|with[-_\s]?cap|concrete[-_\s]?shot|pack[-_\s]?shot)(?:[^a-z0-9]|$)/i;
const SWATCH_IMAGE_PATTERN =
  /(?:^|[^a-z0-9])(swatch|shade|color[-_\s]?chip|colour[-_\s]?chip|color[-_\s]?tile|colour[-_\s]?tile)(?:[^a-z0-9]|$)/i;
const HEX_PATTERN = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

function argValues(name) {
  const out = [];
  for (let idx = 0; idx < process.argv.length; idx += 1) {
    if (process.argv[idx] === `--${name}`) {
      const value = process.argv[idx + 1];
      if (value && !value.startsWith('--')) out.push(value);
    }
  }
  return out;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function todayStamp() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeUrlSearchText(value) {
  const text = normalizeLower(value);
  if (!text) return '';
  try {
    const decoded = decodeURIComponent(text);
    return decoded && decoded !== text ? `${text} ${decoded}` : text;
  } catch {
    return text;
  }
}

function hasValidHex(value) {
  return HEX_PATTERN.test(normalizeString(value));
}

function likelyProductOnlyImageUrl(value) {
  const text = normalizeUrlSearchText(value);
  return Boolean(text && PRODUCT_IMAGE_PATTERN.test(text));
}

function likelyShadeSwatchImageUrl(value) {
  const text = normalizeUrlSearchText(value);
  return Boolean(text && SWATCH_IMAGE_PATTERN.test(text));
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => {
      if (item === undefined || item === null) return false;
      if (typeof item === 'string' && item.trim() === '') return false;
      return true;
    }),
  );
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function csvEscape(value) {
  const text = value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function compareAuditRows(left, right) {
  return (
    String(left.product_id || '').localeCompare(String(right.product_id || '')) ||
    String(left.merchant_id || '').localeCompare(String(right.merchant_id || '')) ||
    String(left.axis_source || '').localeCompare(String(right.axis_source || '')) ||
    String(left.variant_id || '').localeCompare(String(right.variant_id || '')) ||
    String(left.shade_name || '').localeCompare(String(right.shade_name || '')) ||
    String(left.visual_status || '').localeCompare(String(right.visual_status || '')) ||
    String(left.source_query || '').localeCompare(String(right.source_query || ''))
  );
}

function increment(map, key, amount = 1) {
  const normalized = normalizeString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 20) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

async function sleep(ms) {
  if (!(ms > 0)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postGateway(gateway, body, timeoutMs) {
  const res = await fetchWithTimeout(
    gateway,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parse_error: text.slice(0, 1000) };
  }
  return { ok: res.ok, status: res.status, json };
}

function getModule(payload, type) {
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  return modules.find((module) => module && module.type === type) || null;
}

function canonicalPdpPayload(response) {
  return (
    getModule(response, 'canonical')?.data?.pdp_payload ||
    response?.pdp_payload ||
    response?.payload?.pdp_payload ||
    response?.product?.pdp_payload ||
    null
  );
}

function getBrandName(product, fallback) {
  return normalizeString(product?.brand?.name || product?.brand_name || fallback);
}

function variantAxisOption(variant) {
  const options = Array.isArray(variant?.options) ? variant.options : [];
  return options.find((option) => SHADE_AXIS_NAMES.has(normalizeLower(option?.name))) || null;
}

function variantShadeLabel(variant) {
  const option = variantAxisOption(variant);
  return normalizeString(option?.value || variant?.shade_name || variant?.shade || '');
}

function productLineShadeLabel(option) {
  const axis = normalizeLower(option?.axis || option?.option_name || option?.name);
  if (!SHADE_AXIS_NAMES.has(axis)) return '';
  return normalizeString(option?.value || option?.label || option?.title || '');
}

function visualEvidenceFromVariant(variant) {
  return compactObject({
    swatch_image_url:
      variant?.swatch_image_url ||
      variant?.swatchImageUrl ||
      variant?.swatch?.image_url ||
      variant?.swatch?.imageUrl ||
      variant?.swatch?.url ||
      variant?.beauty_meta?.shade_image_url ||
      variant?.beautyMeta?.shade_image_url ||
      variant?.beautyMeta?.shadeImageUrl,
    shade_hex:
      variant?.swatch?.hex ||
      variant?.beauty_meta?.shade_hex ||
      variant?.beautyMeta?.shade_hex ||
      variant?.beautyMeta?.shadeHex ||
      variant?.shade_hex ||
      variant?.shadeHex,
    label_image_url: variant?.label_image_url || variant?.labelImageUrl,
    image_url: variant?.image_url || variant?.imageUrl || variant?.image,
  });
}

function visualEvidenceFromProductLineOption(option) {
  return compactObject({
    swatch_image_url:
      option?.swatch_image_url ||
      option?.swatchImageUrl ||
      option?.swatch?.image_url ||
      option?.swatch?.imageUrl ||
      option?.swatch?.url,
    shade_hex:
      option?.swatch_color ||
      option?.swatchColor ||
      option?.color_hex ||
      option?.colorHex ||
      option?.swatch?.hex,
    label_image_url: option?.label_image_url || option?.labelImageUrl,
    image_url: option?.image_url || option?.imageUrl || option?.image,
  });
}

function deriveKnownSourceShadeSwatchUrl(shadeValue, product) {
  const shadeKey = normalizeLower(shadeValue).replace(/[^a-z0-9]+/g, '');
  if (!shadeKey) return '';
  const brandName = normalizeLower(product?.brand?.name || product?.brand_name);
  const productUrl = normalizeLower(
    product?.url ||
      product?.canonical_url ||
      product?.canonicalUrl ||
      product?.product_url ||
      product?.source_url ||
      product?.destination_url,
  );
  if (brandName === 'rms beauty' || productUrl.includes('rmsbeauty.com')) {
    return `https://www.rmsbeauty.com/cdn/shop/files/${shadeKey}_100x.png`;
  }
  return '';
}

function classifyVisualEvidence(evidence, product, shadeLabel) {
  const shadeHex = evidence.shade_hex;
  if (hasValidHex(shadeHex)) {
    return {
      visual_status: 'real_swatch_or_hex',
      display_mode: 'hex_swatch',
      evidence_kind: 'shade_hex',
      chosen_visual_url: '',
      blocker_reason: '',
    };
  }

  const explicitSwatch = normalizeString(evidence.swatch_image_url);
  const explicitTextureSwatch = isTrustedSourceBackedShadeTextureUrl(explicitSwatch, shadeLabel);
  if (explicitSwatch && (explicitTextureSwatch || !likelyProductOnlyImageUrl(explicitSwatch))) {
    return {
      visual_status: 'real_swatch_or_hex',
      display_mode: 'image_swatch',
      evidence_kind: explicitTextureSwatch
        ? 'source_backed_texture_swatch'
        : likelyShadeSwatchImageUrl(explicitSwatch)
        ? 'explicit_swatch_image'
        : 'explicit_swatch_field_unpatterned',
      chosen_visual_url: explicitSwatch,
      blocker_reason: '',
    };
  }

  const labelOrImage = normalizeString(evidence.label_image_url || evidence.image_url);
  const labelTextureSwatch = isTrustedSourceBackedShadeTextureUrl(labelOrImage, shadeLabel);
  if (labelOrImage && likelyShadeSwatchImageUrl(labelOrImage) && !likelyProductOnlyImageUrl(labelOrImage)) {
    return {
      visual_status: 'real_swatch_or_hex',
      display_mode: 'image_swatch',
      evidence_kind: 'trusted_label_image_swatch',
      chosen_visual_url: labelOrImage,
      blocker_reason: '',
    };
  }
  if (labelTextureSwatch) {
    return {
      visual_status: 'real_swatch_or_hex',
      display_mode: 'image_swatch',
      evidence_kind: 'source_backed_texture_swatch',
      chosen_visual_url: labelOrImage,
      blocker_reason: '',
    };
  }

  const derived = deriveKnownSourceShadeSwatchUrl(shadeLabel, product);
  if (derived) {
    return {
      visual_status: 'real_swatch_or_hex',
      display_mode: 'image_swatch',
      evidence_kind: 'known_source_derived_swatch',
      chosen_visual_url: derived,
      blocker_reason: '',
    };
  }

  const productOnly = [explicitSwatch, evidence.label_image_url, evidence.image_url]
    .filter(Boolean)
    .filter((url) => !isTrustedSourceBackedShadeTextureUrl(url, shadeLabel))
    .find((url) => likelyProductOnlyImageUrl(url));
  if (productOnly) {
    return {
      visual_status: 'blocked_product_image_source',
      display_mode: 'text_chip',
      evidence_kind: 'product_image_rejected',
      chosen_visual_url: '',
      blocked_visual_url: productOnly,
      blocker_reason: 'product_or_packaging_image_not_allowed_for_shade_swatch',
    };
  }

  if (explicitSwatch || labelOrImage) {
    return {
      visual_status: 'text_fallback_missing_swatch',
      display_mode: 'text_chip',
      evidence_kind: 'ambiguous_image_rejected',
      chosen_visual_url: '',
      blocked_visual_url: explicitSwatch || labelOrImage,
      blocker_reason: 'image_not_trusted_as_shade_swatch',
    };
  }

  return {
    visual_status: 'text_fallback_missing_swatch',
    display_mode: 'text_chip',
    evidence_kind: 'missing_visual',
    chosen_visual_url: '',
    blocked_visual_url: '',
    blocker_reason: 'missing_source_backed_swatch_or_hex',
  };
}

function collectShadeRowsFromPayload({ productId, merchantId, sourceQuery, pdpPayload }) {
  const product = pdpPayload?.product || {};
  const rows = [];
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  for (const variant of variants) {
    const shadeLabel = variantShadeLabel(variant);
    if (!shadeLabel) continue;
    const evidence = visualEvidenceFromVariant(variant);
    const classification = classifyVisualEvidence(evidence, product, shadeLabel);
    rows.push({
      product_id: productId,
      merchant_id: merchantId || product?.merchant_id || 'external_seed',
      product_title: product?.title || '',
      brand_name: getBrandName(product, ''),
      source_query: sourceQuery || '',
      axis_source: 'variant',
      variant_id: variant?.variant_id || variant?.id || '',
      shade_name: shadeLabel,
      ...classification,
      source_swatch_image_url: evidence.swatch_image_url || '',
      source_shade_hex: evidence.shade_hex || '',
      source_label_image_url: evidence.label_image_url || '',
      source_image_url: evidence.image_url || '',
      product_url:
        product?.url ||
        product?.canonical_url ||
        product?.canonicalUrl ||
        product?.product_url ||
        product?.source_url ||
        '',
    });
  }

  const productLineOptions = Array.isArray(product?.product_line_options)
    ? product.product_line_options
    : [];
  for (const option of productLineOptions) {
    const shadeLabel = productLineShadeLabel(option);
    if (!shadeLabel) continue;
    const evidence = visualEvidenceFromProductLineOption(option);
    const classification = classifyVisualEvidence(evidence, product, shadeLabel);
    rows.push({
      product_id: productId,
      merchant_id: merchantId || product?.merchant_id || 'external_seed',
      product_title: product?.title || '',
      brand_name: getBrandName(product, ''),
      source_query: sourceQuery || '',
      axis_source: 'product_line_option',
      variant_id: option?.product_id || option?.option_id || '',
      shade_name: shadeLabel,
      ...classification,
      source_swatch_image_url: evidence.swatch_image_url || '',
      source_shade_hex: evidence.shade_hex || '',
      source_label_image_url: evidence.label_image_url || '',
      source_image_url: evidence.image_url || '',
      product_url:
        option?.url ||
        product?.url ||
        product?.canonical_url ||
        product?.canonicalUrl ||
        product?.product_url ||
        product?.source_url ||
        '',
    });
  }

  return rows;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await worker(items[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run);
  await Promise.all(runners);
  return out;
}

async function discoverBySearch({ gateway, queries, perQueryLimit, timeoutMs }) {
  const items = [];
  for (const query of queries) {
    const res = await postGateway(
      gateway,
      {
        operation: 'find_products_multi',
        payload: {
          search: { query, limit: perQueryLimit, in_stock_only: false },
          options: { debug: false },
        },
      },
      timeoutMs,
    );
    const products = Array.isArray(res.json?.products) ? res.json.products : [];
    for (const product of products) {
      const productId = normalizeString(product?.product_id || product?.id);
      if (!productId.startsWith('sig_')) continue;
      items.push({
        product_id: productId,
        merchant_id: normalizeString(product?.merchant_id || 'external_seed'),
        title: normalizeString(product?.title),
        brand: normalizeString(product?.brand || product?.brand_name),
        source_query: query,
      });
    }
  }
  return uniqBy(items, (item) => `${item.merchant_id}:${item.product_id}`);
}

async function discoverByDb({ limit }) {
  if (!process.env.DATABASE_URL) {
    const error = new Error('DATABASE_URL not configured');
    error.code = 'NO_DATABASE';
    throw error;
  }
  const { closePool, query } = require('../src/db');
  try {
    const res = await query(
      `
        SELECT
          product_id,
          merchant_id,
          brand_norm AS brand,
          title_norm AS title
        FROM pdp_identity_listing
        WHERE live_read_enabled = true
          AND product_id LIKE 'sig_%'
          AND (
            variant_axes::text ~* 'shade|color|colour|tone|hue'
            OR source_payload::text ~* 'shade|color|colour|tone|hue'
          )
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );
    return (res.rows || []).map((row) => ({
      product_id: normalizeString(row.product_id),
      merchant_id: normalizeString(row.merchant_id || 'external_seed'),
      title: normalizeString(row.title),
      brand: normalizeString(row.brand),
      source_query: 'db_identity_listing',
    }));
  } finally {
    await closePool().catch(() => {});
  }
}

async function fetchPdp({ gateway, item, timeoutMs }) {
  const res = await postGateway(
    gateway,
    {
      operation: 'get_pdp_v2',
      payload: {
        product_ref: {
          product_id: item.product_id,
          merchant_id: item.merchant_id || 'external_seed',
        },
        subject: { type: 'product_group', id: item.product_id },
        include: ['canonical', 'variant_selector', 'offers', 'product_intel'],
        options: { no_cache: true, cache_bypass: true, debug: false },
      },
    },
    timeoutMs,
  );
  if (!res.ok) {
    return { ok: false, status: res.status, error: `gateway_http_${res.status}` };
  }
  const pdpPayload = canonicalPdpPayload(res.json);
  if (!pdpPayload) return { ok: false, status: res.status, error: 'missing_canonical_pdp_payload' };
  return { ok: true, status: res.status, pdpPayload };
}

function summarizeRows(rows, candidates, errors, discoveryMode) {
  const productMap = new Map();
  const brands = {};
  const statuses = {};
  for (const row of rows) {
    increment(statuses, row.visual_status);
    increment(brands, normalizeLower(row.brand_name || 'unknown') || 'unknown');
    const key = `${row.merchant_id}:${row.product_id}`;
    if (!productMap.has(key)) {
      productMap.set(key, {
        product_id: row.product_id,
        merchant_id: row.merchant_id,
        product_title: row.product_title,
        brand_name: row.brand_name,
        shade_count: 0,
        real_swatch_or_hex_count: 0,
        text_fallback_missing_swatch_count: 0,
        blocked_product_image_source_count: 0,
      });
    }
    const product = productMap.get(key);
    product.shade_count += 1;
    product[`${row.visual_status}_count`] = (product[`${row.visual_status}_count`] || 0) + 1;
  }
  const products = [...productMap.values()];
  return {
    generated_at: new Date().toISOString(),
    discovery_mode: discoveryMode,
    candidate_count: candidates.length,
    pdp_error_count: errors.length,
    shade_option_count: rows.length,
    shade_pdp_count: products.length,
    status_counts: statuses,
    product_counts: {
      all_real_swatch_or_hex: products.filter((item) => item.real_swatch_or_hex_count === item.shade_count).length,
      has_text_fallback_missing_swatch: products.filter((item) => item.text_fallback_missing_swatch_count > 0).length,
      has_blocked_product_image_source: products.filter((item) => item.blocked_product_image_source_count > 0).length,
    },
    top_brands_by_shade_options: topEntries(brands, 25),
  };
}

async function main() {
  const mode = normalizeLower(argValue('mode', 'auto'));
  const gateway = argValue('gateway', DEFAULT_GATEWAY);
  const frontend = argValue('frontend', DEFAULT_FRONTEND).replace(/\/+$/, '');
  const limit = parsePositiveInt(argValue('limit'), 250, 1, 5000);
  const maxCandidates = parsePositiveInt(argValue('max-candidates'), limit, 1, 5000);
  const perQueryLimit = parsePositiveInt(argValue('per-query-limit'), 36, 1, 100);
  const timeoutMs = parsePositiveInt(argValue('timeout-ms'), 18000, 1000, 120000);
  const concurrency = parsePositiveInt(argValue('concurrency'), 4, 1, 16);
  const outDir = argValue(
    'out-dir',
    path.join('reports', `shade_visual_quality_audit_${todayStamp()}`),
  );
  const cliQueries = argValues('query')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const queries = cliQueries.length ? cliQueries : DEFAULT_QUERIES;
  const cliProductIds = argValues('product-id')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  fs.mkdirSync(outDir, { recursive: true });

  let discoveryMode = mode;
  let candidates = [];
  const discoveryErrors = [];

  if (cliProductIds.length > 0) {
    discoveryMode = 'explicit_product_ids';
    candidates = cliProductIds.map((productId) => ({
      product_id: productId,
      merchant_id: 'external_seed',
      source_query: 'explicit_product_id',
    }));
  } else if (mode === 'db' || mode === 'auto') {
    try {
      candidates = await discoverByDb({ limit });
      discoveryMode = 'db';
    } catch (error) {
      discoveryErrors.push({ mode: 'db', error: error?.message || String(error), code: error?.code || '' });
      if (mode === 'db') throw error;
    }
  }

  if (candidates.length === 0 && (mode === 'search' || mode === 'auto')) {
    candidates = await discoverBySearch({ gateway, queries, perQueryLimit, timeoutMs });
    discoveryMode = 'search';
  }

  candidates = uniqBy(candidates, (item) => `${item.merchant_id || 'external_seed'}:${item.product_id}`)
    .slice(0, maxCandidates);

  const rows = [];
  const pdpErrors = [];
  let completed = 0;
  await mapLimit(candidates, concurrency, async (item) => {
    try {
      const result = await fetchPdp({ gateway, item, timeoutMs });
      if (!result.ok) {
        pdpErrors.push({ ...item, error: result.error, status: result.status || '' });
        return;
      }
      const shadeRows = collectShadeRowsFromPayload({
        productId: item.product_id,
        merchantId: item.merchant_id,
        sourceQuery: item.source_query,
        pdpPayload: result.pdpPayload,
      });
      rows.push(...shadeRows);
    } catch (error) {
      pdpErrors.push({ ...item, error: error?.message || String(error), status: '' });
    } finally {
      completed += 1;
      if (completed % 10 === 0 || completed === candidates.length) {
        process.stderr.write(`shade visual audit: ${completed}/${candidates.length} PDPs checked\n`);
      }
      await sleep(20);
    }
  });

  rows.sort(compareAuditRows);
  pdpErrors.sort(compareAuditRows);

  const productRows = Object.values(
    rows.reduce((acc, row) => {
      const key = `${row.merchant_id}:${row.product_id}`;
      if (!acc[key]) {
        acc[key] = {
          product_id: row.product_id,
          merchant_id: row.merchant_id,
          product_title: row.product_title,
          brand_name: row.brand_name,
          product_url: `${frontend}/products/${row.product_id}`,
          shade_option_count: 0,
          real_swatch_or_hex_count: 0,
          text_fallback_missing_swatch_count: 0,
          blocked_product_image_source_count: 0,
          review_priority: 'P2',
          recommended_action: '',
        };
      }
      acc[key].shade_option_count += 1;
      acc[key][`${row.visual_status}_count`] =
        (acc[key][`${row.visual_status}_count`] || 0) + 1;
      return acc;
    }, {}),
  ).map((row) => {
    const blocked = row.blocked_product_image_source_count || 0;
    const missing = row.text_fallback_missing_swatch_count || 0;
    const total = row.shade_option_count || 0;
    return {
      ...row,
      real_swatch_coverage_rate: total ? Number((row.real_swatch_or_hex_count / total).toFixed(4)) : 0,
      review_priority: blocked > 0 ? 'P0' : missing > 0 ? 'P1' : 'pass',
      recommended_action:
        blocked > 0
          ? 'Backfill source-backed swatch_image_url or shade_hex; keep product/packaging image blocked from swatch UI.'
          : missing > 0
            ? 'Backfill source-backed swatch_image_url or shade_hex; text chip fallback is safe until then.'
            : 'No shade visual action needed.',
    };
  }).sort((left, right) => {
    const priorityOrder = { P0: 0, P1: 1, P2: 2, pass: 3 };
    return (
      (priorityOrder[left.review_priority] ?? 9) - (priorityOrder[right.review_priority] ?? 9) ||
      right.shade_option_count - left.shade_option_count ||
      left.brand_name.localeCompare(right.brand_name)
    );
  });

  const summary = summarizeRows(rows, candidates, pdpErrors, discoveryMode);
  summary.discovery_errors = discoveryErrors;
  summary.report_files = {
    summary_json: path.join(outDir, 'summary.json'),
    shade_visual_quality_audit_csv: path.join(outDir, 'shade_visual_quality_audit.csv'),
    product_rollup_csv: path.join(outDir, 'shade_visual_product_rollup.csv'),
    missing_swatch_backfill_candidates_csv: path.join(outDir, 'missing_swatch_backfill_candidates.csv'),
    blocked_product_image_sources_csv: path.join(outDir, 'blocked_product_image_sources.csv'),
    pdp_errors_csv: path.join(outDir, 'pdp_errors.csv'),
  };

  const rowColumns = [
    'product_id',
    'merchant_id',
    'product_title',
    'brand_name',
    'source_query',
    'axis_source',
    'variant_id',
    'shade_name',
    'visual_status',
    'display_mode',
    'evidence_kind',
    'chosen_visual_url',
    'blocked_visual_url',
    'blocker_reason',
    'source_swatch_image_url',
    'source_shade_hex',
    'source_label_image_url',
    'source_image_url',
    'product_url',
  ];
  const productColumns = [
    'product_id',
    'merchant_id',
    'product_title',
    'brand_name',
    'product_url',
    'shade_option_count',
    'real_swatch_or_hex_count',
    'text_fallback_missing_swatch_count',
    'blocked_product_image_source_count',
    'real_swatch_coverage_rate',
    'review_priority',
    'recommended_action',
  ];

  writeCsv(path.join(outDir, 'shade_visual_quality_audit.csv'), rows, rowColumns);
  writeCsv(path.join(outDir, 'shade_visual_product_rollup.csv'), productRows, productColumns);
  writeCsv(
    path.join(outDir, 'missing_swatch_backfill_candidates.csv'),
    rows.filter((row) => row.visual_status === 'text_fallback_missing_swatch'),
    rowColumns,
  );
  writeCsv(
    path.join(outDir, 'blocked_product_image_sources.csv'),
    rows.filter((row) => row.visual_status === 'blocked_product_image_source'),
    rowColumns,
  );
  writeCsv(
    path.join(outDir, 'pdp_errors.csv'),
    pdpErrors,
    ['product_id', 'merchant_id', 'title', 'brand', 'source_query', 'status', 'error'],
  );
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify({
    generated_at: summary.generated_at,
    discovery_mode: summary.discovery_mode,
    candidate_count: summary.candidate_count,
    shade_pdp_count: summary.shade_pdp_count,
    shade_option_count: summary.shade_option_count,
    pdp_error_count: summary.pdp_error_count,
    status_counts: summary.status_counts,
    product_counts: summary.product_counts,
    out_dir: outDir,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  classifyVisualEvidence,
  compareAuditRows,
  collectShadeRowsFromPayload,
  deriveKnownSourceShadeSwatchUrl,
  likelyProductOnlyImageUrl,
  likelyShadeSwatchImageUrl,
  summarizeRows,
  visualEvidenceFromProductLineOption,
  visualEvidenceFromVariant,
};
