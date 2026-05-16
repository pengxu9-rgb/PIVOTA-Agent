#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const DEFAULT_INPUTS = [
  'reports/shade_visual_quality_audit_20260516/blocked_product_image_sources.csv',
  'reports/shade_visual_quality_audit_20260516/missing_swatch_backfill_candidates.csv',
];

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function argValues(name) {
  const out = [];
  for (let idx = 0; idx < process.argv.length; idx += 1) {
    if (process.argv[idx] !== `--${name}`) continue;
    const value = process.argv[idx + 1];
    if (value && !value.startsWith('--')) out.push(value);
  }
  return out;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function todayStamp() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function asString(value) {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function normalizeLower(value) {
  return asString(value).toLowerCase();
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

function normalizeShadeToken(value) {
  return normalizeLower(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function shadeTokenAliases(value) {
  const normalized = normalizeShadeToken(value);
  if (!normalized) return [];
  const out = new Set([normalized, normalized.replace(/\s+/g, '-') , normalized.replace(/\s+/g, '_'), normalized.replace(/\s+/g, '')]);
  const words = normalized.split(/\s+/).filter(Boolean);
  const withoutJoiners = words.filter((word) => !['and'].includes(word)).join(' ');
  if (withoutJoiners && withoutJoiners !== normalized) {
    out.add(withoutJoiners);
    out.add(withoutJoiners.replace(/\s+/g, '-'));
    out.add(withoutJoiners.replace(/\s+/g, '_'));
    out.add(withoutJoiners.replace(/\s+/g, ''));
  }
  const withoutArticles = words.filter((word) => !['a', 'an', 'the'].includes(word)).join(' ');
  if (withoutArticles && withoutArticles !== normalized) {
    out.add(withoutArticles);
    out.add(withoutArticles.replace(/\s+/g, '-'));
    out.add(withoutArticles.replace(/\s+/g, '_'));
    out.add(withoutArticles.replace(/\s+/g, ''));
  }
  const initialismWords = words.filter((word) => !['and', 'a', 'an', 'the'].includes(word));
  if (initialismWords.length > 1 && initialismWords.length <= 5) {
    out.add(initialismWords.map((word) => word[0]).join(''));
  }
  const singularized = words.map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)).join(' ');
  if (singularized && singularized !== normalized) {
    out.add(singularized);
    out.add(singularized.replace(/\s+/g, '-'));
    out.add(singularized.replace(/\s+/g, '_'));
    out.add(singularized.replace(/\s+/g, ''));
  }
  if (/\bwinnr\b/.test(normalized)) {
    const winner = normalized.replace(/\bwinnr\b/g, 'winner');
    out.add(winner);
    out.add(winner.replace(/\s+/g, '-'));
    out.add(winner.replace(/\s+/g, '_'));
    out.add(winner.replace(/\s+/g, ''));
  }
  if (/^\d+$/.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      out.add(String(numeric).padStart(2, '0'));
      out.add(`shade ${String(numeric).padStart(2, '0')}`);
      out.add(`shade-${String(numeric).padStart(2, '0')}`);
      out.add(`shade_${String(numeric).padStart(2, '0')}`);
    }
  }
  return Array.from(out).filter(Boolean);
}

function urlMatchesShade(value, shadeName) {
  const text = normalizeUrlSearchText(value).replace(/%20/g, ' ');
  const shade = normalizeShadeToken(shadeName);
  if (!text || !shade) return false;
  if (/^\d+$/.test(shade)) {
    const numeric = Number(shade);
    if (!Number.isFinite(numeric)) return false;
    const padded = String(numeric).padStart(2, '0');
    return new RegExp(`(?:^|[^a-z0-9])(?:shade|sh)?[-_\\s]?0*${numeric}(?:[^a-z0-9]|$)`, 'i').test(text) ||
      new RegExp(`(?:^|[^a-z0-9])${padded}(?:[^a-z0-9]|$)`, 'i').test(text);
  }
  const compactText = text.replace(/[^a-z0-9]+/g, ' ');
  return shadeTokenAliases(shade).some((alias) => {
    if (!alias) return false;
    const normalizedAlias = normalizeLower(alias);
    if (!normalizedAlias) return false;
    if (text.includes(normalizedAlias)) return true;
    return compactText.includes(normalizedAlias.replace(/[-_]+/g, ' '));
  });
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(asString(value));
}

function normalizeHttpUrl(value) {
  const text = asString(value);
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  return isHttpUrl(text) ? text : '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = asString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function uniqueShadeNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = asString(value);
    const key = normalizeShadeToken(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function collectImageUrls(seedData) {
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  const values = [
    seed.swatch_image_url,
    snapshot.swatch_image_url,
    ...asArray(seed.image_urls),
    ...asArray(seed.images),
    ...asArray(snapshot.image_urls),
    ...asArray(snapshot.images),
    ...asArray(seed.content_image_urls),
    ...asArray(snapshot.content_image_urls),
  ];
  for (const variant of [...asArray(seed.variants), ...asArray(snapshot.variants)]) {
    values.push(
      variant?.swatch_image_url,
      variant?.label_image_url,
      variant?.image_url,
      ...asArray(variant?.image_urls),
      ...asArray(variant?.images),
    );
  }
  return uniqueStrings(values.map(normalizeHttpUrl)).filter(isHttpUrl);
}

function normalizeHexColor(value) {
  const text = asString(value).trim();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : '';
}

function readHexFromObject(value) {
  const obj = asObject(value);
  return normalizeHexColor(
    obj.swatch_color ||
      obj.swatchColor ||
      obj.color_hex ||
      obj.colorHex ||
      obj.shade_hex ||
      obj.shadeHex ||
      obj.swatch?.hex ||
      obj.beauty_meta?.shade_hex ||
      obj.beautyMeta?.shade_hex,
  );
}

function isTrustedSourceBackedShadeTextureUrl(url, shadeName) {
  const text = normalizeUrlSearchText(url);
  if (!isHttpUrl(url) || !text) return false;
  const hasPositiveTextureSignal =
    /(?:^|[^a-z0-9])(smear|texture|single[-_\s]?swatch|shade[-_\s]?swatch|color[-_\s]?swatch|colour[-_\s]?swatch)(?:[^a-z0-9]|$)/i.test(text);
  if (!hasPositiveTextureSignal) return false;
  if (!urlMatchesShade(text, shadeName)) return false;
  if (
    /model|infographics?|product[-_\s]?w(?:ith)?[-_\s]?smear/i.test(text) ||
    /(?:^|[^a-z0-9])(all[-_\s]?shades?|arm[-_\s]?swatch|armswatch|shade[-_\s]?names?|chart|routine|pairing|before|after)(?:[^a-z0-9]|$)/i.test(text)
  ) {
    return false;
  }
  if (/(?:^|[^a-z0-9])(concrete|ecomm|ecommerce|pack[-_\s]?shot|packaging|package|box|bottle|tube|compact|silo|hero|primary)(?:[^a-z0-9]|$)/i.test(text)) {
    return false;
  }
  return true;
}

function buildShopifyProductJsonUrl(productUrl) {
  const text = asString(productUrl);
  if (!isHttpUrl(text)) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  const match = url.pathname.match(/^(.*\/products\/[^/.?#/]+)(?:\/)?$/i);
  if (!match) return '';
  url.pathname = `${match[1]}.js`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function collectShopifyProductImageUrls(product) {
  const values = [
    product?.featured_image,
    ...asArray(product?.images),
    ...asArray(product?.media).flatMap((item) => [
      item?.src,
      item?.preview_image?.src,
    ]),
    ...asArray(product?.variants).flatMap((variant) => [
      variant?.featured_image?.src,
      variant?.featured_image,
      variant?.image,
    ]),
  ];
  return uniqueStrings(values.map(normalizeHttpUrl)).filter(isHttpUrl);
}

function shopifyProductToSeedLike(product) {
  const optionName = asString(asArray(product?.options)[0]?.name) || 'Color';
  const variants = asArray(product?.variants).map((variant) => ({
    title: firstNonEmptyString(variant?.public_title, variant?.title, variant?.option1),
    options: [{ name: optionName, value: firstNonEmptyString(variant?.option1, variant?.public_title, variant?.title) }],
    swatch_image_url: normalizeHttpUrl(variant?.featured_image?.src || variant?.featured_image || variant?.image),
  }));
  const imageUrls = collectShopifyProductImageUrls(product);
  return {
    title: asString(product?.title),
    product_title: asString(product?.title),
    vendor: asString(product?.vendor),
    image_urls: imageUrls,
    images: imageUrls,
    variants,
    snapshot: {
      title: asString(product?.title),
      product_title: asString(product?.title),
      vendor: asString(product?.vendor),
      image_urls: imageUrls,
      images: imageUrls,
      variants,
    },
  };
}

function mergeSeedDataForVisualDiscovery(seedData, supplementalSeedData) {
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  const supplemental = asObject(supplementalSeedData);
  const supplementalSnapshot = asObject(supplemental.snapshot);
  return {
    ...seed,
    image_urls: uniqueStrings([
      ...asArray(seed.image_urls),
      ...asArray(seed.images),
      ...asArray(supplemental.image_urls),
      ...asArray(supplemental.images),
    ]),
    images: uniqueStrings([
      ...asArray(seed.images),
      ...asArray(seed.image_urls),
      ...asArray(supplemental.images),
      ...asArray(supplemental.image_urls),
    ]),
    variants: [...asArray(seed.variants), ...asArray(supplemental.variants)],
    snapshot: {
      ...snapshot,
      image_urls: uniqueStrings([
        ...asArray(snapshot.image_urls),
        ...asArray(snapshot.images),
        ...asArray(supplementalSnapshot.image_urls),
        ...asArray(supplementalSnapshot.images),
      ]),
      images: uniqueStrings([
        ...asArray(snapshot.images),
        ...asArray(snapshot.image_urls),
        ...asArray(supplementalSnapshot.images),
        ...asArray(supplementalSnapshot.image_urls),
      ]),
      variants: [...asArray(snapshot.variants), ...asArray(supplementalSnapshot.variants)],
    },
  };
}

async function fetchShopifyProductJson(productUrl, { timeoutMs = 15000 } = {}) {
  const url = buildShopifyProductJsonUrl(productUrl);
  if (!url) return { ok: false, source_url: '', blocker_reason: 'not_shopify_product_url' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json,text/javascript,*/*;q=0.8',
        'user-agent': 'PivotaShadeSwatchBackfill/1.0 (+https://pivota.cc)',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const lower = text.toLowerCase();
    if (/(captcha|access denied|bot protection|cloudflare|login required|sign in required|paywall)/i.test(lower)) {
      return { ok: false, source_url: url, http_status: response.status, blocker_reason: 'shopify_product_endpoint_blocked' };
    }
    if (!response.ok) {
      return { ok: false, source_url: url, http_status: response.status, blocker_reason: `shopify_product_endpoint_http_${response.status}` };
    }
    const product = JSON.parse(text);
    return { ok: true, source_url: url, http_status: response.status, product, seed_data: shopifyProductToSeedLike(product) };
  } catch (error) {
    return {
      ok: false,
      source_url: url,
      blocker_reason: error?.name === 'AbortError' ? 'shopify_product_endpoint_timeout' : 'shopify_product_endpoint_parse_or_fetch_failed',
      error: asString(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function findSourceBackedSwatchUrl(seedData, shadeNames) {
  const shades = uniqueStrings(shadeNames);
  if (!shades.length) return '';
  for (const url of collectImageUrls(seedData)) {
    for (const shadeName of shades) {
      if (isTrustedSourceBackedShadeTextureUrl(url, shadeName)) return url;
    }
  }
  return '';
}

function extractVariantShade(variant) {
  for (const option of asArray(variant?.options)) {
    const name = normalizeLower(option?.name);
    if (['shade', 'color', 'colour', 'tone', 'hue'].includes(name)) return asString(option?.value);
  }
  return asString(variant?.shade_name || variant?.shade || variant?.title);
}

function findSourceBackedShadeHex(seedData, shadeNames) {
  const shades = uniqueStrings(shadeNames);
  if (!shades.length) return '';
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  const variants = [...asArray(seed.variants), ...asArray(snapshot.variants)];
  for (const variant of variants) {
    const shade = extractVariantShade(variant);
    if (!shades.some((target) => normalizeShadeToken(target) === normalizeShadeToken(shade))) continue;
    const hex = readHexFromObject(variant);
    if (hex) return hex;
  }

  const topLevelHex = readHexFromObject(seed) || readHexFromObject(snapshot);
  const singleSourceShade = variants.length === 1 ? extractVariantShade(variants[0]) : '';
  if (
    topLevelHex &&
    (!variants.length || shades.some((target) => normalizeShadeToken(target) === normalizeShadeToken(singleSourceShade)))
  ) {
    return topLevelHex;
  }
  return '';
}

function findSourceBackedVisualsByShade(seedData, shadeNames, reportHexesByShade = new Map()) {
  const visualsByShade = new Map();
  for (const shadeName of uniqueShadeNames(shadeNames)) {
    const shadeKey = normalizeShadeToken(shadeName);
    const reportHexes = reportHexesByShade.get(shadeKey) || new Set();
    const reportHex = reportHexes.size === 1 ? Array.from(reportHexes)[0] : '';
    const swatchUrl = findSourceBackedSwatchUrl(seedData, [shadeName]);
    const shadeHex = reportHex || findSourceBackedShadeHex(seedData, [shadeName]);
    if (!swatchUrl && !shadeHex) continue;
    visualsByShade.set(shadeKey, { shade_name: shadeName, swatch_image_url: swatchUrl, shade_hex: shadeHex });
  }
  return visualsByShade;
}

function readSeedBrand(seedData) {
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  return firstNonEmptyString(
    seed.brand,
    seed.brand_name,
    seed.brandName,
    seed.vendor,
    seed.retailer_brand,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.brandName,
    snapshot.vendor,
    snapshot.retailer_brand,
  );
}

function readSeedTitle(seedData) {
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  return firstNonEmptyString(
    seed.title,
    seed.product_title,
    seed.product_name,
    seed.name,
    snapshot.title,
    snapshot.product_title,
    snapshot.product_name,
    snapshot.name,
  );
}

function readSeedUrl(seedData, key) {
  const seed = asObject(seedData);
  const snapshot = asObject(seed.snapshot);
  return firstNonEmptyString(seed[key], snapshot[key]);
}

function visualPatchFields(variant, swatchUrl, shadeHex) {
  return {
    ...(swatchUrl ? { swatch_image_url: swatchUrl, label_image_url: swatchUrl } : {}),
    ...(shadeHex
      ? {
          swatch_color: shadeHex,
          color_hex: shadeHex,
          shade_hex: shadeHex,
          swatch: { ...asObject(variant.swatch), hex: shadeHex },
        }
      : {}),
    source_quality_status: 'captured',
  };
}

function patchVariant(variant, swatchUrl, shadeHex, targetShades, forceSingleVariant = false) {
  const shade = extractVariantShade(variant);
  const matches = forceSingleVariant || targetShades.some((target) => normalizeShadeToken(target) === normalizeShadeToken(shade));
  if (!matches) return variant;
  return {
    ...variant,
    ...visualPatchFields(variant, swatchUrl, shadeHex),
  };
}

function applyVisualPatch(
  seedData,
  { swatchUrl = '', shadeHex = '', source = 'source_backed_seed_visual_fields' } = {},
  targetShades,
  generatedAt = new Date().toISOString(),
) {
  const seed = JSON.parse(JSON.stringify(asObject(seedData)));
  const snapshot = asObject(seed.snapshot);
  const seedVariants = asArray(seed.variants);
  const snapshotVariants = asArray(snapshot.variants);
  const patchVariants = (variants) => {
    const forceSingleVariant = variants.length === 1;
    return variants.map((variant) => patchVariant(asObject(variant), swatchUrl, shadeHex, targetShades, forceSingleVariant));
  };

  if (swatchUrl) {
    seed.swatch_image_url = swatchUrl;
    seed.label_image_url = swatchUrl;
  }
  if (shadeHex) {
    seed.swatch_color = shadeHex;
    seed.color_hex = shadeHex;
    seed.shade_hex = shadeHex;
    seed.swatch = { ...asObject(seed.swatch), hex: shadeHex };
  }
  if (seedVariants.length) seed.variants = patchVariants(seedVariants);
  seed.snapshot = {
    ...snapshot,
    ...(swatchUrl ? { swatch_image_url: swatchUrl, label_image_url: swatchUrl } : {}),
    ...(shadeHex
      ? {
          swatch_color: shadeHex,
          color_hex: shadeHex,
          shade_hex: shadeHex,
          swatch: { ...asObject(snapshot.swatch), hex: shadeHex },
        }
      : {}),
    ...(snapshotVariants.length ? { variants: patchVariants(snapshotVariants) } : {}),
    diagnostics: {
      ...asObject(snapshot.diagnostics),
      shade_swatch_backfill: {
        applied: true,
        source,
        evidence_kind: swatchUrl ? 'source_backed_texture_swatch' : 'source_backed_explicit_hex',
        swatch_image_url: swatchUrl,
        shade_hex: shadeHex,
        shade_names: targetShades,
        applied_at: generatedAt,
      },
    },
  };
  return seed;
}

function applyVisualPatchByShade(
  seedData,
  visualsByShade,
  targetShades,
  generatedAt = new Date().toISOString(),
  source = 'source_backed_seed_visual_fields',
) {
  const seed = JSON.parse(JSON.stringify(asObject(seedData)));
  const snapshot = asObject(seed.snapshot);
  const seedVariants = asArray(seed.variants);
  const snapshotVariants = asArray(snapshot.variants);
  const uniqueTargets = uniqueShadeNames(targetShades);
  const visualEntries = uniqueTargets
    .map((shadeName) => {
      const shadeKey = normalizeShadeToken(shadeName);
      const visual = visualsByShade.get(shadeKey);
      return visual ? { shade_key: shadeKey, ...visual } : null;
    })
    .filter(Boolean);
  const soleVisual = visualEntries.length === 1 ? visualEntries[0] : null;

  const patchVariants = (variants) => {
    const forceSingleVariant = variants.length === 1 && soleVisual;
    return variants.map((variant) => {
      const source = asObject(variant);
      const shadeKey = normalizeShadeToken(extractVariantShade(source));
      const visual = forceSingleVariant ? soleVisual : visualsByShade.get(shadeKey);
      if (!visual) return source;
      return {
        ...source,
        ...visualPatchFields(source, visual.swatch_image_url, visual.shade_hex),
      };
    });
  };

  if (soleVisual) Object.assign(seed, visualPatchFields(seed, soleVisual.swatch_image_url, soleVisual.shade_hex));
  if (seedVariants.length) seed.variants = patchVariants(seedVariants);
  seed.snapshot = {
    ...snapshot,
    ...(soleVisual ? visualPatchFields(snapshot, soleVisual.swatch_image_url, soleVisual.shade_hex) : {}),
    ...(snapshotVariants.length ? { variants: patchVariants(snapshotVariants) } : {}),
    diagnostics: {
      ...asObject(snapshot.diagnostics),
      shade_swatch_backfill: {
        applied: true,
        source,
        evidence_kind: 'source_backed_visuals_by_shade',
        target_shade_count: uniqueTargets.length,
        patched_shade_count: visualEntries.length,
        visuals_by_shade: visualEntries,
        applied_at: generatedAt,
      },
    },
  };
  return seed;
}

function applySwatchPatch(seedData, swatchUrl, targetShades, generatedAt = new Date().toISOString()) {
  return applyVisualPatch(seedData, { swatchUrl }, targetShades, generatedAt);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];
    const next = text[idx + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        idx += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((item) => asString(item));
  return rows.slice(1).filter((items) => items.some((item) => asString(item))).map((items) =>
    Object.fromEntries(header.map((key, idx) => [key, items[idx] ?? ''])),
  );
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
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function collectTargetsFromReports(inputFiles) {
  const targetsByExternalId = new Map();
  const sigTargets = new Map();
  const register = (map, id, row) => {
    if (!id) return;
    const existing = map.get(id) || {
      id,
      shade_names: new Set(),
      source_hexes: new Set(),
      source_hexes_by_shade: new Map(),
      source_rows: 0,
    };
    if (row.shade_name) existing.shade_names.add(row.shade_name);
    const sourceHex = normalizeHexColor(row.source_shade_hex);
    if (sourceHex) {
      existing.source_hexes.add(sourceHex);
      const shadeKey = normalizeShadeToken(row.shade_name);
      if (shadeKey) {
        const hexes = existing.source_hexes_by_shade.get(shadeKey) || new Set();
        hexes.add(sourceHex);
        existing.source_hexes_by_shade.set(shadeKey, hexes);
      }
    }
    existing.source_rows += 1;
    map.set(id, existing);
  };

  for (const inputFile of inputFiles) {
    if (!fs.existsSync(inputFile)) continue;
    for (const row of parseCsv(fs.readFileSync(inputFile, 'utf8'))) {
      const productId = asString(row.product_id);
      const variantId = asString(row.variant_id);
      if (variantId.startsWith('ext_')) register(targetsByExternalId, variantId, row);
      else if (productId.startsWith('ext_')) register(targetsByExternalId, productId, row);
      else if (productId.startsWith('sig_')) register(sigTargets, productId, row);
    }
  }

  return { targetsByExternalId, sigTargets };
}

async function resolveSigTargets(sigTargets, targetsByExternalId) {
  const sigIds = Array.from(sigTargets.keys());
  if (!sigIds.length) return;
  let res;
  try {
    res = await query(
      `
        SELECT pivota_signature_id, source_product_id AS external_product_id
        FROM catalog_products
        WHERE merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND pivota_signature_id = ANY($1::text[])
          AND source_product_id LIKE 'ext\\_%' ESCAPE '\\'
      `,
      [sigIds],
    );
  } catch (error) {
    if (/catalog_products/i.test(String(error?.message || error))) {
      process.stderr.write(
        'source-backed shade swatch backfill: catalog_products unavailable; continuing with ext_* report targets only\n',
      );
      return;
    }
    throw error;
  }
  for (const row of res.rows || []) {
    const sigTarget = sigTargets.get(asString(row.pivota_signature_id));
    const externalProductId = asString(row.external_product_id);
    if (!sigTarget || !externalProductId) continue;
    const existing = targetsByExternalId.get(externalProductId) || {
      id: externalProductId,
      shade_names: new Set(),
      source_hexes: new Set(),
      source_hexes_by_shade: new Map(),
      source_rows: 0,
    };
    for (const shade of sigTarget.shade_names) existing.shade_names.add(shade);
    for (const hex of sigTarget.source_hexes) existing.source_hexes.add(hex);
    for (const [shadeKey, hexes] of sigTarget.source_hexes_by_shade || []) {
      const existingHexes = existing.source_hexes_by_shade.get(shadeKey) || new Set();
      for (const hex of hexes) existingHexes.add(hex);
      existing.source_hexes_by_shade.set(shadeKey, existingHexes);
    }
    existing.source_rows += sigTarget.source_rows;
    targetsByExternalId.set(externalProductId, existing);
  }
}

async function loadSeedRows(externalProductIds, { market = '', limit = 0 } = {}) {
  if (!externalProductIds.length) return [];
  const params = [externalProductIds];
  let marketClause = '';
  if (market) {
    params.push(market);
    marketClause = `AND upper(market) = upper($${params.length})`;
  }
  let limitClause = '';
  if (limit > 0) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  const res = await query(
    `
      SELECT id, external_product_id, market, title, canonical_url, destination_url, status, seed_data
      FROM external_product_seeds
      WHERE external_product_id = ANY($1::text[])
        ${marketClause}
      ORDER BY external_product_id
      ${limitClause}
    `,
    params,
  );
  return res.rows || [];
}

async function main() {
  const inputFiles = (argValues('input').length ? argValues('input') : DEFAULT_INPUTS)
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  const outDir = argValue('out-dir', path.join('reports', `source_backed_shade_swatch_backfill_${todayStamp()}`));
  const market = asString(argValue('market', 'US')).toUpperCase();
  const apply = hasFlag('apply');
  const limit = Number(argValue('limit', '0')) || 0;
  const includeLiveShopifyProductJson = hasFlag('include-live-shopify-product-json') || hasFlag('live-shopify-product-json');
  const generatedAt = new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  const { targetsByExternalId, sigTargets } = collectTargetsFromReports(inputFiles);
  await resolveSigTargets(sigTargets, targetsByExternalId);

  const targetIds = Array.from(targetsByExternalId.keys());
  const rows = await loadSeedRows(targetIds, { market, limit });
  const candidates = [];
  const blockers = [];
  const liveShopifyCache = new Map();
  let liveShopifyFetchCount = 0;
  let liveShopifySuccessCount = 0;
  let updated = 0;

  for (const row of rows) {
    const target = targetsByExternalId.get(asString(row.external_product_id));
    const targetShades = Array.from(target?.shade_names || []).filter(Boolean);
    const uniqueTargetShades = uniqueShadeNames(targetShades);
    let visualSource = 'source_backed_seed_visual_fields';
    let liveShopifyResult = null;
    let liveShopifySourceUrl = '';
    let visualsByShade = findSourceBackedVisualsByShade(row.seed_data, targetShades, target?.source_hexes_by_shade);
    let visualEntries = uniqueTargetShades
      .map((shadeName) => {
        const shadeKey = normalizeShadeToken(shadeName);
        const visual = visualsByShade.get(shadeKey);
        return visual ? { shade_key: shadeKey, ...visual } : null;
      })
      .filter(Boolean);

    if (includeLiveShopifyProductJson && visualEntries.length < uniqueTargetShades.length) {
      const productUrl = firstNonEmptyString(
        row.canonical_url,
        row.destination_url,
        readSeedUrl(row.seed_data, 'canonical_url'),
        readSeedUrl(row.seed_data, 'destination_url'),
        readSeedUrl(row.seed_data, 'product_url'),
      );
      const shopifyProductJsonUrl = buildShopifyProductJsonUrl(productUrl);
      liveShopifySourceUrl = shopifyProductJsonUrl;
      if (shopifyProductJsonUrl) {
        if (!liveShopifyCache.has(shopifyProductJsonUrl)) {
          liveShopifyFetchCount += 1;
          liveShopifyCache.set(shopifyProductJsonUrl, await fetchShopifyProductJson(productUrl));
        }
        liveShopifyResult = liveShopifyCache.get(shopifyProductJsonUrl);
        if (liveShopifyResult?.ok) {
          liveShopifySuccessCount += 1;
          const mergedSeedData = mergeSeedDataForVisualDiscovery(row.seed_data, liveShopifyResult.seed_data);
          const liveVisualsByShade = findSourceBackedVisualsByShade(
            mergedSeedData,
            targetShades,
            target?.source_hexes_by_shade,
          );
          const liveVisualEntries = uniqueTargetShades
            .map((shadeName) => {
              const shadeKey = normalizeShadeToken(shadeName);
              const visual = liveVisualsByShade.get(shadeKey);
              return visual ? { shade_key: shadeKey, ...visual } : null;
            })
            .filter(Boolean);
          if (liveVisualEntries.length > visualEntries.length) {
            visualsByShade = liveVisualsByShade;
            visualEntries = liveVisualEntries;
            visualSource = 'source_backed_public_shopify_product_endpoint';
          }
        }
      }
    }

    const soleVisual = visualEntries.length === 1 ? visualEntries[0] : null;
    const swatchUrl = soleVisual?.swatch_image_url || '';
    const shadeHex = soleVisual?.shade_hex || '';
    const base = {
      seed_id: row.id,
      external_product_id: row.external_product_id,
      market: row.market,
      brand: readSeedBrand(row.seed_data),
      title: firstNonEmptyString(row.title, readSeedTitle(row.seed_data)),
      canonical_url: firstNonEmptyString(row.canonical_url, readSeedUrl(row.seed_data, 'canonical_url')),
      destination_url: firstNonEmptyString(row.destination_url, readSeedUrl(row.seed_data, 'destination_url')),
      shade_names: targetShades.join('|'),
      target_shade_count: uniqueTargetShades.length,
      patched_shade_count: visualEntries.length,
      source_report_rows: target?.source_rows || 0,
      visual_source: visualSource,
      source_shopify_product_url: liveShopifySourceUrl,
    };
    if (!visualEntries.length) {
      blockers.push({
        ...base,
        blocker_reason: liveShopifyResult && !liveShopifyResult.ok
          ? liveShopifyResult.blocker_reason
          : 'no_per_shade_source_backed_swatch_texture_or_hex_asset',
        live_shopify_http_status: liveShopifyResult?.http_status || '',
        live_shopify_error: liveShopifyResult?.error || '',
      });
      continue;
    }
    const nextSeedData = applyVisualPatchByShade(row.seed_data, visualsByShade, targetShades, generatedAt, visualSource);
    candidates.push({
      ...base,
      swatch_image_url: swatchUrl,
      shade_hex: shadeHex,
      visual_evidence_kind:
        visualEntries.length > 1
          ? 'source_backed_visuals_by_shade'
          : swatchUrl
            ? 'source_backed_texture_swatch'
            : 'source_backed_explicit_hex',
      visuals_by_shade: JSON.stringify(visualEntries),
      action: apply ? 'updated' : 'dry_run',
    });
    if (apply) {
      await query(
        `UPDATE external_product_seeds SET seed_data = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [row.id, JSON.stringify(nextSeedData)],
      );
      updated += 1;
    }
  }

  const candidateColumns = [
    'seed_id',
    'external_product_id',
    'market',
    'brand',
    'title',
    'shade_names',
    'swatch_image_url',
    'shade_hex',
    'visual_evidence_kind',
    'visuals_by_shade',
    'target_shade_count',
    'patched_shade_count',
    'source_report_rows',
    'visual_source',
    'source_shopify_product_url',
    'action',
    'canonical_url',
    'destination_url',
  ];
  const blockerColumns = [
    'seed_id',
    'external_product_id',
    'market',
    'brand',
    'title',
    'shade_names',
    'target_shade_count',
    'patched_shade_count',
    'source_report_rows',
    'visual_source',
    'source_shopify_product_url',
    'blocker_reason',
    'live_shopify_http_status',
    'live_shopify_error',
    'canonical_url',
    'destination_url',
  ];
  writeCsv(path.join(outDir, 'source_backed_shade_swatch_backfill_candidates.csv'), candidates, candidateColumns);
  writeCsv(path.join(outDir, 'source_backed_shade_swatch_backfill_blockers.csv'), blockers, blockerColumns);
  const summary = {
    generated_at: generatedAt,
    mode: apply ? 'apply' : 'dry_run',
    market,
    include_live_shopify_product_json: includeLiveShopifyProductJson,
    input_files: inputFiles,
    report_target_count: targetIds.length,
    loaded_seed_count: rows.length,
    live_shopify_fetch_count: liveShopifyFetchCount,
    live_shopify_success_count: liveShopifySuccessCount,
    candidate_count: candidates.length,
    blocker_count: blockers.length,
    updated_count: updated,
    report_files: {
      candidates_csv: path.join(outDir, 'source_backed_shade_swatch_backfill_candidates.csv'),
      blockers_csv: path.join(outDir, 'source_backed_shade_swatch_backfill_blockers.csv'),
    },
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  applySwatchPatch,
  applyVisualPatch,
  applyVisualPatchByShade,
  buildShopifyProductJsonUrl,
  collectImageUrls,
  collectShopifyProductImageUrls,
  fetchShopifyProductJson,
  findSourceBackedVisualsByShade,
  findSourceBackedSwatchUrl,
  findSourceBackedShadeHex,
  isTrustedSourceBackedShadeTextureUrl,
  mergeSeedDataForVisualDiscovery,
  normalizeHexColor,
  parseCsv,
  shadeTokenAliases,
  shopifyProductToSeedLike,
  urlMatchesShade,
};
